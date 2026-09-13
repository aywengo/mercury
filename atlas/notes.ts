/**
 * The note store: contribution, dedup, sequence, replication feed, curation
 * (docs/knowledge-base.md sections 11.2, 11.3, 12 and 13).
 *
 * Three properties govern everything here.
 *
 * **One writer per project, deliberately.** Every write that changes a project's notes takes the
 * next value of that project's `seq` inside a `BEGIN IMMEDIATE`. That single constraint is what makes
 * a cursor a complete, gapless description of "everything that changed since I last asked", and it is
 * why a replica that applies writes in `seq` order and commits before advancing its cursor can never
 * miss a retirement or apply a revision before the note it revises.
 *
 * **Corroboration is derived, never stored (K3).** It is `COUNT(DISTINCT ...)` over `note_sources`.
 * A cached column would be a second source of truth, and the number it caches is the number section 12
 * promotes notes on -- a drift there promotes notes that were never corroborated.
 *
 * **Per-item answers.** One bad note never fails a batch, and a note Atlas refuses is refused with a
 * reason from a closed vocabulary. A host cannot tell "Atlas is down" from "Atlas hated my note" from
 * a batch-level error, and the second one needs an operator, not a retry.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { tx } from './db.ts';
import type { Redactor } from './redact.ts';
import { repoIdentity } from './identity.ts';
import { MAX_EVIDENCE, validateDraft, type AtlasBounds } from './validation.ts';
import {
  EVIDENCE_REQUIRED_KINDS, NOTE_KINDS, NOTE_TIERS,
  type ContributionResult, type Corroboration, type Note, type NoteContribution, type NoteTier,
} from './types.ts';

export interface ProjectRecord {
  id: string;
  name: string;
  repoIdentities: string[];
  promotionPolicy: PromotionPolicy | null;
  createdAt: string;
}

/** Section 12. `null` disables auto-promotion: every promotion becomes a human act. */
export interface PromotionPolicy {
  auto: { minRuns: number; minDistinctHarnessesOrHosts: number; kinds: string[] } | null;
}

export interface ProjectInput {
  id: string;
  name: string;
  repoIdentities: string[];
  promotionPolicy?: PromotionPolicy | null;
}

export interface NoteDetail {
  note: Note;
  revisions: { revision: number; note: Note; createdAt: string }[];
  sources: { hostId: string; runId: string | null; agent: string | null; harnessVersion: string | null; source: string; recordedAt: string }[];
}

export interface FeedPage {
  notes: Note[];
  nextSeq: number;
}

const DEFAULT_AUTO_KINDS = ['fact', 'convention', 'command', 'pitfall'];

export class NoteStore {
  private readonly db: DatabaseSync;
  private readonly bounds: AtlasBounds;
  private readonly redactor: Redactor;

  constructor(db: DatabaseSync, bounds: AtlasBounds, redactor: Redactor) {
    this.db = db;
    this.bounds = bounds;
    this.redactor = redactor;
  }

  // --- projects -------------------------------------------------------------

  createProject(input: ProjectInput): ProjectRecord {
    const now = new Date().toISOString();
    tx(this.db, () => {
      this.db.prepare(
        'INSERT INTO projects (id, name, repo_identities_json, promotion_policy_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(input.id, input.name, JSON.stringify(input.repoIdentities ?? []),
        JSON.stringify(input.promotionPolicy ?? null), now);
      // The seq row is created with the project rather than lazily, so "project exists" and "this
      // project has a sequence" are the same fact. A lazily-created counter would need its own
      // race handling inside every write.
      this.db.prepare('INSERT INTO project_seq (project_id, seq) VALUES (?, 0)').run(input.id);
    });
    return this.getProject(input.id)!;
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  listProjects(): ProjectRecord[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY id').all() as unknown as ProjectRow[]).map(toProject);
  }

  updateProject(id: string, patch: Partial<Pick<ProjectInput, 'name' | 'repoIdentities' | 'promotionPolicy'>>): ProjectRecord | null {
    const existing = this.getProject(id);
    if (!existing) return null;
    const next = {
      name: patch.name ?? existing.name,
      repoIdentities: patch.repoIdentities ?? existing.repoIdentities,
      policy: patch.promotionPolicy === undefined ? existing.promotionPolicy : patch.promotionPolicy,
    };
    this.db.prepare('UPDATE projects SET name = ?, repo_identities_json = ?, promotion_policy_json = ? WHERE id = ?')
      .run(next.name, JSON.stringify(next.repoIdentities), JSON.stringify(next.policy), id);
    return this.getProject(id);
  }

  // --- contributors ---------------------------------------------------------

  addContributor(tokenHash: string, hostId: string, projects: string[]): void {
    this.db.prepare(`
      INSERT INTO contributors (token_hash, host_id, project_ids_json, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(token_hash) DO UPDATE SET host_id = excluded.host_id, project_ids_json = excluded.project_ids_json`)
      .run(tokenHash, hostId, JSON.stringify(projects), new Date().toISOString());
  }

  removeContributor(tokenHash: string): boolean {
    return Number(this.db.prepare('DELETE FROM contributors WHERE token_hash = ?').run(tokenHash).changes) > 0;
  }

  /**
   * Revoke every token bound to a host. Returns how many were removed.
   *
   * More than one is possible and normal: rotating a token by adding a second one leaves two rows for
   * one host, and revoking the host has to take both or the old token keeps working after the operator
   * believes it is gone.
   */
  removeContributorByHost(hostId: string): number {
    return Number(this.db.prepare('DELETE FROM contributors WHERE host_id = ?').run(hostId).changes);
  }

  listContributors(): { hostId: string; projects: string[]; createdAt: string; lastSeenAt: string | null }[] {
    return (this.db.prepare('SELECT * FROM contributors ORDER BY host_id').all() as unknown as ContributorRow[])
      .map((r) => ({ hostId: r.host_id, projects: JSON.parse(r.project_ids_json) as string[], createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
  }

  // --- contribution ---------------------------------------------------------

  /**
   * Accept a batch of contributions from one host.
   *
   * The whole batch runs in one transaction, and the per-item answers are cached against the batch's
   * idempotency key before it commits. A re-send after a lost acknowledgement therefore receives the
   * SAME answers rather than being re-evaluated, which is what makes a retry a no-op instead of a
   * second corroboration.
   */
  contribute(projectId: string, hostId: string, contributions: unknown[], idempotencyKey: string | undefined, batchLimit: number): ContributionResult[] {
    if (!this.getProject(projectId)) {
      // Not a 404 for the whole request: a host configured for two projects where one was deleted
      // should learn which notes failed, not lose the whole batch to one status code.
      return contributions.map(() => ({ rejected: 'unknown-project' }));
    }
    if (contributions.length > batchLimit) {
      return contributions.map(() => ({ rejected: 'over-batch-limit' }));
    }
    if (idempotencyKey) {
      const cached = this.db.prepare('SELECT response_json FROM idempotency_keys WHERE contributor = ? AND key = ?')
        .get(hostId, idempotencyKey) as { response_json: string } | undefined;
      if (cached) return JSON.parse(cached.response_json) as ContributionResult[];
    }

    return tx(this.db, () => {
      // Re-check inside the transaction: the fast path above read without a lock, and a concurrent
      // retry of the same batch could have committed between the read and here.
      if (idempotencyKey) {
        const cached = this.db.prepare('SELECT response_json FROM idempotency_keys WHERE contributor = ? AND key = ?')
          .get(hostId, idempotencyKey) as { response_json: string } | undefined;
        if (cached) return JSON.parse(cached.response_json) as ContributionResult[];
      }
      const project = this.getProject(projectId)!;
      const results: ContributionResult[] = [];
      for (const raw of contributions) results.push(this.contributeOne(project, hostId, raw));

      if (idempotencyKey) {
        this.db.prepare('INSERT INTO idempotency_keys (contributor, key, response_json, created_at) VALUES (?, ?, ?, ?)')
          .run(hostId, idempotencyKey, JSON.stringify(results), new Date().toISOString());
      }
      return results;
    });
  }

  /**
   * One note, start to finish: validate, redact, cross-check the project, dedup, assign a seq.
   *
   * Order is deliberate. Vocabulary and bounds first because they are cheap and say the most; the
   * secret scan before the dedup lookup, because a note that contains a secret must not become a
   * source row on an existing note even as a mere corroboration -- the claim it carries is the thing
   * that leaked, and agreeing with it is a way of repeating it.
   */
  private contributeOne(project: ProjectRecord, hostId: string, raw: unknown): ContributionResult {
    const draft = validateDraft(raw, { ...this.bounds, maxEvidence: MAX_EVIDENCE });
    if (!draft.ok) return { rejected: draft.reason };

    const body = raw as Record<string, unknown>;
    const claimedHost = typeof body.hostId === 'string' ? body.hostId : (body.provenance as { hostId?: string } | undefined)?.hostId;
    if (claimedHost !== undefined && claimedHost !== hostId) {
      // Visible, not corrected. Silently rewriting provenance to the token binding would make a host
      // that misreports work, so the misconfiguration would never be found.
      return { rejected: 'host-mismatch' };
    }

    const claim = this.redactor.redact(draft.draft.claim);
    const detail = draft.draft.detail === undefined ? undefined : this.redactor.redact(draft.draft.detail);
    if (claim !== draft.draft.claim || (detail !== undefined && detail !== draft.draft.detail)) {
      return { rejected: 'secret-detected' };
    }

    // The project cross-check of section 5: a note is accepted only if a repository it could be
    // about belongs to the project. A Run against an unrelated repository contributes nothing, and
    // that is a normal outcome rather than an error.
    const identities = [
      ...(typeof body.repoIdentity === 'string' ? [body.repoIdentity] : []),
      ...(Array.isArray(body.extraRepoIdentities) ? (body.extraRepoIdentities as unknown[]).filter((x): x is string => typeof x === 'string') : []),
    ];
    if (identities.length > 0 && !identities.some((i) => project.repoIdentities.includes(i))) {
      return { rejected: 'repo-not-in-project' };
    }

    const provenance = (body.provenance ?? {}) as Record<string, unknown>;
    const scope = draft.draft.scope;
    // A note scoped to a repository must name a repository in the project, or it is a claim about a
    // repository the project has never heard of.
    if (scope.startsWith('repo:')) {
      const hash = scope.slice(5, 21);
      const known = project.repoIdentities.map((identity) => repoIdentity(identity)?.hash).filter((h): h is string => Boolean(h));
      if (known.length > 0 && !known.includes(hash)) return { rejected: 'repo-not-in-project' };
    }

    const contribution: NoteContribution = {
      projectId: project.id,
      kind: draft.draft.kind,
      scope,
      claim,
      ...(detail !== undefined ? { detail } : {}),
      evidence: draft.draft.evidence ?? [],
      ...(draft.draft.contradicts ? { contradicts: draft.draft.contradicts } : {}),
      provenance: {
        source: provenanceSource(provenance.source),
        hostId,
        ...(typeof provenance.runId === 'string' ? { runId: provenance.runId } : {}),
        ...(typeof provenance.agent === 'string' ? { agent: provenance.agent } : {}),
        harnessVersion: typeof provenance.harnessVersion === 'string' ? provenance.harnessVersion : null,
        recordedAt: typeof provenance.recordedAt === 'string' ? provenance.recordedAt : new Date().toISOString(),
      },
    };

    const claimHashKey = claimHashOf(contribution);
    const existing = this.db.prepare('SELECT note_id FROM notes WHERE project_id = ? AND claim_hash = ?')
      .get(project.id, claimHashKey) as { note_id: string } | undefined;
    if (existing) {
      this.addSource(existing.note_id, contribution);
      // Re-check promotion here as well as on insert. Corroboration accumulates through the
      // duplicate path -- that is the whole mechanism -- so a note that crossed the policy threshold
      // on its third host would otherwise stay a candidate forever, and the auto-promotion of
      // section 12 would only ever fire on a note's first and least-corroborated moment.
      this.autoPromote(project, existing.note_id, 'system:corroboration');
      return { duplicate: existing.note_id };
    }
    return { accepted: this.insertNote(project, contribution, claimHashKey) };
  }

  /**
   * Land a brand-new note.
   *
   * A `repo-record` note from an accepted decision record lands PROMOTED: git review is the curation
   * step for decisions (section 6.3), and routing it through a second promotion queue would only add
   * latency to the most trustworthy kind of knowledge Atlas holds. Everything else lands as a
   * candidate and has to earn its way across.
   */
  private insertNote(project: ProjectRecord, c: NoteContribution, claimHashKey: string): string {
    const noteId = `note_${randomBytes(8).toString('hex')}`;
    const tier: NoteTier = c.provenance.source === 'repo-record' || c.provenance.source === 'operator' ? 'promoted' : 'candidate';
    const seq = this.nextSeq(project.id);
    const now = new Date().toISOString();
    const note = buildNote(noteId, 1, project.id, tier, c, this.corroboration(noteId), seq);

    this.db.prepare(`
      INSERT INTO notes (note_id, project_id, current_revision, tier, kind, scope, claim_hash, seq, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
      .run(noteId, project.id, tier, c.kind, c.scope, claimHashKey, seq, now, now);
    this.writeRevision(note, seq, now);
    this.addSource(noteId, c);
    if (tier === 'candidate') this.autoPromote(project, noteId, 'system:corroboration');
    else if (tier === 'promoted') {
      this.db.prepare('INSERT INTO promotions (note_id, from_tier, to_tier, actor, reason, seq, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(noteId, 'candidate', 'promoted', `system:${c.provenance.source}`, 'curated at source', seq, now);
    }
    return noteId;
  }

  /** Add one corroborating source. The unique key makes a retry of the same Run a no-op. */
  private addSource(noteId: string, c: NoteContribution): void {
    this.db.prepare(`
      INSERT INTO note_sources (note_id, host_id, run_id, agent, harness_version, source, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(note_id, host_id, run_id) DO NOTHING`)
      .run(noteId, c.provenance.hostId, c.provenance.runId ?? '', c.provenance.agent ?? null,
        c.provenance.harnessVersion ?? null, c.provenance.source, c.provenance.recordedAt);
  }

  /**
   * The per-project sequence, assigned under the transaction the caller already holds.
   *
   * `UPDATE ... RETURNING` rather than a read-then-write: two concurrent writers inside their own
   * `BEGIN IMMEDIATE` are serialized by SQLite, but a read-then-write still reads a value the other
   * transaction may have advanced before this one commits, and a skipped seq is the gap a cursor
   * cannot survive.
   */
  private nextSeq(projectId: string): number {
    const row = this.db.prepare('UPDATE project_seq SET seq = seq + 1 WHERE project_id = ? RETURNING seq')
      .get(projectId) as { seq: number } | undefined;
    if (!row) throw new Error(`project ${projectId} has no sequence row`);
    return row.seq;
  }

  private writeRevision(note: Note, seq: number, createdAt: string): void {
    this.db.prepare('INSERT INTO note_revisions (note_id, revision, note_json, seq, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(note.noteId, note.revision, JSON.stringify(note), seq, createdAt);
  }

  // --- corroboration --------------------------------------------------------

  /** Counted from `note_sources` on every call. There is no cached copy to disagree with (K3). */
  corroboration(noteId: string): Corroboration {
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT run_id) AS runs, COUNT(DISTINCT host_id) AS hosts, COUNT(DISTINCT agent) AS harnesses
      FROM note_sources WHERE note_id = ?`).get(noteId) as { runs: number; hosts: number; harnesses: number };
    return { runs: Number(row.runs), hosts: Number(row.hosts), harnesses: Number(row.harnesses) };
  }

  /**
   * Corroboration-based promotion (section 12).
   *
   * Both conditions must hold: enough distinct Runs, AND those Runs spread over enough distinct
   * harnesses or hosts. The second is the K3 argument made operational -- three PrimeAgent Runs on one
   * host agreeing can be a shared vendor quirk, one PrimeAgent Run and one Claude Run agreeing much
   * less likely can be.
   */
  private autoPromote(project: ProjectRecord, noteId: string, actor: string): boolean {
    const policy = project.promotionPolicy?.auto;
    if (!policy) return false;
    const note = this.getNote(project.id, noteId);
    if (!note || note.note.tier !== 'candidate') return false;
    if (!(policy.kinds.length ? policy.kinds : DEFAULT_AUTO_KINDS).includes(note.note.kind)) return false;
    const c = this.corroboration(noteId);
    if (c.runs < policy.minRuns) return false;
    if (Math.max(c.hosts, c.harnesses) < policy.minDistinctHarnessesOrHosts) return false;
    // `transition`, not `promote`: this runs inside the contribution's transaction, and `promote`
    // opens one of its own.
    this.transition(project.id, noteId, 'promoted', actor,
      `auto: ${c.runs} runs across ${Math.max(c.hosts, c.harnesses)} hosts or harnesses`);
    return true;
  }

  // --- curation -------------------------------------------------------------

  promote(projectId: string, noteId: string, actor: string, reason: string): Note | null {
    return tx(this.db, () => this.transition(projectId, noteId, 'promoted', actor, reason));
  }

  retire(projectId: string, noteId: string, actor: string, reason: string, supersededBy?: string): Note | null {
    return tx(this.db, () => this.transition(projectId, noteId, 'retired', actor, reason, supersededBy));
  }

  /**
   * A tier change, and the only place one happens.
   *
   * The reason is required rather than optional. A promotion with no recorded reason is unreconstructable
   * at 3am, which is the same argument crew/teams.md 7.1 makes about placement reasons.
   */
  private transition(projectId: string, noteId: string, to: NoteTier, actor: string, reason: string, supersededBy?: string): Note | null {
    if (!reason || reason.trim() === '') throw new Error('a tier change requires a reason');
    // The transaction is opened by the caller, not here. `autoPromote` reaches this from inside a
    // contribution, which already holds one, and SQLite answers BEGIN inside a transaction with an
    // error rather than a savepoint -- so a self-contained tx here would make every auto-promotion
    // throw and no note would ever cross over.
    const row = this.db.prepare('SELECT * FROM notes WHERE note_id = ? AND project_id = ?').get(noteId, projectId) as NoteRow | undefined;
    if (!row) return null;
    const from = row.tier as NoteTier;
    if (from === to) return this.getNote(projectId, noteId)?.note ?? null;
    const seq = this.nextSeq(projectId);
    const now = new Date().toISOString();
    const revision = row.current_revision + 1;
    const base = this.getNote(projectId, noteId)!.note;
    const next: Note = {
      ...base, revision, tier: to, seq,
      ...(supersededBy ? { supersededBy } : {}),
    };
    this.db.prepare('UPDATE notes SET tier = ?, current_revision = ?, seq = ?, updated_at = ? WHERE note_id = ?')
      .run(to, revision, seq, now, noteId);
    this.writeRevision(next, seq, now);
    this.db.prepare('INSERT INTO promotions (note_id, from_tier, to_tier, actor, reason, seq, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(noteId, from, to, actor, reason, seq, now);
    return next;
  }

  /**
   * Declare a conflict. Atlas does not detect contradictions and does not pick a winner (section 12);
   * it records a declaration, flags BOTH notes, and leaves the pair in place so a Run sees the
   * disagreement rather than one side presented as settled.
   */
  contest(projectId: string, noteId: string, contradicts: string, actor: string): boolean {
    return tx(this.db, () => {
      const a = this.db.prepare('SELECT note_id FROM notes WHERE note_id = ? AND project_id = ?').get(noteId, projectId);
      const b = this.db.prepare('SELECT note_id FROM notes WHERE note_id = ? AND project_id = ?').get(contradicts, projectId);
      if (!a || !b || noteId === contradicts) return false;
      const seq = this.nextSeq(projectId);
      const now = new Date().toISOString();
      // Both directions, so either note's reader sees the pair. A one-way edge would mean the note
      // that was contested keeps being served as though nothing were known against it.
      for (const [x, y] of [[noteId, contradicts], [contradicts, noteId]] as const) {
        this.db.prepare(`
          INSERT INTO contests (note_id, contradicts_note_id, actor, seq, at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(note_id, contradicts_note_id) DO NOTHING`).run(x, y, actor, seq, now);
        this.bumpForContest(projectId, x, seq, now);
      }
      return true;
    });
  }

  private bumpForContest(projectId: string, noteId: string, seq: number, now: string): void {
    const row = this.db.prepare('SELECT * FROM notes WHERE note_id = ?').get(noteId) as NoteRow | undefined;
    if (!row) return;
    const note = this.getNote(projectId, noteId)!.note;
    const revision = row.current_revision + 1;
    this.db.prepare('UPDATE notes SET current_revision = ?, seq = ?, updated_at = ? WHERE note_id = ?')
      .run(revision, seq, now, noteId);
    this.writeRevision({ ...note, revision, contested: true, seq }, seq, now);
  }

  // --- reads ----------------------------------------------------------------

  /**
   * The replication feed (section 11.2): everything with `seq > since`, in seq order.
   *
   * `tier=promoted` filters to writes that concern the promoted set, INCLUDING the transition out of
   * it. A retirement of a promoted note is a promoted-set change and must appear, or a replica keeps
   * serving a retired note forever and the cursor was a lie.
   */
  feed(projectId: string, since: number, tier: 'promoted' | 'all', opts: { scope?: string; kind?: string; limit: number }): FeedPage {
    const clauses = ['n.project_id = ?', 'n.seq > ?'];
    const params: (string | number)[] = [projectId, since];
    if (tier === 'promoted') {
      clauses.push(`(n.tier = 'promoted' OR (n.tier = 'retired' AND EXISTS (
        SELECT 1 FROM promotions p WHERE p.note_id = n.note_id AND p.to_tier = 'promoted')))`)
        ;
    }
    if (opts.scope) { clauses.push('n.scope = ?'); params.push(opts.scope); }
    if (opts.kind) { clauses.push('n.kind = ?'); params.push(opts.kind); }
    params.push(opts.limit);
    const rows = this.db.prepare(`
      SELECT n.* FROM notes n WHERE ${clauses.join(' AND ')} ORDER BY n.seq ASC LIMIT ?`).all(...params) as unknown as NoteRow[];
    const notes = rows.map((r) => this.currentNote(r)!).filter((n): n is Note => Boolean(n));
    const nextSeq = rows.length > 0 ? Number(rows[rows.length - 1]!.seq) : since;
    return { notes, nextSeq };
  }

  /** The full promoted set and the seq to continue from, in one round trip (section 13). */
  bootstrap(projectId: string): FeedPage {
    const rows = this.db.prepare("SELECT * FROM notes WHERE project_id = ? AND tier = 'promoted' ORDER BY seq ASC")
      .all(projectId) as unknown as NoteRow[];
    const seqRow = this.db.prepare('SELECT seq FROM project_seq WHERE project_id = ?').get(projectId) as { seq: number } | undefined;
    return {
      notes: rows.map((r) => this.currentNote(r)!).filter((n): n is Note => Boolean(n)),
      // The CURRENT seq, not the last note's: a promotion or a contest advanced the sequence past the
      // newest note, and resuming below it would replay writes the replica is about to receive anyway.
      nextSeq: Number(seqRow?.seq ?? 0),
    };
  }

  getNote(projectId: string, noteId: string): NoteDetail | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE note_id = ? AND project_id = ?').get(noteId, projectId) as NoteRow | undefined;
    if (!row) return null;
    const note = this.currentNote(row);
    if (!note) return null;
    const revisions = (this.db.prepare('SELECT revision, note_json, created_at FROM note_revisions WHERE note_id = ? ORDER BY revision ASC')
      .all(noteId) as unknown as { revision: number; note_json: string; created_at: string }[])
      .map((r) => ({ revision: r.revision, note: JSON.parse(r.note_json) as Note, createdAt: r.created_at }));
    const sources = (this.db.prepare('SELECT * FROM note_sources WHERE note_id = ? ORDER BY recorded_at ASC').all(noteId) as unknown as SourceRow[])
      .map((s) => ({ hostId: s.host_id, runId: s.run_id || null, agent: s.agent, harnessVersion: s.harness_version, source: s.source, recordedAt: s.recorded_at }));
    return { note, revisions, sources };
  }

  /**
   * The current revision of a note, read from `note_revisions` rather than rebuilt from columns.
   *
   * The revision row is the immutable record of what was written, and it is what a replica already
   * received. Rebuilding from the `notes` columns would produce a note that differs in its corroboration
   * counters from the one that was served, and a replica would then hold two versions of one revision.
   */
  private currentNote(row: NoteRow): Note | null {
    const rev = this.db.prepare('SELECT note_json FROM note_revisions WHERE note_id = ? AND revision = ?')
      .get(row.note_id, row.current_revision) as { note_json: string } | undefined;
    if (!rev) return null;
    const note = JSON.parse(rev.note_json) as Note;
    return { ...note, corroboration: this.corroboration(row.note_id), contested: this.isContested(row.note_id) };
  }

  private isContested(noteId: string): boolean {
    return this.db.prepare('SELECT 1 FROM contests WHERE note_id = ? LIMIT 1').get(noteId) !== undefined;
  }

  // --- retention ------------------------------------------------------------

  /**
   * Retire candidates nobody corroborated (section 12). This is how the noise tier 2 inevitably
   * produces drains itself without an operator sweeping it.
   *
   * Returns the ids it retired so the caller can log a count; the promotions rows carry the audit
   * trail, and the evidence the notes pointed at is in git and untouched (K1).
   */
  retireStaleCandidates(olderThanMs: number): string[] {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = this.db.prepare(`
      SELECT n.note_id, n.project_id FROM notes n
      WHERE n.tier = 'candidate' AND n.updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM note_sources s WHERE s.note_id = n.note_id AND s.recorded_at > ?)`)
      .all(cutoff, cutoff) as unknown as { note_id: string; project_id: string }[];
    const done: string[] = [];
    for (const row of rows) {
      try {
        if (this.retire(row.project_id, row.note_id, 'system:retention', 'stale')) done.push(row.note_id);
      } catch { /* one failure must not stop the sweep */ }
    }
    return done;
  }

  /** Delete retired notes past their retention. The promotions and contests rows stay (section 12). */
  deleteExpiredRetired(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = this.db.prepare("SELECT note_id FROM notes WHERE tier = 'retired' AND updated_at < ?").all(cutoff) as unknown as { note_id: string }[];
    for (const row of rows) {
      this.db.prepare('DELETE FROM note_revisions WHERE note_id = ?').run(row.note_id);
      this.db.prepare('DELETE FROM note_sources WHERE note_id = ?').run(row.note_id);
      this.db.prepare('DELETE FROM notes WHERE note_id = ?').run(row.note_id);
    }
    return rows.length;
  }

  /** Idempotency keys are swept too; they are a replay guard, not a record to keep forever. */
  deleteExpiredIdempotencyKeys(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return Number(this.db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff).changes);
  }

  // --- metrics --------------------------------------------------------------

  countsByProject(): { projectId: string; tier: string; kind: string; n: number }[] {
    return (this.db.prepare('SELECT project_id, tier, kind, COUNT(*) AS n FROM notes GROUP BY project_id, tier, kind')
      .all() as unknown as { project_id: string; tier: string; kind: string; n: number }[])
      .map((r) => ({ projectId: r.project_id, tier: r.tier, kind: r.kind, n: Number(r.n) }));
  }

  lastContributionByHost(): { hostId: string; lastSeenAt: string | null }[] {
    return (this.db.prepare('SELECT host_id, last_seen_at FROM contributors ORDER BY host_id').all() as unknown as { host_id: string; last_seen_at: string | null }[])
      .map((r) => ({ hostId: r.host_id, lastSeenAt: r.last_seen_at }));
  }
}

function buildNote(noteId: string, revision: number, projectId: string, tier: NoteTier, c: NoteContribution, corroboration: Corroboration, seq: number): Note {
  return {
    noteId, revision, projectId,
    kind: c.kind, scope: c.scope, claim: c.claim,
    ...(c.detail !== undefined ? { detail: c.detail } : {}),
    evidence: c.evidence,
    tier,
    ...(c.contradicts ? { contradicts: c.contradicts } : {}),
    provenance: c.provenance,
    corroboration,
    seq,
  };
}

/**
 * The dedup key: kind + scope + a normalized claim.
 *
 * This must match `claimHash()` in the host's `src/knowledge/validation.ts` byte for byte, or the
 * same claim arriving from two hosts becomes two notes and corroboration never accumulates. It is
 * checked, not trusted: `test/atlasContract.test.ts` hashes the same claims through both
 * implementations.
 */
export function claimHashOf(c: NoteContribution): string {
  const normalized = c.claim.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.,;:!?]+$/, '');
  return createHash('sha256').update(`${c.kind}\n${c.scope}\n${normalized}`, 'utf8').digest('hex');
}

function provenanceSource(raw: unknown): NoteContribution['provenance']['source'] {
  const value = typeof raw === 'string' ? raw : 'agent-reported';
  return (['agent-reported', 'distilled', 'repo-record', 'operator'] as const).includes(value as never)
    ? value as NoteContribution['provenance']['source'] : 'agent-reported';
}

interface ProjectRow { id: string; name: string; repo_identities_json: string; promotion_policy_json: string; created_at: string }
interface NoteRow { note_id: string; project_id: string; current_revision: number; tier: string; kind: string; scope: string; claim_hash: string; seq: number; created_at: string; updated_at: string }
interface SourceRow { host_id: string; run_id: string; agent: string | null; harness_version: string | null; source: string; recorded_at: string }
interface ContributorRow { host_id: string; project_ids_json: string; created_at: string; last_seen_at: string | null }

function toProject(r: ProjectRow): ProjectRecord {
  return {
    id: r.id, name: r.name,
    repoIdentities: JSON.parse(r.repo_identities_json) as string[],
    promotionPolicy: r.promotion_policy_json ? JSON.parse(r.promotion_policy_json) as PromotionPolicy : null,
    createdAt: r.created_at,
  };
}

export { NOTE_KINDS, NOTE_TIERS, EVIDENCE_REQUIRED_KINDS };

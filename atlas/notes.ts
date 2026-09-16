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
  assertUsableHostId, EVIDENCE_REQUIRED_KINDS, NOTE_KINDS, NOTE_TIERS,
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

/**
 * A project's shape without its content. See `NoteStore.summary()`.
 *
 * Deliberately has no field that could hold a claim. Adding one later should require deleting this
 * comment, not remembering to keep a route honest.
 */
export interface ProjectSummary {
  projectId: string;
  /** Notes per tier, e.g. `{ promoted: 12, candidate: 3 }`. Tiers with no notes are absent, not zero. */
  byTier: Record<string, number>;
  /** Kinds among promoted notes only -- the ones a Run is actually being told. */
  promotedByKind: Record<string, number>;
  contestedPairs: number;
  /** Contributors that have taught this project something, most recent first. */
  contributors: { hostId: string; notes: number; lastArrival: string }[];
  latestSeq: number;
}

export interface FeedPage {
  notes: Note[];
  nextSeq: number;
}

const DEFAULT_AUTO_KINDS = ['fact', 'convention', 'command', 'pitfall'];

/**
 * Raised when a tier change would put two live notes on one claim.
 *
 * It is a domain error rather than an HTTP one because `notes.ts` knows nothing about transports; the
 * promote route turns it into a 409 that names the note to retire first. A plain Error here would reach
 * the operator as a bare 500, which is the wrong answer to a request they can actually fix.
 */
export class ClaimConflictError extends Error {
  // Declared rather than declared-and-assigned in the constructor signature: the repo builds with
  // `erasableSyntaxOnly`, which rejects TypeScript parameter properties.
  readonly projectId: string;
  readonly noteId: string;
  readonly conflictingNoteId: string;

  constructor(projectId: string, noteId: string, conflictingNoteId: string) {
    super(
      `note ${noteId} cannot become live: note ${conflictingNoteId} already holds this claim in a live ` +
        `tier for project ${projectId}. Retire ${conflictingNoteId} first.`,
    );
    this.projectId = projectId;
    this.noteId = noteId;
    this.conflictingNoteId = conflictingNoteId;
    this.name = 'ClaimConflictError';
  }
}

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
    // Same rule as the contributor file loader. Two entry points, one definition, so the CLI cannot
    // accept what the file loader refuses.
    const usable = assertUsableHostId(hostId, 'contributor');
    this.db.prepare(`
      INSERT INTO contributors (token_hash, host_id, project_ids_json, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(token_hash) DO UPDATE SET host_id = excluded.host_id, project_ids_json = excluded.project_ids_json`)
      .run(tokenHash, usable, JSON.stringify(projects), new Date().toISOString());
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
  /**
   * `hostId` is the caller's TOKEN BINDING, not a value from the request body.
   *
   * `null` means the caller is an admin, which is not bound to any host: an operator posting a note acts
   * on behalf of a host and names it in the body. Passing the literal string 'admin' instead would make
   * every operator note fail the `host-mismatch` check below, because the body correctly names the host
   * that recorded it -- which is exactly what an operator note has to do to be attributable.
   */
  contribute(projectId: string, hostId: string | null, contributions: unknown[], idempotencyKey: string | undefined, batchLimit: number): ContributionResult[] {
    if (!this.getProject(projectId)) {
      // Not a 404 for the whole request: a host configured for two projects where one was deleted
      // should learn which notes failed, not lose the whole batch to one status code.
      return contributions.map(() => ({ rejected: 'unknown-project' }));
    }
    if (contributions.length > batchLimit) {
      return contributions.map(() => ({ rejected: 'over-batch-limit' }));
    }
    // One value for the read and the write. The insert below coalesces a null host to 'admin' because
    // the column is part of a PRIMARY KEY and SQL NULLs are never equal to each other -- storing NULL
    // would let every admin retry look like a first attempt. The reads were never given the same
    // treatment, and `contributor = NULL` matches no row, so an admin retry missed its own cached
    // response, re-evaluated, and then hit the PRIMARY KEY on insert: a 500 that repeats forever, with
    // the host backing off and resending the same key. Measured before this line existed:
    //   first call  -> {"accepted":"note_..."}
    //   retry, same key -> UNIQUE constraint failed: idempotency_keys.contributor, ...key
    const contributor = hostId ?? 'admin';

    if (idempotencyKey) {
      const cached = this.db.prepare('SELECT response_json FROM idempotency_keys WHERE contributor = ? AND key = ?')
        .get(contributor, idempotencyKey) as { response_json: string } | undefined;
      if (cached) return JSON.parse(cached.response_json) as ContributionResult[];
    }

    return tx(this.db, () => {
      // Re-check inside the transaction: the fast path above read without a lock, and a concurrent
      // retry of the same batch could have committed between the read and here.
      if (idempotencyKey) {
        const cached = this.db.prepare('SELECT response_json FROM idempotency_keys WHERE contributor = ? AND key = ?')
          .get(contributor, idempotencyKey) as { response_json: string } | undefined;
        if (cached) return JSON.parse(cached.response_json) as ContributionResult[];
      }
      const project = this.getProject(projectId)!;
      const results: ContributionResult[] = [];
      for (const raw of contributions) results.push(this.contributeOne(project, hostId, raw));

      if (idempotencyKey) {
        // Same `contributor` the two reads above used. It is coalesced because the column participates
        // in a PRIMARY KEY and SQL NULLs are never equal to each other: storing NULL would let every
        // admin retry look like a first attempt and re-count corroboration, which is the exact failure
        // the key exists to prevent. Reading with `hostId` while writing this coalesced value is what
        // made an admin retry miss its own cache and then violate the key.
        this.db.prepare('INSERT INTO idempotency_keys (contributor, key, response_json, created_at) VALUES (?, ?, ?, ?)')
          .run(contributor, idempotencyKey, JSON.stringify(results), new Date().toISOString());
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
  private contributeOne(project: ProjectRecord, hostId: string | null, raw: unknown): ContributionResult {
    const draft = validateDraft(raw, { ...this.bounds, maxEvidence: MAX_EVIDENCE });
    if (!draft.ok) return { rejected: draft.reason };

    const body = raw as Record<string, unknown>;
    const claimedHost = typeof body.hostId === 'string' ? body.hostId : (body.provenance as { hostId?: string } | undefined)?.hostId;
    // A contributor is bound to one host by its token, and a body that names another is a visible
    // `host-mismatch` rather than something to correct silently: rewriting provenance to the binding
    // would make a misreporting host work, so the misconfiguration would never be found.
    //
    // An admin is not bound to a host at all. Its binding is null, and the body's host is the only
    // attribution an operator note can have, so it is taken as given.
    if (hostId !== null && claimedHost !== undefined && claimedHost !== hostId) {
      return { rejected: 'host-mismatch' };
    }
    // The trust boundary, stated because it is not enforced: an admin may attribute a note to a host
    // that has never registered, and corroboration counts distinct host_ids, so a typo would inflate the
    // `hosts` figure a promotion policy reads. Validating the name against the contributors table would
    // not remove the trust -- an admin can already promote, retire and contest at will, and could name a
    // host that exists but did not agree -- so it would trade a phantom id for a false sense of one. The
    // audit trail in `promotions` records the actor either way.
    const effectiveHost = hostId ?? claimedHost ?? 'admin';

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
        hostId: effectiveHost,
        ...(typeof provenance.runId === 'string' ? { runId: provenance.runId } : {}),
        ...(typeof provenance.agent === 'string' ? { agent: provenance.agent } : {}),
        harnessVersion: typeof provenance.harnessVersion === 'string' ? provenance.harnessVersion : null,
        recordedAt: typeof provenance.recordedAt === 'string' ? provenance.recordedAt : new Date().toISOString(),
      },
    };

    const claimHashKey = claimHashOf(contribution);
    // A retired note is excluded from dedup intentionally (#551). A retired note went through
    // `retireStaleCandidates` (no corroboration) or an explicit operator retirement; its claim is no
    // longer in the served set. A later contribution of the same claim should land fresh -- as a new
    // candidate that can earn its way to promoted again -- rather than silently augmenting a note that
    // will never be served. The result is therefore `accepted`, not `duplicate`, and the old retired
    // row stays as history.
    //
    // Determinism: at most one non-retired note exists per (project_id, claim_hash), so `.get()` returns
    // that row or nothing. Two things hold that up, and neither is this query alone:
    //   - insertion: this is the only gate before insertNote(), the sole writer of the notes table;
    //   - revival: transition() refuses to move a note into a live tier while another live note already
    //     holds the claim, which is what stops an admin promoting an old retired note beside its
    //     replacement (ClaimConflictError).
    // There is no UNIQUE constraint backing this, so a future writer that bypasses both would break it
    // silently; the guard lives in transition() because that is the single place tiers change.
    const existing = this.db.prepare(
      "SELECT note_id FROM notes WHERE project_id = ? AND claim_hash = ? AND tier NOT IN ('retired', 'deleted')",
    ).get(project.id, claimHashKey) as { note_id: string } | undefined;
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
   * Delete a note, safely (#590).
   *
   * This is the only way a note's content ever leaves Atlas, and it is not a DELETE. It writes a final
   * revision that carries a fresh `seq`, marks the note `deleted`, and holds no claim, no detail and no
   * evidence. The row survives; the knowledge does not.
   *
   * The reason it has to work this way is the cursor. A replica advances by `seq` and trusts that every
   * change is a row in the feed. A bare DELETE produces no row, so every replica that had already
   * received the note would keep serving it forever with nothing to reconcile against -- Atlas would
   * become a service that silently disagrees with its own copies. A tombstone is the DELETE that a
   * cursor can see.
   *
   * What is deliberately NOT removed: the note id, the claim hash, the provenance, and the whole
   * `promotions` audit trail. An operator asking "what did Mercury believe here in March" must still get
   * an answer, and section 12 keeps that trail indefinitely. What IS removed is the part that can hurt:
   * the claim text and anything quoted inside it.
   *
   * One caveat that is easy to miss and was missed once. The revisions written BEFORE the tombstone are
   * immutable rows (section 11.3) and still hold the original text on disk. `getNote()` therefore blanks
   * them at read time for a deleted note, which is what makes "the knowledge does not survive" true of
   * the service rather than only of the newest row. Stored bytes are not rewritten: the immutability
   * promise and the deletion promise are both kept, and the cost is that someone with direct read access
   * to the database file can still recover the text. That is a backup-and-disk-trust question, not one
   * this route can answer.
   *
   * `reason` is required for the same reason a retirement requires one. A deletion with no recorded
   * reason is indistinguishable from a bug at 3am.
   */
  deleteNote(projectId: string, noteId: string, actor: string, reason: string): Note | null {
    if (!reason || reason.trim() === '') throw new Error('a deletion requires a reason');
    return tx(this.db, () => this.transition(projectId, noteId, 'deleted', actor, reason));
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
    // Bringing a note back into a live tier is the one move the dedup gate cannot see, and it is the one
    // move that can put two live notes on one claim. contributeOne() only refuses to *insert* beside a
    // live note; nothing stopped a retired note from being promoted beside the note that replaced it.
    // Before the retired-claim fix that was harmless -- there was only ever one row per claim -- so this
    // guard is load-bearing for that change rather than general tidiness.
    // `deleted` is exempt alongside `retired`: this guard stops a note being brought BACK into a live
    // tier beside the note that replaced its claim, and a deletion moves in the opposite direction.
    // Leaving it out would make deleting the second of two same-claim notes throw, which is the opposite
    // of what an operator reaching for a delete wants.
    if (to !== 'retired' && to !== 'deleted') {
      const clash = this.db.prepare(
        "SELECT note_id FROM notes WHERE project_id = ? AND claim_hash = ? AND tier NOT IN ('retired', 'deleted') AND note_id != ?",
      ).get(projectId, row.claim_hash, noteId) as { note_id: string } | undefined;
      if (clash) throw new ClaimConflictError(projectId, noteId, clash.note_id);
    }
    const seq = this.nextSeq(projectId);
    const now = new Date().toISOString();
    const revision = row.current_revision + 1;
    const base = this.getNote(projectId, noteId)!.note;
    // A tombstone carries the identity and the sequence number and nothing else. Emptying the claim here
    // is the entire point of the operation, so it happens in the one place that writes revisions rather
    // than in each caller -- a caller that forgot would "delete" a note and leave its text in the
    // revision table, in the feed, and in every replica that had already pulled it.
    const next: Note = to === 'deleted'
      ? { ...base, revision, tier: to, seq, claim: '', detail: undefined, evidence: [], contested: false }
      : { ...base, revision, tier: to, seq, ...(supersededBy ? { supersededBy } : {}) };
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
      const now = new Date().toISOString();
      // Both directions, so either note's reader sees the pair. A one-way edge would mean the note
      // that was contested keeps being served as though nothing were known against it.
      //
      // Each bump takes its OWN seq. Sharing one value between the two notes would put both at seq N,
      // and a replica paging with a limit below the batch size would read the first, set its cursor to
      // N, then ask for `seq > N` and never see the second -- the note would be dropped from that
      // replica forever, silently. The gapless-cursor guarantee of section 11.2 is about distinct
      // values, not merely increasing ones, and this is the path that was easy to get wrong because
      // both notes really are part of one event.
      for (const [x, y] of [[noteId, contradicts], [contradicts, noteId]] as const) {
        const seq = this.nextSeq(projectId);
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
    // The stored revision, read raw rather than through getNote(). getNote() is a READ projection and
    // redacts (section 11.5); persisting its output would fold a read-time view into the record and make
    // a secret declared after the note was written unrecoverable even from the audit trail.
    const rev = this.db.prepare('SELECT note_json FROM note_revisions WHERE note_id = ? AND revision = ?')
      .get(noteId, row.current_revision) as { note_json: string } | undefined;
    if (!rev) return;
    const note = JSON.parse(rev.note_json) as Note;
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
      // A tombstone is in here for the same reason a retirement is, and it matters more: a replica that
      // misses a retirement keeps serving a stale note, and a replica that misses a DELETION keeps
      // serving text Atlas was asked to destroy. Only tombstones of notes that once reached `promoted`
      // are relevant -- the replica holds nothing else -- and the promotions table is what records that
      // a note ever got there, since the note's own row no longer does.
      clauses.push(`(n.tier = 'promoted' OR (n.tier IN ('retired', 'deleted') AND EXISTS (
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
      // Redacted too. A caller that asks for one note gets its whole history, and a read-time pass that
      // covered only the current revision would leak the secret through an older one.
      .map((r) => ({ revision: r.revision, note: this.project(JSON.parse(r.note_json) as Note), createdAt: r.created_at }))
      // And blanked, for a deleted note, for the same reason in a different direction. `transition()`
      // empties the tombstone revision, but the revisions before it are immutable and still carry the
      // text -- so without this pass a caller could delete a note for "secret in the claim" and then
      // read the secret straight back out of the history on the same route. Scrubbing here rather than
      // rewriting the rows keeps section 11.3's immutability promise: what is stored does not change,
      // what is served does.
      //
      // Retired notes are deliberately NOT scrubbed. Section 12 distinguishes them precisely because a
      // reader may want to know what Mercury believed before the decision; a deleted note is the case
      // where the answer is no longer supposed to be available.
      .map((r) => (note.tier === 'deleted' && r.note.tier !== 'deleted' ? { ...r, note: scrubbed(r.note) } : r));
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
    return this.project({ ...note, corroboration: this.corroboration(row.note_id), contested: this.isContested(row.note_id) });
  }

  /**
   * The read projection: redact, then hand the note to a caller (section 11.5).
   *
   * Every read path in this file goes through here -- the feed, bootstrap, and getNote -- so this is the
   * one place a read can be made safe rather than three places someone has to remember.
   *
   * The write path already rejected a note whose text still matched a declared secret, so why redact
   * again? Because `ATLAS_SECRETS` can GROW. A token that was not declared when the note landed is just
   * text in the database until it is declared, and a note outlives every workspace that produced it and
   * is replicated to every host. The write-time pass cannot reach those copies; only a read-time pass
   * can, which is what makes "add the secret to ATLAS_SECRETS" an action that takes effect immediately
   * rather than a backfill job that has to run everywhere.
   *
   * Only `claim` and `detail` are scanned. They are the two free-text fields (section 3); everything
   * else comes from a closed vocabulary or a bounded grammar, and scanning structured fields would
   * spend the read budget on values that cannot contain prose.
   */
  private project(note: Note): Note {
    const claim = this.redactor.redact(note.claim);
    const detail = note.detail === undefined ? undefined : this.redactor.redact(note.detail);
    return claim === note.claim && detail === note.detail ? note : { ...note, claim, detail };
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

  /**
   * Tombstone retired notes older than `olderThanMs` (issue #590).
   *
   * This is what `deleteExpiredRetired()` was trying to be before it was removed rather than wired. That
   * method issued bare DELETEs, and a deletion produces no `seq` row. A replica advances by cursor, so it
   * would never learn the note was gone and would keep serving a note Atlas had destroyed -- permanently,
   * with nothing to reconcile against. That is the divergence issue #555 was written about, and wiring the
   * old method would have created it rather than fixed it.
   *
   * The `deleted` tier is what makes the same retention safe. Every removal here is a revision with a
   * sequence number, so a replica applies it exactly as it applies a retirement: same feed, same cursor,
   * same ordering guarantees.
   *
   * The age is the caller's decision and this method has no default. The sweep reads it from
   * `ATLAS_RETIRED_TOMBSTONE_AGE_MS`, which is UNSET by default, so Atlas still retains retired notes
   * indefinitely unless an operator asks otherwise. Making deletion the default would smuggle a data-loss
   * policy in behind a replication fix, and section 18 open question 6 has not been answered yet.
   */
  tombstoneExpiredRetired(olderThanMs: number): { tombstoned: string[]; failed: { noteId: string; error: string }[] } {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = this.db.prepare(`
      SELECT note_id, project_id FROM notes WHERE tier = 'retired' AND updated_at < ?`)
      .all(cutoff) as unknown as { note_id: string; project_id: string }[];
    const tombstoned: string[] = [];
    const failed: { noteId: string; error: string }[] = [];
    for (const row of rows) {
      try {
        if (this.deleteNote(row.project_id, row.note_id, 'system:retention', 'expired')) tombstoned.push(row.note_id);
      } catch (err) {
        // One bad note must not stop the sweep -- but it must not be SILENT either. Returning the count
        // alone would let a sweep that failed on every single note report `tombstoned: 0`, which is
        // indistinguishable from "nothing was eligible", and the operator would read a broken deletion
        // as an idle cycle. The note id and the error go back to the caller so the log can say which.
        failed.push({ noteId: row.note_id, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      }
    }
    return { tombstoned, failed };
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

  /**
   * Per-project counts, for a reader that wants to know how a project is doing rather than what it says.
   *
   * Section 14 asks for exactly this as the Fleet dashboard's data source, and the deliberate omission is
   * the interesting part: no claim text, no detail, no evidence. A dashboard that shows "4 promoted
   * command notes and 2 contested pairs" needs nothing more, and a reader token that could fetch the
   * claims is a different permission than the one section 12 gives a reader. Fleet is meant to answer
   * "which hosts have gone quiet", not to become a second copy of the knowledge base.
   *
   * Aggregated in SQL rather than by paging the feed: a project with 40k notes would otherwise make the
   * dashboard's load cost proportional to the thing it is measuring.
   */
  summary(projectId: string): ProjectSummary {
    const tierCounts = (this.db.prepare(
      "SELECT tier, COUNT(*) AS n FROM notes WHERE project_id = ? GROUP BY tier",
    ).all(projectId) as unknown as { tier: string; n: number }[]);
    const byTier: Record<string, number> = {};
    for (const r of tierCounts) byTier[r.tier] = Number(r.n);

    const kindCounts = (this.db.prepare(
      "SELECT kind, COUNT(*) AS n FROM notes WHERE project_id = ? AND tier = 'promoted' GROUP BY kind ORDER BY kind",
    ).all(projectId) as unknown as { kind: string; n: number }[]);
    const promotedByKind: Record<string, number> = {};
    for (const r of kindCounts) promotedByKind[r.kind] = Number(r.n);

    // Counted through notes rather than read off the contests table, which has no project column and
    // would otherwise count other projects' disputes.
    const contested = this.db.prepare(
      'SELECT COUNT(*) AS n FROM contests c JOIN notes n ON n.note_id = c.note_id WHERE n.project_id = ?',
    ).get(projectId) as { n: number } | undefined;

    // Last arrival per contributor, from note_sources rather than contributors.last_seen_at: the two
    // differ, and the column the dashboard wants is "when did this host last teach us something", which
    // is a contribution and not a request. A host that polls every minute and contributes nothing would
    // look like a host that is learning.
    const contributors = (this.db.prepare(
      `SELECT s.host_id AS hostId, COUNT(*) AS notes, MAX(s.recorded_at) AS lastArrival
         FROM note_sources s JOIN notes n ON n.note_id = s.note_id
        WHERE n.project_id = ?
        GROUP BY s.host_id
        ORDER BY lastArrival DESC`,
    ).all(projectId) as unknown as { hostId: string; notes: number; lastArrival: string }[]);

    const seqRow = this.db.prepare('SELECT seq FROM project_seq WHERE project_id = ?').get(projectId) as { seq: number } | undefined;

    return {
      projectId,
      byTier,
      promotedByKind,
      contestedPairs: Number(contested?.n ?? 0),
      contributors: contributors.map((c) => ({ hostId: c.hostId, notes: Number(c.notes), lastArrival: c.lastArrival })),
      latestSeq: Number(seqRow?.seq ?? 0),
    };
  }

  lastContributionByHost(): { hostId: string; lastSeenAt: string | null }[] {
    return (this.db.prepare('SELECT host_id, last_seen_at FROM contributors ORDER BY host_id').all() as unknown as { host_id: string; last_seen_at: string | null }[])
      .map((r) => ({ hostId: r.host_id, lastSeenAt: r.last_seen_at }));
  }
}

/**
 * A note with its knowledge removed and its identity left intact.
 *
 * Mirrors the tombstone shape that `transition()` writes, so "deleted" means the same thing on both
 * the row and the read projection: the claim, detail and evidence go, the note id, tier, sequence
 * number, timestamps and actor stay. Knowing that a note existed, when it was written and that it was
 * deleted is audit information. Repeating what it said after being told to forget it is not.
 */
function scrubbed(note: Note): Note {
  return { ...note, claim: '', detail: undefined, evidence: [], contested: false };
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

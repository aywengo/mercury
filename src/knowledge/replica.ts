/**
 * The local replica of Atlas's promoted notes (docs/knowledge-base.md 8.3).
 *
 * The reason this table exists is what Run creation does NOT do: it never makes a network call.
 * Selection reads here, so the worst Atlas outage produces a pack that is a few minutes stale rather
 * than a Run that cannot start. Everything below follows from making that safe.
 */

import type { DatabaseSync } from 'node:sqlite';
import { tx } from '../db/database.ts';
import { claimHash } from './validation.ts';
import { NOTE_SOURCES, type Note, type NoteKind, type NoteSource, type NoteTier } from './types.ts';

export interface ReplicaRow {
  noteId: string;
  projectId: string;
  kind: NoteKind;
  scope: string;
  claim: string;
  detail: string;
  tier: NoteTier;
  seq: number;
  revision: number;
  evidence: Note['evidence'];
  corroboration: { runs: number; harnesses: number; hosts: number };
  claimHash: string;
  recordedAt: string;
  contested: boolean;
  /**
   * Where the note came from, as Atlas reported it. Null for a row written before migration v11, which
   * stored no provenance at all. Callers must not substitute a plausible value: the whole of #553 is that
   * a fabricated `agent-reported` understated trust for operator and repo-record notes.
   */
  source: NoteSource | null;
  hostId: string | null;
}

export interface ApplyResult {
  applied: number;
  retired: number;
  /** Rows skipped because the replica already holds an equal or newer revision of them. */
  skipped: number;
  cursor: number;
}

interface DbRow {
  note_id: string; project_id: string; kind: string; scope: string; claim: string; detail: string;
  tier: string; seq: number; revision: number; evidence_json: string; corr_runs: number;
  corr_harnesses: number; corr_hosts: number; claim_hash: string; recorded_at: string;
  contested: number; source: string; host_id: string;
}

function toRow(n: Note): DbRow {
  return {
    note_id: n.noteId, project_id: n.projectId, kind: n.kind, scope: n.scope, claim: n.claim,
    detail: n.detail ?? '', tier: n.tier, seq: n.seq, revision: n.revision,
    evidence_json: JSON.stringify(n.evidence ?? []),
    corr_runs: n.corroboration?.runs ?? 0, corr_harnesses: n.corroboration?.harnesses ?? 0,
    corr_hosts: n.corroboration?.hosts ?? 0,
    claim_hash: '', recorded_at: n.provenance?.recordedAt ?? '', contested: n.contested ? 1 : 0,
    // Carried, not inferred. Recorded empty rather than defaulted when absent, because the reader
    // distinguishes "no provenance was stored" from a source that happens to look like the default.
    source: n.provenance?.source ?? '', host_id: n.provenance?.hostId ?? '',
  };
}

export class ReplicaStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Null when this host has never completed a pull, which is what selects bootstrap over paging. */
  getCursor(projectId: string): number | null {
    const row = this.db.prepare('SELECT seq FROM knowledge_replica_cursor WHERE project_id = ?')
      .get(projectId) as { seq: number } | undefined;
    return row ? Number(row.seq) : null;
  }

  /**
   * Apply one page and advance the cursor, in ONE transaction.
   *
   * The cursor lives inside the transaction rather than after it, and that ordering is the whole
   * design: commit the notes then crash, and the next pull re-applies them (upsert, so harmless);
   * advance the cursor then crash, and the notes are gone from the replica forever while every later
   * pull starts past them. Only "notes committed, cursor not" is a recoverable state, so it is the
   * only one the code can produce.
   */
  applyBatch(projectId: string, notes: Note[], nextSeq: number, appliedAt: string): ApplyResult {
    const result: ApplyResult = { applied: 0, retired: 0, skipped: 0, cursor: this.getCursor(projectId) ?? 0 };
    if (notes.length === 0) {
      // Still advance: a page can be empty because everything between the old cursor and nextSeq was
      // a transition this replica does not carry, and re-asking for it every tick would spin.
      //
      // Wrapped in tx() even though a single statement is already atomic, so the invariant stated at the
      // top of this method -- the cursor only ever moves inside a transaction -- has no exception to
      // remember. A reader should not have to prove that the one branch which breaks the rule is safe.
      tx(this.db, () => {
        if (nextSeq > result.cursor) {
          this.setCursor(projectId, nextSeq, appliedAt);
          result.cursor = nextSeq;
        }
      });
      return result;
    }
    // Sort defensively. The cursor is a single high-water mark, so applying out of order would let a
    // later row be overwritten by an earlier one and the cursor then skip past the correction.
    const ordered = [...notes].sort((a, b) => a.seq - b.seq || a.noteId.localeCompare(b.noteId));
    tx(this.db, () => {
      const insert = this.db.prepare(`
        INSERT INTO knowledge_replica (
          note_id, project_id, kind, scope, claim, detail, tier, seq, revision, evidence_json,
          corr_runs, corr_harnesses, corr_hosts, claim_hash, recorded_at, updated_at, contested,
          source, host_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(note_id) DO UPDATE SET
          kind = excluded.kind, scope = excluded.scope, claim = excluded.claim, detail = excluded.detail,
          tier = excluded.tier, seq = excluded.seq, revision = excluded.revision,
          evidence_json = excluded.evidence_json, corr_runs = excluded.corr_runs,
          corr_harnesses = excluded.corr_harnesses, corr_hosts = excluded.corr_hosts,
          recorded_at = excluded.recorded_at, updated_at = excluded.updated_at,
          contested = excluded.contested,
          -- Included in the update as well as the insert. A row written before v11 has an empty source,
          -- and the cursor reset makes the puller re-send it; if the ON CONFLICT arm left source alone,
          -- the correction would arrive and be dropped, leaving the row permanently unknown.
          source = excluded.source, host_id = excluded.host_id
        WHERE excluded.seq >= knowledge_replica.seq
      `);
      for (const note of ordered) {
        const row = toRow(note);
        // Computed here rather than carried: Atlas's feed does not send a hash, and the host's own
        // normalization is the one an operator greps for when they ask "why is this note separate".
        row.claim_hash = claimHash(note.kind, note.scope, note.claim);
        const before = this.db.prepare('SELECT seq FROM knowledge_replica WHERE note_id = ?')
          .get(note.noteId) as { seq: number } | undefined;
        // A replayed page must not roll a note back to an older revision. The guard is in the UPDATE
        // too, so this is for the count rather than for correctness.
        if (before && Number(before.seq) > note.seq) { result.skipped += 1; continue; }
        insert.run(
          row.note_id, row.project_id, row.kind, row.scope, row.claim, row.detail, row.tier, row.seq,
          row.revision, row.evidence_json, row.corr_runs, row.corr_harnesses, row.corr_hosts,
          row.claim_hash, row.recorded_at, appliedAt, row.contested, row.source, row.host_id,
        );
        result.applied += 1;
        if (note.tier !== 'promoted') result.retired += 1;
      }
      if (nextSeq > result.cursor) {
        this.setCursor(projectId, nextSeq, appliedAt);
        result.cursor = nextSeq;
      }
    });
    return result;
  }

  private setCursor(projectId: string, seq: number, appliedAt: string): void {
    this.db.prepare(`
      INSERT INTO knowledge_replica_cursor (project_id, seq, updated_at) VALUES (?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at
    `).run(projectId, seq, appliedAt);
  }

  /** Every promoted note for a project, in Atlas's arrival order. Selection re-orders this. */
  promoted(projectId: string): ReplicaRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM knowledge_replica WHERE project_id = ? AND tier = 'promoted' ORDER BY seq DESC",
    ).all(projectId) as unknown as DbRow[];
    return rows.map(fromRow);
  }

  count(projectId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM knowledge_replica WHERE project_id = ? AND tier = 'promoted'")
      .get(projectId) as { n: number };
    return Number(row.n);
  }

  /** Highest seq present in the replica, for the metrics gauge. Null when the replica is empty. */
  maxSeq(projectId: string): number | null {
    const row = this.db.prepare('SELECT MAX(seq) AS s FROM knowledge_replica WHERE project_id = ?')
      .get(projectId) as { s: number | null };
    return row?.s === null || row?.s === undefined ? null : Number(row.s);
  }

  /** Drop everything for a project. Used when a host is rebound to a different Atlas project. */
  clear(projectId: string): number {
    const res = this.db.prepare('DELETE FROM knowledge_replica WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM knowledge_replica_cursor WHERE project_id = ?').run(projectId);
    return Number(res.changes);
  }
}

function fromRow(r: DbRow): ReplicaRow {
  let evidence: Note['evidence'] = [];
  try {
    const parsed = JSON.parse(r.evidence_json) as Note['evidence'];
    if (Array.isArray(parsed)) evidence = parsed;
  } catch {
    // A corrupt evidence blob must not hide a note the rest of the row describes. An empty list is
    // the honest reading of "we cannot show you why", and the claim still reaches the pack.
    evidence = [];
  }
  return {
    noteId: r.note_id, projectId: r.project_id, kind: r.kind as NoteKind, scope: r.scope,
    claim: r.claim, detail: r.detail, tier: r.tier as NoteTier, seq: Number(r.seq),
    revision: Number(r.revision), evidence,
    corroboration: { runs: Number(r.corr_runs), harnesses: Number(r.corr_harnesses), hosts: Number(r.corr_hosts) },
    claimHash: r.claim_hash, recordedAt: r.recorded_at, contested: r.contested === 1,
    // Empty string is the pre-v11 marker, not a source name. Read as null so no caller can mistake it
    // for a value that came from Atlas.
    source: NOTE_SOURCES.includes(r.source as NoteSource) ? (r.source as NoteSource) : null,
    hostId: r.host_id === '' ? null : r.host_id,
  };
}

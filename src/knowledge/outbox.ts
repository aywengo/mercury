/**
 * The host-local outbox (docs/knowledge-base.md section 8.1).
 *
 * The outbox is what makes K4 true rather than aspirational on the write side: a Run's notes are
 * durable in the same SQLite transaction that finalizes the Run, so there is no window in which a
 * Run is complete and its notes exist only in memory. If that transaction does not commit, neither
 * does the terminal state, and the Run is finalized again -- which is why inserting here takes no
 * transaction of its own when called from the finalize path.
 */

import type { DatabaseSync } from 'node:sqlite';
import { tx } from '../db/database.ts';
import { claimHash } from './validation.ts';
import type { NoteContribution } from './types.ts';

export interface OutboxRow {
  id: number;
  runId: string | null;
  idempotencyKey: string;
  contribution: NoteContribution;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

/** Keys for `knowledge_sync_state`. Written by the pusher and the puller, read by the status route. */
/**
 * Increment a counter held in `knowledge_sync_state`.
 *
 * Shared by both synchronization directions on purpose. A counter lives in the database rather than in
 * process memory because the API process serves `/metrics` and the worker is the one that pushes and
 * pulls; a per-process counter would report zero to the process an operator actually queries.
 */
export function bumpCounter(
  store: { getState(key: string): string | null; setState(key: string, value: string): void },
  key: string,
): void {
  const current = Number(store.getState(key) ?? '0');
  store.setState(key, String((Number.isFinite(current) ? current : 0) + 1));
}

export const SYNC_KEYS = {
  lastPushAt: 'last_push_at',
  lastPushError: 'last_push_error',
  lastPullAt: 'last_pull_at',
  lastPullError: 'last_pull_error',
} as const;

interface OutboxDbRow {
  id: number;
  run_id: string | null;
  idempotency_key: string;
  note_json: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
}

/**
 * The idempotency key: `(runId, claimHash)`, derived rather than random.
 *
 * Random would work as a dedup key for one delivery attempt and fail for the case that matters. A
 * batch Atlas applied but whose acknowledgement was lost is re-sent with the SAME key on the next
 * pass, so Atlas answers `duplicate` and the note gains no corroboration. A random key would make
 * that ordinary retry look like a second Run independently reaching the same conclusion, which is
 * the one number section 12 promotes notes on.
 */
export function idempotencyKey(runId: string | null, c: NoteContribution): string {
  // A Run-scoped row keys on the Run. A runless row keys on its ingest source: `operator:` for an
  // operator note and `index:` for a runless `repo-record` row (the `knowledge index` command).
  // Collapsing both to one prefix would make an indexed record and an operator note with the same
  // claim deduplicate against each other in the outbox — they are different acts (a git-reviewed
  // decision and a human assertion), and silently dropping the second is the exact failure the key
  // exists to prevent. The key is also Atlas's per-contributor dedup key, so the prefix must be
  // readable rather than empty.
  const prefix = runId ?? (c.provenance.source === 'repo-record' ? 'index' : 'operator');
  return `${prefix}:${claimHash(c.kind, c.scope, c.claim)}`;
}

export class OutboxStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Queue contributions inside the caller's transaction.
   *
   * Deliberately does not open a transaction of its own, so the caller's atomicity is what governs.
   *
   * Nesting `tx()` would in fact be safe here: `tx()` in `src/db/database.ts` keeps a per-database depth
   * counter and joins an open transaction instead of issuing a second `BEGIN`. This comment previously said
   * nesting "would either throw or silently commit the Run's terminal state early", which is true of raw
   * SQLite and false of `tx()`.
   *
   * The method still exists because the call site should say what it depends on. The finalize path needs the
   * outbox rows and the Run's terminal state to commit together (section 8.1); calling `insertInTx` from
   * inside that transaction states the dependency, whereas calling the self-transacting `insert()` works
   * only because of a depth counter a reader would have to go and find.
   *
   * Do NOT assume the same of `tx()` in `atlas/db.ts`. That one has no depth counter and issues `BEGIN
   * IMMEDIATE` unconditionally, so a nested call there really does throw.
   */
  insertInTx(items: ReadonlyArray<{ runId: string | null; contribution: NoteContribution }>): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO knowledge_outbox (run_id, idempotency_key, note_json, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
    );
    let inserted = 0;
    for (const item of items) {
      const key = idempotencyKey(item.runId, item.contribution);
      const info = stmt.run(item.runId, key, JSON.stringify(item.contribution), now);
      if (info.changes > 0) inserted += 1;
    }
    return inserted;
  }

  /** Queue contributions in their own transaction. For the operator paths, which have no Run. */
  insert(items: ReadonlyArray<{ runId: string | null; contribution: NoteContribution }>): number {
    if (items.length === 0) return 0;
    let inserted = 0;
    tx(this.db, () => { inserted = this.insertInTx(items); });
    return inserted;
  }

  /** Up to `limit` rows in insertion order (section 8.2: batches are taken in insertion order). */
  takeBatch(limit: number): OutboxRow[] {
    const rows = this.db
      .prepare('SELECT * FROM knowledge_outbox ORDER BY id ASC LIMIT ?')
      .all(limit) as unknown as OutboxDbRow[];
    return rows.map(toRow);
  }

  /**
   * Drop rows Atlas answered `accepted` or `duplicate` for.
   *
   * Only ever called with the ids actually sent, and only with a per-item answer. A transport
   * failure deletes nothing (section 8.2), which is why this takes ids rather than a count.
   */
  remove(ids: readonly number[]): void {
    if (ids.length === 0) return;
    tx(this.db, () => {
      const del = this.db.prepare('DELETE FROM knowledge_outbox WHERE id = ?');
      for (const id of ids) del.run(id);
    });
  }

  /** Record a failed delivery: bump attempts, keep the row, remember why. */
  markFailure(ids: readonly number[], error: string): void {
    if (ids.length === 0) return;
    tx(this.db, () => {
      const upd = this.db.prepare('UPDATE knowledge_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?');
      for (const id of ids) upd.run(error.slice(0, 2000), id);
    });
  }

  depth(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM knowledge_outbox').get() as { c: number }).c;
  }

  /** The oldest row, for the status route. An outbox that is deep AND old is a different problem
   *  from one that is deep and draining, and the operator needs to tell them apart. */
  oldest(): { id: number; createdAt: string; attempts: number; lastError: string | null } | null {
    const row = this.db
      .prepare('SELECT id, created_at, attempts, last_error FROM knowledge_outbox ORDER BY id ASC LIMIT 1')
      .get() as unknown as { id: number; created_at: string; attempts: number; last_error: string | null } | undefined;
    if (!row) return null;
    return { id: row.id, createdAt: row.created_at, attempts: row.attempts, lastError: row.last_error };
  }

  setState(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO knowledge_sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, new Date().toISOString());
  }

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM knowledge_sync_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
}

function toRow(r: OutboxDbRow): OutboxRow {
  // A row that will not parse is a bug or corruption, not a data condition to tolerate: dropping it
  // silently would mean a note vanished with no metric and no log. It throws, the batch is not sent,
  // and the outbox depth alert is what an operator sees.
  return {
    id: r.id,
    runId: r.run_id,
    idempotencyKey: r.idempotency_key,
    contribution: JSON.parse(r.note_json) as NoteContribution,
    createdAt: r.created_at,
    attempts: r.attempts,
    lastError: r.last_error,
  };
}

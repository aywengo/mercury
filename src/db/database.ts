// SQLite persistence via node:sqlite (built-in, no native deps).
// Migrations are applied idempotently at startup (Mercury.md section 31, Persistence).

import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS: string[] = [
  // v1: initial schema
  `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    task TEXT NOT NULL,
    repository_json TEXT NOT NULL,
    workspace_branch TEXT,
    workspace_path TEXT,
    agent TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    retry_of TEXT,
    error TEXT,
    error_kind TEXT,
    constraints_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    cancellation_requested_at TEXT,
    final_commits_json TEXT NOT NULL DEFAULT '[]',
    pr_url TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  CREATE INDEX IF NOT EXISTS idx_runs_owner_created ON runs(owner_id, created_at);

  CREATE TABLE IF NOT EXISTS run_skills (
    run_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    skill_version TEXT NOT NULL,
    skill_hash TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    PRIMARY KEY (run_id, skill_id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE (run_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, sequence);

  CREATE TABLE IF NOT EXISTS run_inputs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    input_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_run_inputs_run ON run_inputs(run_id, created_at);

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // v2: multi-repository runs (roadmap #6). repositories_json is nullable for
  // backward compatibility with rows created before this migration.
  `
  ALTER TABLE runs ADD COLUMN repositories_json TEXT;
  `,
  // v3: owner-scoped idempotency keys (issue #8). The key alone was global, so
  // one user could retrieve another user's run by reusing their key. Rebuild the
  // table with PRIMARY KEY (owner, key); pre-existing rows are backfilled from
  // runs.owner_id so the real owner keeps idempotency across the migration
  // (rows whose run is missing fall back to 'unknown').
  `
  CREATE TABLE idempotency_keys_v3 (
    owner TEXT NOT NULL,
    key TEXT NOT NULL,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner, key)
  );
  INSERT INTO idempotency_keys_v3 (owner, key, run_id, created_at)
    SELECT COALESCE(r.owner_id, 'unknown'), ik.key, ik.run_id, ik.created_at
    FROM idempotency_keys ik LEFT JOIN runs r ON r.id = ik.run_id;
  DROP TABLE idempotency_keys;
  ALTER TABLE idempotency_keys_v3 RENAME TO idempotency_keys;
  `,
  // v4: index on events.type, for the /metrics sandbox-enablement count (issue #131).
  //
  // events is the largest table (every run appends many rows) and it had only
  // idx_events_run_seq, keyed on (run_id, sequence) and therefore useless for a predicate on
  // type alone. The sandbox count was a full scan of every event ever recorded -- tolerable in
  // a one-off query, not on an endpoint a scraper hits every 15 seconds.
  //
  // type is low-cardinality, which normally argues against an index, but that argument is about
  // selectivity for a LARGE MATCHING SET. The value being counted here is rare, so the seek is
  // the win. (run_id) is included so the index also covers the COUNT(DISTINCT run_id) and the
  // count never touches the events table itself.
  `
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, run_id);
  `,
  // v5: cluster-wide alert dedupe (issue #142).
  //
  // Both alert paths measure a CLUSTER-GLOBAL quantity and deduped with a per-process variable, so
  // an N-worker deployment sent N copies of one alert. That is how alerting gets muted and then
  // ignored. The dedupe has to live where the workers share it, which is this database.
  //
  // One row per alert key, holding who last claimed the right to send and when.
  `
  CREATE TABLE IF NOT EXISTS alert_claims (
    key TEXT PRIMARY KEY,
    claimed_at TEXT NOT NULL,
    worker_id TEXT NOT NULL
  );
  `,
  // v6: run goals (docs/goals.md section 5).
  //
  // One row per Run, updated in place. The event stream is already the history, so a second
  // append-only copy of the same facts would just be a second source of truth to fall out of
  // agreement with the first.
  //
  // `time_used_seconds`, deliberately NOT `time_used_ms`: the harness reports seconds
  // (PrimeAgent's goalState.time_used_seconds), and a column named _ms holding seconds is a
  // unit bug waiting to be discovered at the worst possible moment.
  //
  // `status` is NOT derived from runs.status and runs.status is never derived from it. A Run
  // that COMPLETED with the goal still active is the case this table exists to make visible.
  `
  CREATE TABLE IF NOT EXISTS run_goals (
    run_id              TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    objective           TEXT NOT NULL,
    contract_json       TEXT,
    gates_json          TEXT,
    token_budget        INTEGER,
    status              TEXT NOT NULL,
    tokens_used         INTEGER,
    time_used_seconds   INTEGER,
    turns_used          INTEGER,
    last_verdict        TEXT,
    last_reason         TEXT,
    last_error          TEXT,
    paused_reason       TEXT,
    source              TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_run_goals_status ON run_goals(status);
  `,
];

export const BUSY_TIMEOUT_MS = 5_000;

/** Synchronous pause, used only for startup contention before any connection is serving traffic. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True for the two "someone else holds the lock" results, primary code is the low byte. */
function isBusy(err: unknown): boolean {
  const code = (err as { errcode?: number })?.errcode;
  if (typeof code !== 'number') return false;
  const primary = code & 0xff;
  return primary === 5 /* SQLITE_BUSY */ || primary === 6 /* SQLITE_LOCKED */;
}

/**
 * Put the database in WAL mode, retrying the one case SQLite refuses to wait for.
 *
 * `PRAGMA busy_timeout` does NOT cover the journal-mode conversion. Upgrading a database that is
 * still in rollback-journal mode requires an exclusive lock, and SQLite answers SQLITE_BUSY
 * immediately rather than consulting the busy handler for it. So on a brand-new file, N processes
 * that start together all attempt the same conversion and all but one die at startup with
 * 'database is locked' -- which is exactly the API-plus-workers startup shape (issue #284).
 *
 * Retrying converges: once the winner has committed the file is WAL, and the pragma is then a
 * no-op that takes no lock at all.
 */
function enableWal(db: DatabaseSync): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      return;
    } catch (err) {
      if (!isBusy(err) || Date.now() >= deadline) throw err;
      sleepSync(10);
    }
  }
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // Concurrent API + worker processes share the DB file (WAL). Without a busy
  // timeout (default 0), a writer that hits an in-flight tx from the other
  // process fails immediately with SQLITE_BUSY ('database is locked') instead
  // of waiting for the lock (issue #38).
  //
  // Set before anything that can contend for the write lock. It does NOT cover the WAL conversion
  // on the next line -- SQLite answers that one without consulting the busy handler at all, which
  // is why enableWal() exists.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  enableWal(db);
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  // Fast path: an up-to-date database takes no write lock at all. This matters. The API and every
  // worker call openDatabase() on a schema that is already current, and wrapping the whole check in
  // BEGIN IMMEDIATE made each of those startup paths contend for the exclusive lock -- which then
  // blocked behind any in-flight write transaction. Only the rare first-open case needs the lock.
  if (pendingMigrations(db).length === 0) return;
  // The slow path re-reads under the write lock rather than trusting the scan above.
  //
  // That scan is the whole bug. It used to be the only read: two processes opening a fresh
  // database together both saw an empty `schema_migrations`, both decided to apply everything, and
  // busy_timeout made the loser WAIT for the winner to commit and then replay migrations that had
  // already run. Replay is not a no-op -- v2 is `ALTER TABLE runs ADD COLUMN` and v3 recreates the
  // idempotency table -- so the loser died with `UNIQUE constraint failed: schema_migrations.version`
  // and never started. Making the INSERT idempotent would not help either, because the DDL is what
  // collides. Re-checking inside BEGIN IMMEDIATE is what makes the loser observe the winner's work
  // instead of repeating it (issue #284).
  tx(db, () => {
    for (const version of pendingMigrations(db)) {
      db.exec(MIGRATIONS[version - 1]);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    }
  });
}

/** Migration versions not yet recorded as applied, in ascending order. */
function pendingMigrations(db: DatabaseSync): number[] {
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const pending: number[] = [];
  for (let version = 1; version <= MIGRATIONS.length; version++) {
    if (!applied.has(version)) pending.push(version);
  }
  return pending;
}

const txDepths = new WeakMap<DatabaseSync, number>();

/** Reentrant transaction helper: nested tx() calls join the outer transaction. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  const depth = txDepths.get(db) ?? 0;
  if (depth > 0) {
    txDepths.set(db, depth + 1);
    try {
      return fn();
    } finally {
      txDepths.set(db, depth);
    }
  }
  // IMMEDIATE, not deferred (issue #49). A deferred BEGIN takes the write lock
  // lazily, so a transaction that reads and then writes -- which is every
  // EventStore.append, since it reads MAX(sequence) before inserting -- has to
  // UPGRADE its read lock to a write lock. SQLite returns SQLITE_BUSY immediately
  // on that upgrade instead of honouring PRAGMA busy_timeout, so a competing
  // writer makes the append throw in ~0ms despite the 5s timeout configured at
  // openDatabase(). BEGIN IMMEDIATE takes the write lock up front, so the same
  // contention waits (and succeeds) instead of failing.
  db.exec('BEGIN IMMEDIATE');
  txDepths.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepths.set(db, 0);
  }
}

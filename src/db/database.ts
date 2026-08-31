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
];

export const BUSY_TIMEOUT_MS = 5_000;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Concurrent API + worker processes share the DB file (WAL). Without a busy
  // timeout (default 0), a writer that hits an in-flight tx from the other
  // process fails immediately with SQLITE_BUSY ('database is locked') instead
  // of waiting for the lock (issue #38).
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    if (applied.has(version)) continue;
    tx(db, () => {
      db.exec(MIGRATIONS[i]);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    });
  }
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

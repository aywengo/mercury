import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, MIGRATIONS } from '../src/db/database.ts';

test('migration v3: idempotency keys become owner-scoped with backfill (issue #8)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-migrate-v3-'));
  const dbPath = join(dir, 'test.db');
  try {
    // Seed a pre-v3 database: v1 + v2 applied, runs + global idempotency keys.
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(MIGRATIONS[0]);
    db.exec(MIGRATIONS[1]);
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(now);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(now);
    db.prepare(`INSERT INTO runs (id, owner_id, task, repository_json, agent, status, attempt, retry_of, error, error_kind,
      constraints_json, created_at, started_at, completed_at, lease_owner, lease_expires_at,
      cancellation_requested_at, final_commits_json, pr_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('run-alice', 'alice', 'x', '{}', 'fake', 'QUEUED', 1, null, null, null, '{}', now, null, null, null, null, null, '[]', null);
    db.prepare(`INSERT INTO runs (id, owner_id, task, repository_json, agent, status, attempt, retry_of, error, error_kind,
      constraints_json, created_at, started_at, completed_at, lease_owner, lease_expires_at,
      cancellation_requested_at, final_commits_json, pr_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('run-orphan', 'bob', 'x', '{}', 'fake', 'QUEUED', 1, null, null, null, '{}', now, null, null, null, null, null, '[]', null);
    db.prepare('INSERT INTO idempotency_keys (key, run_id, created_at) VALUES (?, ?, ?)').run('k-alice', 'run-alice', now);
    db.prepare('INSERT INTO idempotency_keys (key, run_id, created_at) VALUES (?, ?, ?)').run('k-orphan', 'run-orphan', now);
    db.close();

    // Open with current code: v3 applies, backfills owner from runs.owner_id.
    const db2 = openDatabase(dbPath);
    const versions = db2.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
    assert.deepEqual(versions.map((v) => v.version), [1, 2, 3]);
    const rows = db2.prepare('SELECT owner, key, run_id FROM idempotency_keys ORDER BY key').all() as {
      owner: string; key: string; run_id: string;
    }[];
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { owner: 'alice', key: 'k-alice', run_id: 'run-alice' },
      { owner: 'bob', key: 'k-orphan', run_id: 'run-orphan' },
    ]);
    // PK is (owner, key): same key under different owners is allowed, dup (owner,key) is not.
    db2.prepare('INSERT INTO idempotency_keys (owner, key, run_id, created_at) VALUES (?, ?, ?, ?)')
      .run('carol', 'k-alice', 'run-alice', now);
    assert.throws(() => {
      db2.prepare('INSERT INTO idempotency_keys (owner, key, run_id, created_at) VALUES (?, ?, ?, ?)')
        .run('alice', 'k-alice', 'run-alice', now);
    }, /UNIQUE/);
    // Reopening is a no-op (idempotent).
    const db3 = openDatabase(dbPath);
    const versions2 = db3.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
    assert.deepEqual(versions2.map((v) => v.version), [1, 2, 3]);
    db2.close();
    db3.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

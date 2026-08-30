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

test('openDatabase sets a busy_timeout (issue #38)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-busy-'));
  const dbPath = join(dir, 'test.db');
  try {
    const db = openDatabase(dbPath);
    const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    assert.ok(row.timeout > 0, `expected busy_timeout > 0, got ${row.timeout}`);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent writer waits for the lock instead of failing with SQLITE_BUSY (issue #38)', async () => {
  const { Worker } = await import('node:worker_threads');
  const dir = mkdtempSync(join(tmpdir(), 'mercury-busy2-'));
  const dbPath = join(dir, 'test.db');
  try {
    const db1 = openDatabase(dbPath);
    const iso = new Date().toISOString();
    db1.exec('BEGIN IMMEDIATE');
    db1.prepare('INSERT INTO runs (id, owner_id, task, repository_json, agent, status, attempt, constraints_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('r1', 'alice', 'x', '{}', 'fake', 'QUEUED', 0, '{}', iso);
    // db2 (separate connection, separate thread) writes while db1 holds the lock;
    // busy_timeout must make it wait, not fail immediately with SQLITE_BUSY.
    const workerSrc = `
      import { parentPort, workerData } from 'node:worker_threads';
      import { openDatabase } from ${JSON.stringify(new URL('../src/db/database.ts', import.meta.url).href)};
      const db = openDatabase(workerData.path);
      try {
        db.prepare('INSERT INTO runs (id, owner_id, task, repository_json, agent, status, attempt, constraints_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run('r2', 'alice', 'x', '{}', 'fake', 'QUEUED', 0, '{}', workerData.iso);
        parentPort.postMessage({ ok: true });
      } catch (e) {
        parentPort.postMessage({ ok: false, err: String(e instanceof Error ? e.message : e) });
      }
      db.close();
    `;
    const worker = new Worker(new URL(`data:text/javascript;base64,${Buffer.from(workerSrc).toString('base64')}`), {
      workerData: { path: dbPath, iso },
    });
    const started = Date.now();
    // release the lock shortly after the worker starts waiting
    const release = setTimeout(() => db1.exec('COMMIT'), 500);
    const result = await new Promise<{ ok: boolean; err?: string }>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    clearTimeout(release);
    const elapsed = Date.now() - started;
    assert.ok(result.ok, `db2 write failed: ${result.err}`);
    const r2 = db1.prepare('SELECT id FROM runs WHERE id = ?').get('r2') as { id: string };
    assert.equal(r2.id, 'r2', 'second writer committed after the lock was released');
    assert.ok(elapsed >= 400, `waited ${elapsed}ms (expected to block on the lock)`);
    assert.ok(elapsed < 5_000, `waited ${elapsed}ms (busy_timeout should cap the wait)`);
    db1.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

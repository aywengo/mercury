import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, MIGRATIONS, BUSY_TIMEOUT_MS } from '../src/db/database.ts';
import { tempDir } from './helpers.ts';

test('migration v3: idempotency keys become owner-scoped with backfill (issue #8)', () => {
  const dir = tempDir('mercury-migrate-v3-');
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
  const dir = tempDir('mercury-busy-');
  const dbPath = join(dir, 'test.db');
  try {
    const db = openDatabase(dbPath);
    const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    assert.equal(row.timeout, BUSY_TIMEOUT_MS, 'busy_timeout must match BUSY_TIMEOUT_MS');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent writer waits for the lock instead of failing with SQLITE_BUSY (issue #38)', async () => {
  const { Worker } = await import('node:worker_threads');
  const dir = tempDir('mercury-busy2-');
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
    // release the lock shortly after the worker starts waiting (500ms << BUSY_TIMEOUT_MS)
    const releaseMs = 500;
    const release = setTimeout(() => db1.exec('COMMIT'), releaseMs);
    const result = await new Promise<{ ok: boolean; err?: string }>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    clearTimeout(release);
    const elapsed = Date.now() - started;
    assert.ok(result.ok, `db2 write failed: ${result.err}`);
    const r2 = db1.prepare('SELECT id FROM runs WHERE id = ?').get('r2') as { id: string };
    assert.equal(r2.id, 'r2', 'second writer committed after the lock was released');
    // The write must have blocked on the lock (not raced past it). Corner: on an
    // extremely slow machine worker startup could exceed releaseMs, making this a
    // no-op proof — observed startup is ~80ms, so the floor still holds in practice.
    assert.ok(elapsed >= releaseMs - 100, `waited ${elapsed}ms (expected to block on the lock)`);
    assert.ok(elapsed < BUSY_TIMEOUT_MS, `waited ${elapsed}ms (busy_timeout should cap the wait)`);
    db1.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read-then-write transaction waits for the lock instead of failing instantly (issue #49)', async () => {
  const { Worker } = await import('node:worker_threads');
  const dir = tempDir('mercury-defer-');
  const dbPath = join(dir, 'test.db');
  try {
    const db1 = openDatabase(dbPath);
    db1.exec('BEGIN IMMEDIATE');
    db1
      .prepare('INSERT INTO events (id, run_id, type, sequence, timestamp, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run('evt_hold', 'r1', 'run.queued', 1, new Date().toISOString(), '{}');
    // The test above writes first, which takes the write lock at the first statement and
    // so does honour busy_timeout even under a deferred BEGIN -- it passes either way and
    // never caught this. EventStore.append is different: it reads MAX(sequence) and then
    // INSERTs. Under a deferred BEGIN the read takes a SHARED lock and the INSERT must
    // UPGRADE it, and SQLite answers that upgrade with SQLITE_BUSY immediately without
    // consulting PRAGMA busy_timeout. So this append used to throw in ~0ms while db1 still
    // held the lock, despite the 5s timeout configured in openDatabase().
    const workerSrc = `
      import { parentPort, workerData } from 'node:worker_threads';
      import { openDatabase } from ${JSON.stringify(new URL('../src/db/database.ts', import.meta.url).href)};
      import { EventStore } from ${JSON.stringify(new URL('../src/events/eventStore.ts', import.meta.url).href)};
      const db = openDatabase(workerData.path);
      try {
        const ev = new EventStore(db).append('r1', 'agent.message', { n: 1 });
        parentPort.postMessage({ ok: true, sequence: ev.sequence });
      } catch (e) {
        parentPort.postMessage({ ok: false, err: String(e instanceof Error ? e.message : e) });
      }
      db.close();
    `;
    const worker = new Worker(new URL(`data:text/javascript;base64,${Buffer.from(workerSrc).toString('base64')}`), {
      workerData: { path: dbPath },
    });
    const started = Date.now();
    const releaseMs = 500;
    // Idempotent release driven from a finally block (Copilot on #90). Without it, a
    // worker rejection or a failing assertion leaves db1 holding an open write
    // transaction, so the failure path leaks a locked database into everything that
    // follows instead of reporting one failure.
    let lockOpen = true;
    const unlock = () => {
      if (!lockOpen) return;
      lockOpen = false;
      try {
        db1.exec('COMMIT');
      } catch {
        // transaction already finished; nothing to release
      }
    };
    const release = setTimeout(unlock, releaseMs);
    try {
      const result = await new Promise<{ ok: boolean; sequence?: number; err?: string }>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      unlock();
      const elapsed = Date.now() - started;
      assert.ok(result.ok, `append failed while another writer held the lock: ${result.err}`);
      assert.equal(result.sequence, 2, 'sequence assigned after the row held by db1');
      assert.ok(elapsed >= releaseMs - 100, `waited ${elapsed}ms (expected to block on the lock)`);
      assert.ok(elapsed < BUSY_TIMEOUT_MS, `waited ${elapsed}ms (busy_timeout should cap the wait)`);
    } finally {
      clearTimeout(release);
      unlock();
      db1.close();
      await worker.terminate();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

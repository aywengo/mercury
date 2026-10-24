import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, MIGRATIONS, BUSY_TIMEOUT_MS } from '../src/db/database.ts';
import { RunStore } from '../src/runs/runStore.ts';
import { RunQueue } from '../src/queue/runQueue.ts';
import { EventStore } from '../src/events/eventStore.ts';
import { GoalStore } from '../src/runs/goalStore.ts';
import { settleGoalOnTerminal } from '../src/runs/goalSettlement.ts';
import { hasStarted } from '../src/domain/types.ts';
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
    // Assert v3 APPLIED rather than pinning the exact list. This test is about the owner-scoping
    // backfill; an exact [1,2,3] made it fail for every later migration, which is a false alarm
    // about a different migration's correctness.
    assert.deepEqual(versions.map((v) => v.version).slice(0, 3), [1, 2, 3], 'v1..v3 must all be applied');
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
    // Same set as before the reopen: that is what "reopening is a no-op" means.
    assert.deepEqual(versions2.map((v) => v.version), versions.map((v) => v.version), 'reopen must not re-apply anything');
    db2.close();
    db3.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration v20: a row written before the origin columns reads null, not a fabricated origin (issue #988)', () => {
  const dir = tempDir('mercury-migrate-v20-');
  const dbPath = join(dir, 'test.db');
  try {
    // Seed a database as it stood at v19: every migration before v20 applied, and one Run already
    // written. This is the only way to test the acceptance criterion "a pre-migration row reads
    // null" -- a Run created by the CURRENT code cannot be a pre-migration row.
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`);
    const now = new Date().toISOString();
    for (let v = 1; v <= 19; v++) {
      db.exec(MIGRATIONS[v - 1]);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v, now);
    }
    db.prepare(`INSERT INTO runs (id, owner_id, task, repository_json, agent, status, attempt, retry_of, error, error_kind,
      constraints_json, created_at, started_at, completed_at, lease_owner, lease_expires_at,
      cancellation_requested_at, final_commits_json, pr_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('run-pre-v20', 'alice', 'x', '{}', 'fake', 'COMPLETED', 1, null, null, null,
        '{"maxDurationMs":1000,"maxRetries":0}', now, null, now, null, null, null, '[]', null);
    db.close();

    const db2 = openDatabase(dbPath);
    const versions = db2.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
    assert.ok(versions.some((v) => v.version === 20), 'v20 must apply on top of a v19 database');
    // The columns exist and are NULL for the pre-existing row -- additive, no backfill.
    const raw = db2.prepare('SELECT origin_kind, origin_ref FROM runs WHERE id = ?').get('run-pre-v20') as
      { origin_kind: string | null; origin_ref: string | null };
    assert.equal(raw.origin_kind, null);
    assert.equal(raw.origin_ref, null);

    const run = new RunStore(db2).get('run-pre-v20')!;
    assert.equal(run.origin, null, 'an unrecorded origin must read as null, never as a fabricated kind');
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration v21: an active pre-v21 Run keeps its execution evidence across a shutdown requeue (issue #990 review, round 1)', () => {
  // Copilot, PR #998 round 1 (major): the v21 column had no backfill, and `hasStarted` falls back to
  // `started_at`. For a Run that is ALREADY active when the migration applies, that fallback is the
  // only evidence that it ran -- and the shutdown requeue clears `started_at` a moment later, so the
  // evidence is destroyed before anything reads it and the goal still settles as never attempted.
  //
  // So the fallback must be MATERIALISED at migration time, while the value still exists. This test
  // is the whole path: pre-v21 active row -> migration -> shutdown requeue -> cancellation.
  const dir = tempDir('mercury-migrate-v21-');
  const dbPath = join(dir, 'test.db');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`);
    const now = new Date().toISOString();
    for (let v = 1; v <= 20; v++) {
      db.exec(MIGRATIONS[v - 1]);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v, now);
    }
    const insertRun = db.prepare(`INSERT INTO runs (id, owner_id, task, repository_json, agent, status,
      attempt, retry_of, error, error_kind, constraints_json, created_at, started_at, completed_at,
      lease_owner, lease_expires_at, cancellation_requested_at, final_commits_json, pr_url)
      VALUES (?, 'alice', 'x', '{}', 'fake', ?, 1, NULL, NULL, NULL,
        '{"maxDurationMs":1000,"maxRetries":0}', ?, ?, ?, ?, ?, NULL, '[]', NULL)`);
    const T = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
    // Active when the migration runs: the case the finding is about.
    insertRun.run('run-active', 'RUNNING', T(0), T(3), null, 'w1', new Date(Date.now() + 60_000).toISOString());
    // Terminal, never requeued: `started_at` still holds its only execution.
    insertRun.run('run-done', 'COMPLETED', T(0), T(1), T(2), null, null);
    // Never started: the backfill must invent nothing.
    insertRun.run('run-queued-never', 'QUEUED', T(0), null, null, null, null);
    // Ran, then was requeued BEFORE the migration, so `started_at` is already NULL. The only record
    // left is the `run.started` event -- which is exactly why the backfill reads events too.
    insertRun.run('run-requeued', 'QUEUED', T(0), null, null, null, null);
    // Ran with no `run.started` event on record: the second backfill statement's only case, and the
    // reason it is not redundant with the first.
    insertRun.run('run-no-event', 'COMPLETED', T(0), T(2), T(3), null, null);
    const ev = db.prepare(`INSERT INTO events (id, run_id, type, sequence, timestamp, payload_json)
      VALUES (?, ?, 'run.started', 1, ?, ?)`);
    ev.run('e-active', 'run-active', T(3), JSON.stringify({ runId: 'run-active', startedAt: T(3) }));
    ev.run('e-done', 'run-done', T(1), JSON.stringify({ runId: 'run-done', startedAt: T(1) }));
    ev.run('e-requeued', 'run-requeued', T(1), JSON.stringify({ runId: 'run-requeued', startedAt: T(1) }));
    db.exec(`INSERT INTO run_goals (run_id, objective, status, source, updated_at)
      VALUES ('run-active', 'obj', 'active', 'operator', '${now}')`);
    db.close();

    const db2 = openDatabase(dbPath);
    const events = new EventStore(db2);
    const goals = new GoalStore(db2);
    const runs = new RunStore(db2, {
      onTerminalTransition: (run, to) => settleGoalOnTerminal({ goals, events }, run, to),
    });
    const queue = new RunQueue(db2, runs);
    const stamp = (id: string) =>
      (db2.prepare('SELECT first_started_at FROM runs WHERE id = ?').get(id) as { first_started_at: string | null })
        .first_started_at;

    // The backfill restores the fact, from the event first (the exact recorded start) and from
    // `started_at` second (for a row whose event is missing).
    assert.equal(stamp('run-active'), T(3), 'an active pre-v21 Run must keep its execution evidence');
    assert.equal(stamp('run-done'), T(1), 'a terminal pre-v21 Run must keep its execution evidence');
    assert.equal(stamp('run-requeued'), T(1), 'a pre-v21 Run whose only record is the event must keep it too');
    assert.equal(stamp('run-no-event'), T(2), 'and one whose only record is started_at must keep that');
    assert.equal(stamp('run-queued-never'), null, 'the backfill must invent nothing for a Run that never ran');

    // The finding's path: requeue the active Run, then cancel it before anything reclaims it.
    assert.equal(queue.requeueForShutdown('run-active', 'w1'), true);
    const requeued = runs.get('run-active')!;
    assert.equal(requeued.startedAt, null, 'the requeue clears the current execution start');
    assert.equal(hasStarted(requeued), true, 'and must not erase the fact that the attempt ran');
    runs.transition('run-active', 'CANCELLED', { completedAt: new Date().toISOString() });
    assert.equal(goals.get('run-active')?.attempted, true,
      'an active Run requeued by the upgrade and then cancelled was still attempted');
    db2.close();
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

/**
 * Concurrent first-open of a fresh database (issue #284).
 *
 * `openDatabase()` is called by the API process and by every worker process. The migration runner
 * read the applied-version set OUTSIDE any transaction and then applied the missing migrations
 * inside one, so two processes starting against a fresh file both computed "nothing applied yet".
 * The second one did not fail fast: `PRAGMA busy_timeout` made it WAIT for the first to commit,
 * and it then replayed migrations that had already been applied.
 *
 * Replaying them is not a benign no-op. v2 is `ALTER TABLE runs ADD COLUMN` and v3 recreates the
 * idempotency-key table, so the duplicate application surfaces as `UNIQUE constraint failed:
 * schema_migrations.version` (or a duplicate-column error) and the process dies at startup.
 *
 * This is the exact shape the local E2E stack produces -- API and worker containers start together
 * against one empty volume -- and it was found there rather than here.
 */
test('concurrent first-open of a fresh database migrates exactly once (issue #284)', async () => {
  const dir = tempDir('mercury-migrate-race-');
  const dbPath = join(dir, 'race.db');
  const barrier = join(dir, 'barrier');
  mkdirSync(barrier, { recursive: true });

  // 8 contenders, not 4. The window is the few hundred microseconds between reading the applied
  // set and taking the write lock, so the odds of crossing it are a function of how many processes
  // start together. Measured against the pre-fix code: 4 racers caught the bug in 4 of 6 runs,
  // 6 racers in 6 of 6. A regression test that only sometimes catches its regression is not a
  // regression test, so this runs with margin.
  const N = 8;
  const MIGRATOR = join(import.meta.dirname, 'fixtures', 'concurrent-migrator.ts');

  // Spawn first, then let them release each other: a barrier only works if every participant can
  // reach it (see the note in crossProcess.test.ts about spawnSync).
  const children = [];
  for (let i = 0; i < N; i++) {
    children.push(spawn(process.execPath, [MIGRATOR, dbPath, barrier], {
      env: { ...process.env, BARRIER_EXPECT: String(N) },
    }));
  }

  const results = await Promise.all(children.map(async (child, i) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });
    const status = await new Promise<number | null>((resolve) => child.once('close', resolve));
    const line = stdout.trim().split('\n').filter(Boolean).pop();
    if (!line) {
      throw new Error(`migrator ${i} produced no output (status ${status}): ${stderr.slice(0, 500)}`);
    }
    return JSON.parse(line) as { ok: boolean; pid: number; error?: string; applied?: number[] };
  }));

  const failed = results.filter((r) => !r.ok);
  assert.deepEqual(
    failed.map((r) => r.error),
    [],
    `every process must open a fresh database successfully; ${failed.length}/${N} died`,
  );

  // One row per migration, not one per process: the loser must observe the winner's work rather
  // than repeat it.
  const db = openDatabase(dbPath);
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
  db.close();
  assert.equal(rows.length, MIGRATIONS.length, 'schema_migrations must hold exactly one row per migration');
  assert.deepEqual(rows.map((r) => r.version), MIGRATIONS.map((_, i) => i + 1));
});

test('openDatabase creates the data directory it is given (issue #1074)', () => {
  // A host installed with the documented `npm install -g` path has nothing that creates
  // `${XDG_STATE_HOME:-~/.local/state}/mercury`, so both services crash-looped on
  // `unable to open database file`. Opening the database is where that directory belongs.
  const dir = tempDir('mercury-open-db-');
  const dbPath = join(dir, 'state', 'mercury', 'mercury.db');
  try {
    assert.ok(!existsSync(join(dir, 'state')), 'the parent does not exist yet');
    const db = openDatabase(dbPath);
    db.close();
    assert.ok(existsSync(dbPath), 'the database exists where the caller asked for it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

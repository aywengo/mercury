// Start-up sweep of workspaces the worker never finalized (issue #976).
//
// The finalize-time artifact scrub (#944) lives in the worker's execute() finally, which a
// crashed worker never reaches: the run's lease expires, the reaper marks it
// FAILED(LEASE_EXPIRED_ERROR), and the session transcript and kernel snapshots keep their
// secrets on disk until workspace GC. The sweep closes that gap on the next worker start.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, tempDir } from './helpers.ts';
import { LEASE_EXPIRED_ERROR } from '../src/queue/runQueue.ts';

const TOKEN = 'sweep-secret-value-0123456789abcdef';

/**
 * A run that held a lease and then never got finalized: claimed, started, workspace set, and
 * its lease back-dated into the past while "the worker" was dead. Mirrors the production path
 * exactly (claim -> STARTING -> crash -> lease expiry -> reaper), only the crash is
 * instantaneous.
 *
 * Default `reap: true` reaps it BEFORE any worker under test starts, so the run is terminal
 * and the claim loop never sees it. `reap: false` leaves it STARTING with an expired lease so
 * the worker under test's START-UP reap is what fails it -- the ordering the first test pins
 * (review on #976).
 */
function makeReapedRun(
  env: ReturnType<typeof makeEnv>,
  workspacePath: string,
  opts: { reap?: boolean } = {},
): string {
  const { reap = true } = opts;
  const run = env.runService.create({
    ownerId: 'alice',
    task: 'a run whose worker died',
    agent: 'fake',
    repository: { localPath: tempDir('mercury-sweep-repo-') },
  });
  env.queue.claim('crashed-worker', 60_000);
  env.runs.transition(run.id, 'STARTING');
  env.runs.setWorkspace(run.id, 'agent/x', workspacePath);
  // The worker died: its lease is now in the past, so the reaper takes the run.
  env.db.prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), run.id);
  if (reap) {
    const { failed } = env.queue.reapExpiredLeases();
    assert.ok(failed.includes(run.id), 'the reaper must fail the expired run');
    const final = env.runs.get(run.id)!;
    assert.equal(final.status, 'FAILED');
    assert.equal(final.error, LEASE_EXPIRED_ERROR);
  }
  return run.id;
}

function writeTranscript(workspace: string, token: string): string {
  const dir = join(workspace, '.mercury-sessions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'agent.message', text: `using token ${token}` }) + '\n');
  return file;
}

test('a run that expired while every worker was down is failed, redacted and stamped on the FIRST start (issue #976)', async () => {
  const env = makeEnv({
    artifactSecrets: [TOKEN],
    workerEnabled: false,
  });
  try {
    const workspace = tempDir('mercury-sweep-ws-');
    const file = writeTranscript(workspace, TOKEN);
    // STARTING with an expired lease until start(): nothing has reaped it yet. Removing the
    // start-up reap would leave the run not FAILED -- hence not a sweep candidate -- and this
    // test would still pass, so it is the ordering the test exists to pin (review on #976).
    const runId = makeReapedRun(env, workspace, { reap: false });

    // The worker comes back: start() reaps first, then sweeps.
    env.worker.start();

    // The start-up reap failed the run and appended its terminal events.
    const final = env.runs.get(runId)!;
    assert.equal(final.status, 'FAILED');
    assert.equal(final.error, LEASE_EXPIRED_ERROR);
    const eventTypes = (env.db
      .prepare('SELECT type FROM events WHERE run_id = ? ORDER BY sequence')
      .all(runId) as { type: string }[])
      .map((row) => row.type);
    assert.ok(eventTypes.includes('error'), 'the error event is appended by the start-up reap');
    assert.ok(eventTypes.includes('run.failed'), 'the run.failed event is appended by the start-up reap');
    assert.equal(eventTypes[eventTypes.length - 1], 'run.failed', 'run.failed is the run\'s last event');

    // The sweep redacted the workspace and stamped the run.
    const content = readFileSync(file, 'utf8');
    assert.ok(!content.includes(TOKEN), 'secret must be gone from the transcript');
    assert.ok(content.includes('[REDACTED]'), 'the redacted marker is expected');
    const stampedAt = env.db
      .prepare('SELECT artifacts_swept_at FROM runs WHERE id = ?').get(runId) as { artifacts_swept_at: string | null };
    assert.ok(stampedAt.artifacts_swept_at, 'the sweep must stamp the run');

    // Second start: the stamped run is no longer a candidate, so its files are not re-scanned.
    const stampBefore = stampedAt.artifacts_swept_at;
    const mtimeBefore = statSync(file).mtimeMs;
    env.worker.stop();
    env.worker.start();
    const stampAfter = env.db
      .prepare('SELECT artifacts_swept_at FROM runs WHERE id = ?').get(runId) as { artifacts_swept_at: string | null };
    assert.equal(stampAfter.artifacts_swept_at, stampBefore, 'the stamp is written once');
    assert.equal(statSync(file).mtimeMs, mtimeBefore, 'a swept workspace is not re-scanned');
  } finally {
    env.close();
  }
});

test('sweep skips what it must: non-reaper failures and vanished workspaces (issue #976)', async () => {
  const env = makeEnv({
    artifactSecrets: [TOKEN],
    workerEnabled: false,
  });
  try {
    // A run the worker FINALIZED itself (FAILED through its own path) is not a candidate: the
    // sweep's scope is exactly the reaper's FAILED set.
    const finalized = env.runService.create({
      ownerId: 'alice',
      task: 'a run that failed through finalize',
      agent: 'fake',
      repository: { localPath: tempDir('mercury-sweep-repo-') },
    });
    env.queue.claim('crashed-worker', 60_000);
    env.runs.transition(finalized.id, 'STARTING');
    const wsFinalized = tempDir('mercury-sweep-ws2-');
    env.runs.setWorkspace(finalized.id, 'agent/x', wsFinalized);
    const fileFinalized = writeTranscript(wsFinalized, TOKEN);
    env.runs.setError(finalized.id, 'Agent failed', 'agent');
    env.runs.transition(finalized.id, 'FAILED', { completedAt: new Date().toISOString() });

    // A reaped run whose workspace is already gone (GC ran first): nothing to scrub, no throw.
    const wsGone = tempDir('mercury-sweep-gone-');
    const reaped = makeReapedRun(env, wsGone);
    rmSync(wsGone, { recursive: true, force: true });

    env.worker.start();

    const stillThere = readFileSync(fileFinalized, 'utf8');
    assert.ok(stillThere.includes(TOKEN), 'the sweep only covers the reaper-failed set');
    const stampFinalized = env.db
      .prepare('SELECT artifacts_swept_at FROM runs WHERE id = ?').get(finalized.id) as { artifacts_swept_at: string | null };
    assert.equal(stampFinalized.artifacts_swept_at, null, 'a non-candidate run is never stamped');
    const stampReaped = env.db
      .prepare('SELECT artifacts_swept_at FROM runs WHERE id = ?').get(reaped) as { artifacts_swept_at: string | null };
    assert.equal(stampReaped.artifacts_swept_at, null, 'a vanished workspace is skipped, not stamped');
  } finally {
    env.close();
  }
});

test('an unreadable subdirectory leaves the run unstamped, and the next start retries it (issue #976)',
  { skip: process.getuid?.() === 0 ? 'running as root: chmod cannot make a directory unreadable' : false },
  async () => {
    const env = makeEnv({
      artifactSecrets: [TOKEN],
      workerEnabled: false,
    });
    try {
      const workspace = tempDir('mercury-sweep-ws-');
      const locked = join(workspace, '.mercury-sessions', 'locked');
      mkdirSync(locked, { recursive: true });
      const file = join(locked, 'session.jsonl');
      writeFileSync(file, JSON.stringify({ type: 'agent.message', text: `using token ${TOKEN}` }) + '\n');
      const runId = makeReapedRun(env, workspace);
      // A subdirectory the sweep cannot list: readdir EACCES mid-pass.
      chmodSync(locked, 0o000);

      env.worker.start();

      // The pass could not read everything, so the run is NOT stamped: the next start retries
      // it instead of the secrets sitting on disk with nothing left to do.
      const stamped = env.db
        .prepare('SELECT artifacts_swept_at FROM runs WHERE id = ?').get(runId) as { artifacts_swept_at: string | null };
      assert.equal(stamped.artifacts_swept_at, null, 'an incomplete pass must not stamp the run');

      // Restore access; the next start retries the run and finishes the job.
      chmodSync(locked, 0o755);
      env.worker.stop();
      env.worker.start();
      const content = readFileSync(file, 'utf8');
      assert.ok(!content.includes(TOKEN), 'the retried pass redacts the previously unreadable transcript');
      assert.ok(content.includes('[REDACTED]'), 'the redacted marker is expected');
      const stampedAfter = env.db
        .prepare('SELECT artifacts_swept_at FROM runs WHERE id = ?').get(runId) as { artifacts_swept_at: string | null };
      assert.ok(stampedAfter.artifacts_swept_at, 'the complete pass stamps the run');
    } finally {
      env.close();
    }
  }
);

test('a SQLITE_BUSY on the first start-up reap is retried and startup completes (issue #976)', async () => {
  const env = makeEnv({
    artifactSecrets: [TOKEN],
    workerEnabled: false,
  });
  try {
    const workspace = tempDir('mercury-sweep-ws-');
    const file = writeTranscript(workspace, TOKEN);
    const runId = makeReapedRun(env, workspace, { reap: false });

    // The write lock is held by another process (the API, a sibling worker): the first reap
    // hits SQLITE_BUSY. Without the retry, start() would throw with running already true and
    // the instance could never start again (review on #976).
    const queue = (env.worker as unknown as { deps: { queue: typeof env.queue } }).deps.queue;
    const originalReap = queue.reapExpiredLeases.bind(queue);
    let reapCalls = 0;
    queue.reapExpiredLeases = (now?: number, onFailed?: (runId: string) => void) => {
      reapCalls += 1;
      if (reapCalls === 1) {
        const busy = new Error('SQLITE_BUSY: database is locked');
        (busy as NodeJS.ErrnoException).code = 'SQLITE_BUSY';
        throw busy;
      }
      return originalReap(now, onFailed);
    };

    // Must complete, not throw: the busy reap is retried.
    env.worker.start();

    assert.ok(reapCalls >= 2, 'the busy first reap is retried');
    // Startup completed: the retried reap failed the run, and the sweep that followed did its job.
    const final = env.runs.get(runId)!;
    assert.equal(final.status, 'FAILED');
    assert.equal(final.error, LEASE_EXPIRED_ERROR);
    const content = readFileSync(file, 'utf8');
    assert.ok(!content.includes(TOKEN), 'the sweep ran after the retried reap');
    const stampedAt = env.db
      .prepare('SELECT artifacts_swept_at FROM runs WHERE id = ?').get(runId) as { artifacts_swept_at: string | null };
    assert.ok(stampedAt.artifacts_swept_at, 'the sweep stamped the run');
  } finally {
    env.close();
  }
});

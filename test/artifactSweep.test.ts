// Start-up sweep of workspaces the worker never finalized (issue #976).
//
// The finalize-time artifact scrub (#944) lives in the worker's execute() finally, which a
// crashed worker never reaches: the run's lease expires, the reaper marks it
// FAILED(LEASE_EXPIRED_ERROR), and the session transcript and kernel snapshots keep their
// secrets on disk until workspace GC. The sweep closes that gap on the next worker start.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, tempDir } from './helpers.ts';
import { LEASE_EXPIRED_ERROR } from '../src/queue/runQueue.ts';

const TOKEN = 'sweep-secret-value-0123456789abcdef';

/**
 * A run that held a lease and then never got finalized: claimed, started, workspace set,
 * lease expired while "the worker" was dead, and reaped. Mirrors the production path exactly
 * (claim -> STARTING -> crash -> lease expiry -> reaper), only the crash is instantaneous.
 * These runs are terminal before any worker under test starts, so the claim loop never sees them.
 */
function makeReapedRun(env: ReturnType<typeof makeEnv>, workspacePath: string): string {
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
  const { failed } = env.queue.reapExpiredLeases();
  assert.ok(failed.includes(run.id), 'the reaper must fail the expired run');
  const final = env.runs.get(run.id)!;
  assert.equal(final.status, 'FAILED');
  assert.equal(final.error, LEASE_EXPIRED_ERROR);
  return run.id;
}

function writeTranscript(workspace: string, token: string): string {
  const dir = join(workspace, '.mercury-sessions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'agent.message', text: `using token ${token}` }) + '\n');
  return file;
}

test('start-up sweep redacts the workspace of a reaper-failed run, once (issue #976)', async () => {
  const env = makeEnv({
    artifactSecrets: [TOKEN],
    workerEnabled: false,
  });
  try {
    const workspace = tempDir('mercury-sweep-ws-');
    const file = writeTranscript(workspace, TOKEN);
    const runId = makeReapedRun(env, workspace);

    // The worker comes back: start() reaps (nothing left) and sweeps.
    env.worker.start();

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

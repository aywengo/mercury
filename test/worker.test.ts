import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, makeGitRepo, waitFor, sleep } from './helpers.ts';
import { PrimeAgentAdapter } from '../src/adapters/primeAgentAdapter.ts';
import { createRedactor } from '../src/domain/redact.ts';
import type { AgentAdapter, AgentEvent, AgentExit, AgentHandle, RunContext } from '../src/domain/types.ts';

test('happy path: create -> queue -> run -> events -> completed', async () => {
  const repo = makeGitRepo(join(tmpdir(), 'mercury-repo-' + Date.now()));
  const env = makeEnv({
    workspaceMode: 'git-worktree',
    repoDir: repo,
    fakeScript: [
      { event: { type: 'step.started', payload: { step: 'inspect' } } },
      { event: { type: 'agent.message', payload: { text: 'inspecting...' } } },
      { event: { type: 'tool.started', payload: { tool: 'bash', cmd: 'npm test' } } },
      { event: { type: 'tool.completed', payload: { tool: 'bash' } } },
      { event: { type: 'test.completed', payload: { passed: 24, failed: 0 } } },
    ],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Fix the failing integration tests',
      agent: 'fake',
      repository: { localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    const final = env.runs.get(run.id)!;
    assert.equal(final.status, 'COMPLETED');
    assert.ok(final.workspacePath);
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('run.started'));
    assert.ok(types.includes('step.started'));
    assert.ok(types.includes('agent.message'));
    assert.ok(types.includes('tool.started'));
    assert.ok(types.includes('test.completed'));
    assert.ok(types.includes('skill.completed'));
    assert.ok(types.includes('run.completed'));
    // workspace has skills written
    assert.ok(existsSync(join(final.workspacePath!, '.agents', 'skills', 'testing', 'SKILL.md')));
  } finally {
    env.close();
  }
});

test('agent failure -> FAILED with error', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-fail-'));
  const env = makeEnv({
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'about to fail' } } },
      { fail: true },
    ],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      repository: { localPath: repo },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 10_000);
    const final = env.runs.get(run.id)!;
    assert.equal(final.status, 'FAILED');
    assert.equal(final.errorKind, 'agent');
    assert.ok(final.error);
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('run.failed'));
    assert.ok(types.includes('error'));
  } finally {
    env.close();
  }
});

test('cancellation: RUNNING -> CANCELLED', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-cancel-'));
  const env = makeEnv({
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'working' } }, delayMs: 50 },
      { event: { type: 'agent.message', payload: { text: 'still working' } }, delayMs: 50 },
      { event: { type: 'agent.message', payload: { text: 'done' } } },
    ],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      repository: { localPath: repo },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'RUNNING');
    env.runService.cancel(run.id, 'alice', false);
    await waitFor(() => env.runs.get(run.id)!.status === 'CANCELLED', 10_000);
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('run.cancelling'));
    assert.ok(types.includes('run.cancelled'));
  } finally {
    env.close();
  }
});

test('cancellation: NEEDS_INPUT -> CANCELLED promptly (issue #1)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-cancel-input-'));
  const env = makeEnv({
    inputTimeoutMs: 30_000, // long timeout; cancel must win well before it
    fakeScript: [
      { input: { question: 'Continue?', choices: ['yes', 'no'] } },
      { event: { type: 'agent.message', payload: { text: 'after input' } } },
    ],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      repository: { localPath: repo },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'NEEDS_INPUT', 10_000);
    const t0 = Date.now();
    env.runService.cancel(run.id, 'alice', false);
    await waitFor(() => env.runs.get(run.id)!.status === 'CANCELLED', 10_000);
    const elapsed = Date.now() - t0;
    // Cancel must be honored promptly, not after the 30s input timeout.
    assert.ok(elapsed < 5_000, `cancel during NEEDS_INPUT took ${elapsed}ms (expected < 5000ms)`);
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('run.cancelling'));
    assert.ok(types.includes('run.cancelled'));
    assert.ok(!types.includes('input.received'));
  } finally {
    env.close();
  }
});

test('human input: NEEDS_INPUT -> input -> RUNNING -> COMPLETED', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-input-'));
  const env = makeEnv({
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'need decision' } } },
      { input: { question: 'This migration changes the public API. Continue?', choices: ['continue', 'abort'] } },
      { event: { type: 'agent.message', payload: { text: 'continuing' } } },
    ],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      repository: { localPath: repo },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'NEEDS_INPUT', 10_000);
    env.runService.submitInput(run.id, 'alice', false, 'continue');
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('input.required'));
    assert.ok(types.includes('input.received'));
  } finally {
    env.close();
  }
});

test('input timeout: NEEDS_INPUT without response -> TIMED_OUT (input-timeout)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-input-timeout-'));
  const env = makeEnv({
    inputTimeoutMs: 300,
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'need decision' } } },
      { input: { question: 'This migration changes the public API. Continue?', choices: ['continue', 'abort'] } },
      { event: { type: 'agent.message', payload: { text: 'never reached' } } },
    ],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      repository: { localPath: repo },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'NEEDS_INPUT', 10_000);
    // No input is provided; the worker must time the wait out (section 19).
    await waitFor(() => env.runs.get(run.id)!.status === 'TIMED_OUT', 10_000);
    const evts = env.events.list(run.id);
    const types = evts.map((e) => e.type);
    const timedOut = evts.find((e) => e.type === 'run.timed_out');
    assert.equal((timedOut!.payload as { reason: string }).reason, 'input-timeout');
    assert.ok(types.includes('input.required'));
    assert.ok(!types.includes('input.received'));
  } finally {
    env.close();
  }
});

test('input timeout disabled (0): waiting input is not timed out', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-input-no-timeout-'));
  const env = makeEnv({
    inputTimeoutMs: 0,
    fakeScript: [
      { input: { question: 'Continue?', choices: ['yes', 'no'] } },
      { event: { type: 'agent.message', payload: { text: 'after input' } } },
    ],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      repository: { localPath: repo },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'NEEDS_INPUT', 10_000);
    await sleep(400); // longer than the 300ms timeout used by the previous test
    assert.equal(env.runs.get(run.id)!.status, 'NEEDS_INPUT');
    env.runService.submitInput(run.id, 'alice', false, 'yes');
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
  } finally {
    env.close();
  }
});

test('timeout: RUNNING -> TIMED_OUT', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-timeout-'));
  const env = makeEnv({
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'slow' } }, delayMs: 200 },
      { event: { type: 'agent.message', payload: { text: 'done' } } },
    ],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'x',
      agent: 'fake',
      repository: { localPath: repo },
      constraints: { maxDurationMs: 100 },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'TIMED_OUT', 10_000);
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('run.timed_out'));
  } finally {
    env.close();
  }
});

test('duplicate execution prevention: two workers, one executes', async () => {
  const env = makeEnv({
    workerEnabled: false,
    fakeScript: [{ event: { type: 'agent.message', payload: { text: 'hi' } }, delayMs: 30 }],
  });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    // claim with two different worker ids
    const claimed1 = env.queue.claim('w1', 60_000);
    const claimed2 = env.queue.claim('w2', 60_000);
    assert.equal(claimed1?.id, run.id);
    assert.equal(claimed2, null);
  } finally {
    env.close();
  }
});

test('lease expiry: active run -> FAILED (infrastructure), queued -> requeued', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.queue.claim('w1', 60_000);
    // simulate crash: expire the lease
    env.db.prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), run.id);
    env.db.prepare("UPDATE runs SET status = 'RUNNING' WHERE id = ?").run(run.id);
    const { failed } = env.queue.reapExpiredLeases();
    assert.deepEqual(failed, [run.id]);
    assert.equal(env.runs.get(run.id)!.status, 'FAILED');
    assert.equal(env.runs.get(run.id)!.errorKind, 'infrastructure');
  } finally {
    env.close();
  }
});

test('a reaped active run loses its lease, so the dead worker stops renewing it (issue #53)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.queue.claim('w1', 60_000);
    assert.equal(env.queue.renewLease(run.id, 'w1', 60_000), true, 'the owner renews normally while healthy');
    // Expire the lease only after that renewal, since renewing pushes lease_expires_at out.
    env.db.prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), run.id);
    env.db.prepare("UPDATE runs SET status = 'RUNNING' WHERE id = ?").run(run.id);

    // Before the fix the reaper marked the run FAILED but left lease_owner pointing at
    // the dead worker. renewLease matches `WHERE lease_owner = ?`, so it kept answering
    // true: the worker never learned it had lost the run, kept driving the agent, and
    // then threw on an invalid transition at finalize.
    const { failed } = env.queue.reapExpiredLeases();
    assert.deepEqual(failed, [run.id]);

    const row = env.db.prepare('SELECT lease_owner, lease_expires_at FROM runs WHERE id = ?').get(run.id) as
      { lease_owner: string | null; lease_expires_at: string | null };
    assert.equal(row.lease_owner, null, 'the reaper must clear lease_owner');
    assert.equal(row.lease_expires_at, null, 'the reaper must clear lease_expires_at');
    assert.equal(env.queue.renewLease(run.id, 'w1', 60_000), false, 'the dead worker must no longer be able to renew');
    assert.equal(env.queue.renewLease(run.id, 'w2', 60_000), false, 'a live lease is required to renew, not just a row');

    // Documents the boundary with M3: the run is terminal, so the remaining requeue path
    // declines. The worker handles this by leaving it FAILED; making it resumable is M3.
    // (This used to assert on requeueLostLease, removed by issue #59 -- it requeued runs whose
    // lease belonged to another live worker. requeueForShutdown is owner-scoped and terminal-safe,
    // so it carries the same "terminal runs are never resurrected" boundary.)
    assert.equal(env.queue.requeueForShutdown(run.id, 'w1'), false);
    assert.equal(env.runs.get(run.id)!.status, 'FAILED');
  } finally {
    env.close();
  }
});

test('lease expiry: reaped run gets a terminal run.failed event (issue #6)', async () => {
  const env = makeEnv({ workerEnabled: true, pollMs: 10 });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.queue.claim('w1', 60_000);
    // simulate crash: expire the lease and mark RUNNING
    env.db.prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), run.id);
    env.db.prepare("UPDATE runs SET status = 'RUNNING', started_at = ? WHERE id = ?").run(new Date(Date.now() - 5000).toISOString(), run.id);
    // the worker loop reaps the expired lease and appends the terminal event
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 10_000);
    const events = env.events.list(run.id);
    const types = events.map((e) => e.type);
    const failedEvts = events.filter((e) => e.type === 'run.failed');
    assert.equal(failedEvts.length, 1, `expected exactly one run.failed, got ${failedEvts.length}`);
    // the terminal event is the last in the timeline
    assert.equal(types[types.length - 1], 'run.failed');
    const failedEvt = failedEvts[0];
    const payload = failedEvt.payload as { kind: string; durationMs: number | null };
    assert.equal(payload.kind, 'infrastructure');
    assert.equal(typeof payload.durationMs, 'number');
    // the run row carries the error + kind
    const row = env.runs.get(run.id)!;
    assert.equal(row.error, 'Worker lease expired (worker crash?)');
    assert.equal(row.errorKind, 'infrastructure');
    // an error event precedes run.failed (uniform with other failure paths)
    assert.ok(types.includes('error'));
  } finally {
    env.close();
  }
});

test('auto-retry on infrastructure failure (workspace missing)', async () => {
  const env = makeEnv({
    workerEnabled: false,
    maxRetries: 1,
    retryBackoffMs: 30,
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'x',
      agent: 'fake',
      repository: { localPath: '/nonexistent/path' },
    });
    env.worker.start();
    await waitFor(() => {
      const r = env.runs.get(run.id)!;
      return r.status === 'FAILED' && r.errorKind === 'infrastructure';
    }, 10_000);
    // auto-retry should have created a retry run
    await waitFor(() => {
      const all = env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 10 });
      return all.runs.some((r) => r.retryOf === run.id);
    }, 10_000);
  } finally {
    env.close();
  }
});
test('auto-retry honors per-run maxRetries: 0 disables retry (issue #9)', async () => {
  const env = makeEnv({
    workerEnabled: false,
    maxRetries: 2, // global allows retries
    retryBackoffMs: 30,
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'x',
      agent: 'fake',
      repository: { localPath: '/nonexistent/path' },
      constraints: { maxRetries: 0 }, // per-run: no auto-retry
    });
    env.worker.start();
    await waitFor(() => {
      const r = env.runs.get(run.id)!;
      return r.status === 'FAILED' && r.errorKind === 'infrastructure';
    }, 10_000);
    // give any (wrong) auto-retry a chance to fire
    await sleep(200);
    const all = env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 10 });
    assert.ok(!all.runs.some((r) => r.retryOf === run.id), 'no retry run should exist');
  } finally {
    env.close();
  }
});

test('auto-retry honors per-run maxRetries above the global default (issue #9)', async () => {
  const env = makeEnv({
    workerEnabled: false,
    maxRetries: 1, // global allows 1 retry
    retryBackoffMs: 30,
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'x',
      agent: 'fake',
      repository: { localPath: '/nonexistent/path' },
      constraints: { maxRetries: 3 }, // per-run: up to 3 retries
    });
    env.worker.start();
    // first retry (attempt 2) should appear despite global maxRetries: 1
    await waitFor(() => {
      const all = env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 10 });
      return all.runs.some((r) => r.retryOf === run.id && r.attempt === 2);
    }, 10_000);
  } finally {
    env.close();
  }
});

test('retry reuses the original base commit (section 21)', async () => {
  // unique temp dir (mkdtemp): a fixed name would leave a repo behind, and the
  // next run's `git commit` would find nothing to commit.
  const repoDir = mkdtempSync(join(tmpdir(), 'mercury-retry-base-'));
  const repo = makeGitRepo(repoDir);
  const env = makeEnv({
    workspaceMode: 'git-worktree',
    fakeScript: [{ fail: true }], // agent failure -> manual retry
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'x',
      agent: 'fake',
      repository: { localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 10_000);
    const original = env.runs.get(run.id)!;
    assert.ok(original.repository.baseCommit, 'base commit resolved and persisted on the run');
    const retry = env.runService.retry(run.id, 'alice', false);
    assert.equal(retry.retryOf, run.id);
    assert.equal(retry.repository.baseCommit, original.repository.baseCommit, 'retry pins the original base commit');
  } finally {
    env.close();
  }
});

test('skills are snapshotted per run', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Fix the failing integration tests',
      agent: 'fake',
      skills: ['testing', 'git-pr'],
    });
    const skills = env.runService.getSkills(run.id);
    assert.deepEqual(skills.map((s) => s.id).sort(), ['git-pr', 'testing']);
    assert.ok(skills.every((s) => s.hash && s.content));
  } finally {
    env.close();
  }
});

// --- roadmap p11/p12: worker resume wiring + cancel race ---------------------

/** Resume-capable fake: records start/resume calls, emits a scripted sequence. */
class ResumableFakeAdapter implements AgentAdapter {
  public startCalls = 0;
  public resumeCalls = 0;
  public resumedSessionFiles: (string | undefined)[] = [];
  private script: { event?: { type: string; payload?: unknown }; fail?: boolean }[];
  constructor(script: { event?: { type: string; payload?: unknown }; fail?: boolean }[] = []) {
    this.script = script;
  }

  async start(context: RunContext): Promise<AgentHandle> {
    this.startCalls++;
    return this.makeHandle(context.run.id, this.script);
  }

  async resume(runId: string, context?: RunContext): Promise<AgentHandle> {
    this.resumeCalls++;
    this.resumedSessionFiles.push(context?.resumeSessionFile);
    return this.makeHandle(runId, [{ event: { type: 'agent.message', payload: { text: 'resumed' } } }]);
  }

  async sendInput(): Promise<void> {}
  async cancel(): Promise<void> {}
  async terminate(): Promise<void> {}

  private makeHandle(runId: string, script: { event?: { type: string; payload?: unknown }; fail?: boolean }[]): AgentHandle {
    const queue: AgentEvent[] = [];
    const waiters: ((ev: AgentEvent) => void)[] = [];
    let done = false;
    const push = (ev: AgentEvent): void => {
      const w = waiters.shift();
      if (w) w(ev);
      else queue.push(ev);
    };
    const exitPromise = (async (): Promise<AgentExit> => {
      for (const step of script) {
        if (step.event) push({ type: step.event.type, payload: step.event.payload ?? {} });
      }
      done = true;
      for (const w of waiters.splice(0)) w({ type: 'agent.message', payload: { text: '[exited]' } });
      return script.some((s) => s.fail)
        ? { code: 1, signal: null, reason: 'failed' }
        : { code: 0, signal: null, reason: 'completed' };
    })();
    async function* events(): AsyncGenerator<AgentEvent> {
      while (true) {
        if (queue.length > 0) yield queue.shift()!;
        else if (done) return;
        else yield await new Promise<AgentEvent>((r) => waiters.push(r));
      }
    }
    return { runId, events: events(), exit: exitPromise, terminate: async () => {} };
  }
}

test('p12: cancel of a hanging agent is honored promptly (cancel race)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'mercury-p12-'));
  const env = makeEnv({
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'working' } }, delayMs: 50 },
      { event: { type: 'agent.message', payload: { text: 'still working' } }, delayMs: 50 },
      { event: { type: 'agent.message', payload: { text: 'still working' } }, delayMs: 50 },
      { event: { type: 'agent.message', payload: { text: 'still working' } }, delayMs: 50 },
      { event: { type: 'agent.message', payload: { text: 'still working' } }, delayMs: 50 },
      { event: { type: 'agent.message', payload: { text: 'still working' } }, delayMs: 50 },
      { event: { type: 'agent.message', payload: { text: 'still working' } }, delayMs: 50 },
      { event: { type: 'agent.message', payload: { text: 'still working' } }, delayMs: 50 },
      { event: { type: 'agent.message', payload: { text: 'still working' } }, delayMs: 50 },
    ],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      repository: { localPath: repo },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'RUNNING');
    const t0 = Date.now();
    env.runService.cancel(run.id, 'alice', false);
    await waitFor(() => env.runs.get(run.id)!.status === 'CANCELLED', 5_000);
    const elapsed = Date.now() - t0;
    // The agent would run ~450ms of script; cancel must win well before the
    // script finishes (and far before the 60s max-duration timeout).
    assert.ok(elapsed < 3_000, `cancel took ${elapsed}ms (expected < 3000ms)`);
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('run.cancelling'));
    assert.ok(types.includes('run.cancelled'));
  } finally {
    env.close();
  }
});

test('p11: retry run resumes the parent agent session (resume wiring)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'mercury-p11-'));
  const resumable = new ResumableFakeAdapter([{ fail: true }]);
  const env = makeEnv({
    adapters: { fake: resumable },
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      repository: { localPath: repo },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 10_000);
    assert.equal(resumable.startCalls, 1);

    // Write a session file into the parent's workspace (what a real adapter does).
    const parent = env.runs.get(run.id)!;
    assert.ok(parent.workspacePath);
    const { writeFileSync } = await import('node:fs');
    const { join: joinPath } = await import('node:path');
    writeFileSync(joinPath(parent.workspacePath!, '.mercury-session-path'), '/tmp/parent-session.jsonl');

    const retry = env.runService.retry(run.id, 'alice', false);
    await waitFor(() => env.runs.get(retry.id)!.status === 'COMPLETED', 10_000);
    assert.equal(resumable.startCalls, 1, 'retry must NOT call start() again');
    assert.equal(resumable.resumeCalls, 1, 'retry must call resume()');
    assert.equal(resumable.resumedSessionFiles[0], '/tmp/parent-session.jsonl');
    const types = env.events.list(retry.id).map((e) => e.type);
    assert.ok(types.includes('run.resuming'));
    assert.ok(types.includes('agent.message'));
  } finally {
    env.close();
  }
});

test('p11: retry falls back to start() when the adapter has no resume support', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'mercury-p11b-'));
  const env = makeEnv({
    fakeScript: [{ fail: true }], // FakeAgentAdapter has no resume()
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      repository: { localPath: repo },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 10_000);
    const retry = env.runService.retry(run.id, 'alice', false);
    await waitFor(() => env.runs.get(retry.id)!.status === 'FAILED', 10_000);
    // FakeAgentAdapter has no resume → worker used start() (fresh attempt).
    assert.equal(env.runs.get(retry.id)!.attempt, 2);
  } finally {
    env.close();
  }
});

test('worker redacts secrets in run error messages (issue #36)', async () => {
  const throwing = {
    async start(): Promise<AgentHandle> {
      throw new Error('workspace setup failed: token=abc123def');
    },
    async resume(): Promise<AgentHandle> { throw new Error('no resume'); },
    async sendInput(): Promise<void> {},
    async cancel(): Promise<void> {},
    async terminate(): Promise<void> {},
  } as unknown as AgentAdapter;
  const env = makeEnv({
    workerEnabled: false,
    redactor: createRedactor([]),
    adapters: { fake: throwing },
  });
  try {
    const repo = mkdtempSync(join(tmpdir(), 'mercury-redact-'));
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repo } });
    env.worker.start();
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 10_000);
    const final = env.runs.get(run.id)!;
    assert.equal(final.errorKind, 'infrastructure');
    assert.ok(final.error, 'error set');
    assert.ok(!final.error.includes('abc123def'), 'secret removed from runs.error');
    assert.ok(final.error.includes('[REDACTED]'), 'redacted marker present');
    // the error event is redacted too (events already redact at append)
    const errEv = env.events.list(run.id).find((e) => e.type === 'error');
    assert.ok(errEv, 'error event present');
    assert.ok(!JSON.stringify(errEv.payload).includes('abc123def'), 'event secret removed');
  } finally {
    env.close();
  }
});

test('agent failure redacts runs.error at finalize (issue #36, site 2)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-fail2-'));
  const env = makeEnv({
    redactor: createRedactor([]),
    fakeScript: [{ fail: true }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      repository: { localPath: repo },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 10_000);
    const final = env.runs.get(run.id)!;
    assert.equal(final.errorKind, 'agent');
    assert.ok(final.error, 'error set');
    assert.ok(final.error.includes('Agent exited with code'), 'derived error message present');
  } finally {
    env.close();
  }
});

test('an unknown agent event type is dropped, and the run still completes (issue #50)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-badevt-'));
  const evil = 'agent.message\ndata: {"type":"run.completed","sequence":1}';
  const env = makeEnv({
    fakeScript: [
      { event: { type: evil, payload: { text: 'injected' } } },
      { event: { type: 'agent.message', payload: { text: 'legitimate' } } },
    ],
  });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repo } });
    // Dropping rather than propagating matters: EventStore.append now throws on an
    // unknown type, and that throw would escape the drive loop uncaught -- so a rogue
    // agent could kill its own run with one odd event type. Reject at the choke point,
    // discard at the boundary.
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 15_000);
    const types = env.events.list(run.id).map((e) => e.type);
    assert.equal(types.filter((x) => x.startsWith('agent.message\n')).length, 0, 'injected type must not persist');
    assert.equal(types.filter((x) => x === 'agent.message').length, 1, 'the legitimate event must survive');
  } finally {
    env.close();
  }
});

/**
 * Adapter that records whether the worker ever called terminate() on the handle.
 * The point is to observe cleanup the worker used to skip entirely: a successful run
 * never terminated its agent, and a run that threw mid-drive unwound past cleanup.
 */
class RecordingAdapter implements AgentAdapter {
  terminateCalls = 0;
  cancelCalls = 0;
  mode: 'ok' | 'throw-midway';
  constructor(mode: 'ok' | 'throw-midway' = 'ok') {
    this.mode = mode;
  }
  async start(context: RunContext): Promise<AgentHandle> {
    const self = this;
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'agent.message', payload: { text: 'first' } };
      if (self.mode === 'throw-midway') throw new Error('agent stream exploded mid-run');
    })();
    return {
      runId: context.run.id,
      events,
      exit: new Promise<AgentExit>((resolve) => {
        setTimeout(() => resolve({ code: 0, signal: null, reason: 'completed' }), 5);
      }),
      terminate: async () => {
        self.terminateCalls += 1;
      },
    };
  }
  async sendInput(): Promise<void> {}
  async cancel(): Promise<void> {
    this.cancelCalls += 1;
  }
}

test('a successful run terminates its agent handle (issue #46)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'mercury-term-ok-'));
  const adapter = new RecordingAdapter('ok');
  const env = makeEnv({ workerEnabled: false, adapters: { fake: adapter } });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repo } });
    env.worker.start();
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    await waitFor(() => adapter.terminateCalls === 1, 3_000);
    // The success path used to break out of the drive loop, await an already-resolved exit,
    // finalize, and never stop the client -- one live `prime-agent --mode rpc` per completed
    // run, forever. Ownership now sits in execute()'s finally.
    assert.equal(adapter.terminateCalls, 1, 'the success path must terminate the handle exactly once');
  } finally {
    env.worker.stop();
    env.close();
  }
});

test('a run that throws mid-drive still terminates its agent handle (issue #47)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'mercury-term-throw-'));
  const adapter = new RecordingAdapter('throw-midway');
  const env = makeEnv({ workerEnabled: false, adapters: { fake: adapter } });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repo } });
    env.worker.start();
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 10_000);
    // The status flips to FAILED inside the catch, and terminate() runs after it in the
    // finally, so wait on the cleanup itself rather than reading it the instant the status
    // lands. Without the fix this never becomes true and the wait fails.
    await waitFor(() => adapter.terminateCalls === 1, 3_000);
    // This is the shape of the cancel race: the drive loop throws, and any throw used to
    // unwind before a terminate() call, leaving a live agent writing into a workspace
    // nobody was watching. Cleanup must not depend on how the loop exited.
    assert.equal(adapter.terminateCalls, 1, 'the throwing path must still terminate the handle');
  } finally {
    env.worker.stop();
    env.close();
  }
});

// --- session pruning (issues #62, #97) -------------------------------------
//
// Every adapter keyed a Session by runId and nothing ever removed it, so a long-lived worker
// accumulated one Session -- run row, RPC client, stderr buffer, event queue -- per run for the
// lifetime of the process. The fix is adapter.dispose(runId), called by the worker's finally.
//
// The ordering is the interesting part: adapters resolve the session by runId INSIDE
// terminate(), so pruning before terminate() makes it find nothing and return without stopping
// the process -- reintroducing the #46 leak. These tests pin both halves together, because a
// test that only checked the map would pass while silently re-opening the leak.

const MOCK_RPC = join(import.meta.dirname, 'fixtures', 'mock-prime-agent-rpc.mjs');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Adapters keep `sessions` private; at runtime it is an ordinary property. */
function sessionKeys(adapter: object): string[] {
  return [...((adapter as unknown as { sessions: Map<string, unknown> }).sessions?.keys() ?? [])];
}

test('worker releases the adapter session AFTER stopping the process (issues #62, #97)', async () => {
  const repo = makeGitRepo(join(tmpdir(), `mercury-dispose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
  const dir = mkdtempSync(join(tmpdir(), 'mercury-dispose-pid-'));
  const pidFile = join(dir, 'pid');
  process.env.MOCK_RPC_MODE = 'happy';
  process.env.MOCK_RPC_PID_FILE = pidFile;
  const adapter = new PrimeAgentAdapter(MOCK_RPC, { args: [] });
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, adapters: { primeagent: adapter } });
  let pid = 0;
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'primeagent', repository: { localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);

    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0, 'the fixture must record its pid');

    // Half 1 -- #46 must not come back. dispose() runs after terminate(), so terminate() still
    // finds its session and stops the process.
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await sleep(25);
    assert.ok(!alive(pid), `RPC process ${pid} survived the run: dispose() reordered before terminate()`);

    // Half 2 -- #62/#97: the session is actually released.
    assert.ok(!sessionKeys(adapter).includes(run.id),
      `adapter still holds a session for completed run ${run.id}; the map grows without bound`);
  } finally {
    // Reap unconditionally: a leaked child keeps the parent's stdio open and the runner HANGS
    // instead of reporting a failure (learned the hard way in #46).
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone, which is the expected case
      }
    }
    env.close();
    delete process.env.MOCK_RPC_MODE;
    delete process.env.MOCK_RPC_PID_FILE;
  }
});

test('worker releases the adapter session on the failure path too (issues #62, #97)', async () => {
  // The success path is the easy one. dispose() lives in execute()'s finally, so a failing run
  // must release it as well -- otherwise a crash loop leaks one Session per attempt, which is
  // the worst case for a long-lived worker.
  const repo = makeGitRepo(join(tmpdir(), `mercury-dispose-fail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
  const env = makeEnv({
    workspaceMode: 'copy',
    repoDir: repo,
    fakeScript: [{ fail: true }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 20_000);
    const fake = env.adapters.fake as unknown as { inputs: Map<string, unknown>; inputWaiters: Map<string, unknown> };
    assert.ok(!fake.inputs.has(run.id), 'per-run inputs must be released after a failed run');
    assert.ok(!fake.inputWaiters.has(run.id), 'per-run input waiters must be released after a failed run');
  } finally {
    env.close();
  }
});

test('a throwing adapter dispose() must not strand the lease (issue #62, #97)', async () => {
  // dispose() sits in the same finally as releaseLease(), before it. Copilot's review point:
  // cleanup code that throws would skip releaseLease and strand the lease. A leaked session is
  // strictly better than a stranded run, so dispose failures are logged and swallowed.
  const repo = makeGitRepo(join(tmpdir(), `mercury-dispose-throw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
  const env = makeEnv({
    workspaceMode: 'copy',
    repoDir: repo,
    fakeScript: [{ event: { type: 'agent.message', payload: { text: 'ok' } } }],
  });
  try {
    const inner = env.adapters.fake;
    const hostile: AgentAdapter = {
      start: (ctx) => inner.start(ctx),
      sendInput: (id, input) => inner.sendInput(id, input),
      cancel: (id) => inner.cancel(id),
      dispose() {
        throw new Error('dispose exploded');
      },
    };
    // Swap the entry in place rather than registering a new agent name: RunService validates
    // the agent against a fixed knownAgents list, and the worker resolves
    // adapters[run.agent] at execution time, so replacing the existing 'fake' key is enough.
    env.adapters.fake = hostile;

    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);

    // The run must still finish normally...
    assert.equal(env.runs.get(run.id)!.status, 'COMPLETED');
    // ...and releaseLease must still have run. If dispose()'s throw escaped the finally, the
    // departed worker would still be recorded as the lease owner.
    const row = env.db
      .prepare('SELECT lease_owner, lease_expires_at FROM runs WHERE id = ?')
      .get(run.id) as { lease_owner: string | null; lease_expires_at: string | null };
    assert.equal(row.lease_owner, null, `lease not released after a throwing dispose(): ${JSON.stringify(row)}`);
    assert.equal(row.lease_expires_at, null);
  } finally {
    env.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, makeGitRepo, waitFor, sleep } from './helpers.ts';
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

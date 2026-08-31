// DaemonAgentAdapter tests against the mock prime-agent daemon.
// Verifies the adapter contract over the daemon socket protocol.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonAgentAdapter } from '../src/adapters/daemonAgentAdapter.ts';
import type { Run, RunContext, ResolvedSkill } from '../src/domain/types.ts';

const MOCK = join(import.meta.dirname, 'fixtures', 'mock-prime-agent-daemon.mjs');

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: 'run_daemon',
    ownerId: 'alice',
    task: 'Fix the failing integration tests',
    repository: { localPath: '/tmp/repo' },
    workspaceBranch: null,
    workspacePath: null,
    agent: 'primeagent',
    status: 'QUEUED',
    attempt: 1,
    retryOf: null,
    error: null,
    errorKind: null,
    constraints: { maxDurationMs: 60_000, maxRetries: 2 },
    createdAt: now,
    startedAt: null,
    completedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    cancellationRequestedAt: null,
    finalCommits: [],
    prUrl: null,
    ...overrides,
  };
}

function makeContext(opts: { run?: Run; skills?: ResolvedSkill[]; env?: Record<string, string> } = {}): {
  context: RunContext;
  workspacePath: string;
} {
  const workspacePath = mkdtempSync(join(tmpdir(), 'mercury-daemon-'));
  const run = opts.run ?? makeRun();
  const context: RunContext = {
    run,
    repository: run.repository,
    workspace: { path: workspacePath, branch: 'agent/' + run.id, baseCommit: 'abc123', mode: 'copy' },
    skills: opts.skills ?? [],
    constraints: run.constraints,
  };
  return { context, workspacePath };
}

async function collectAll(handle: Awaited<ReturnType<DaemonAgentAdapter['start']>>): Promise<{
  events: { type: string; payload: unknown }[];
  exit: import('../src/domain/types.ts').AgentExit;
}> {
  const events: { type: string; payload: unknown }[] = [];
  for await (const ev of handle.events) {
    if (ev.type === '__done__') break;
    events.push({ type: ev.type, payload: ev.payload });
  }
  const exit = await handle.exit;
  return { events, exit };
}

function spawnAdapter(env: Record<string, string>): DaemonAgentAdapter {
  return new DaemonAgentAdapter(process.execPath, { args: [MOCK], env });
}

test('daemon: happy path — prompt, events, completion', async () => {
  const { context, workspacePath } = makeContext();
  const adapter = spawnAdapter({ MOCK_DAEMON_SOCKET: join(workspacePath, '.mercury-sessions', 'daemon.sock') });
  try {
    const handle = await adapter.start(context);
    const { events, exit } = await collectAll(handle);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('agent.message'), `expected agent.message, got ${types.join(',')}`);
    assert.ok(types.includes('tool.started'));
    assert.ok(types.includes('tool.completed'));
    assert.equal(exit.code, 0);
    const msg = events.find((e) => e.type === 'agent.message')?.payload as { text: string };
    assert.equal(msg.text, 'Hello from daemon mock');
  } finally {
    await adapter.cancel(context.run.id);
  }
});

test('daemon: input request -> response -> completion', async () => {
  const { context, workspacePath } = makeContext();
  const adapter = spawnAdapter({ MOCK_DAEMON_SOCKET: join(workspacePath, '.mercury-sessions', 'daemon.sock'), MOCK_DAEMON_MODE: 'input' });
  try {
    const handle = await adapter.start(context);
    // Phase 1: wait for input.required (promise-based, doesn't consume the generator)
    const inputPromise = new Promise<{ type: string; payload: unknown }>((resolve) => {
      (async () => {
        for await (const ev of handle.events) {
          if (ev.type === 'input.required') { resolve({ type: ev.type, payload: ev.payload }); return; }
          if (ev.type === '__done__') { resolve({ type: '__none__', payload: {} }); return; }
        }
      })();
    });
    const inputEvent = await inputPromise;
    assert.ok(inputEvent.type === 'input.required', 'expected input.required');
    const payload = inputEvent.payload as { method: string; options: { label: string; value: string }[] };
    assert.equal(payload.method, 'select');
    assert.equal(payload.options.length, 2);
    await adapter.sendInput(context.run.id, { value: 'yes', at: new Date().toISOString() });
    // Phase 2: collect the rest (response events from the mock)
    const all: { type: string; payload: unknown }[] = [];
    for await (const ev of handle.events) {
      if (ev.type === '__done__') break;
      all.push({ type: ev.type, payload: ev.payload });
    }
    const exit = await handle.exit;
    assert.equal(exit.code, 0);
    const msg = all.find((e) => e.type === 'agent.message')?.payload as { text: string };
    assert.ok(msg.text.includes('got input'), `expected 'got input' in '${msg.text}'`);
  } finally {
    await adapter.cancel(context.run.id);
  }
});

test('daemon: sendInput writes the RPC response shape { id, value } (issue #10)', async () => {
  const { context, workspacePath } = makeContext();
  const logPath = join(workspacePath, 'daemon.log');
  const adapter = spawnAdapter({
    MOCK_DAEMON_SOCKET: join(workspacePath, '.mercury-sessions', 'daemon.sock'),
    MOCK_DAEMON_MODE: 'input',
    MOCK_DAEMON_LOG: logPath,
  });
  try {
    const handle = await adapter.start(context);
    // wait for input.required
    const inputPromise = new Promise<{ type: string; payload: unknown }>((resolve) => {
      (async () => {
        for await (const ev of handle.events) {
          if (ev.type === 'input.required') { resolve({ type: ev.type, payload: ev.payload }); return; }
          if (ev.type === '__done__') { resolve({ type: '__none__', payload: {} }); return; }
        }
      })();
    });
    const inputEvent = await inputPromise;
    assert.equal(inputEvent.type, 'input.required');
    const payload = inputEvent.payload as { requestId: string };
    await adapter.sendInput(context.run.id, { value: 'yes', at: new Date().toISOString() });
    // drain the rest so the session completes
    for await (const ev of handle.events) {
      if (ev.type === '__done__') break;
    }
    await handle.exit;
    // the mock logs the exact frame it received
    const log = readFileSync(logPath, 'utf8');
    const line = log.split('\n').find((l) => l.startsWith('input response: '));
    assert.ok(line, 'expected an input response log line');
    const frame = JSON.parse(line!.slice('input response: '.length)) as Record<string, unknown>;
    assert.equal(frame.type, 'extension_ui_response');
    assert.equal(frame.id, payload.requestId);
    assert.equal(frame.value, 'yes');
    assert.equal(frame.requestId, undefined, 'old requestId key must be gone');
    assert.equal(frame.response, undefined, 'old response key must be gone');
  } finally {
    await adapter.cancel(context.run.id);
  }
});
test('daemon: sendInput confirm method coerces to { id, confirmed } (issue #10)', async () => {
  const { context, workspacePath } = makeContext();
  const logPath = join(workspacePath, 'daemon.log');
  const adapter = spawnAdapter({
    MOCK_DAEMON_SOCKET: join(workspacePath, '.mercury-sessions', 'daemon.sock'),
    MOCK_DAEMON_MODE: 'input',
    MOCK_DAEMON_METHOD: 'confirm',
    MOCK_DAEMON_LOG: logPath,
  });
  try {
    const handle = await adapter.start(context);
    const inputPromise = new Promise<{ type: string; payload: unknown }>((resolve) => {
      (async () => {
        for await (const ev of handle.events) {
          if (ev.type === 'input.required') { resolve({ type: ev.type, payload: ev.payload }); return; }
          if (ev.type === '__done__') { resolve({ type: '__none__', payload: {} }); return; }
        }
      })();
    });
    const inputEvent = await inputPromise;
    assert.equal(inputEvent.type, 'input.required');
    const payload = inputEvent.payload as { requestId: string };
    await adapter.sendInput(context.run.id, { value: 'yes', at: new Date().toISOString() });
    for await (const ev of handle.events) {
      if (ev.type === '__done__') break;
    }
    await handle.exit;
    const log = readFileSync(logPath, 'utf8');
    const line = log.split('\n').find((l) => l.startsWith('input response: '));
    assert.ok(line, 'expected an input response log line');
    const frame = JSON.parse(line!.slice('input response: '.length)) as Record<string, unknown>;
    assert.equal(frame.type, 'extension_ui_response');
    assert.equal(frame.id, payload.requestId);
    assert.equal(frame.confirmed, true);
    assert.equal(frame.value, undefined);
  } finally {
    await adapter.cancel(context.run.id);
  }
});

test('daemon: sendInput cancelled passthrough writes { id, cancelled } (issue #10)', async () => {
  const { context, workspacePath } = makeContext();
  const logPath = join(workspacePath, 'daemon.log');
  const adapter = spawnAdapter({
    MOCK_DAEMON_SOCKET: join(workspacePath, '.mercury-sessions', 'daemon.sock'),
    MOCK_DAEMON_MODE: 'input',
    MOCK_DAEMON_LOG: logPath,
  });
  try {
    const handle = await adapter.start(context);
    const inputPromise = new Promise<{ type: string; payload: unknown }>((resolve) => {
      (async () => {
        for await (const ev of handle.events) {
          if (ev.type === 'input.required') { resolve({ type: ev.type, payload: ev.payload }); return; }
          if (ev.type === '__done__') { resolve({ type: '__none__', payload: {} }); return; }
        }
      })();
    });
    const inputEvent = await inputPromise;
    assert.equal(inputEvent.type, 'input.required');
    const payload = inputEvent.payload as { requestId: string };
    await adapter.sendInput(context.run.id, { value: { cancelled: true }, at: new Date().toISOString() });
    for await (const ev of handle.events) {
      if (ev.type === '__done__') break;
    }
    await handle.exit;
    const log = readFileSync(logPath, 'utf8');
    const line = log.split('\n').find((l) => l.startsWith('input response: '));
    assert.ok(line, 'expected an input response log line');
    const frame = JSON.parse(line!.slice('input response: '.length)) as Record<string, unknown>;
    assert.equal(frame.type, 'extension_ui_response');
    assert.equal(frame.id, payload.requestId);
    assert.equal(frame.cancelled, true);
    assert.equal(frame.value, undefined);
  } finally {
    await adapter.cancel(context.run.id);
  }
});



test('daemon: abort cancels the session', async () => {
  const { context, workspacePath } = makeContext();
  const adapter = spawnAdapter({ MOCK_DAEMON_SOCKET: join(workspacePath, '.mercury-sessions', 'daemon.sock') });
  const handle = await adapter.start(context);
  await adapter.cancel(context.run.id);
  const exit = await handle.exit;
  assert.ok(exit.code !== 0 || exit.signal === 'SIGTERM');
});

test('daemon: spawn failure surfaces as failed exit', async () => {
  const { context, workspacePath } = makeContext();
  const adapter = new DaemonAgentAdapter('/nonexistent/prime-agent', { args: [] });
  try {
    const handle = await adapter.start(context);
    const exit = await handle.exit;
    assert.notEqual(exit.code, 0);
  } catch {
    // start() may throw if the spawn fails immediately — acceptable
  }
});

test('daemon: context file written into workspace', async () => {
  const { context, workspacePath } = makeContext();
  const adapter = spawnAdapter({ MOCK_DAEMON_SOCKET: join(workspacePath, '.mercury-sessions', 'daemon.sock') });
  try {
    await adapter.start(context);
    const ctx = JSON.parse(readFileSync(join(workspacePath, '.mercury-context.json'), 'utf8')) as { runId: string; task: string };
    assert.equal(ctx.runId, 'run_daemon');
    assert.equal(ctx.task, 'Fix the failing integration tests');
  } finally {
    await adapter.cancel(context.run.id);
  }
});

test('daemon: sendInput throws when no live session (issue #30)', async () => {
  const { context, workspacePath } = makeContext();
  const adapter = spawnAdapter({
    MOCK_DAEMON_SOCKET: join(workspacePath, '.mercury-sessions', 'daemon.sock'),
    MOCK_DAEMON_MODE: 'input',
  });
  try {
    await assert.rejects(
      () => adapter.sendInput('no-such-run', { value: 'x', at: new Date().toISOString() }),
      /No live agent session/,
    );
  } finally {
    await adapter.cancel(context.run.id);
  }
});
test('daemon: sendInput throws when not waiting for input (issue #30)', async () => {
  const { context, workspacePath } = makeContext();
  const adapter = spawnAdapter({
    MOCK_DAEMON_SOCKET: join(workspacePath, '.mercury-sessions', 'daemon.sock'),
    // happy mode: no input.required emitted, so the session has no pending dialog
  });
  try {
    const handle = await adapter.start(context);
    // drain events so the session is established
    for await (const ev of handle.events) {
      if (ev.type === '__done__') break;
    }
    await assert.rejects(
      () => adapter.sendInput(context.run.id, { value: 'x', at: new Date().toISOString() }),
      /not waiting for input/,
    );
  } finally {
    await adapter.cancel(context.run.id);
  }
});

test('daemon: terminate() settles the exit promise instead of leaving it pending (issue #55)', async () => {
  // The bug: terminate() set `done = true`, and every exit handler in this adapter was
  // guarded on `done`, so none of them would settle afterwards. handle.exit NEVER resolved.
  // The worker then sat in Promise.race([handle.exit, sleep(10_000)]) for the full timeout and
  // reported an invented SIGKILL/terminated exit instead of the real one.
  //
  // `ignore` mode acks the prompt and then emits nothing, so nothing else can settle the exit
  // -- terminate() is the only candidate.
  const { context, workspacePath } = makeContext();
  const adapter = spawnAdapter({
    MOCK_DAEMON_SOCKET: join(workspacePath, '.mercury-sessions', 'daemon.sock'),
    MOCK_DAEMON_MODE: 'ignore',
  });
  try {
    const handle = await adapter.start(context);

    await handle.terminate();

    // Race against a deadline rather than awaiting: the bug IS that this promise never
    // settles, so a plain await would hang the runner instead of failing it. The bound is far
    // below the worker's 10s fabrication timeout -- that gap is the user-visible win.
    const TIMEOUT_MS = 5_000;
    const settledIn = Date.now();
    const outcome = await Promise.race([
      handle.exit.then((exit) => ({ kind: 'settled' as const, exit })),
      new Promise<{ kind: 'hung' }>((resolve) => setTimeout(() => resolve({ kind: 'hung' }), TIMEOUT_MS)),
    ]);

    // assert.fail returns never, so this narrows the union for the lines below.
    if (outcome.kind === 'hung') {
      assert.fail(`handle.exit never resolved after terminate() -- the worker would stall `
        + `${TIMEOUT_MS}ms+ and invent an exit reason instead of the real one`);
    }

    const elapsed = Date.now() - settledIn;
    assert.ok(elapsed < TIMEOUT_MS, `exit settled only after ${elapsed}ms`);
    // The reason must be the real one, not the worker's fabricated SIGKILL fallback.
    assert.equal(outcome.exit.reason, 'terminated', `expected the real 'terminated' reason, got ${JSON.stringify(outcome.exit)}`);
  } finally {
    await adapter.cancel(context.run.id);
  }
});

// NOTE (issue #55): an idempotency test for settleExit was written and deliberately
// removed. It asserted that tearing down after a natural end left the exit reason as
// 'completed', but that assertion CANNOT fail: a Promise ignores every resolve() after
// the first, so deleting the `if (session.exitSettled) return` guard left the test green.
// A test that cannot fail is worse than no test, because it reads as coverage. The guard
// is kept as defence in depth; the behaviour that actually matters -- terminate() settling
// the exit at all -- is covered by the test above, which does fail when the settle is
// removed.

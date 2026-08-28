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

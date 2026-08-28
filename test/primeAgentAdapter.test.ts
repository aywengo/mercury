// PrimeAgentAdapter tests against the mock prime-agent RPC server.
// Verifies the full adapter contract: start/events/exit, human input,
// cancellation, spawn failure, resume.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrimeAgentAdapter } from '../src/adapters/primeAgentAdapter.ts';
import type { Run, RunContext, ResolvedSkill } from '../src/domain/types.ts';

const MOCK = join(import.meta.dirname, 'fixtures', 'mock-prime-agent-rpc.mjs');

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: 'run_test',
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
  const workspacePath = mkdtempSync(join(tmpdir(), 'mercury-adapter-'));
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

function writeSkills(workspacePath: string, skills: ResolvedSkill[]): void {
  for (const skill of skills) {
    for (const [rel, content] of Object.entries(skill.files)) {
      const dest = join(workspacePath, '.agents', 'skills', skill.id, rel);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, content);
    }
  }
}

async function collectAll(handle: Awaited<ReturnType<PrimeAgentAdapter['start']>>): Promise<{
  events: { type: string; payload: unknown }[];
  exit: import('../src/domain/types.ts').AgentExit;
}> {
  const events: { type: string; payload: unknown }[] = [];
  for await (const ev of handle.events) {
    if (ev.type === '__done__') continue;
    events.push(ev);
  }
  const exit = await handle.exit;
  return { events, exit };
}

test('happy path: real RPC protocol -> translated Mercury events -> exit 0', async () => {
  const { context, workspacePath } = makeContext();
  const adapter = new PrimeAgentAdapter(MOCK);
  try {
    const handle = await adapter.start(context);
    const { events, exit } = await collectAll(handle);
    assert.equal(exit.code, 0);
    assert.equal(exit.reason, 'completed');
    const types = events.map((e) => e.type);
    assert.ok(types.includes('tool.started'));
    assert.ok(types.includes('tool.completed'));
    const messages = events.filter((e) => e.type === 'agent.message');
    assert.ok(messages.some((m) => String((m.payload as { text?: string }).text).includes('Hello from mock agent')));
    // context file + session path recorded
    assert.ok(existsSync(join(workspacePath, '.mercury-context.json')));
    assert.ok(existsSync(join(workspacePath, '.mercury-session-path')));
    assert.equal(readFileSync(join(workspacePath, '.mercury-session-path'), 'utf8').trim(), '/tmp/mock-session.jsonl');
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('skills are passed via --skill and written into the workspace', async () => {
  const { context, workspacePath } = makeContext();
  const skill: ResolvedSkill = {
    id: 'testing',
    version: '1.0.0',
    description: 'test skill',
    capabilities: ['testing'],
    path: '/unused',
    content: '# Testing\n',
    files: { 'SKILL.md': '# Testing\n' },
    hash: 'abc',
  };
  writeSkills(workspacePath, [skill]);
  const argvFile = join(workspacePath, 'argv.json');
  process.env.MOCK_RPC_ARGV_FILE = argvFile;
  const adapter = new PrimeAgentAdapter(MOCK, { args: ['--provider', 'omlx'] });
  try {
    const handle = await adapter.start({ ...context, skills: [skill] });
    await collectAll(handle);
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    assert.ok(argv.includes('--skill'));
    assert.ok(argv.includes(join(workspacePath, '.agents', 'skills', 'testing')));
    assert.ok(argv.includes('--provider'));
    assert.ok(argv.includes('omlx'));
    assert.ok(argv.includes('--session-dir'));
    assert.ok(argv.includes(join(workspacePath, '.mercury-sessions')));
  } finally {
    delete process.env.MOCK_RPC_ARGV_FILE;
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('human input: extension_ui_request -> input.required -> sendInput -> completion', async () => {
  const { context } = makeContext();
  const adapter = new PrimeAgentAdapter(MOCK, { args: [] });
  process.env.MOCK_RPC_MODE = 'input';
  try {
    const handle = await adapter.start({ ...context, run: makeRun({ id: 'run_input' }) });
    const events: { type: string; payload: unknown }[] = [];
    const iterator = handle.events[Symbol.asyncIterator]();
    let inputRequired: { type: string; payload: unknown } | null = null;
    for (let i = 0; i < 10; i++) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (value.type === '__done__') break;
      events.push(value);
      if (value.type === 'input.required') {
        inputRequired = value;
        break;
      }
    }
    assert.ok(inputRequired, 'expected input.required');
    const payload = inputRequired.payload as { requestId: string; method: string; title?: string };
    assert.equal(payload.method, 'input');
    assert.equal(payload.requestId, 'ui-1');
    await adapter.sendInput('run_input', { value: 'my answer', at: new Date().toISOString() });
    // drain the rest
    for await (const ev of handle.events) {
      if (ev.type === '__done__') break;
      events.push(ev);
    }
    const exit = await handle.exit;
    assert.equal(exit.code, 0);
    const messages = events.filter((e) => e.type === 'agent.message');
    assert.ok(messages.some((m) => String((m.payload as { text?: string }).text).includes('my answer')));
  } finally {
    delete process.env.MOCK_RPC_MODE;
    adapter.cancel('run_input').catch(() => {});
  }
});

test('spawn failure: command not found -> exit 127, reason failed', async () => {
  const { context } = makeContext();
  const adapter = new PrimeAgentAdapter('/nonexistent/prime-agent');
  const handle = await adapter.start(context);
  const { events, exit } = await collectAll(handle);
  assert.equal(exit.code, 127);
  assert.equal(exit.reason, 'failed');
  assert.equal(events.length, 0);
});

test('agent crash before agent_end -> exit with code, reason failed', async () => {
  const { context } = makeContext();
  const adapter = new PrimeAgentAdapter(MOCK);
  process.env.MOCK_RPC_MODE = 'fail';
  try {
    const handle = await adapter.start({ ...context, run: makeRun({ id: 'run_fail' }) });
    const { exit } = await collectAll(handle);
    assert.equal(exit.code, 1);
    assert.equal(exit.reason, 'failed');
  } finally {
    delete process.env.MOCK_RPC_MODE;
    adapter.cancel('run_fail').catch(() => {});
  }
});

test('cancel: cooperative abort then exit reason cancelled', async () => {
  const { context } = makeContext();
  const adapter = new PrimeAgentAdapter(MOCK);
  process.env.MOCK_RPC_MODE = 'hang';
  try {
    const handle = await adapter.start({ ...context, run: makeRun({ id: 'run_cancel' }) });
    await adapter.cancel('run_cancel');
    const exit = await handle.exit;
    assert.equal(exit.reason, 'cancelled');
  } finally {
    delete process.env.MOCK_RPC_MODE;
    adapter.cancel('run_cancel').catch(() => {});
  }
});

test('terminate (timeout path): exit reason terminated', async () => {
  const { context } = makeContext();
  const adapter = new PrimeAgentAdapter(MOCK);
  process.env.MOCK_RPC_MODE = 'hang';
  try {
    const handle = await adapter.start({ ...context, run: makeRun({ id: 'run_term' }) });
    await handle.terminate();
    const exit = await handle.exit;
    assert.equal(exit.reason, 'terminated');
  } finally {
    delete process.env.MOCK_RPC_MODE;
    adapter.cancel('run_term').catch(() => {});
  }
});

test('resume: respawns with --resume <sessionFile>', async () => {
  const { context, workspacePath } = makeContext();
  const adapter = new PrimeAgentAdapter(MOCK);
  const argvFile = join(workspacePath, 'argv-resume.json');
  try {
    const handle = await adapter.start(context);
    await collectAll(handle);
    // the RPC process stays alive after agent_end; stop it so resume() respawns
    await adapter.cancel(context.run.id).catch(() => {});
    process.env.MOCK_RPC_ARGV_FILE = argvFile;
    await adapter.resume(context.run.id);
    delete process.env.MOCK_RPC_ARGV_FILE;
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    assert.ok(argv.includes('--resume'));
    assert.ok(argv.includes('/tmp/mock-session.jsonl'));
    await adapter.cancel(context.run.id).catch(() => {});
  } finally {
    delete process.env.MOCK_RPC_ARGV_FILE;
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('trace context: run/worker ids are exported to the agent process env (section 25)', async () => {
  const { context, workspacePath } = makeContext();
  const runId = 'run_trace';
  const envFile = join(workspacePath, 'env.json');
  const adapter = new PrimeAgentAdapter(MOCK, { workerId: 'test-worker-1' });
  process.env.MOCK_RPC_ENV_FILE = envFile;
  try {
    const handle = await adapter.start({ ...context, run: makeRun({ id: runId }) });
    await collectAll(handle);
    const exported = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>;
    assert.equal(exported.MERCURY_RUN_ID, runId);
    assert.equal(exported.MERCURY_TRACE_ID, runId);
    assert.equal(exported.MERCURY_WORKER_ID, 'test-worker-1');
  } finally {
    delete process.env.MOCK_RPC_ENV_FILE;
    adapter.cancel(runId).catch(() => {});
  }
});

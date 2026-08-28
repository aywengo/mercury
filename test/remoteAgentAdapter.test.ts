// RemoteAgentAdapter tests against the generic mock remote agent HTTP server.
// Covers docs/agent-adapters.md section 5.5: create -> poll -> complete, event
// mapping, input round-trip, cancel, auth header presence, credential redaction,
// poll timeout, API failure, resume, config validation, registry loading.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RemoteAgentAdapter,
  validateRemoteAgentConfig,
  type RemoteAgentConfig,
} from '../src/adapters/remoteAgentAdapter.ts';
import { RemoteAgentRegistry } from '../src/adapters/remoteAgentRegistry.ts';
import type { AgentExit, Run, RunContext, ResolvedSkill } from '../src/domain/types.ts';

const MOCK = join(import.meta.dirname, 'fixtures', 'mock-remote-agent.mjs');

// --- mock server helper -----------------------------------------------------

const servers: ChildProcess[] = [];

before(() => {
  process.env.MERCURY_DEVIN_API_KEY = 'mock-token';
});

async function startMockServer(env: Record<string, string> = {}): Promise<{ port: number; proc: ChildProcess }> {
  const proc = spawn(process.execPath, [MOCK], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(proc);
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock server did not start')), 5000);
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const m = text.match(/LISTENING (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`mock server exited early: ${code}`));
    });
  });
  return { port, proc };
}

after(() => {
  for (const p of servers) p.kill('SIGKILL');
});

// --- helpers ----------------------------------------------------------------

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: 'run_remote',
    ownerId: 'alice',
    task: 'Fix the failing integration tests',
    repository: { localPath: '/tmp/repo' },
    workspaceBranch: null,
    workspacePath: null,
    agent: 'devin',
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

function makeContext(opts: { run?: Run; skills?: ResolvedSkill[] } = {}): {
  context: RunContext;
  workspacePath: string;
} {
  const workspacePath = mkdtempSync(join(tmpdir(), 'mercury-remote-'));
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

/** The "devin" config from docs/agent-adapters.md section 5.4. */
function devinConfig(port: number, overrides: Partial<RemoteAgentConfig> = {}): RemoteAgentConfig {
  return {
    id: 'devin',
    description: 'mock devin',
    api: {
      baseUrl: `http://127.0.0.1:${port}`,
      auth: { type: 'bearer', headerName: 'Authorization', envVar: 'MERCURY_DEVIN_API_KEY' },
      createTask: {
        method: 'POST', path: '/sessions',
        body: { prompt: '{task}', repository: '{workspace}' },
        idField: 'session.id',
      },
      getTask: {
        method: 'GET', path: '/sessions/{id}', statusField: 'status',
        statusMap: { running: 'running', blocked: 'running', success: 'completed', error: 'failed', cancelled: 'cancelled' },
      },
      events: { method: 'GET', path: '/sessions/{id}/events', eventField: 'events', eventTypeField: 'type' },
      sendInput: { method: 'POST', path: '/sessions/{id}/messages', body: { message: '{input}' } },
      cancel: { method: 'POST', path: '/sessions/{id}/cancel' },
    },
    poll: { intervalMs: 20, timeoutMs: 10_000 },
    eventMap: {
      started: 'step.started',
      message: 'agent.message',
      tool_started: 'tool.started',
      tool_completed: 'tool.completed',
      error: 'error',
    },
    ...overrides,
  };
}

async function collectAll(handle: Awaited<ReturnType<RemoteAgentAdapter['start']>>): Promise<{
  events: { type: string; payload: unknown }[];
  exit: AgentExit;
}> {
  const events: { type: string; payload: unknown }[] = [];
  for await (const ev of handle.events) {
    if (ev.type === '__done__') continue;
    events.push(ev);
  }
  const exit = await handle.exit;
  return { events, exit };
}

/** Set the credential env var for the duration of a test body. */
async function withCredential<T>(fn: () => Promise<T>): Promise<T> {
  process.env.MERCURY_DEVIN_API_KEY = 'mock-token';
  try {
    return await fn();
  } finally {
    delete process.env.MERCURY_DEVIN_API_KEY;
  }
}

// --- tests ------------------------------------------------------------------

test('happy path: create -> poll -> complete with mapped events', async () => {
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'happy' });
  const { context } = makeContext();
  const adapter = new RemoteAgentAdapter(devinConfig(port));
  const handle = await adapter.start(context);
  const { events, exit } = await collectAll(handle);
  assert.equal(exit.code, 0);
  assert.equal(exit.reason, 'completed');
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['step.started', 'agent.message', 'tool.started', 'tool.completed']);
  const msg = events.find((e) => e.type === 'agent.message');
  assert.equal((msg!.payload as { text: string }).text, 'hello from remote');
});

test('createTask body templating: {task} and {workspace} placeholders', async () => {
  const logFile = join(tmpdir(), `remote-log-${Date.now()}.jsonl`);
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'happy', MOCK_REMOTE_LOG: logFile });
  const { context, workspacePath } = makeContext();
  const adapter = new RemoteAgentAdapter(devinConfig(port));
  const handle = await adapter.start(context);
  await collectAll(handle);
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const create = lines.find((l) => l.method === 'POST' && l.path === '/sessions');
  assert.ok(create, 'createTask request logged');
  assert.equal(create.body.prompt, 'Fix the failing integration tests');
  assert.equal(create.body.repository, workspacePath);
});

test('auth header: bearer token sent on every request', async () => {
  const logFile = join(tmpdir(), `remote-auth-${Date.now()}.jsonl`);
  const { port } = await startMockServer({
    MOCK_REMOTE_MODE: 'happy',
    MOCK_REMOTE_REQUIRE_AUTH: '1',
    MOCK_REMOTE_TOKEN: 'secret-token-123',
    MOCK_REMOTE_LOG: logFile,
  });
  const { context } = makeContext();
  process.env.MERCURY_DEVIN_API_KEY = 'secret-token-123';
  try {
    const adapter = new RemoteAgentAdapter(devinConfig(port));
    const handle = await adapter.start(context);
    const { exit } = await collectAll(handle);
    assert.equal(exit.reason, 'completed');
  } finally {
    delete process.env.MERCURY_DEVIN_API_KEY;
  }
  // all requests authenticated (mock would 401 otherwise)
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 4, 'multiple requests logged');
});

test('missing credential -> start throws (infrastructure failure)', async () => {
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'happy' });
  const { context } = makeContext();
  const adapter = new RemoteAgentAdapter(devinConfig(port));
  delete process.env.MERCURY_DEVIN_API_KEY;
  try {
    await assert.rejects(() => adapter.start(context), /MERCURY_DEVIN_API_KEY/);
  } finally {
    process.env.MERCURY_DEVIN_API_KEY = 'mock-token'; // restore for later tests
  }
});

test('credential never appears in events or run payloads', async () => {
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'happy' });
  const { context } = makeContext();
  process.env.MERCURY_DEVIN_API_KEY = 'super-secret-credential-xyz';
  try {
    const adapter = new RemoteAgentAdapter(devinConfig(port));
    const handle = await adapter.start(context);
    const { events, exit } = await collectAll(handle);
    assert.equal(exit.reason, 'completed');
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('super-secret-credential-xyz'), 'credential leaked into events');
  } finally {
    process.env.MERCURY_DEVIN_API_KEY = 'mock-token'; // restore for later tests
  }
});

test('input round-trip: ask -> input.required -> sendInput -> agent continues', async () => {
  const inputFile = join(tmpdir(), `remote-input-${Date.now()}.jsonl`);
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'input', MOCK_REMOTE_INPUT_FILE: inputFile });
  const { context } = makeContext();
  const adapter = new RemoteAgentAdapter(devinConfig(port, {
    eventMap: { started: 'step.started', ask: 'input.required', message: 'agent.message' },
  }));
  const handle = await adapter.start(context);

  const events: { type: string; payload: unknown }[] = [];
  const iterator = handle.events[Symbol.asyncIterator]();
  let next = await iterator.next();
  let asked = false;
  while (!next.done) {
    if (next.value.type === 'input.required') {
      asked = true;
      const askPayload = next.value.payload as { question: string };
      assert.equal(askPayload.question, 'Continue?');
      await adapter.sendInput(handle.runId, { value: 'yes', at: new Date().toISOString() });
    } else {
      events.push(next.value);
    }
    next = await iterator.next();
  }
  assert.ok(asked, 'expected input.required');
  const exit = await handle.exit;
  assert.equal(exit.reason, 'completed');
  const msg = events.find((e) => e.type === 'agent.message');
  assert.equal((msg!.payload as { text: string }).text, 'got: yes');
  // input reached the vendor with the {input} placeholder replaced
  const inputs = readFileSync(inputFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(inputs[0].message, 'yes');
});

test('cancel: POST cancel endpoint, exit reason cancelled', async () => {
  const cancelFile = join(tmpdir(), `remote-cancel-${Date.now()}.txt`);
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'hang', MOCK_REMOTE_CANCEL_FILE: cancelFile });
  const { context } = makeContext();
  const adapter = new RemoteAgentAdapter(devinConfig(port));
  const handle = await adapter.start(context);
  // let a few polls happen
  await new Promise((r) => setTimeout(r, 150));
  await adapter.cancel(handle.runId);
  const exit = await handle.exit;
  assert.equal(exit.reason, 'cancelled');
  const cancelled = readFileSync(cancelFile, 'utf8').trim();
  assert.ok(cancelled.startsWith('sess-'), 'cancel endpoint called with session id');
});

test('cancel without cancel endpoint: marks cancelled locally', async () => {
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'hang' });
  const { context } = makeContext();
  const adapter = new RemoteAgentAdapter(devinConfig(port, {
    api: { ...devinConfig(port).api, cancel: undefined },
  }));
  const handle = await adapter.start(context);
  await new Promise((r) => setTimeout(r, 150));
  await adapter.cancel(handle.runId);
  const exit = await handle.exit;
  assert.equal(exit.reason, 'cancelled');
});

test('terminate: exit reason terminated', async () => {
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'hang' });
  const { context } = makeContext();
  const adapter = new RemoteAgentAdapter(devinConfig(port));
  const handle = await adapter.start(context);
  await new Promise((r) => setTimeout(r, 150));
  await handle.terminate();
  const exit = await handle.exit;
  assert.equal(exit.reason, 'terminated');
});

test('agent failure: status error -> exit failed', async () => {
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'fail' });
  const { context } = makeContext();
  const adapter = new RemoteAgentAdapter(devinConfig(port));
  const handle = await adapter.start(context);
  const { exit } = await collectAll(handle);
  assert.equal(exit.code, 1);
  assert.equal(exit.reason, 'failed');
});

test('poll timeout: exit reason timeout', async () => {
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'hang' });
  const { context } = makeContext();
  const adapter = new RemoteAgentAdapter(devinConfig(port, {
    poll: { intervalMs: 20, timeoutMs: 200 },
  }));
  const handle = await adapter.start(context);
  const { exit } = await collectAll(handle);
  assert.equal(exit.reason, 'timeout');
});

test('transient API failure: keeps polling and completes', async () => {
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'api-fail' });
  const { context } = makeContext();
  const adapter = new RemoteAgentAdapter(devinConfig(port));
  const handle = await adapter.start(context);
  const { events, exit } = await collectAll(handle);
  assert.equal(exit.reason, 'completed');
  assert.ok(events.length > 0, 'events still emitted after transient failures');
});

test('resume: re-attaches to the existing task id without creating a new task', async () => {
  const logFile = join(tmpdir(), `remote-resume-${Date.now()}.jsonl`);
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'happy', MOCK_REMOTE_LOG: logFile });
  const { context } = makeContext();
  const adapter = new RemoteAgentAdapter(devinConfig(port));
  const handle = await adapter.start(context);
  const { exit } = await collectAll(handle);
  assert.equal(exit.reason, 'completed');

  await adapter.resume(handle.runId);
  const { exit: exit2 } = await collectAll(handle);
  assert.equal(exit2.reason, 'completed');

  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const creates = lines.filter((l) => l.method === 'POST' && l.path === '/sessions');
  assert.equal(creates.length, 1, 'resume must not create a new task');
});

test('resume without task id -> throws', async () => {
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'fail' });
  const { context } = makeContext();
  const adapter = new RemoteAgentAdapter(devinConfig(port));
  const handle = await adapter.start(context);
  await collectAll(handle);
  // simulate a session with no task id (createTask failed path is covered by start throwing)
  const session = (adapter as unknown as { sessions: Map<string, { taskId: string | null }> }).sessions.get(handle.runId)!;
  session.taskId = null;
  await assert.rejects(() => adapter.resume(handle.runId), /No remote task id/);
});

test('config validation rejects bad configs', () => {
  assert.throws(() => validateRemoteAgentConfig({} as RemoteAgentConfig), /id is required/);
  assert.throws(
    () => validateRemoteAgentConfig({ id: 'x', description: 'd', api: { baseUrl: 'ftp://x', auth: { type: 'bearer', headerName: 'Authorization', envVar: 'K' }, createTask: { method: 'POST', path: '/s', body: {}, idField: 'id' }, getTask: { method: 'GET', path: '/s/{id}', statusField: 'status', statusMap: { ok: 'completed' } }, poll: { intervalMs: 100, timeoutMs: 1000 }, eventMap: {} } } as unknown as RemoteAgentConfig),
    /http\(s\) URL/,
  );
  assert.throws(
    () => validateRemoteAgentConfig({ id: 'x', description: 'd', api: { baseUrl: 'http://x', auth: { type: 'bearer', envVar: 'K' }, createTask: { method: 'POST', path: '/s', body: {}, idField: 'id' }, getTask: { method: 'GET', path: '/s/{id}', statusField: 'status', statusMap: { ok: 'completed' } }, poll: { intervalMs: 100, timeoutMs: 1000 }, eventMap: {} } } as unknown as RemoteAgentConfig),
    /headerName required/,
  );
  assert.throws(
    () => validateRemoteAgentConfig({ id: 'x', description: 'd', api: { baseUrl: 'http://x', auth: { type: 'bearer', headerName: 'Authorization', envVar: 'K' }, createTask: { method: 'POST', path: '/s', body: {}, idField: 'id' }, getTask: { method: 'GET', path: '/s/{id}', statusField: 'status', statusMap: {} }, poll: { intervalMs: 100, timeoutMs: 1000 }, eventMap: {} } } as unknown as RemoteAgentConfig),
    /statusMap/,
  );
});

test('registry: loads JSON configs from a directory', async () => {
  const { port } = await startMockServer({ MOCK_REMOTE_MODE: 'happy' });
  const dir = mkdtempSync(join(tmpdir(), 'mercury-remote-agents-'));
  writeFileSync(join(dir, 'devin.json'), JSON.stringify(devinConfig(port)));
  writeFileSync(join(dir, 'not-a-config.txt'), 'ignored');
  const registry = new RemoteAgentRegistry(dir);
  const adapters = registry.load();
  assert.ok(adapters['devin'] instanceof RemoteAgentAdapter);
  assert.equal(Object.keys(adapters).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('registry: missing dir -> no agents', () => {
  const registry = new RemoteAgentRegistry(join(tmpdir(), 'does-not-exist-' + Date.now()));
  assert.deepEqual(registry.load(), {});
});

test('registry: invalid config file -> throws with file path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-remote-agents-'));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'bad' }));
  const registry = new RemoteAgentRegistry(dir);
  assert.throws(() => registry.load(), /bad.json/);
  rmSync(dir, { recursive: true, force: true });
});

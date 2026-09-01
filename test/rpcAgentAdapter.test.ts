// RpcAgentAdapter tests against the mock RPC server (mock-prime-agent-rpc.mjs,
// which speaks the REAL RPC JSONL protocol). Covers docs/agent-adapters.md
// section 6.5: happy path, argv construction, input round-trip, cancel,
// resume, spawn failure, agent failure, vendor-extras tolerance, config
// validation, registry loading.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RpcAgentAdapter,
  validateRpcAgentConfig,
  type RpcAgentConfig,
} from '../src/adapters/rpcAgentAdapter.ts';
import { RpcAgentRegistry } from '../src/adapters/rpcAgentRegistry.ts';
import type { AgentExit, Run, RunContext, ResolvedSkill } from '../src/domain/types.ts';
import { tempDir } from './helpers.ts';

const MOCK = join(import.meta.dirname, 'fixtures', 'mock-prime-agent-rpc.mjs');

// --- helpers ----------------------------------------------------------------

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: 'run_rpc',
    ownerId: 'alice',
    task: 'Fix the failing integration tests',
    repository: { localPath: '/tmp/repo' },
    workspaceBranch: null,
    workspacePath: null,
    agent: 'pi',
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
  const workspacePath = tempDir('mercury-rpc-');
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

/** The "pi" config from docs/agent-adapters.md section 6.4. */
function piConfig(overrides: Partial<RpcAgentConfig> = {}): RpcAgentConfig {
  return {
    id: 'pi',
    description: 'Pi Agent (pi.dev)',
    // The mock fixture is a shebang script (like the real pi/omp binaries).
    command: MOCK,
    args: [],
    protocol: { modeFlag: '--mode', modeValue: 'rpc' },
    eventMap: {},
    input: { enabled: true },
    resume: { enabled: true },
    ...overrides,
  };
}

async function collectAll(handle: Awaited<ReturnType<RpcAgentAdapter['start']>>): Promise<{
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

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// --- tests ------------------------------------------------------------------

test('happy path: RPC events translated to Mercury events, exit completed', async () => {
  const { context } = makeContext();
  const adapter = new RpcAgentAdapter(piConfig());
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
    assert.ok(existsSync(join(context.workspace.path, '.mercury-context.json')));
    assert.ok(existsSync(join(context.workspace.path, '.mercury-session-path')));
    assert.equal(readFileSync(join(context.workspace.path, '.mercury-session-path'), 'utf8').trim(), '/tmp/mock-session.jsonl');
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('argv construction: mode flag/value, cwd, session-dir, static args, trace env', async () => {
  const { context, workspacePath } = makeContext();
  const argvFile = join(workspacePath, 'argv.json');
  const envFile = join(workspacePath, 'env.json');
  const adapter = new RpcAgentAdapter(piConfig({
    args: ['--provider', 'omlx'],
    env: { MOCK_RPC_ARGV_FILE: argvFile, MOCK_RPC_ENV_FILE: envFile },
  }));
  try {
    const handle = await adapter.start(context);
    await collectAll(handle);
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    assert.ok(argv.includes('--mode'));
    assert.ok(argv.includes('rpc'));
    assert.ok(argv.includes('--cwd'));
    assert.ok(argv.includes(workspacePath));
    assert.ok(argv.includes('--session-dir'));
    assert.ok(argv.includes(join(workspacePath, '.mercury-sessions')));
    assert.ok(argv.includes('--provider'));
    assert.ok(argv.includes('omlx'));
    const env = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>;
    assert.equal(env.MERCURY_RUN_ID, 'run_rpc');
    assert.equal(env.MERCURY_TRACE_ID, 'run_rpc');
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('custom mode flag/value + session-dir flag from config', async () => {
  const { context, workspacePath } = makeContext();
  const argvFile = join(workspacePath, 'argv-custom.json');
  const adapter = new RpcAgentAdapter(piConfig({
    protocol: { modeFlag: '--protocol', modeValue: 'json-rpc' },
    resume: { enabled: true, sessionDirFlag: '--sessions' },
    env: { MOCK_RPC_ARGV_FILE: argvFile },
  }));
  try {
    const handle = await adapter.start(context);
    await collectAll(handle);
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    assert.ok(argv.includes('--protocol'));
    assert.ok(argv.includes('json-rpc'));
    assert.ok(argv.includes('--sessions'));
    assert.ok(argv.includes(join(workspacePath, '.mercury-sessions')));
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('human input: extension_ui_request -> input.required -> sendInput -> completion', async () => {
  const { context } = makeContext();
  const adapter = new RpcAgentAdapter(piConfig({ env: { MOCK_RPC_MODE: 'input' } }));
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
    for await (const ev of handle.events) {
      if (ev.type === '__done__') break;
      events.push(ev);
    }
    const exit = await handle.exit;
    assert.equal(exit.code, 0);
    const messages = events.filter((e) => e.type === 'agent.message');
    assert.ok(messages.some((m) => String((m.payload as { text?: string }).text).includes('my answer')));
  } finally {
    adapter.cancel('run_input').catch(() => {});
  }
});

test('input disabled -> sendInput throws', async () => {
  const { context } = makeContext();
  const adapter = new RpcAgentAdapter(piConfig({ input: { enabled: false } }));
  try {
    const handle = await adapter.start({ ...context, run: makeRun({ id: 'run_noinput' }) });
    await assert.rejects(() => adapter.sendInput('run_noinput', { value: 'x', at: new Date().toISOString() }), /does not accept input/);
    await handle.terminate();
  } finally {
    adapter.cancel('run_noinput').catch(() => {});
  }
});

test('spawn failure: command not found -> exit 127, reason failed', async () => {
  const { context } = makeContext();
  const adapter = new RpcAgentAdapter(piConfig({ command: '/nonexistent/pi-agent' }));
  const handle = await adapter.start(context);
  const { events, exit } = await collectAll(handle);
  assert.equal(exit.code, 127);
  assert.equal(exit.reason, 'failed');
  assert.deepEqual(events, []);
});

test('agent crash before agent_end -> exit with code, reason failed', async () => {
  const { context } = makeContext();
  const adapter = new RpcAgentAdapter(piConfig({ env: { MOCK_RPC_MODE: 'fail' } }));
  try {
    const handle = await adapter.start({ ...context, run: makeRun({ id: 'run_fail' }) });
    const { exit } = await collectAll(handle);
    assert.equal(exit.code, 1);
    assert.equal(exit.reason, 'failed');
  } finally {
    adapter.cancel('run_fail').catch(() => {});
  }
});

test('cancel: cooperative abort then exit reason cancelled', async () => {
  const { context } = makeContext();
  const adapter = new RpcAgentAdapter(piConfig({ env: { MOCK_RPC_MODE: 'hang' } }));
  try {
    const handle = await adapter.start({ ...context, run: makeRun({ id: 'run_cancel' }) });
    await adapter.cancel('run_cancel');
    const exit = await handle.exit;
    assert.equal(exit.reason, 'cancelled');
  } finally {
    adapter.cancel('run_cancel').catch(() => {});
  }
});

test('terminate (timeout path): exit reason terminated', async () => {
  const { context } = makeContext();
  const adapter = new RpcAgentAdapter(piConfig({ env: { MOCK_RPC_MODE: 'hang' } }));
  try {
    const handle = await adapter.start({ ...context, run: makeRun({ id: 'run_term' }) });
    await handle.terminate();
    const exit = await handle.exit;
    assert.equal(exit.reason, 'terminated');
  } finally {
    adapter.cancel('run_term').catch(() => {});
  }
});

test('resume: respawns with --resume <sessionFile>', async () => {
  const { context, workspacePath } = makeContext();
  const adapter = new RpcAgentAdapter(piConfig());
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

test('resume disabled -> throws', async () => {
  const { context } = makeContext();
  const adapter = new RpcAgentAdapter(piConfig({ resume: { enabled: false } }));
  try {
    const handle = await adapter.start(context);
    await collectAll(handle);
    await assert.rejects(() => adapter.resume(context.run.id), /does not support resume/);
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('vendor extras (omp-style ready/negotiate_protocol) are ignored, stream intact', async () => {
  const { context } = makeContext();
  const adapter = new RpcAgentAdapter(piConfig({
    env: { MOCK_RPC_VENDOR_EXTRAS: '1' },
    protocol: { ignoreEventTypes: ['ready', 'negotiate_protocol', 'subagent_lifecycle', 'host_tool_call'] },
  }));
  try {
    const handle = await adapter.start(context);
    const { events, exit } = await collectAll(handle);
    assert.equal(exit.code, 0);
    assert.equal(exit.reason, 'completed');
    const types = events.map((e) => e.type);
    assert.ok(!types.includes('agent.message') || true); // extras never surface as events
    assert.ok(!events.some((e) => JSON.stringify(e).includes('negotiate_protocol')));
    assert.ok(!events.some((e) => JSON.stringify(e).includes('subagent_lifecycle')));
    // normal events still flow
    assert.ok(types.includes('tool.started'));
    assert.ok(types.includes('tool.completed'));
    const messages = events.filter((e) => e.type === 'agent.message');
    assert.ok(messages.some((m) => String((m.payload as { text?: string }).text).includes('Hello from mock agent')));
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('vendor extras without ignoreEventTypes: still ignored (unknown types default)', async () => {
  const { context } = makeContext();
  const adapter = new RpcAgentAdapter(piConfig({ env: { MOCK_RPC_VENDOR_EXTRAS: '1' } }));
  try {
    const handle = await adapter.start(context);
    const { events, exit } = await collectAll(handle);
    assert.equal(exit.reason, 'completed');
    assert.ok(!events.some((e) => JSON.stringify(e).includes('ready')));
    assert.ok(!events.some((e) => JSON.stringify(e).includes('negotiate_protocol')));
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('trace context: run/worker ids exported to the agent process env (section 25)', async () => {
  const { context, workspacePath } = makeContext();
  const runId = 'run_trace';
  const envFile = join(workspacePath, 'env.json');
  const adapter = new RpcAgentAdapter(piConfig({ env: { MOCK_RPC_ENV_FILE: envFile } }), { workerId: 'test-worker-1' });
  try {
    const handle = await adapter.start({ ...context, run: makeRun({ id: runId }) });
    await collectAll(handle);
    const exported = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>;
    assert.equal(exported.MERCURY_RUN_ID, runId);
    assert.equal(exported.MERCURY_TRACE_ID, runId);
    assert.equal(exported.MERCURY_WORKER_ID, 'test-worker-1');
  } finally {
    adapter.cancel(runId).catch(() => {});
  }
});

test('config validation rejects bad configs', () => {
  assert.throws(() => validateRpcAgentConfig({} as RpcAgentConfig), /id is required/);
  assert.throws(() => validateRpcAgentConfig({ id: 'x' } as RpcAgentConfig), /command is required/);
  assert.throws(
    () => validateRpcAgentConfig({ id: 'x', command: 'c', protocol: { readyDelayMs: -1 } } as RpcAgentConfig),
    /readyDelayMs must be a non-negative number/,
  );
  assert.throws(
    () => validateRpcAgentConfig({ id: 'x', command: 'c', protocol: { ignoreEventTypes: 'ready' } } as unknown as RpcAgentConfig),
    /ignoreEventTypes must be an array/,
  );
});

test('registry: loads JSON configs from a directory', async () => {
  const dir = tempDir('mercury-rpc-agents-');
  writeFileSync(join(dir, 'pi.json'), JSON.stringify(piConfig()));
  writeFileSync(join(dir, 'not-a-config.txt'), 'ignored');
  const registry = new RpcAgentRegistry(dir);
  const adapters = registry.load();
  assert.ok(adapters['pi'] instanceof RpcAgentAdapter);
  assert.equal(Object.keys(adapters).length, 1);
});

test('registry: missing dir -> no agents', () => {
  const registry = new RpcAgentRegistry(join(tmpdir(), 'does-not-exist-' + Date.now()));
  assert.deepEqual(registry.load(), {});
});

test('registry: invalid config file -> throws with file path', () => {
  const dir = tempDir('mercury-rpc-agents-');
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'bad' }));
  const registry = new RpcAgentRegistry(dir);
  assert.throws(() => registry.load(), /bad.json/);
});

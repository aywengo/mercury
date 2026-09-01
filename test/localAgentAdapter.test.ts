// LocalAgentAdapter tests against the generic mock local agent fixture.
// Covers docs/agent-adapters.md section 4.4: happy path, event mapping,
// input round-trip, cancel, resume, spawn failure, timeout/terminate,
// json/text output, argv/env construction, registry loading.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalAgentAdapter,
  validateLocalAgentConfig,
  type LocalAgentConfig,
} from '../src/adapters/localAgentAdapter.ts';
import { LocalAgentRegistry } from '../src/adapters/localAgentRegistry.ts';
import type { AgentExit, Run, RunContext, ResolvedSkill } from '../src/domain/types.ts';
import { tempDir, tempFile } from './helpers.ts';

const MOCK = join(import.meta.dirname, 'fixtures', 'mock-local-agent.mjs');

// --- helpers ----------------------------------------------------------------

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: 'run_local',
    ownerId: 'alice',
    task: 'Fix the failing integration tests',
    repository: { localPath: '/tmp/repo' },
    workspaceBranch: null,
    workspacePath: null,
    agent: 'my-agent',
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
  const workspacePath = tempDir('mercury-local-');
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

/** The "my-agent" config from docs/agent-adapters.md section 4.3 (jsonl variant). */
function jsonlConfig(overrides: Partial<LocalAgentConfig> = {}): LocalAgentConfig {
  return {
    id: 'my-agent',
    description: 'hypothetical jsonl agent',
    command: process.execPath,
    args: [MOCK],
    taskInput: { mode: 'arg', flag: '--task' },
    output: { format: 'jsonl', stream: true, eventPath: 'type' },
    eventMap: {
      started: 'step.started',
      message: 'agent.message',
      toolStarted: 'tool.started',
      toolCompleted: 'tool.completed',
      toolFailed: 'tool.failed',
      completed: 'done',
    },
    input: { mode: 'stdin', promptEvent: 'ask' },
    cancel: { signal: 'SIGTERM', graceMs: 200 },
    resume: { flag: '--resume', sessionIdSource: 'event', sessionIdPath: 'session_id' },
    ...overrides,
  };
}

async function collectAll(handle: Awaited<ReturnType<LocalAgentAdapter['start']>>): Promise<{
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

test('happy path: jsonl events mapped to Mercury events, exit completed', async () => {
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig());
  const handle = await adapter.start(context);
  const { events, exit } = await collectAll(handle);
  assert.equal(exit.code, 0);
  assert.equal(exit.reason, 'completed');
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['step.started', 'agent.message', 'tool.started', 'tool.completed']);
  const msg = events.find((e) => e.type === 'agent.message');
  assert.equal((msg!.payload as { text: string }).text, 'hello from mock');
});

test('argv construction: task flag, skills flags, sandbox policy flags', async () => {
  const argvFile = tempFile('argv', 'json');
  const envFile = tempFile('env', 'json');
  const { context } = makeContext({
    skills: [
      { id: 'git-pr', version: '1', description: '', capabilities: [], path: '', content: '', hash: '', files: {} },
      { id: 'testing', version: '1', description: '', capabilities: [], path: '', content: '', hash: '', files: {} },
    ],
  });
  const adapter = new LocalAgentAdapter(jsonlConfig({
    env: { MOCK_LOCAL_ARGV_FILE: argvFile, MOCK_LOCAL_ENV_FILE: envFile },
    skills: { flag: '--allowedTools', values: { 'git-pr': 'Bash(git *)', testing: 'Bash(npm test)' } },
    sandbox: { policyFlag: '--sandbox', policyValue: 'workspace-write' },
  }));
  const handle = await adapter.start(context);
  await collectAll(handle);

  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
  assert.ok(argv.includes('--task'));
  assert.ok(argv.includes('Fix the failing integration tests'));
  assert.ok(argv.includes('--allowedTools'));
  assert.ok(argv.includes('Bash(git *)'));
  assert.ok(argv.includes('Bash(npm test)'));
  assert.ok(argv.includes('--sandbox'));
  assert.ok(argv.includes('workspace-write'));

  const env = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>;
  assert.equal(env.MERCURY_RUN_ID, 'run_local');
  assert.equal(env.MERCURY_TRACE_ID, 'run_local');
});

test('task via stdin mode', async () => {
  const argvFile = tempFile('argv-stdin', 'json');
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({
    taskInput: { mode: 'stdin' },
    args: [MOCK],
    env: { MOCK_LOCAL_ARGV_FILE: argvFile },
  }));
  const handle = await adapter.start(context);
  const { exit } = await collectAll(handle);
  assert.equal(exit.reason, 'completed');
  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
  assert.ok(!argv.includes('--task')); // task went via stdin, not argv
});

test('task via file mode: task written to workspace, flag points at it', async () => {
  const argvFile = tempFile('argv-file', 'json');
  const { context, workspacePath } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({
    taskInput: { mode: 'file', flag: '--task-file', filePath: 'task.txt' },
    args: [MOCK],
    env: { MOCK_LOCAL_ARGV_FILE: argvFile },
  }));
  const handle = await adapter.start(context);
  const { exit } = await collectAll(handle);
  assert.equal(exit.reason, 'completed');
  assert.equal(readFileSync(join(workspacePath, 'task.txt'), 'utf8'), 'Fix the failing integration tests');
  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
  assert.ok(argv.includes('--task-file'));
  assert.ok(argv.includes('task.txt'));
});

test('input round-trip: ask -> input.required -> sendInput -> agent continues', async () => {
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({ args: [MOCK], env: { MOCK_LOCAL_MODE: 'input' } }));
  const handle = await adapter.start(context);

  const events: { type: string; payload: unknown }[] = [];
  const iterator = handle.events[Symbol.asyncIterator]();
  let next = await iterator.next();
  let asked = false;
  while (!next.done) {
    if (next.value.type === 'input.required') {
      asked = true;
      const askPayload = next.value.payload as { question: string; options: string[] };
      assert.equal(askPayload.question, 'Continue?');
      assert.deepEqual(askPayload.options, ['yes', 'no']);
      await adapter.sendInput(handle.runId, { value: 'yes', at: new Date().toISOString() });
    } else {
      events.push(next.value);
    }
    next = await iterator.next();
  }
  assert.ok(asked, 'expected input.required');
  const exit = await handle.exit;
  assert.equal(exit.reason, 'completed');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('agent.message'));
  const msg = events.find((e) => e.type === 'agent.message');
  assert.equal((msg!.payload as { text: string }).text, 'got: yes');
});

test('cancel: SIGTERM then grace -> exit reason cancelled', async () => {
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({ args: [MOCK], env: { MOCK_LOCAL_MODE: 'hang' } }));
  const handle = await adapter.start(context);
  // wait until the agent is up
  await new Promise((r) => setTimeout(r, 300));
  await adapter.cancel(handle.runId);
  const exit = await handle.exit;
  assert.equal(exit.reason, 'cancelled');
});

test('cancel via stdin signal mode', async () => {
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({
    args: [MOCK],
    env: { MOCK_LOCAL_MODE: 'hang' },
    cancel: { signal: 'stdin', graceMs: 200 },
  }));
  const handle = await adapter.start(context);
  await new Promise((r) => setTimeout(r, 300));
  await adapter.cancel(handle.runId);
  const exit = await handle.exit;
  assert.equal(exit.reason, 'cancelled');
});

test('spawn failure: command not found -> exit failed', async () => {
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({ command: '/nonexistent/agent-binary' }));
  const handle = await adapter.start(context);
  const { events, exit } = await collectAll(handle);
  assert.equal(exit.code, 127);
  assert.equal(exit.reason, 'failed');
  assert.deepEqual(events, []);
});

test('agent failure: non-zero exit -> exit failed', async () => {
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({ args: [MOCK], env: { MOCK_LOCAL_MODE: 'fail' } }));
  const handle = await adapter.start(context);
  const { exit } = await collectAll(handle);
  assert.equal(exit.code, 1);
  assert.equal(exit.reason, 'failed');
});

test('terminate: SIGKILL -> exit reason terminated', async () => {
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({ args: [MOCK], env: { MOCK_LOCAL_MODE: 'hang' } }));
  const handle = await adapter.start(context);
  await new Promise((r) => setTimeout(r, 300));
  await handle.terminate();
  const exit = await handle.exit;
  assert.equal(exit.reason, 'terminated');
});

test('json output: single doc parsed at exit, message + completed', async () => {
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({
    args: [MOCK],
    env: { MOCK_LOCAL_MODE: 'json' },
    output: { format: 'json', stream: false },
    eventMap: { message: 'agent.message', completed: 'result' },
  }));
  const handle = await adapter.start(context);
  const { events, exit } = await collectAll(handle);
  assert.equal(exit.reason, 'completed');
  const msg = events.find((e) => e.type === 'agent.message');
  assert.equal((msg!.payload as { text: string }).text, 'hi from json');
});

test('text output: lines become agent.message events', async () => {
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({
    args: [MOCK],
    env: { MOCK_LOCAL_MODE: 'text' },
    output: { format: 'text' },
    eventMap: {},
  }));
  const handle = await adapter.start(context);
  const { events, exit } = await collectAll(handle);
  assert.equal(exit.reason, 'completed');
  const texts = events.filter((e) => e.type === 'agent.message').map((e) => (e.payload as { text: string }).text);
  assert.deepEqual(texts, ['line one', 'line two']);
});

test('resume: respawns with --resume <sessionId> captured from events', async () => {
  const argvFile = tempFile('argv-resume', 'json');
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({ args: [MOCK], env: { MOCK_LOCAL_ARGV_FILE: argvFile } }));
  const handle = await adapter.start(context);
  const { exit } = await collectAll(handle);
  assert.equal(exit.reason, 'completed');

  await adapter.resume(handle.runId);
  await waitFor(() => {
    try {
      const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
      return argv.includes('--resume');
    } catch {
      return false;
    }
  });
  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
  assert.ok(argv.includes('--resume'));
  assert.ok(argv[argv.indexOf('--resume') + 1].startsWith('sess-'));
});

test('resume without session id -> throws', async () => {
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({
    args: [MOCK],
    env: { MOCK_LOCAL_MODE: 'fail' }, // no done event -> no session id captured
  }));
  const handle = await adapter.start(context);
  await collectAll(handle);
  await assert.rejects(() => adapter.resume(handle.runId), /No session id/);
});

test('resume unsupported -> throws', async () => {
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({ resume: undefined }));
  const handle = await adapter.start(context);
  await collectAll(handle);
  await assert.rejects(() => adapter.resume(handle.runId), /does not support resume/);
});

test('flag-mode input: agent exits waiting, sendInput respawns with answer flag', async () => {
  const argvFile = tempFile('argv-flag', 'json');
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({
    args: [MOCK],
    env: { MOCK_LOCAL_MODE: 'input-flag', MOCK_LOCAL_ARGV_FILE: argvFile },
    input: { mode: 'flag', flag: '--answer', promptEvent: 'ask' },
  }));
  const handle = await adapter.start(context);

  const events: { type: string; payload: unknown }[] = [];
  const iterator = handle.events[Symbol.asyncIterator]();
  let next = await iterator.next();
  let asked = false;
  while (!next.done) {
    if (next.value.type === 'input.required') {
      asked = true;
      await adapter.sendInput(handle.runId, { value: 'yes', at: new Date().toISOString() });
    } else {
      events.push(next.value);
    }
    next = await iterator.next();
  }
  assert.ok(asked, 'expected input.required');
  const exit = await handle.exit;
  assert.equal(exit.reason, 'completed');
  await waitFor(() => {
    try {
      const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
      return argv.includes('--answer');
    } catch {
      return false;
    }
  });
  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
  assert.ok(argv.includes('--answer'));
  assert.ok(argv.includes('yes'));
});

test('prompt-file input mode: answer written to workspace file', async () => {
  const { context, workspacePath } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({
    args: [MOCK],
    env: { MOCK_LOCAL_MODE: 'input' },
    input: { mode: 'prompt-file', filePath: 'answer.txt', promptEvent: 'ask' },
  }));
  const handle = await adapter.start(context);

  const events: { type: string; payload: unknown }[] = [];
  const iterator = handle.events[Symbol.asyncIterator]();
  let next = await iterator.next();
  let asked = false;
  while (!next.done) {
    if (next.value.type === 'input.required') {
      asked = true;
      await adapter.sendInput(handle.runId, { value: 'yes', at: new Date().toISOString() });
      assert.equal(readFileSync(join(workspacePath, 'answer.txt'), 'utf8'), 'yes');
    } else {
      events.push(next.value);
    }
    next = await iterator.next();
  }
  assert.ok(asked, 'expected input.required');
  const exit = await handle.exit;
  assert.equal(exit.reason, 'completed');
});

test('config validation rejects bad configs', () => {
  assert.throws(() => validateLocalAgentConfig({} as LocalAgentConfig), /id is required/);
  assert.throws(
    () => validateLocalAgentConfig({ id: 'x', command: 'c', taskInput: { mode: 'arg' }, output: { format: 'jsonl' }, eventMap: {}, cancel: { signal: 'SIGTERM', graceMs: 100 } } as LocalAgentConfig),
    /taskInput.flag required/,
  );
  assert.throws(
    () => validateLocalAgentConfig({ id: 'x', command: 'c', taskInput: { mode: 'stdin' }, output: { format: 'jsonl' }, eventMap: {}, cancel: { signal: 'SIGKILL', graceMs: 100 } } as unknown as LocalAgentConfig),
    /cancel.signal must be/,
  );
});

test('registry: loads JSON configs from a directory', async () => {
  const dir = tempDir('mercury-agents-');
  writeFileSync(join(dir, 'my-agent.json'), JSON.stringify(jsonlConfig()));
  writeFileSync(join(dir, 'not-a-config.txt'), 'ignored');
  const registry = new LocalAgentRegistry(dir);
  const adapters = registry.load();
  assert.ok(adapters['my-agent'] instanceof LocalAgentAdapter);
  assert.equal(Object.keys(adapters).length, 1);
});

test('registry: missing dir -> no agents', () => {
  const registry = new LocalAgentRegistry(join(tmpdir(), 'does-not-exist-' + Date.now()));
  assert.deepEqual(registry.load(), {});
});

test('registry: invalid config file -> throws with file path', () => {
  const dir = tempDir('mercury-agents-');
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'bad' }));
  const registry = new LocalAgentRegistry(dir);
  assert.throws(() => registry.load(), /bad.json/);
});

test('session id from stdout regex (resume.sessionIdSource=stdout)', async () => {
  const argvFile = tempFile('argv-resume2', 'json');
  const { context } = makeContext();
  const adapter = new LocalAgentAdapter(jsonlConfig({
    args: [MOCK],
    env: { MOCK_LOCAL_MODE: 'text', MOCK_LOCAL_ARGV_FILE: argvFile },
    output: { format: 'text' },
    eventMap: {},
    resume: { flag: '--resume', sessionIdSource: 'stdout', sessionIdPath: 'session (\\S+)' },
  }));
  const handle = await adapter.start(context);
  const { exit } = await collectAll(handle);
  assert.equal(exit.reason, 'completed');
  // text mode prints "line one"/"line two" — no session id; resume should throw
  await assert.rejects(() => adapter.resume(handle.runId), /No session id/);
});

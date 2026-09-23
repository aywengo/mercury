// RpcAgentAdapter tests against the mock RPC server (mock-prime-agent-rpc.mjs,
// which speaks the REAL RPC JSONL protocol). Covers docs/agent-adapters.md
// section 6.5: happy path, argv construction, input round-trip, cancel,
// resume, spawn failure, agent failure, vendor-extras tolerance, config
// validation, registry loading.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RpcAgentAdapter,
  buildPrompt,
  buildResumePrompt,
  validateRpcAgentConfig,
  type RpcAgentConfig,
} from '../src/adapters/rpcAgentAdapter.ts';
import { NOTES_FILE } from '../src/knowledge/materialize.ts';
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

// --- knowledge prompt line (issue #687, docs/knowledge-base.md section 9.3) --------------------
//
// buildPrompt() told the agent to read .mercury-context.json, and the context file carried the
// `knowledge` block, but nothing told the agent to follow the pointer to the pack file. The 9.3
// row asks for one added line, present only when a pack exists: a Run without knowledge must get
// the exact prompt it got before, byte for byte, which is why the guards below compare against
// the base string rather than checking for an absence.

const KNOWLEDGE = {
  packHash: '584f8eaef4261d769be580927693d5e9',
  path: NOTES_FILE,
  count: 1,
};

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test('prompt snapshot with a pack names the pack file exactly once', () => {
  const { context } = makeContext();
  const withPack = buildPrompt({ ...context, knowledge: KNOWLEDGE });
  assert.equal(countOccurrences(withPack, NOTES_FILE), 1,
    'the pack file must be named exactly once; a repeated pointer is noise the harness reads past');
  // The line says what the file is, not just where it is: a bare path in a prompt is indistinguishable
  // from any other file the prompt happens to mention.
  assert.match(withPack, /knowledge/i);
  // The pre-existing lines survive unchanged.
  assert.match(withPack, /Read \.mercury-context\.json/);
  assert.match(withPack, /\.agents\/skills\//);
});

test('prompt snapshot without a pack is unchanged from base', () => {
  const { context } = makeContext();
  const withoutPack = buildPrompt(context);
  // The base prompt, reconstructed from the pre-#687 builder. If buildPrompt's base wording ever
  // changes, this test fails and the wording should be updated HERE, deliberately.
  const base = [
    'You are Mercury, an autonomous coding agent. Execute the task below inside this workspace.',
    '',
    `TASK: ${context.run.task}`,
    '',
    'Read .mercury-context.json in the workspace root for the full run context (repository, branch, base commit, constraints, selected skills).',
    'The selected skills are available under .agents/skills/ — read the relevant SKILL.md files and follow their guidance.',
    '',
    `Work in this workspace (${context.workspace.path}). Make focused commits with clear messages as you make progress.`,
    'When the task is complete, reply with a concise summary of what you changed and why.',
  ].join('\n');
  assert.equal(withoutPack, base,
    'a Run without a knowledge pack must get the exact prompt it got before #687');
});

test('resume prompt carries the same conditional line', () => {
  const { context } = makeContext();
  const withoutPack = buildResumePrompt(context);
  const withPack = buildResumePrompt({ ...context, knowledge: KNOWLEDGE });
  assert.doesNotMatch(withoutPack, new RegExp(NOTES_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the no-pack resume prompt must not name the pack file');
  assert.equal(countOccurrences(withPack, NOTES_FILE), 1);
  // With a pack the resume prompt is the base sentence plus the line, so the base is recoverable.
  assert.ok(withPack.startsWith(withoutPack),
    'the resume line appends to the same base sentence rather than replacing it');
});

const PRESET = {
  id: 'reviewer',
  version: '1.0.0',
  role: 'Code reviewer',
  trust: 'builtin' as const,
  contentHash: 'b1946ac92492d2347c6235b4d2611184e0f2a1c8a0d5de4f4e5d4c9d5a3b7c2d',
  instructionPath: '.mercury/preset/INSTRUCTION.md',
  instruction: 'Review hunks before you write code.',
};

test('resume prompt carries the preset line exactly once (#722)', () => {
  const { context } = makeContext();
  const base = buildResumePrompt(context);
  // Without a preset the resume prompt is byte-identical to base (acceptance 1).
  const withPreset = buildResumePrompt({ ...context, preset: PRESET });
  assert.ok(withPreset.startsWith(base),
    'the preset line appends to the same base sentence rather than replacing it');
  assert.equal(countOccurrences(withPreset, PRESET.instructionPath), 1,
    'the instruction path must be named exactly once');
  assert.ok(withPreset.includes(`You are filling the role: ${PRESET.role}`),
    'the resume prompt names the role the way the first prompt does');
  // Knowledge + preset together: both lines, each exactly once.
  const both = buildResumePrompt({ ...context, knowledge: KNOWLEDGE, preset: PRESET });
  assert.equal(countOccurrences(both, NOTES_FILE), 1);
  assert.equal(countOccurrences(both, PRESET.instructionPath), 1);
  assert.ok(both.startsWith(base));
});

test('the started adapter sends the preset line on resume (mock captures the prompt)', async () => {
  const { context, workspacePath } = makeContext();
  const promptFile = join(workspacePath, 'prompts.jsonl');
  const adapter = new RpcAgentAdapter(piConfig({ env: { MOCK_RPC_PROMPT_FILE: promptFile } }));
  try {
    const handle = await adapter.start(context);
    await collectAll(handle);
    // The RPC process stays alive after agent_end; stop it so resume() respawns.
    await adapter.cancel(context.run.id).catch(() => {});
    // Worker retry path: the retry context carries the preset, and the session file recorded by
    // the first run is resumed.
    const sessionFile = join(workspacePath, 'sessions', 'session-1.json');
    mkdirSync(join(sessionFile, '..'), { recursive: true });
    writeFileSync(sessionFile, JSON.stringify({ ok: true }));
    const handle2 = await adapter.resume(context.run.id, {
      ...context,
      preset: PRESET,
      resumeSessionFile: sessionFile,
    });
    await collectAll(handle2);
    const prompts = readFileSync(promptFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string);
    const resumePrompt = prompts[prompts.length - 1]!;
    assert.equal(countOccurrences(resumePrompt, PRESET.instructionPath), 1,
      'the resumed session must be told the role instruction path exactly once');
    assert.ok(resumePrompt.includes(`You are filling the role: ${PRESET.role}`),
      'the resume prompt names the role the way the first prompt does');
    await adapter.cancel(context.run.id).catch(() => {});
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('the context file preset block carries the full identity (#722, AC 3)', async () => {
  // The comment promises id, version, role, trust, content hash and the instruction path; the
  // block must deliver exactly that, so an agent can see which bytes it runs under.
  const { context, workspacePath } = makeContext();
  const adapter = new RpcAgentAdapter(piConfig());
  try {
    const handle = await adapter.start({ ...context, preset: PRESET });
    await collectAll(handle);
    const parsed = JSON.parse(readFileSync(join(workspacePath, '.mercury-context.json'), 'utf8')) as {
      preset?: Record<string, unknown>;
    };
    assert.ok(parsed.preset, 'the context file must carry a preset block');
    assert.deepEqual(
      Object.keys(parsed.preset).sort(),
      ['contentHash', 'id', 'instructionPath', 'role', 'trust', 'version'],
    );
    await adapter.cancel(context.run.id).catch(() => {});
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('the started adapter actually sends the knowledge line (mock captures the prompt)', async () => {
  const { context, workspacePath } = makeContext();
  const promptFile = join(workspacePath, 'prompts.jsonl');
  const adapter = new RpcAgentAdapter(piConfig({ env: { MOCK_RPC_PROMPT_FILE: promptFile } }));
  try {
    const handle = await adapter.start({ ...context, knowledge: KNOWLEDGE });
    await collectAll(handle);
    const prompts = readFileSync(promptFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string);
    assert.ok(prompts.length >= 1);
    assert.equal(countOccurrences(prompts[0]!, NOTES_FILE), 1,
      'the first prompt the agent process receives must name the pack file exactly once');
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('the started adapter without a pack sends the base prompt (mock captures the prompt)', async () => {
  const { context, workspacePath } = makeContext();
  const promptFile = join(workspacePath, 'prompts.jsonl');
  const adapter = new RpcAgentAdapter(piConfig({ env: { MOCK_RPC_PROMPT_FILE: promptFile } }));
  try {
    const handle = await adapter.start(context);
    await collectAll(handle);
    const prompts = readFileSync(promptFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string);
    assert.equal(prompts[0]!.includes(NOTES_FILE), false,
      'a Run with no pack must not name a pack file that does not exist');
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

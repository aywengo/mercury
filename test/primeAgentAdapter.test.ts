// PrimeAgentAdapter tests against the mock prime-agent RPC server.
// Verifies the full adapter contract: start/events/exit, human input,
// cancellation, spawn failure, resume.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrimeAgentAdapter } from '../src/adapters/primeAgentAdapter.ts';
import type { Run, RunContext, ResolvedSkill } from '../src/domain/types.ts';
import { tempDir } from './helpers.ts';

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
  const workspacePath = tempDir('mercury-adapter-');
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('terminate() stops the RPC process after a normal agent_end (issue #46)', async () => {
  // The core of #46. `agent_end` settles the exit promise while this RPC process is still
  // alive reading stdin, so "the run completed" says nothing about the process. terminate()
  // used to bail out on `session.done` -- already true here -- so stop() was unreachable from
  // the completion path and every successful run leaked a live process.
  const dir = tempDir('mercury-pid-');
  const pidFile = join(dir, 'pid');
  process.env.MOCK_RPC_MODE = 'happy';
  process.env.MOCK_RPC_PID_FILE = pidFile;
  const adapter = new PrimeAgentAdapter(MOCK, { args: [] });
  let pid = 0;
  try {
    const { context } = makeContext({ run: makeRun({ id: 'run_leak' }) });
    const handle = await adapter.start(context);
    const { exit } = await collectAll(handle);
    assert.equal(exit.reason, 'completed');

    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0, 'fixture must record its pid');
    // Asserting the process is STILL alive here is deliberate: it pins the precondition that
    // made this a leak, so the test cannot silently degrade into a no-op if the fixture ever
    // starts exiting on its own.
    assert.ok(alive(pid), 'the RPC process should still be running after agent_end (this is the leak)');

    await handle.terminate();

    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.ok(!alive(pid), `RPC process ${pid} survived terminate(); it leaked`);
  } finally {
    // Reap the child unconditionally. If the fix regresses, the leaked process keeps the
    // parent's stdio pipes open and the test runner hangs instead of reporting a failure --
    // verified: with the original `|| session.done` guard restored, this file never exits.
    // Killing it here turns that regression into a clean assertion failure.
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone, which is the expected case
      }
    }
    delete process.env.MOCK_RPC_MODE;
    delete process.env.MOCK_RPC_PID_FILE;
  }
});

test('a traversal skill id is rejected before the agent is spawned (issue #95)', async () => {
  // Defence in depth: SkillRegistry.resolve validates ids today, but primeAgentAdapter turns
  // skill.id into a path handed to a child process, and join() does NOT contain --
  // join(ws, '.agents', 'skills', '../../etc') escapes the workspace silently. The adapter must
  // not depend on its caller having validated.
  const { context, workspacePath } = makeContext();
  const evil: ResolvedSkill = {
    id: '../../outside',
    version: '1.0.0',
    description: 'x',
    capabilities: [],
    path: '/unused',
    content: '# x\n',
    files: { 'SKILL.md': '# x\n' },
    hash: 'abc',
  };
  const argvFile = join(workspacePath, 'argv-evil.json');
  process.env.MOCK_RPC_ARGV_FILE = argvFile;
  const adapter = new PrimeAgentAdapter(MOCK, { args: [] });
  try {
    await assert.rejects(
      () => adapter.start({ ...context, skills: [evil] }),
      /Unsafe skill id/,
      'a `..` skill id must be refused, not joined into a path',
    );
    // The agent must never be spawned. Note what this does NOT claim: start() writes the run
    // context file (.mercury-context.json) before it ever looks at skills, so that write still
    // happens. The guarantee is about the child process, not about the whole call being atomic.
    assert.equal(existsSync(argvFile), false, 'the agent must never be spawned for an unsafe skill id');
  } finally {
    delete process.env.MOCK_RPC_ARGV_FILE;
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('an absolute-path skill id is rejected too (issue #95)', async () => {
  // join() also discards everything before an absolute segment:
  // join(ws, '.agents', 'skills', '/etc/cron.d') === '/etc/cron.d'.
  const { context, workspacePath } = makeContext();
  const evil: ResolvedSkill = {
    id: '/etc/cron.d',
    version: '1.0.0',
    description: 'x',
    capabilities: [],
    path: '/unused',
    content: '# x\n',
    files: { 'SKILL.md': '# x\n' },
    hash: 'abc',
  };
  const adapter = new PrimeAgentAdapter(MOCK, { args: [] });
  try {
    await assert.rejects(
      () => adapter.start({ ...context, skills: [evil] }),
      /Unsafe skill id/,
      'an absolute skill id must be refused',
    );
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('a skills directory that is a symlink out of the workspace is refused (issue #95)', async () => {
  // A safe id is not the only escape. The workspace is a checkout of a repo that may be untrusted,
  // so `.agents/skills` can itself arrive as a symlink to anywhere on the host; joining a perfectly
  // well-formed id onto it resolves outside the workspace. Same reasoning as issue #58.
  const { context, workspacePath } = makeContext();
  const outside = tempDir('mercury-symlink-target-');
  mkdirSync(join(outside, 'testing'), { recursive: true });
  // workspace/.agents/skills -> <outside>
  mkdirSync(join(workspacePath, '.agents'), { recursive: true });
  symlinkSync(outside, join(workspacePath, '.agents', 'skills'));

  const ok: ResolvedSkill = {
    id: 'testing',  // completely well-formed
    version: '1.0.0', description: 'x', capabilities: [], path: '/unused',
    content: '# x\n', files: { 'SKILL.md': '# x\n' }, hash: 'abc',
  };
  const argvFile = join(workspacePath, 'argv-symlink.json');
  process.env.MOCK_RPC_ARGV_FILE = argvFile;
  const adapter = new PrimeAgentAdapter(MOCK, { args: [] });
  try {
    await assert.rejects(
      () => adapter.start({ ...context, skills: [ok] }),
      /escapes the skill root|symlink/i,
      'a symlinked skills root must be refused even for a safe id',
    );
    assert.equal(existsSync(argvFile), false, 'no agent may be spawned against an escaping path');
  } finally {
    delete process.env.MOCK_RPC_ARGV_FILE;
    adapter.cancel(context.run.id).catch(() => {});
  }
});

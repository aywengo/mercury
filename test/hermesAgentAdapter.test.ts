// HermesAgentAdapter tests against the generic mock hermes CLI fixture.
// Covers docs/agent-adapters.md Phase 3: happy path (agent.message + completed),
// argv construction (task via stdin, skills, budgets, resume), session id
// capture from stderr, resume, cancel, terminate, spawn failure, agent failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HermesAgentAdapter } from '../src/adapters/hermesAgentAdapter.ts';
import type { AgentExit, Run, RunContext, ResolvedSkill } from '../src/domain/types.ts';

const MOCK = join(import.meta.dirname, 'fixtures', 'mock-hermes-agent.mjs');

// --- helpers ----------------------------------------------------------------

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: 'run_hermes',
    ownerId: 'alice',
    task: 'Fix the failing integration tests',
    repository: { localPath: '/tmp/repo' },
    workspaceBranch: null,
    workspacePath: null,
    agent: 'hermes',
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
  const workspacePath = mkdtempSync(join(tmpdir(), 'mercury-hermes-'));
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

function adapter(opts: Record<string, unknown> = {}): HermesAgentAdapter {
  return new HermesAgentAdapter({ cmd: process.execPath, args: [MOCK], ...opts });
}

async function collectAll(handle: Awaited<ReturnType<HermesAgentAdapter['start']>>): Promise<{
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

// --- tests ------------------------------------------------------------------

test('happy path: final response -> agent.message, exit completed', async () => {
  const { context } = makeContext();
  const a = adapter();
  const handle = await a.start(context);
  const { events, exit } = await collectAll(handle);
  assert.equal(exit.code, 0);
  assert.equal(exit.reason, 'completed');
  const msgs = events.filter((e) => e.type === 'agent.message');
  assert.equal(msgs.length, 1);
  assert.equal((msgs[0].payload as { text: string }).text, 'Hello from mock hermes');
});

test('argv construction: task via stdin, skills, budgets, yolo, accept-hooks, --in', async () => {
  const argvFile = join(tmpdir(), `hermes-argv-${Date.now()}.json`);
  const envFile = join(tmpdir(), `hermes-env-${Date.now()}.json`);
  const { context, workspacePath } = makeContext({
    skills: [
      { id: 'git-pr', version: '1', description: '', capabilities: [], path: '', content: '', hash: '', files: {} },
      { id: 'testing', version: '1', description: '', capabilities: [], path: '', content: '', hash: '', files: {} },
    ],
  });
  const a = adapter({
    maxTurns: 10,
    runBudgetSeconds: 300,
    yolo: true,
    acceptHooks: true,
    source: 'tool',
    env: { MOCK_HERMES_ARGV_FILE: argvFile, MOCK_HERMES_ENV_FILE: envFile },
  });
  const handle = await a.start(context);
  await collectAll(handle);

  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
  assert.ok(argv.includes('chat'));
  assert.ok(argv.includes('-Q'));
  assert.ok(argv.includes('--query-file'));
  assert.ok(argv.includes('-'));
  assert.ok(argv.includes('--max-turns'));
  assert.ok(argv.includes('10'));
  assert.ok(argv.includes('--run-budget'));
  assert.ok(argv.includes('300'));
  assert.ok(argv.includes('-s'));
  assert.ok(argv.includes('git-pr'));
  assert.ok(argv.includes('testing'));
  assert.ok(argv.includes('--yolo'));
  assert.ok(argv.includes('--accept-hooks'));
  assert.ok(argv.includes('--source'));
  assert.ok(argv.includes('tool'));
  assert.ok(argv.includes('--in'));
  assert.ok(argv.includes(workspacePath));

  const env = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>;
  assert.equal(env.MERCURY_RUN_ID, 'run_hermes');
  assert.equal(env.MERCURY_TRACE_ID, 'run_hermes');
});

test('session id captured from stderr for resume', async () => {
  const { context } = makeContext();
  const a = adapter({ env: { MOCK_HERMES_SESSION: 'sess-abc123' } });
  const handle = await a.start(context);
  await collectAll(handle);
  const session = (a as unknown as { sessions: Map<string, { sessionId: string | null }> }).sessions.get(handle.runId)!;
  assert.equal(session.sessionId, 'sess-abc123');
});

test('resume: respawns with --resume <sessionId>', async () => {
  const argvFile = join(tmpdir(), `hermes-resume-${Date.now()}.json`);
  const { context } = makeContext();
  const a = adapter({ env: { MOCK_HERMES_SESSION: 'sess-abc123', MOCK_HERMES_ARGV_FILE: argvFile } });
  const handle = await a.start(context);
  const { exit } = await collectAll(handle);
  assert.equal(exit.reason, 'completed');

  await a.resume(handle.runId);
  // poll until the respawned process writes its argv
  const start = Date.now();
  let argv: string[] = [];
  while (Date.now() - start < 3000) {
    try {
      argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
      if (argv.includes('--resume')) break;
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(argv.includes('--resume'));
  assert.equal(argv[argv.indexOf('--resume') + 1], 'sess-abc123');
});

test('resume without session id -> throws', async () => {
  const { context } = makeContext();
  const a = adapter({ env: { MOCK_HERMES_MODE: 'fail' } });
  const handle = await a.start(context);
  await collectAll(handle);
  // fail mode still prints session_id, so clear it to simulate no capture
  const session = (a as unknown as { sessions: Map<string, { sessionId: string | null }> }).sessions.get(handle.runId)!;
  session.sessionId = null;
  await assert.rejects(() => a.resume(handle.runId), /No session id/);
});

test('agent failure: non-zero exit -> exit failed', async () => {
  const { context } = makeContext();
  const a = adapter({ env: { MOCK_HERMES_MODE: 'fail' } });
  const handle = await a.start(context);
  const { exit } = await collectAll(handle);
  assert.equal(exit.code, 1);
  assert.equal(exit.reason, 'failed');
});

test('spawn failure: command not found -> exit failed', async () => {
  const { context } = makeContext();
  const a = new HermesAgentAdapter({ cmd: '/nonexistent/hermes-binary' });
  const handle = await a.start(context);
  const { events, exit } = await collectAll(handle);
  assert.equal(exit.code, 127);
  assert.equal(exit.reason, 'failed');
  assert.deepEqual(events, []);
});

test('cancel: SIGTERM then grace -> exit reason cancelled', async () => {
  const { context } = makeContext();
  const a = adapter({ env: { MOCK_HERMES_MODE: 'hang' }, cancelGraceMs: 200 });
  const handle = await a.start(context);
  await new Promise((r) => setTimeout(r, 300));
  await a.cancel(handle.runId);
  const exit = await handle.exit;
  assert.equal(exit.reason, 'cancelled');
});

test('terminate: SIGKILL -> exit reason terminated', async () => {
  const { context } = makeContext();
  const a = adapter({ env: { MOCK_HERMES_MODE: 'hang' } });
  const handle = await a.start(context);
  await new Promise((r) => setTimeout(r, 300));
  await handle.terminate();
  const exit = await handle.exit;
  assert.equal(exit.reason, 'terminated');
});

test('sendInput is not supported (deferred per design)', async () => {
  const { context } = makeContext();
  const a = adapter();
  const handle = await a.start(context);
  await collectAll(handle);
  await assert.rejects(() => a.sendInput(handle.runId, { value: 'x', at: new Date().toISOString() }), /does not support sendInput/);
});

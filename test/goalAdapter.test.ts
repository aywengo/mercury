// Phase 2: the adapter seeds the harness goal and relays reports back over the real RPC
// protocol, using the mock RPC server in `goal` mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { PrimeAgentAdapter } from '../src/adapters/primeAgentAdapter.ts';
import type { GoalState, Run, RunContext } from '../src/domain/types.ts';
import { tempDir } from './helpers.ts';

const MOCK = join(import.meta.dirname, 'fixtures', 'mock-prime-agent-rpc.mjs');

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: 'run_goal_adapter', ownerId: 'alice', task: 'Fix the failing integration tests',
    repository: { localPath: '/tmp/repo' }, workspaceBranch: null, workspacePath: null,
    agent: 'primeagent', status: 'QUEUED', attempt: 1, retryOf: null, error: null, errorKind: null,
    constraints: { maxDurationMs: 60_000, maxRetries: 2 }, createdAt: now, startedAt: null,
    completedAt: null, leaseOwner: null, leaseExpiresAt: null, cancellationRequestedAt: null,
    finalCommits: [], prUrl: null, ...overrides,
  };
}

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    runId: 'run_goal_adapter', status: 'active', objective: 'make the tests pass',
    tokenBudget: 5000, source: 'operator', updatedAt: 'u', ...overrides,
  };
}

function makeContext(goalState?: GoalState): { context: RunContext; workspacePath: string } {
  const workspacePath = tempDir('mercury-goal-adapter-');
  const run = makeRun();
  return {
    workspacePath,
    context: {
      run, repository: run.repository,
      workspace: { path: workspacePath, branch: 'agent/' + run.id, baseCommit: 'abc123', mode: 'copy' },
      skills: [], constraints: run.constraints, goal: goalState,
    },
  };
}

async function drain(handle: Awaited<ReturnType<PrimeAgentAdapter['start']>>) {
  const events: { type: string; payload: unknown }[] = [];
  for await (const ev of handle.events) {
    if (ev.type === '__done__') continue;
    events.push(ev);
    if (ev.type === 'agent.end') break;
  }
  return events;
}

test('--goal and --goal-token-budget reach the harness argv', async () => {
  const { context, workspacePath } = makeContext(goal());
  const argvFile = join(workspacePath, 'argv.json');
  process.env.MOCK_RPC_ARGV_FILE = argvFile;
  const adapter = new PrimeAgentAdapter(MOCK);
  try {
    await drain(await adapter.start(context));
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    const i = argv.indexOf('--goal');
    assert.ok(i >= 0, `--goal missing from argv: ${JSON.stringify(argv)}`);
    assert.equal(argv[i + 1], 'make the tests pass', 'objective must be one argv element');
    const j = argv.indexOf('--goal-token-budget');
    assert.ok(j >= 0, '--goal-token-budget missing');
    assert.equal(argv[j + 1], '5000');
  } finally {
    delete process.env.MOCK_RPC_ARGV_FILE;
    await adapter.cancel(context.run.id).catch(() => {});
  }
});

test('no goal means no goal flags', async () => {
  const { context, workspacePath } = makeContext();
  const argvFile = join(workspacePath, 'argv.json');
  process.env.MOCK_RPC_ARGV_FILE = argvFile;
  const adapter = new PrimeAgentAdapter(MOCK);
  try {
    await drain(await adapter.start(context));
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    assert.ok(!argv.includes('--goal'), 'goal flags leaked into a goalless run');
    assert.ok(!argv.includes('--goal-token-budget'));
  } finally {
    delete process.env.MOCK_RPC_ARGV_FILE;
    await adapter.cancel(context.run.id).catch(() => {});
  }
});

test('resume does NOT re-seed the goal', async () => {
  // `--goal` seeds a NEW root session. A resumed session already owns its goal, and re-seeding
  // would reset the usage counters under a budget that is still being enforced.
  const { context, workspacePath } = makeContext(goal());
  const adapter = new PrimeAgentAdapter(MOCK);
  try {
    await drain(await adapter.start(context));
    await adapter.cancel(context.run.id).catch(() => {});
    const argvFile = join(workspacePath, 'argv-resume.json');
    process.env.MOCK_RPC_ARGV_FILE = argvFile;
    await adapter.resume(context.run.id);
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    assert.ok(argv.includes('--resume'), 'resume did not pass --resume');
    assert.ok(!argv.includes('--goal'), 'resume re-seeded the goal');
    assert.ok(!argv.includes('--goal-token-budget'), 'resume re-seeded the budget');
  } finally {
    delete process.env.MOCK_RPC_ARGV_FILE;
    await adapter.cancel(context.run.id).catch(() => {});
  }
});

test('goal reports survive the real RPC protocol', async () => {
  // End to end over the actual JSONL protocol: the mock emits goal_update frames walking
  // active -> paused -> budget_limited -> complete, and the adapter must surface each one.
  const { context } = makeContext(goal());
  const adapter = new PrimeAgentAdapter(MOCK);
  process.env.MOCK_RPC_MODE = 'goal';
  try {
    const events = await drain(await adapter.start(context));
    const goalEvents = events.filter((e) => e.type.startsWith('goal.')).map((e) => e.type);
    assert.deepEqual(goalEvents, ['goal.updated', 'goal.paused', 'goal.budget_limited', 'goal.completed'],
      'goal reports did not survive the RPC translation');
  } finally {
    delete process.env.MOCK_RPC_MODE;
    await adapter.cancel(context.run.id).catch(() => {});
  }
});

test('an unrecognised status from the harness is surfaced over the wire, not dropped', async () => {
  const { context } = makeContext(goal());
  const adapter = new PrimeAgentAdapter(MOCK);
  process.env.MOCK_RPC_MODE = 'goal';
  process.env.MOCK_RPC_GOAL_UNRECOGNISED = '1';
  try {
    const events = await drain(await adapter.start(context));
    const errs = events.filter((e) => e.type === 'goal.error');
    assert.equal(errs.length, 1, 'the unrecognised report was discarded');
    assert.match(JSON.stringify(errs[0].payload), /teleported/);
  } finally {
    delete process.env.MOCK_RPC_MODE;
    delete process.env.MOCK_RPC_GOAL_UNRECOGNISED;
    await adapter.cancel(context.run.id).catch(() => {});
  }
});

/**
 * Operator goal cancel (docs/goals.md 8).
 *
 * `cancelled` lives in MERCURY_ONLY_GOAL_STATUSES, so a harness reporting it is refused, and
 * until this route existed nothing at all could set it. These tests are the proof that the
 * status is now reachable, and that reaching it does not disturb anything else.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { makeEnv } from './helpers.ts';
import type { Express } from 'express';
import type { AgentAdapter, AgentCapabilities, AgentVersionInfo } from '../src/domain/types.ts';

function capableAdapter(): AgentAdapter {
  const capabilities: AgentCapabilities = {
    goals: { set: '0.3.3', track: '0.3.3', tokenBudget: '0.3.3', contract: '0.3.3', gates: '0.3.3' },
  };
  return {
    capabilities,
    detectVersion: async (): Promise<AgentVersionInfo> => ({ version: '0.9.4', raw: '0.9.4' }),
    start: async () => { throw new Error('not started'); },
    sendInput: async () => {},
    cancel: async () => {},
  } as AgentAdapter;
}

/** A capable adapter registered under `capable`, with probes settled so the version is known. */
function envWithGoal() {
  const env = makeEnv({
    workerEnabled: false,
    adapters: { capable: capableAdapter() },
    probeCapabilities: true,
  });
  return env;
}

function makeApi(env: ReturnType<typeof makeEnv>, tokens: [string, string][] = [[ALICE_TOKEN, 'alice'], [BOB_TOKEN, 'bob']]) {
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    apiTokens: new Map(tokens),
    adminToken: null,
  });
  return { app, close: () => stream.stop() };
}

function listen(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

async function withServer<T>(env: ReturnType<typeof makeEnv>, fn: (base: string) => Promise<T>): Promise<T> {
  const { app, close } = makeApi(env);
  const srv = await listen(app);
  try { return await fn(`http://127.0.0.1:${srv.port}`); }
  finally { await srv.close(); close(); }
}

const ALICE_TOKEN = ['tok','alice'].join('-');
const BOB_TOKEN = ['tok','bob'].join('-');
const AUTH = { authorization: `Bearer ${ALICE_TOKEN}` } as const;

function goalEvents(env: ReturnType<typeof makeEnv>, runId: string): string[] {
  return env.events.list(runId).filter((e) => e.type.startsWith('goal.')).map((e) => e.type);
}

test('cancelling a goal records it as operator-dropped and announces it', async () => {
  const env = envWithGoal();
  await env.agentCapabilities.settle();
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'work', agent: 'capable', goal: { objective: 'done' } });
    await withServer(env, async (base) => {
      const res = await fetch(`${base}/api/runs/${run.id}/goal/cancel`, { method: 'POST', headers: AUTH });
      const text = await res.text();
      assert.equal(res.status, 200, `cancel failed: ${text}`);
      const body = JSON.parse(text) as { goal: { status: string; source: string } };
      assert.equal(body.goal.status, 'cancelled');
      assert.equal(body.goal.source, 'operator', 'an operator action must not look like a harness report');
    });
    assert.equal(env.goals.get(run.id)?.status, 'cancelled');
    assert.deepEqual(goalEvents(env, run.id), ['goal.created', 'goal.cancelled']);
  } finally { env.close(); }
});

test('cancelling a goal does NOT touch Run status', async () => {
  // The §6 rule: no goal event may change Run.status. Cancel is the one place a human asks for a
  // goal state change, so it is the place someone would be tempted to also stop the Run.
  const env = envWithGoal();
  await env.agentCapabilities.settle();
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'work', agent: 'capable', goal: { objective: 'done' } });
    await withServer(env, async (base) => {
      const res = await fetch(`${base}/api/runs/${run.id}/goal/cancel`, { method: 'POST', headers: AUTH });
      assert.equal(res.status, 200);
    });
    assert.equal(env.runService.get(run.id, 'alice', true)!.status, run.status, 'cancel moved Run status');
  } finally { env.close(); }
});

test('a cancelled goal survives the Run finishing', async () => {
  // Settlement turns an open goal into `unmet` when the Run ends. `unmet` claims the harness fell
  // short; an operator who stopped tracking deliberately has made no such claim, so cancel must
  // win. If this regresses, cancel is decorative -- it would be overwritten moments later.
  const env = envWithGoal();
  await env.agentCapabilities.settle();
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'work', agent: 'capable', goal: { objective: 'done' } });
    env.runService.cancelGoal(run.id, 'alice', true);
    env.runs.transition(run.id, 'STARTING');
    // TIMED_OUT is one of the exit routes the design calls out for goal settlement, so this
    // checks the survivor property on a route other than the ordinary one.
    env.runs.transition(run.id, 'TIMED_OUT');
    assert.equal(env.goals.get(run.id)?.status, 'cancelled', 'settlement overwrote an operator cancel');
    assert.ok(!goalEvents(env, run.id).includes('goal.unmet'), 'goal.unmet fired on a cancelled goal');
  } finally { env.close(); }
});

test('a settled goal cannot be cancelled', async () => {
  // `complete` and `unmet` are verdicts. Cancelling one would erase the record the feature exists
  // to keep, so this refuses rather than no-ops -- a silent 200 would tell the operator they had
  // changed something.
  const env = envWithGoal();
  await env.agentCapabilities.settle();
  try {
    for (const status of ['complete', 'unmet', 'cancelled'] as const) {
      const run = env.runService.create({ ownerId: 'alice', task: `work ${status}`, agent: 'capable', goal: { objective: 'done' } });
      env.goals.update(run.id, { status }, new Date().toISOString());
      let code = 0;
      await withServer(env, async (base) => {
        const res = await fetch(`${base}/api/runs/${run.id}/goal/cancel`, { method: 'POST', headers: AUTH });
        code = res.status;
      });
      assert.equal(code, 409, `cancelling a ${status} goal returned ${code}, not 409`);
      assert.equal(env.goals.get(run.id)?.status, status, `a ${status} goal was changed`);
    }
  } finally { env.close(); }
});

test('cancel is owner-scoped and 404s rather than 403s', async () => {
  const env = envWithGoal();
  await env.agentCapabilities.settle();
  try {
    const alice = env.runService.create({ ownerId: 'alice', task: 'alice work', agent: 'capable', goal: { objective: 'o' } });
    await withServer(env, async (base) => {
      const res = await fetch(`${base}/api/runs/${alice.id}/goal/cancel`, {
        method: 'POST', headers: { authorization: `Bearer ${BOB_TOKEN}` },
      });
      assert.equal(res.status, 404, `cross-owner cancel returned ${res.status}`);
    });
    assert.equal(env.goals.get(alice.id)?.status, 'active', 'another owner cancelled alice goal');
  } finally { env.close(); }
});

test('cancelling a goalless Run is a 404, not a 500', async () => {
  const env = envWithGoal();
  await env.agentCapabilities.settle();
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'no goal', agent: 'capable' });
    await withServer(env, async (base) => {
      const res = await fetch(`${base}/api/runs/${run.id}/goal/cancel`, { method: 'POST', headers: AUTH });
      assert.equal(res.status, 404);
      assert.deepEqual(goalEvents(env, run.id), [], 'a goal event was emitted for a goalless Run');
    });
  } finally { env.close(); }
});

test('GET the goal endpoint returns the row, and 404s when there is none', async () => {
  const env = envWithGoal();
  await env.agentCapabilities.settle();
  try {
    const withGoal = env.runService.create({ ownerId: 'alice', task: 'work', agent: 'capable', goal: { objective: 'the objective' } });
    const without = env.runService.create({ ownerId: 'alice', task: 'plain', agent: 'capable' });
    await withServer(env, async (base) => {
      const hit = await (await fetch(`${base}/api/runs/${withGoal.id}/goal`, { headers: AUTH })).json() as { goal: { objective: string } };
      assert.equal(hit.goal.objective, 'the objective');
      assert.equal((await fetch(`${base}/api/runs/${without.id}/goal`, { headers: AUTH })).status, 404);
      assert.equal((await fetch(`${base}/api/runs/nonexistent/goal`, { headers: AUTH })).status, 404);
    });
  } finally { env.close(); }
});

test('the cancel row and event are written together', async () => {
  // If the event append throws, the row must not stay cancelled. A row saying `cancelled` with no
  // event leaves the timeline claiming the goal was live the whole time.
  const env = envWithGoal();
  await env.agentCapabilities.settle();
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'work', agent: 'capable', goal: { objective: 'done' } });
    const realAppend = env.events.append.bind(env.events);
    env.events.append = ((runId: string, type: string, payload: unknown) => {
      if (type === 'goal.cancelled') throw new Error('injected append failure');
      return realAppend(runId, type, payload as never);
    }) as typeof env.events.append;
    assert.throws(() => env.runService.cancelGoal(run.id, 'alice', true), /injected append failure/);
    env.events.append = realAppend;
    assert.equal(env.goals.get(run.id)?.status, 'active', 'the row was cancelled while its event failed');
    assert.ok(!goalEvents(env, run.id).includes('goal.cancelled'));
  } finally { env.close(); }
});

// Phase 3: goal status is surfaced on every read path, and never in place of Run status.
//
// The rule under test is from docs/goals.md 4: goal status and Run status are orthogonal, and a
// surface that shows `COMPLETED` while hiding `unmet` reproduces the original problem with extra
// steps. So these tests assert both values are present together, not merely that one is present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Express } from 'express';
import { createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { expectStatus, makeEnv } from './helpers.ts';
import { goalBadge, goalLabel } from '../ui/app.js';

const UI_DIR = join(import.meta.dirname, '..', 'ui');

function makeApi(env: ReturnType<typeof makeEnv>, tokens: [string, string][] = [['tok-alice', 'alice']]) {
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
    // Explicit loopback host: a wildcard bind on macOS can coexist with another process already
    // holding 127.0.0.1, and requests meant for this app get answered by that other server.
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

const AUTH = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };

function seed(env: ReturnType<typeof makeEnv>, objective = 'make tests pass') {
  const run = env.runService.create({ ownerId: 'alice', task: 'the task', agent: 'fake' });
  env.goals.insert({ runId: run.id, status: 'active', objective, source: 'operator', updatedAt: 'u' });
  return run;
}

async function withServer<T>(
  env: ReturnType<typeof makeEnv>,
  fn: (base: string) => Promise<T>,
  tokens?: [string, string][],
): Promise<T> {
  const { app, close } = makeApi(env, tokens);
  const srv = await listen(app);
  try {
    return await fn(`http://127.0.0.1:${srv.port}`);
  } finally {
    await srv.close();
    close();
  }
}

test('run detail returns the goal as a SIBLING of the run, never folded into it', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = seed(env);
    await withServer(env, async (base) => {
      const res = await fetch(`${base}/api/runs/${run.id}`, { headers: AUTH });
      await expectStatus(res, 200, 'GET run detail');
      const body = await res.json() as { run: Record<string, unknown>; goal: Record<string, unknown> };
      assert.equal(body.goal.status, 'active');
      assert.equal(body.goal.objective, 'make tests pass');
      // Folding it into the Run would let a client read `run.goal` and still never compare it
      // against `run.status`, which is the substitution this whole design forbids.
      assert.ok(!('goal' in body.run), 'goal was folded into the Run object');
    });
  } finally { env.close(); }
});

test('detail says "no goal" explicitly, so absence is an answer rather than a gap', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'plain', agent: 'fake' });
    await withServer(env, async (base) => {
      const body = await (await fetch(`${base}/api/runs/${run.id}`, { headers: AUTH })).json() as Record<string, unknown>;
      assert.equal(body.goal, null, 'a goalless run must answer null, not omit the field');
    });
  } finally { env.close(); }
});

test('run list carries goal statuses in parallel, leaving runs an array of Run', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const withGoal = seed(env, 'tracked');
    const plain = env.runService.create({ ownerId: 'alice', task: 'untracked', agent: 'fake' });
    await withServer(env, async (base) => {
      const body = await (await fetch(`${base}/api/runs?limit=50`, { headers: AUTH })).json() as
        { runs: Record<string, unknown>[]; goals: Record<string, string> };
      assert.ok(Array.isArray(body.runs), 'runs must stay an array -- existing clients check it');
      assert.ok(body.runs.every((r) => !('goal' in r) && !('goalStatus' in r)),
        'goal status leaked onto the Run objects');
      assert.equal(body.goals[withGoal.id], 'active');
      // "no goal" is the ABSENCE of a key, not a status value. Inventing `absent` here would
      // make it impossible for a renderer to tell "no goal" from "goal of status absent".
      assert.ok(!(plain.id in body.goals), 'a goalless run appeared in the goals map');
    });
  } finally { env.close(); }
});

test('goalBadge renders the three states differently, and escapes what it interpolates', () => {
  // Real import of the real module, not a regex over its source: this is the function the
  // dashboard actually calls.
  assert.match(goalBadge(undefined, 'r1'), /goal-unknown/);
  assert.match(goalBadge({}, 'r1'), /goal-none/);
  assert.match(goalBadge({ r1: 'unmet' }, 'r1'), /goal-unmet/);
  // "server said nothing" must not read as "no goal".
  assert.notEqual(goalBadge(undefined, 'r1'), goalBadge({}, 'r1'));
  // Cast: the type system already forbids this value, and the parser rejects it upstream. This
  // asserts the renderer does not depend on either of those, because a badge that trusts its
  // input is one schema change away from stored XSS.
  const xss = goalBadge({ r1: 'active"><img src=x onerror=alert(1)>' } as never, 'r1');
  assert.ok(!xss.includes('<img'), `unescaped status reached markup: ${xss}`);
});

test('goalLabel keeps the run page badge distinct from the status badge', () => {
  assert.equal(goalLabel(undefined).cls, 'goal-unknown');
  assert.equal(goalLabel(null).cls, 'goal-none');
  assert.equal(goalLabel({ status: 'unmet' }).cls, 'goal-unmet');
  // The label carries its own prefix, so it cannot be mistaken for the Run status it sits next to.
  assert.match(goalLabel({ status: 'complete' }).text, /^goal: /);
});

test('an unmet goal that never started reads differently from one that ran', () => {
  // Issue #489. Both are genuinely unmet, but one is the signal and the other is a Run that died
  // before the harness received the objective. Rendered identically, a routine infrastructure
  // failure carries the same weight as the pair this feature exists to expose.
  const ran = goalLabel({ status: 'unmet', attempted: true });
  const never = goalLabel({ status: 'unmet', attempted: false });
  assert.notEqual(never.text, ran.text, 'never-started reads the same as attempted');
  assert.match(never.text, /never started/);
  assert.notEqual(never.cls, ran.cls, 'never-started is styled identically');
  assert.match(never.cls, /goal-unattempted/);
  // The distinction is stated, not hidden behind a hover.
  assert.match(never.title, /terminal status before the harness/);

  // Absent means no answer, and must not be read as "never started" -- that would relabel every
  // unsettled goal on the dashboard.
  assert.equal(goalLabel({ status: 'unmet' }).cls, 'goal-unmet');
  assert.equal(goalLabel({ status: 'unmet', attempted: undefined }).cls, 'goal-unmet');
});

test('the run page renders goal status BESIDE run status, and never instead of it', () => {
  // The rendering rule is a requirement, not polish. Asserted on the markup and the renderer
  // together: an element that exists but is never filled is as bad as one that was never added.
  const html = readFileSync(join(UI_DIR, 'run.html'), 'utf8');
  const js = readFileSync(join(UI_DIR, 'run.js'), 'utf8');
  assert.ok(html.includes('id="status-badge"'), 'status badge missing');
  const statusAt = html.indexOf('id="status-badge"');
  const goalAt = html.indexOf('id="goal-badge"');
  assert.ok(goalAt > 0, 'goal badge missing from the run page');
  assert.ok(Math.abs(goalAt - statusAt) < 400, 'goal badge is not beside the status badge');
  assert.ok(js.includes("$('status-badge').innerHTML"), 'status badge never rendered');
  assert.ok(js.includes("$('goal-badge').innerHTML"), 'goal badge never rendered');
});

test('the list page gained a Goal column without losing the Status column', () => {
  const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
  const js = readFileSync(join(UI_DIR, 'index.js'), 'utf8');
  const header = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'));
  assert.match(header, /<th>Status<\/th><th>Goal<\/th>/, 'Goal column is not beside Status');
  assert.match(js, /statusClass\(r\.status\)/, 'status column lost');
  assert.match(js, /goalBadge\(goals, r\.id\)/, 'goal column never rendered');
});

test('a goal report refreshes the header, so badge and timeline cannot disagree', () => {
  // Without this the badge shows whatever it was at page load while the timeline moves on: two
  // views of one Run saying different things, which is the failure the feature exists to remove.
  const js = readFileSync(join(UI_DIR, 'run.js'), 'utf8');
  assert.match(js, /if \(e\.type\.startsWith\('goal\.'\)\) loadRun\(\);/);
});

test('the goals map is scoped to the runs the caller may already see', async () => {
  // The map is keyed by run id and built from the page the caller was given, so it cannot
  // enumerate another owner's goals. Asserted rather than assumed: a leaking map would expose
  // goal status -- and via the detail endpoint, objectives -- across an owner boundary while
  // every existing list assertion still looked correct.
  const env = makeEnv({ workerEnabled: false });
  try {
    const aliceRun = env.runService.create({ ownerId: 'alice', task: 'alice work', agent: 'fake' });
    env.goals.insert({ runId: aliceRun.id, status: 'unmet', objective: 'alice objective', source: 'operator', updatedAt: 'u' });
    const bobRun = env.runService.create({ ownerId: 'bob', task: 'bob work', agent: 'fake' });
    env.goals.insert({ runId: bobRun.id, status: 'active', objective: 'bob objective', source: 'operator', updatedAt: 'u' });

    await withServer(env, async (base) => {
      const bobRes = await fetch(`${base}/api/runs?limit=50`, { headers: { authorization: 'Bearer tok-bob' } });
      const bobList = await bobRes.json() as { runs: { id: string }[]; goals: Record<string, string> };

      assert.deepEqual(bobList.runs.map((r) => r.id), [bobRun.id]);
      assert.deepEqual(Object.keys(bobList.goals), [bobRun.id], 'the goals map crossed an owner boundary');
      assert.equal(bobList.goals[aliceRun.id], undefined);

      // 404, not 403: another owner's Run must not be confirmable at all, and that covers its
      // goal as much as its status.
      const detail = await fetch(`${base}/api/runs/${aliceRun.id}`, {
        headers: { authorization: 'Bearer tok-bob' },
      });
      assert.equal(detail.status, 404);
    }, [['tok-alice', 'alice'], ['tok-bob', 'bob']]);
  } finally { env.close(); }
});

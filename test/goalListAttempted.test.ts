/**
 * The run list must distinguish the two kinds of `unmet` (issue #492).
 *
 * #489 gave the gauge an `attempted` label and #491 gave the detail page one, but the list -- the
 * view an operator actually scans -- read a map whose value was a bare status string, so it rendered
 * "the harness held the objective and never declared it met" identically to "the Run died before the
 * harness received it". Same complaint as #489, one surface further along.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Express } from 'express';
import { createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { makeEnv } from './helpers.ts';
import { goalBadge } from '../ui/app.js';
import { parseRunListResponse } from '../client/api/protocol.ts';
import { renderRunList } from '../client/commands/list.ts';

const OFF = { json: false, noColor: true };

function makeApi(env: ReturnType<typeof makeEnv>, tokens: [string, string][]) {
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService, events: env.events, stream,
    apiTokens: new Map(tokens), adminToken: null,
  });
  return { app, close: () => stream.stop() };
}

function listen(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    // Explicit loopback: a wildcard bind on macOS can coexist with another process already
    // holding 127.0.0.1, and this request would be answered by that other server.
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

async function withServer<T>(
  env: ReturnType<typeof makeEnv>,
  fn: (base: string) => Promise<T>,
  tokens: [string, string][],
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

function settled(env: ReturnType<typeof makeEnv>, runId: string, attempted: boolean) {
  env.goals.update(runId, { status: 'unmet', attempted }, 'now');
}

test('the list map carries attempted, and omits it when there is no answer', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const seed = () => {
      const run = env.runService.create({ ownerId: 'alice', task: 't', agent: 'fake' });
      env.goals.insert({ runId: run.id, status: 'active', objective: 'obj', source: 'operator', updatedAt: 'u' });
      return run;
    };
    const ran = seed(); settled(env, ran.id, true);
    const never = seed(); settled(env, never.id, false);
    const open = seed();   // still active: no answer to give

    await withServer(env, async (base) => {
      const res = await fetch(`${base}/api/runs?limit=50`, { headers: { authorization: 'Bearer tok-alice' } });
      assert.equal(res.status, 200, 'list request was not authenticated');
      const body = await res.json() as {
        goals: Record<string, { status: string; attempted?: boolean }>;
      };
      assert.deepEqual(body.goals[ran.id], { status: 'unmet', attempted: true });
      assert.deepEqual(body.goals[never.id], { status: 'unmet', attempted: false });
      // Absent, not false. Serialising `attempted: undefined` as null or false would turn "we do
      // not know" into "it never started".
      assert.deepEqual(body.goals[open.id], { status: 'active' });
      assert.ok(!('attempted' in body.goals[open.id]));
    }, [['tok-alice', 'alice']]);
  } finally { env.close(); }
});

test('the goals map still cannot cross an owner boundary', async () => {
  // Carried over from #489's review, which found an earlier version of this assertion was reading a
  // 401 body and passing forever. The map changed shape; the boundary it must respect did not.
  const env = makeEnv({ workerEnabled: false });
  try {
    const alice = env.runService.create({ ownerId: 'alice', task: 'a', agent: 'fake' });
    env.goals.insert({ runId: alice.id, status: 'unmet', objective: 'a obj', source: 'operator', updatedAt: 'u' });
    env.goals.update(alice.id, { status: 'unmet', attempted: true }, 'now');
    const bob = env.runService.create({ ownerId: 'bob', task: 'b', agent: 'fake' });
    env.goals.insert({ runId: bob.id, status: 'active', objective: 'b obj', source: 'operator', updatedAt: 'u' });

    await withServer(env, async (base) => {
      const res = await fetch(`${base}/api/runs?limit=50`, { headers: { authorization: 'Bearer tok-bob' } });
      assert.equal(res.status, 200, 'bob could not list his own runs');
      const body = await res.json() as { runs: { id: string }[]; goals: Record<string, unknown> };
      assert.deepEqual(body.runs.map((r) => r.id), [bob.id]);
      assert.deepEqual(Object.keys(body.goals), [bob.id], 'the goals map crossed an owner boundary');
      assert.equal(body.goals[alice.id], undefined);
    }, [['tok-alice', 'alice'], ['tok-bob', 'bob']]);
  } finally { env.close(); }
});

test('runs list renders the two kinds of unmet differently', () => {
  const run = (id: string) => ({ id, ownerId: 'a', task: 't', agent: 'fake', status: 'COMPLETED',
    attempt: 1, retryOf: null, error: null, errorKind: null, constraints: {},
    createdAt: '2026-01-01T00:00:00Z', startedAt: null, completedAt: null,
    workspaceBranch: null, workspacePath: null, leaseOwner: null, leaseExpiresAt: null });
  const render = (goals: unknown) => renderRunList(
    { runs: [run('r1')], nextCursor: null, goals } as never, OFF as never, false);

  const ran = render({ r1: { status: 'unmet', attempted: true } });
  const never = render({ r1: { status: 'unmet', attempted: false } });
  assert.notEqual(ran, never, 'the list renders both kinds of unmet identically');
  assert.match(never, /unmet \(never started\)/);
  assert.match(ran, /unmet/);
  assert.doesNotMatch(ran, /never started/);

  // Unknown stays unmarked: absent attempted is "no answer", not "never started".
  assert.doesNotMatch(render({ r1: { status: 'unmet' } }), /never started/);

  // The three original states survive the shape change.
  assert.match(render(undefined), /\?/, 'server-predates-goals state lost');
  assert.match(render({}), /\u2014|−|-/, 'no-goal state lost');
});

test('goalBadge distinguishes the two kinds of unmet and still escapes', () => {
  const ran = goalBadge({ r1: { status: 'unmet', attempted: true } }, 'r1');
  const never = goalBadge({ r1: { status: 'unmet', attempted: false } }, 'r1');
  assert.notEqual(ran, never, 'the dashboard badge renders both kinds identically');
  assert.match(never, /never started/);
  assert.match(never, /goal-unattempted/, 'badge is not styled as subordinate');
  assert.doesNotMatch(ran, /never started/);
  // Unknown must not collapse into the never-started rendering.
  assert.doesNotMatch(goalBadge({ r1: { status: 'unmet' } }, 'r1'), /never started/);

  // The badge reads raw fetch data, not parsed protocol, so escaping is the only guard.
  const xss = goalBadge({ r1: { status: 'unmet', attempted: false, title: 'x" onmouseover=alert(1)' } } as never, 'r1');
  assert.ok(!xss.includes('<img') && !xss.includes('onmouseover='), `unescaped value reached markup: ${xss}`);
});

test('a bare status string is rejected with a message that names the skew', () => {
  // The map used to hold strings. Accepting both shapes would keep the ambiguity forever, so the
  // parser rejects the old one -- but the message has to say what is actually wrong, or a version
  // skew sends the operator looking in the wrong place.
  assert.throws(
    () => parseRunListResponse({ runs: [], nextCursor: null, goals: { r1: 'unmet' } }),
    (e: unknown) => e instanceof Error && /out of step/.test(e.message),
  );
  // An unknown status inside the new shape is still refused, not rendered.
  assert.throws(
    () => parseRunListResponse({ runs: [], nextCursor: null, goals: { r1: { status: 'teleported' } } }),
    (e: unknown) => e instanceof Error && /unknown goal status/.test(e.message),
  );
});

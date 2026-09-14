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
        { runs: Record<string, unknown>[]; goals: Record<string, { status: string; attempted?: boolean }> };
      assert.ok(Array.isArray(body.runs), 'runs must stay an array -- existing clients check it');
      assert.ok(body.runs.every((r) => !('goal' in r) && !('goalStatus' in r)),
        'goal status leaked onto the Run objects');
      assert.equal(body.goals[withGoal.id].status, 'active');
      // Unsettled, so `attempted` is absent rather than false.
      assert.equal('attempted' in body.goals[withGoal.id], false,
        'an unsettled goal reported an attempted answer it does not have');
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
  assert.match(goalBadge({ r1: { status: 'unmet' } }, 'r1'), /goal-unmet/);
  // "server said nothing" must not read as "no goal".
  assert.notEqual(goalBadge(undefined, 'r1'), goalBadge({}, 'r1'));
  // Cast: the type system already forbids this value, and the parser rejects it upstream. This
  // asserts the renderer does not depend on either of those, because a badge that trusts its
  // input is one schema change away from stored XSS.
  // Routed through the object shape the map now carries: the badge reads `goal.status` from raw
  // fetch data, so the escape has to hold on the new path, not just the old one.
  const xss = goalBadge({ r1: { status: 'active"><img src=x onerror=alert(1)>' } } as never, 'r1');
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

test('goal badge colours keep opposite meanings distinguishable', () => {
  // Colour is the fast channel on this view. The first .goal-unattempted rule used var(--muted),
  // which is exactly what .goal-none ("no goal") and .goal-unknown ("server does not report goals")
  // use -- so "the objective was not met", "there is no goal" and "we do not know" shared one colour.
  // That reintroduces, in CSS, the conflation issue #489 exists to remove, and no JS test can see it.
  const css = readFileSync(join(UI_DIR, 'style.css'), 'utf8');
  const colorOf = (cls: string): string => {
    const m = new RegExp(`\\.goal-${cls}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(m, `.goal-${cls} rule missing from style.css`);
    const c = /color:\s*([^;]+);/.exec(m[1]);
    assert.ok(c, `.goal-${cls} declares no colour`);
    return c[1].trim();
  };
  const unmet = colorOf('unmet');
  const unattempted = colorOf('unattempted');
  const none = colorOf('none');
  const unknown = colorOf('unknown');

  // Never-started stays in the unmet colour family: quieter, not a different statement.
  assert.equal(unattempted, unmet,
    `never-started (${unattempted}) left the unmet colour family (${unmet}) -- muting it reads as "nothing to report"`);
  // And none of the three opposite states may share a colour.
  assert.notEqual(unmet, none, 'unmet and "no goal" are the same colour');
  assert.notEqual(unattempted, unknown, 'never-started and "unknown" are the same colour');
  assert.notEqual(unmet, unknown, 'unmet and "unknown" are the same colour');

  // De-escalated by weight, so it is still visibly subordinate to a real unmet.
  const weight = (cls: string): string =>
    new RegExp(`\\.goal-${cls}\\s*\\{[^}]*font-weight:\\s*([^;]+);`).exec(css)?.[1]?.trim() ?? 'default';
  assert.notEqual(weight('unattempted'), weight('unmet'), 'never-started shouts at the same weight');
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


// --- the limitation docs/status.md records: no client can SET a goal -------------------------------
//
// Goals are wired end to end on the server -- `POST /api/runs` forwards `goal`, the detail page renders
// it, the list carries it, `/api/agents` advertises support for it -- and yet neither first-party client
// can create one, so the feature is reachable only by hand-writing HTTP. docs/status.md says so under
// "Goal setting has no client surface", and #575 holds the decision about whether that is temporary.
//
// This assertion exists so the docs cannot silently outlive the fact. Adding `--goal` or a dashboard goal
// field is the correct fix for #575, not a mistake -- but it must arrive together with the docs and the
// issue, or the next reader inherits a status page describing a limitation that no longer applies. That is
// the same drift #572 was about, so it is checked rather than remembered.

test('no first-party client can set a goal, and docs/status.md says so', () => {
  const cli = readFileSync(join(import.meta.dirname, '..', 'client', 'cli.ts'), 'utf8');
  const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
  const status = readFileSync(join(import.meta.dirname, '..', 'docs', 'status.md'), 'utf8');

  const createFlags = /'runs create':\s*\[([^\]]*)\]/.exec(cli);
  assert.ok(createFlags, 'could not find the `runs create` flag list in client/cli.ts -- update this test');
  assert.ok(
    !createFlags[1].includes("'--goal'"),
    'mercuryctl gained --goal. That closes part of #575: update the "Goal setting has no client surface" '
    + 'section of docs/status.md in the same change, or delete it if both clients can now set goals.',
  );

  const fields = [...html.matchAll(/<(?:input|select|textarea)[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(fields.length > 0, 'could not read the create-form fields from ui/index.html -- update this test');
  assert.ok(
    !fields.some((f) => /goal/i.test(f)),
    `ui/index.html gained a goal field (${fields.filter((f) => /goal/i.test(f)).join(', ')}). `
    + 'Update the "Goal setting has no client surface" section of docs/status.md and #575 in the same change.',
  );

  assert.match(status, /### Goal setting has no client surface/,
    'the status page no longer records the goal-setting gap; if a client can now set goals, that is correct '
    + '-- remove this section and this test together, and close #575.');
});


/*
 * docs/goals.md 13.6 describes three surfaces for goal capability. Two are shipped and one is not, and the
 * section used to describe all three as future work -- it opened "GET /api/agents returns bare strings today"
 * while the handler that returns `capabilities` cites this very section as its spec, and it said
 * `mercuryctl agents list` "gains a goal column" that the command already renders.
 *
 * That is not a cosmetic tense problem. 13.7 says it own way: "a stale table is worse than none because it
 * looks authoritative." Someone implementing #575 reads 13.6 as the work list, and would have started by
 * adding an API field and a CLI column that both exist.
 *
 * So these assertions bind the section to the code rather than to prose. If a shipped fact changes, the doc
 * has to change with it; if the dashboard starts reading capabilities, the "not built" claim fails and points
 * at #575.
 */

const GOALS_DOC = readFileSync(join(import.meta.dirname, '..', 'docs', 'goals.md'), 'utf8');
const ROUTES_SRC = readFileSync(join(import.meta.dirname, '..', 'src', 'api', 'routes.ts'), 'utf8');
const CLI_AGENTS_SRC = readFileSync(join(import.meta.dirname, '..', 'client', 'commands', 'agents.ts'), 'utf8');
const UI_INDEX_SRC = readFileSync(join(UI_DIR, 'index.js'), 'utf8');

/** The 13.6 section, up to the next heading. */
function section136(): string {
  const at = GOALS_DOC.indexOf('### 13.6');
  assert.notEqual(at, -1, 'docs/goals.md lost section 13.6');
  const next = GOALS_DOC.indexOf('\n### ', at + 5);
  return GOALS_DOC.slice(at, next === -1 ? GOALS_DOC.length : next);
}

test('13.6 does not describe the capability field as still missing', () => {
  const sec = section136();
  assert.doesNotMatch(sec, /returns bare strings|bare strings today/,
    'the handler in src/api/routes.ts returns capabilities alongside agents, and cites 13.6 as its spec');
  assert.doesNotMatch(sec, /\bmercuryctl agents list`? gains\b/,
    'mercuryctl already renders a GOALS column; "gains" reads as a to-do');

  // The claims the section now makes about shipped code, checked against that code.
  assert.match(sec, /"capabilities"/, 'the section no longer shows the shape the endpoint actually returns');
  assert.match(ROUTES_SRC, /capabilities\s*:/,
    'GET /api/agents no longer returns capabilities -- the section and the handler disagree');
  assert.match(CLI_AGENTS_SRC, /'GOALS'/,
    'mercuryctl agents list no longer renders a GOALS column -- the section and the CLI disagree');
});

test('13.6 keeps the dashboard as unbuilt work and points at the open issue', () => {
  const sec = section136();
  assert.match(sec, /Not built|not built/, 'the section no longer separates shipped from unbuilt');
  assert.match(sec, /issues\/575/, 'the unbuilt part lost its link to the open issue');
  // The claim rests on the UI not reading capabilities at all. If that changes, this fails and the
  // section must be rewritten -- which is exactly when #575 is being resolved.
  assert.equal(UI_INDEX_SRC.match(/capabilities/g), null,
    'ui/index.js now reads capabilities; 13.6 still calls the dashboard unbuilt, and #575 may be resolved');
});
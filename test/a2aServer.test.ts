// The A2A server spike (docs/a2a-design.md section 13 A0, A0-1 #986).
//
// Four questions were open when decision 3 was taken, and their answers are recorded in the design.
// This file is their EVIDENCE: each test drives the real SDK over Mercury's real Express app, so an
// answer is a request that succeeded rather than a reading of the SDK's package metadata.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { closeServer, createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { A2A_AGENT_CARD_PATH, A2A_PREFIX, A2A_SKILL_SELECTION_EXTENSION, BOT_OWNER_PREFIX, type A2aConfig } from '../src/a2a/config.ts';
import { botOwnerId } from '../src/host/bots/keys.ts';
import { createRunTaskStore } from '../src/a2a/taskStore.ts';
import { makeEnv, makeGitRepo, tempDir } from './helpers.ts';

const SKILL_ID = 'fix-a-test';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Every temp path goes through the helper (issue #73 L8): it registers the directory for the
// file-level teardown, so a test that fails mid-way still leaves nothing behind.
function tempRepo(): string {
  return makeGitRepo(tempDir('mercury-a2a-repo-'));
}

function a2aConfig(repo: string, over: Partial<A2aConfig> = {}): A2aConfig {
  // `maxRetries` is stated rather than left to a default: the blocking-wait test below turns on the
  // difference between a terminal ATTEMPT and a final CHAIN, and that difference only exists when a
  // retry is allowed.
  return {
    enabled: true,
    publicUrl: 'http://127.0.0.1:1',
    skills: [{
      id: SKILL_ID,
      name: 'Fix a failing test',
      description: 'Investigates and fixes one failing test.',
      owners: ['alice'],
      template: {
        task: 'An external agent asked for the following.\n---\n{{input}}',
        repository: { localPath: repo, baseBranch: 'main' },
        agent: 'fake',
        constraints: { maxDurationMs: 30_000, maxRetries: 0 },
      },
      inputMaxChars: 100,
    }],
    ...over,
  };
}

function makeApi(
  env: ReturnType<typeof makeEnv>,
  a2a?: A2aConfig,
  opts: {
    adminToken?: string | null;
    tokens?: [string, string][];
    rateLimits?: { createRun?: { windowMs: number; max: number } };
    settleMarginMs?: number;
  } = {},
) {
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    apiTokens: new Map(opts.tokens ?? [['tok-alice', 'alice'], ['tok-bob', 'bob']]),
    adminToken: opts.adminToken ?? null,
    ...(opts.rateLimits ? { rateLimits: opts.rateLimits } : {}),
    ...(a2a ? {
      a2a: {
        runService: env.runService,
        config: a2a,
        version: '0.0.0-test',
        ...(opts.settleMarginMs === undefined ? {} : { settleMarginMs: opts.settleMarginMs }),
      },
    } : {}),
  });
  return { app, close: () => stream.stop() };
}

async function listen(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    // Loopback explicitly, like test/api.test.ts: a wildcard bind can succeed on a port another
    // process holds on 127.0.0.1, and the request then reaches the wrong server.
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as { port: number }).port, close: () => closeServer(server) });
    });
  });
}

const ALICE = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
const EXT = { 'a2a-extensions': A2A_SKILL_SELECTION_EXTENSION };
const V1 = { 'a2a-version': '1.0', ...EXT };

type RestError = { error?: { code?: number; status?: string; message?: string; details?: { reason?: string }[] } };
type TaskBody = { id?: string; contextId?: string; status?: { state?: number; timestamp?: string }; metadata?: Record<string, unknown> };

test('spike Q1: the SDK REST binding serves on Mercury\'s Express 4 app, with no second framework', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close } = makeApi(env, a2aConfig(tempRepo()));
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      // A real request through the SDK's own REST router. The content type is the binding's, and the
      // error body is the SDK's REST error mapper, so this is the SDK answering -- not Mercury's
      // Express answering on the SDK's behalf.
      const res = await fetch(`${base}${A2A_PREFIX}/tasks/nope`, { headers: { ...ALICE, ...V1 } });
      const body = await res.json() as RestError;
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type') ?? '', /^application\/a2a\+json/);
      assert.equal(body.error?.details?.[0]?.reason, 'TASK_NOT_FOUND');

      // The framework is the one Mercury already depends on: Express 4, which is also what the
      // SDK's `express` optional peer dependency accepts (`^4.21.2 || ^5.1.0`).
      const expressVersion = (JSON.parse(readFileSync(join(ROOT, 'node_modules/express/package.json'), 'utf8')) as { version: string }).version;
      assert.equal(expressVersion.split('.')[0], '4', `the app under test must be Express 4, got ${expressVersion}`);
      const sdkPkg = JSON.parse(readFileSync(join(ROOT, 'node_modules/@a2a-js/sdk/package.json'), 'utf8')) as { peerDependencies: Record<string, string> };
      assert.ok(
        sdkPkg.peerDependencies.express!.includes('^4.21.2'),
        'the SDK must declare support for the Express 4 line Mercury runs',
      );
    } finally { await srv.close(); close(); }
  } finally { env.close(); }
});

test('spike Q2: no SDK task store is instantiated, and the store seam refuses writes', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    // The mounted handler needs no store at all: `A2ARequestHandler` is a plain interface and
    // Mercury implements it over RunService. The seam the SDK offers (`TaskStore`) is implementable
    // as reads with writes refused, which is what the boundary rule requires of it.
    const store = createRunTaskStore({ runService: env.runService });
    await assert.rejects(
      () => store.save({} as never, {} as never),
      /does not accept task writes/,
      'save must refuse: a second task store would disagree with the Run chain after a restart',
    );

    // Nothing under the boundary reaches for the SDK's own stores or its SQL-backed package.
    for (const file of sourceFiles(join(ROOT, 'src', 'a2a'))) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!/InMemoryTaskStore/.test(text), `${relative(ROOT, file)} must not instantiate the SDK's in-memory task store`);
      assert.ok(!/@a2a-js\/sdk\/server\/database/.test(text), `${relative(ROOT, file)} must not reach the SDK's SQL task stores`);
    }
  } finally { env.close(); }
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

test('spike Q3: v0.3 compatibility is off, and a missing or non-1.0 A2A-Version is refused', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close } = makeApi(env, a2aConfig(tempRepo()));
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      // The version header is the ONLY variable: `EXT` declares the required extension, and the
      // absent case genuinely omits the header rather than falling back to a default.
      const send = (version?: string) => fetch(`${base}${A2A_PREFIX}/message:send`, {
        method: 'POST',
        headers: { ...ALICE, ...EXT, ...(version === undefined ? {} : { 'a2a-version': version }) },
        body: JSON.stringify({
          // `returnImmediately` so a request that IS accepted does not hold the connection open for
          // the Run's whole deadline: this test is about the version gate, not about the wait.
          message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hello' }], metadata: { skillId: SKILL_ID } },
          configuration: { returnImmediately: true },
        }),
      });
      for (const version of [undefined, '0.3', '2.0']) {
        const res = await send(version);
        const body = await res.json() as RestError;
        assert.equal(res.status, 400, `A2A-Version ${version ?? '(absent)'} must be refused`);
        assert.equal(body.error?.details?.[0]?.reason, 'VERSION_NOT_SUPPORTED', `A2A-Version ${version ?? '(absent)'} must be VersionNotSupportedError`);
        // The refusal comes from the 1.0 REST binding itself, in the binding's own content type and
        // error shape -- not from a Mercury-level version check, and not from a route that happens
        // to be missing.
        //
        // What this does NOT prove, and cannot: that the SDK's opt-in v0.3 compatibility layer is
        // off. Enabling `legacyCompat` is unobservable here, because the CARD declares a single
        // 1.0 interface and `validateVersion` refuses v0.3 on either path. The card is therefore
        // the enforcement (§5), and the option is left absent as belt-and-braces rather than as the
        // mechanism. Recorded in §11 rather than claimed as a caught mutation.
        assert.match(res.headers.get('content-type') ?? '', /^application\/a2a\+json/, `A2A-Version ${version ?? '(absent)'} must be refused by the 1.0 REST binding`);
      }
      // The card is not version-gated: a client has to read it to learn which version to send.
      const card = await fetch(`${base}${A2A_AGENT_CARD_PATH}`);
      assert.equal(card.status, 200);
    } finally { await srv.close(); close(); }
  } finally { env.close(); }
});

test('spike Q4: Mercury\'s auth middleware runs before every SDK handler, and only the public card is exempt', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close } = makeApi(env, a2aConfig(tempRepo()));
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      // No credential: Mercury's own 401, from the same gate /api uses. The SDK never sees it.
      for (const [method, path] of [['GET', '/tasks/x'], ['POST', '/message:send'], ['POST', '/tasks/x:cancel']] as const) {
        const res = await fetch(`${base}${A2A_PREFIX}${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...V1 },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        assert.equal(res.status, 401, `${method} ${path} without a credential must be 401`);
        assert.deepEqual(await res.json(), { error: 'authentication required' });
      }
      // An invalid token is refused too -- the same resolver decides, so a bad token is not "no owner".
      const bad = await fetch(`${base}${A2A_PREFIX}/tasks/x`, { headers: { authorization: 'Bearer nope', ...V1 } });
      assert.equal(bad.status, 401);

      // The ONE exemption, and it is explicit: the public card. It carries no skills (section 6.8),
      // so an unauthenticated caller learns that the host speaks A2A and how to authenticate.
      const card = await fetch(`${base}${A2A_AGENT_CARD_PATH}`);
      assert.equal(card.status, 200);
      const cardBody = await card.json() as { skills?: unknown[]; supportedInterfaces?: { protocolVersion?: string; protocolBinding?: string }[] };
      // Protojson omits an empty repeated field, so "no skills" arrives as absent OR empty; both
      // mean the same thing to a client, and asserting only one of them would be a test of the
      // serializer rather than of the card.
      assert.equal((cardBody.skills ?? []).length, 0, 'the public card must list no skills');
      assert.equal(cardBody.supportedInterfaces?.[0]?.protocolVersion, '1.0');
      assert.equal(cardBody.supportedInterfaces?.[0]?.protocolBinding, 'HTTP+JSON');

      // The extended card is authenticated, and lists exactly the caller's skills.
      const extended = await fetch(`${base}${A2A_PREFIX}/extendedAgentCard`, { headers: { ...ALICE, ...V1 } });
      assert.equal(extended.status, 200);
      assert.deepEqual((await extended.json() as { skills: { id: string }[] }).skills.map((s) => s.id), [SKILL_ID]);
      // Bob owns nothing: his extended card is the public one, with no skills.
      const bob = await fetch(`${base}${A2A_PREFIX}/extendedAgentCard`, { headers: { authorization: 'Bearer tok-bob', ...V1 } });
      assert.equal(bob.status, 200);
      assert.equal(((await bob.json() as { skills?: unknown[] }).skills ?? []).length, 0);
    } finally { await srv.close(); close(); }
  } finally { env.close(); }
});

test('spike: SendMessage creates a Run with the server-stamped A2A origin, and GetTask reads the chain back', async () => {
  const env = makeEnv();
  try {
    const { app, close } = makeApi(env, a2aConfig(tempRepo()));
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const res = await fetch(`${base}${A2A_PREFIX}/message:send`, {
        method: 'POST',
        headers: { ...ALICE, ...V1 },
        body: JSON.stringify({ message: { messageId: 'msg-1', role: 'ROLE_USER', parts: [{ text: 'please fix it' }], metadata: { skillId: SKILL_ID } } }),
      });
      assert.equal(res.status, 200);
      const sent = await res.json() as { task?: TaskBody };
      const taskId = sent.task?.id;
      assert.ok(taskId, `SendMessage must return a task, got ${JSON.stringify(sent)}`);

      const run = env.runs.get(taskId)!;
      assert.equal(run.origin?.kind, 'a2a', 'an A2A-created Run must carry the server-stamped origin');
      assert.equal(run.origin?.ref, SKILL_ID);
      assert.match(run.task, /An external agent asked for the following\./, 'the operator\'s template text is the task');
      assert.match(run.task, /please fix it/, 'the caller\'s text is the only slot it fills');
      assert.equal(run.ownerId, 'alice');

      const got = await fetch(`${base}${A2A_PREFIX}/tasks/${taskId}`, { headers: { ...ALICE, ...V1 } });
      assert.equal(got.status, 200);
      const task = await got.json() as TaskBody;
      assert.equal(task.id, taskId);
      assert.equal(task.contextId, taskId);

      // Another owner cannot read it: the task is owner-scoped like every other Mercury surface.
      const other = await fetch(`${base}${A2A_PREFIX}/tasks/${taskId}`, { headers: { authorization: 'Bearer tok-bob', ...V1 } });
      assert.equal(other.status, 404);
    } finally { await srv.close(); close(); }
  } finally { env.close(); }
});

test('a default-configured server exposes no A2A route and no agent card', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    // Three ways to be off, and all three must be off: no config at all, disabled, and enabled with
    // an empty catalog (section 6.1 -- a card with no skills is a server that cannot do anything).
    const variants: (A2aConfig | undefined)[] = [
      undefined,
      a2aConfig(tempRepo(), { enabled: false }),
      a2aConfig(tempRepo(), { skills: [] }),
    ];
    for (const config of variants) {
      const { app, close } = makeApi(env, config);
      const srv = await listen(app);
      try {
        const base = `http://127.0.0.1:${srv.port}`;
        const card = await fetch(`${base}${A2A_AGENT_CARD_PATH}`);
        assert.equal(card.status, 404, 'a default-configured server must serve no agent card');
        const route = await fetch(`${base}${A2A_PREFIX}/tasks/x`, { headers: { ...ALICE, ...V1 } });
        assert.equal(route.status, 404, 'a default-configured server must serve no A2A route');
        // The native surface is untouched by any of this.
        assert.equal((await fetch(`${base}/healthz`)).status, 200);
      } finally { await srv.close(); close(); }
    }
  } finally { env.close(); }
});


// ---------------------------------------------------------------------------------------------
// Review round 1 (#1000). Five findings, each one a behavior the design states and the spike did
// not implement. Every one of them is driven through the real app, because each is a statement
// about a REQUEST, not about a helper.
// ---------------------------------------------------------------------------------------------

/** The body the binding accepts for a new task, so the refusal tests are about the refusal. */
function sendBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hello' }], metadata: { skillId: SKILL_ID }, ...over },
    configuration: { returnImmediately: true },
  });
}

test('section 6.3: admin and bot credentials are refused on every A2A route, and only there', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close } = makeApi(env, a2aConfig(tempRepo()), {
      adminToken: 'tok-admin',
      tokens: [['tok-alice', 'alice'], ['tok-bot', 'bot-nightly']],
    });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const routes = [
        ['GET', '/tasks/x'], ['POST', '/message:send'], ['POST', '/tasks/x:cancel'],
        ['GET', '/tasks'], ['GET', '/extendedAgentCard'],
      ] as const;
      for (const [label, header] of [['admin', 'Bearer tok-admin'], ['bot', 'Bearer tok-bot']] as const) {
        for (const [method, path] of routes) {
          const res = await fetch(`${base}${A2A_PREFIX}${path}`, {
            method,
            headers: { authorization: header, 'content-type': 'application/json', ...V1 },
            ...(method === 'POST' ? { body: '{}' } : {}),
          });
          assert.equal(res.status, 403, `${label} ${method} ${path} must be refused (section 6.3)`);
        }
      }
      // The refusal is Mercury's, BEFORE the SDK: an A2A error body would mean the SDK answered,
      // and `requireAuth` alone would have accepted the admin token and passed `isAdmin` on.
      const refused = await fetch(`${base}${A2A_PREFIX}/tasks/x`, { headers: { authorization: 'Bearer tok-admin', ...V1 } });
      assert.deepEqual(await refused.json(), { error: 'admin credentials are not accepted on A2A routes' });
      const botRefused = await fetch(`${base}${A2A_PREFIX}/tasks/x`, { headers: { authorization: 'Bearer tok-bot', ...V1 } });
      assert.deepEqual(await botRefused.json(), { error: 'bot credentials are not accepted on A2A routes' });

      // The public card is the one exemption, and it is exempt from AUTHENTICATION -- so a credential
      // that is refused everywhere else is simply not consulted here.
      assert.equal((await fetch(`${base}${A2A_AGENT_CARD_PATH}`)).status, 200);
      assert.equal((await fetch(`${base}${A2A_AGENT_CARD_PATH}`, { headers: { authorization: 'Bearer tok-admin' } })).status, 200);

      // The refusal is keyed on the prefix the bot layer actually writes, pinned here against the
      // helper that produces a real bot owner id: a rename on either side would otherwise turn the
      // gate into a no-op that every test above still passes.
      assert.ok(botOwnerId('nightly').startsWith(BOT_OWNER_PREFIX),
        `BOT_OWNER_PREFIX must match the owner ids src/host/bots writes, got ${botOwnerId('nightly')}`);

      // An ordinary owner is unaffected, and the refusal is A2A-SPECIFIC: the admin token is still
      // admin on the native API, where seeing across owners is the point.
      assert.equal((await fetch(`${base}${A2A_PREFIX}/extendedAgentCard`, { headers: { ...ALICE, ...V1 } })).status, 200);
      assert.equal((await fetch(`${base}/api/runs`, { headers: { authorization: 'Bearer tok-admin' } })).status, 200);
    } finally { await srv.close(); close(); }
  } finally { env.close(); }
});

test('section 6.4: a new-task message carrying a contextId is rejected, not silently re-contexted', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close } = makeApi(env, a2aConfig(tempRepo()));
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const res = await fetch(`${base}${A2A_PREFIX}/message:send`, {
        method: 'POST',
        headers: { ...ALICE, ...V1 },
        body: sendBody({ contextId: 'existing-context' }),
      });
      const body = await res.json() as RestError;
      assert.equal(res.status, 400, 'a caller-supplied contextId must be refused');
      assert.match(body.error?.message ?? '', /contextId/);
      // The point of the refusal: accepting it would have created a Run and then answered with the
      // ROOT RUN ID as the context -- work done in a context the caller believes it chose.
      assert.equal(env.runs.list({ ownerId: 'alice', limit: 10 }).runs.length, 0, 'no Run may be created for a refused message');
      // The refusal is about the field, not about sending: the same message without it is accepted.
      const ok = await fetch(`${base}${A2A_PREFIX}/message:send`, {
        method: 'POST', headers: { ...ALICE, ...V1 }, body: sendBody({ messageId: 'm2' }),
      });
      assert.equal(ok.status, 200);
    } finally { await srv.close(); close(); }
  } finally { env.close(); }
});

test('caller text reaches the agent literally, including $& and $$', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close } = makeApi(env, a2aConfig(tempRepo()));
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      // `String.replace` interprets these in a STRING replacement: `$&` is the matched text (here
      // `{{input}}`), `$$` is one literal `$`. This is a coding agent, so both are ordinary input.
      const text = 'Fix the regex /$&/ and the shell $$HOME, then `$1`.';
      const res = await fetch(`${base}${A2A_PREFIX}/message:send`, {
        method: 'POST', headers: { ...ALICE, ...V1 },
        body: JSON.stringify({
          message: { messageId: 'm-literal', role: 'ROLE_USER', parts: [{ text }], metadata: { skillId: SKILL_ID } },
          configuration: { returnImmediately: true },
        }),
      });
      assert.equal(res.status, 200);
      const taskId = ((await res.json()) as { task?: TaskBody }).task?.id;
      assert.ok(taskId);
      const run = env.runs.get(taskId)!;
      assert.ok(run.task.includes(text), `the caller's text must arrive unchanged, got: ${run.task}`);
      assert.ok(!run.task.includes('{{input}}'), 'the placeholder must not survive as the matched text');
    } finally { await srv.close(); close(); }
  } finally { env.close(); }
});

test('section 6.6: a blocking SendMessage waits through a retry backoff and reports the CHAIN', async () => {
  // An INFRASTRUCTURE failure is the kind the worker auto-retries (worker.ts autoRetryDueAt), so
  // this is the one shape where a terminal attempt is not a final chain.
  const env = makeEnv({
    fakeScript: [{ exit: { code: 1, signal: null, reason: 'failed', errorKind: 'infrastructure' } }],
    maxRetries: 1,
    retryBackoffMs: 250,
  });
  try {
    const repo = tempRepo();
    const config = a2aConfig(repo, {});
    config.skills = [{ ...config.skills[0]!, template: { ...config.skills[0]!.template, constraints: { maxDurationMs: 30_000, maxRetries: 1 } } }];
    const { app, close } = makeApi(env, config);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const started = Date.now();
      const res = await fetch(`${base}${A2A_PREFIX}/message:send`, {
        method: 'POST', headers: { ...ALICE, ...V1 },
        // NOT returnImmediately: this is the blocking path.
        body: JSON.stringify({ message: { messageId: 'm-block', role: 'ROLE_USER', parts: [{ text: 'do it' }], metadata: { skillId: SKILL_ID } } }),
      });
      const elapsed = Date.now() - started;
      assert.equal(res.status, 200);
      const task = ((await res.json()) as { task?: TaskBody & { status?: { state?: string } } }).task;
      assert.ok(task?.id);
      // Both attempts ran: the wait covered the backoff instead of returning the failed attempt.
      assert.equal(env.runs.listChain(task.id).length, 2, 'the blocking wait must cover the retry, not end on the failed attempt');
      assert.ok(elapsed >= 250, `the wait must include the backoff, waited ${elapsed}ms`);
      // And the reported state is the FINAL chain's, not the retry-pending WORKING of attempt 1.
      // Protojson serializes the enum by NAME, so this is the name rather than its number.
      assert.equal(task.status?.state, 'TASK_STATE_FAILED', 'a final chain of failed attempts reports FAILED');
      // `retryPending` is gone from the metadata for the same reason.
      assert.equal((task.metadata as { mercury?: { attempt?: number; retryPending?: boolean } })?.mercury?.attempt, 2);
      assert.equal((task.metadata as { mercury?: { retryPending?: boolean } })?.mercury?.retryPending, false);
    } finally { await srv.close(); close(); }
  } finally { env.close(); }
});

test('SendMessage draws on the SAME Run-creation budget as POST /api/runs', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const repo = tempRepo();
    const { app, close } = makeApi(env, a2aConfig(repo), { rateLimits: { createRun: { windowMs: 60_000, max: 1 } } });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      // The budget is spent on the NATIVE route first, by the same owner. If A2A had its own
      // limiter -- or none -- the SendMessage below would succeed.
      const native = await fetch(`${base}/api/runs`, {
        method: 'POST', headers: { ...ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'native', repository: { localPath: repo, baseBranch: 'main' } }),
      });
      assert.equal(native.status, 201, `the native create must be the one that spends the budget, got ${native.status}`);
      const res = await fetch(`${base}${A2A_PREFIX}/message:send`, {
        method: 'POST', headers: { ...ALICE, ...V1 }, body: sendBody(),
      });
      assert.equal(res.status, 429, 'SendMessage must share the Run-creation budget, not bypass it');
      // A DIFFERENT message id would otherwise be a fresh idempotency key, which is exactly the
      // bypass this covers: distinct ids, one queue, no limit.
      assert.equal((await fetch(`${base}${A2A_PREFIX}/message:send`, {
        method: 'POST', headers: { ...ALICE, ...V1 }, body: sendBody({ messageId: 'm-other' }),
      })).status, 429);
      // ... and the same budget by SPELLING. Express routes case-insensitively and ignores a trailing
      // slash by default, so all four of these reach the SDK's send route; a case-sensitive suffix
      // check skipped the limiter for every one of them. A 429 rather than a 404 is the evidence
      // that the variant really does reach the route AND that the budget applies to it.
      for (const path of [
        '/message:send/', '/MESSAGE:SEND', '/message:send/',
        '/tenant-a/message:send/', '/TENANT-A/MESSAGE:SEND',
      ]) {
        const res = await fetch(`${base}${A2A_PREFIX}${path}`, {
          method: 'POST', headers: { ...ALICE, ...V1 }, body: sendBody({ messageId: `m-${path}` }),
        });
        assert.equal(res.status, 429, `POST ${path} must draw on the same budget, got ${res.status}`);
      }
      // Cancelling is not Run creation and must not spend the budget: a caller at the limit still
      // has to be able to cancel.
      assert.notEqual((await fetch(`${base}${A2A_PREFIX}/tasks/nope:cancel`, {
        method: 'POST', headers: { ...ALICE, ...V1 }, body: '{}',
      })).status, 429);
    } finally { await srv.close(); close(); }
  } finally { env.close(); }
});

test('section 6.6: the blocking bound follows a persisted retry due time, not just the config budget', async () => {
  // The margin is 100 ms here rather than the 5 s default, and the backoff (700 ms) is far longer
  // than the resulting initial budget (2 x (100 + 100) = 400 ms). A wait bounded only by config
  // would therefore return attempt 1's retry-pending WORKING task at ~400 ms. This is the case the
  // earlier test could not reach: it used a backoff SHORTER than the default margin.
  const env = makeEnv({
    fakeScript: [{ exit: { code: 1, signal: null, reason: 'failed', errorKind: 'infrastructure' } }],
    maxRetries: 1,
    retryBackoffMs: 700,
    pollMs: 25,
  });
  try {
    const repo = tempRepo();
    const config = a2aConfig(repo, {});
    config.skills = [{ ...config.skills[0]!, template: { ...config.skills[0]!.template, constraints: { maxDurationMs: 100, maxRetries: 1 } } }];
    const { app, close } = makeApi(env, config, { settleMarginMs: 100 });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const started = Date.now();
      const res = await fetch(`${base}${A2A_PREFIX}/message:send`, {
        method: 'POST', headers: { ...ALICE, ...V1 },
        body: JSON.stringify({ message: { messageId: 'm-long-backoff', role: 'ROLE_USER', parts: [{ text: 'do it' }], metadata: { skillId: SKILL_ID } } }),
      });
      const elapsed = Date.now() - started;
      assert.equal(res.status, 200);
      const task = ((await res.json()) as { task?: TaskBody & { status?: { state?: string } } }).task;
      assert.ok(task?.id);
      assert.equal(env.runs.listChain(task.id).length, 2, 'the wait must cover a backoff longer than the margin');
      assert.ok(elapsed >= 700, `the wait must include the whole backoff, waited ${elapsed}ms`);
      assert.equal(task.status?.state, 'TASK_STATE_FAILED', 'the wait must not end on the retry-pending attempt');
    } finally { await srv.close(); close(); }
  } finally { env.close(); }
});

test('the card advertises the field the handler actually reads', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close } = makeApi(env, a2aConfig(tempRepo()));
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const card = await (await fetch(`${base}${A2A_AGENT_CARD_PATH}`)).json() as {
        capabilities?: { extensions?: { uri?: string; description?: string }[] };
      };
      const extension = card.capabilities?.extensions?.find((e) => e.uri === A2A_SKILL_SELECTION_EXTENSION);
      assert.ok(extension, 'the required skill-selection extension must be on the card');
      // `SendMessageRequest.message.metadata`, the path `resolveSkill` reads. Advertising
      // `SendMessageRequest.metadata` sends a compliant client into a malformed-request error.
      assert.match(extension.description ?? '', /SendMessageRequest\.message\.metadata\.skillId/);
    } finally { await srv.close(); close(); }
  } finally { env.close(); }
});

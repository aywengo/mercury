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
import { A2A_AGENT_CARD_PATH, A2A_PREFIX, A2A_SKILL_SELECTION_EXTENSION, type A2aConfig } from '../src/a2a/config.ts';
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
        constraints: { maxDurationMs: 30_000 },
      },
      inputMaxChars: 100,
    }],
    ...over,
  };
}

function makeApi(env: ReturnType<typeof makeEnv>, a2a?: A2aConfig) {
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    apiTokens: new Map([['tok-alice', 'alice'], ['tok-bob', 'bob']]),
    adminToken: null,
    ...(a2a ? { a2a: { runService: env.runService, config: a2a, version: '0.0.0-test' } } : {}),
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

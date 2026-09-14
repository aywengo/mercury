/**
 * The dashboard half of issue #523: what `ui/index.js` does with the `/api/agents` payload.
 *
 * `e2e/system.test.ts` pins the SERVER half of the agreement -- `agents` stays a plain `string[]`,
 * because `src/api/routes.ts` adds `capabilities` as a parallel field for no other reason. The other
 * half was unguarded: the dashboard's own guard lived inside DOM code that no test loaded, so deleting
 * it would have been silent. That is the asymmetry #523 was filed about.
 *
 * The guard now lives in `agentOptions()` (ui/app.js), a pure function, so the property that must hold
 * is the property under test rather than a line someone can remove while touching the file. This is the
 * same shape `goalContractUi.test.ts` uses for the dashboard half of #497 -- import the helper, assert
 * on its output -- and needs no browser.
 *
 * Two of #523's three acceptance criteria asked for things this dashboard does not render: there is no
 * SKILLS column (the run-list columns are Run, Task, Repo, Agent, Status, Goal, Created, Duration), and
 * the dashboard never reads `capabilities` at all -- `loadAgents()` consumes `agents` and `defaultAgent`
 * and nothing else. Asserting them would have been a DOM assertion reading as coverage it does not
 * provide, which is the failure mode the issue itself warns against. Criterion 1 is real and is covered
 * here against the live endpoint.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Express } from 'express';
import { createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { FakeAgentAdapter } from '../src/adapters/fakeAgentAdapter.ts';
import { expectStatus, makeEnv } from './helpers.ts';
import { agentOptions } from '../ui/app.js';

function opts(payload: unknown): { options: string[] | null; value: string | null } {
  return agentOptions(payload);
}

// --- criterion 1: a server-registered agent reaches the dropdown ----------------------------------

test('a server-registered agent is listed, not just the page\'s hardcoded fallbacks', () => {
  const r = opts({ agents: ['fake', 'hermes'], defaultAgent: 'hermes' });
  assert.deepEqual(r.options, ['fake', 'hermes']);
  assert.equal(r.value, 'hermes', 'the server default must be what the dropdown opens on');
});

test('the payload the real endpoint returns lists a registered agent', async () => {
  // The unit cases above use hand-written payloads; this one uses the server's actual response, so the
  // two halves of the contract are checked against each other rather than against my reading of them.
  // `hermes` is registered but is NOT one of the two options hardcoded in index.html, so seeing it here
  // is what "the server list replaced the static one" means in practice.
  const env = makeEnv({ workerEnabled: false, adapters: { hermes: new FakeAgentAdapter({ script: [] }) } });
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    apiTokens: new Map([['tok-alice', 'alice']]),
    adminToken: null,
  });
  const srv = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/agents`, {
      headers: { authorization: 'Bearer tok-alice' },
    });
    await expectStatus(res, 200, 'GET /api/agents');
    const payload = await res.json() as Record<string, unknown>;
    const r = opts(payload);
    assert.ok(r.options, 'the live payload was rejected by the guard, so the dropdown would keep its static options');
    assert.ok(r.options!.includes('hermes'), `registered agent missing from the dropdown options: ${JSON.stringify(r.options)}`);
    assert.equal(r.value, 'fake', 'defaultAgent is fake, so fake must be selected');
  } finally {
    await srv.close();
    stream.stop();
    env.close();
  }
});

// --- the guard that keeps a reshaped payload from emptying the dropdown ---------------------------

test('a non-array agents value keeps the page\'s own static options', () => {
  // This is the exact regression src/api/routes.ts documents when it explains why `capabilities` is a
  // parallel field: reshaping `agents` into objects must not leave a working server showing two
  // hardcoded agents with no error anywhere.
  for (const payload of [
    {},
    { agents: null },
    { agents: 'fake' },
    { agents: { 0: 'fake', 1: 'hermes' } },
    { agents: [{ id: 'fake' }, { id: 'hermes' }] }, // the reshaping the server comment warns about
    null,
    undefined,
  ]) {
    const r = opts(payload);
    assert.deepEqual(r, { options: null, value: null },
      `payload ${JSON.stringify(payload)} must leave the <select> untouched`);
  }
});

test('an array of unusable ids is treated as a payload we do not understand', () => {
  // The old code did `opt.textContent = a` for every element, so this input rendered one <option>
  // reading "[object Object]" per entry: a dropdown that looks populated and cannot create a Run.
  for (const payload of [
    { agents: [{ id: 'fake' }] },
    { agents: [1, 2, 3] },
    { agents: [null, ''] },
  ]) {
    assert.deepEqual(opts(payload), { options: null, value: null },
      `${JSON.stringify(payload)} would have rendered unusable options`);
  }
});

test('usable ids survive alongside unusable ones', () => {
  const r = opts({ agents: ['fake', { id: 'hermes' }, '', 'hermes'] });
  assert.deepEqual(r.options, ['fake', 'hermes']);
});

// --- which option is selected ---------------------------------------------------------------------

test('the server default wins when it is registered', () => {
  assert.equal(opts({ agents: ['fake', 'hermes'], defaultAgent: 'hermes' }).value, 'hermes');
});

test('an unregistered default is not selected, so the dropdown cannot hold a value it cannot submit', () => {
  // select.value = 'ghost' on a <select> without that option leaves value === '', so the create form
  // would submit an agent id the server rejects. Falling through is the correct reading.
  const r = opts({ agents: ['hermes', 'local'], defaultAgent: 'ghost' });
  assert.equal(r.value, 'hermes', 'falls through to fake, then to the first id');
});

test('fake is preferred over the first id when the default is absent', () => {
  // Matches the pre-extraction behaviour: `fake` is the only adapter guaranteed to exist, so a page
  // that defaults to it never creates a Run against something that may not be installed.
  assert.equal(opts({ agents: ['hermes', 'fake'] }).value, 'fake');
  assert.equal(opts({ agents: ['hermes', 'local'] }).value, 'hermes');
});

test('a non-string defaultAgent can never match, so it falls through', () => {
  // There is no `typeof` guard on defaultAgent, and this is what makes it unnecessary: `ids` holds only
  // strings and `includes` compares by identity, so 42, null, and an object whose toString() returns a
  // real id all fail to match and the fallback applies. The object case is the one that would matter --
  // a truthy non-string that stringifies to a registered id must still not be selected.
  assert.equal(opts({ agents: ['hermes'], defaultAgent: 42 }).value, 'hermes');
  assert.equal(opts({ agents: ['hermes'], defaultAgent: null }).value, 'hermes');
  assert.equal(opts({ agents: ['hermes'], defaultAgent: { toString: () => 'hermes' } }).value, 'hermes');
  assert.equal(opts({ agents: ['fake', 'hermes'], defaultAgent: { toString: () => 'hermes' } }).value, 'fake');
});

test('an empty agents array yields an empty dropdown, not the static options', () => {
  // Pinned as current behaviour, not endorsed. Unreachable through the server: RunService's constructor
  // throws unless defaultAgent is among knownAgents, so a server with no adapters never boots. Recorded
  // so a future change to that constructor cannot silently alter this too.
  assert.deepEqual(opts({ agents: [], defaultAgent: 'fake' }), { options: [], value: null });
});

// --- helpers --------------------------------------------------------------------------------------

function listen(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    // Explicit loopback host: a wildcard bind on macOS can coexist with another process already holding
    // 127.0.0.1, and requests meant for this app are answered by the other socket (issue #185).
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => new Promise<void>((res) => server.close(() => res())) });
    });
  });
}

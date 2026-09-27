// Owner-transfer API for a removed bot's Runs (dispatcher-bot-design §17.7, issue #760):
// admin-only POST /api/runs/reassign rewrites runs.owner_id in one transaction with a
// run.owner_reassigned event per Run; the uninstall flag calls it before teardown.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { expectStatus, makeEnv, tempDir } from './helpers.ts';
import { closeServer, createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';

function makeApi(env: ReturnType<typeof makeEnv>, tokens: [string, string][] = [['tok-alice', 'alice']], admin?: string) {
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    apiTokens: new Map(tokens),
    adminToken: admin ?? null,
  });
  return { app, stream, close: () => stream.stop() };
}

async function listen(app: import('express').Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      // closeServer (not bare server.close): it force-destroys keep-alive sockets after the
      // grace window, so undici's connection pool cannot hold the test process open.
      resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, close: () => closeServer(server) });
    });
  });
}

async function createRunAs(env: ReturnType<typeof makeEnv>, port: number, token: string, owner: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ task: `run for ${owner}`, repository: { url: 'https://github.com/aywengo/mercury' } }),
  });
  await expectStatus(res, 201, 'run create');
  const body = await res.json() as { runId: string };
  return body.runId;
}

test('POST /runs/reassign: admin rewrites every Run of fromOwner in one call, with an event each', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close } = makeApi(env, [['tok-alice', 'alice'], ['tok-bot', 'bot-nightly']], 'tok-admin');
    const { port, close: stop } = await listen(app);
    try {
      const a = await createRunAs(env, port, 'tok-alice', 'alice');
      const b = await createRunAs(env, port, 'tok-bot', 'bot-nightly');
      const b2 = await createRunAs(env, port, 'tok-bot', 'bot-nightly');
      const res = await fetch(`http://127.0.0.1:${port}/api/runs/reassign`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-admin', 'content-type': 'application/json' },
        body: JSON.stringify({ fromOwner: 'bot-nightly', toOwner: 'alice' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { transferred: number; runIds: string[] };
      assert.equal(body.transferred, 2);
      assert.deepEqual([...body.runIds].sort(), [b, b2].sort());
      // alice's token now sees all three Runs; the bot token sees none.
      const listAlice = await fetch(`http://127.0.0.1:${port}/api/runs`, { headers: { authorization: 'Bearer tok-alice' } });
      const la = await listAlice.json() as { runs: { id: string }[] };
      assert.deepEqual(la.runs.map((r) => r.id).sort(), [a, b, b2].sort());
      const listBot = await fetch(`http://127.0.0.1:${port}/api/runs`, { headers: { authorization: 'Bearer tok-bot' } });
      const lb = await listBot.json() as { runs: { id: string }[] };
      assert.equal(lb.runs.length, 0, 'the dead bot owner keeps nothing');
      // The audit trail: a run.owner_reassigned event per transferred Run.
      const evRes = await fetch(`http://127.0.0.1:${port}/api/runs/${b}/events`, { headers: { authorization: 'Bearer tok-admin' } });
      const ev = await evRes.json() as { events: { type: string; payload?: { fromOwner?: string; toOwner?: string } }[] };
      const transfer = ev.events.find((e) => e.type === 'run.owner_reassigned');
      assert.ok(transfer, 'transfer event appended');
      assert.equal(transfer.payload?.fromOwner, 'bot-nightly');
      assert.equal(transfer.payload?.toOwner, 'alice');
    } finally {
      await stop();
      close();
    }
  } finally {
    env.close();
  }
});

test('POST /runs/reassign: non-admin gets 403, unauthenticated 401, bad input 400', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close } = makeApi(env, [['tok-alice', 'alice']], 'tok-admin');
    const { port, close: stop } = await listen(app);
    try {
      const nonAdmin = await fetch(`http://127.0.0.1:${port}/api/runs/reassign`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' },
        body: JSON.stringify({ fromOwner: 'bot-nightly', toOwner: 'alice' }),
      });
      assert.equal(nonAdmin.status, 403);
      const unauth = await fetch(`http://127.0.0.1:${port}/api/runs/reassign`, { method: 'POST' });
      assert.equal(unauth.status, 401);
      for (const bad of [
        { fromOwner: '', toOwner: 'alice' },
        { fromOwner: 'bot-nightly', toOwner: '' },
        { fromOwner: 'bot-nightly', toOwner: 'bot-nightly' },
        { fromOwner: 'has space', toOwner: 'alice' },
        {},
      ]) {
        const res = await fetch(`http://127.0.0.1:${port}/api/runs/reassign`, {
          method: 'POST',
          headers: { authorization: 'Bearer tok-admin', 'content-type': 'application/json' },
          body: JSON.stringify(bad),
        });
        assert.equal(res.status, 400, `bad input refused: ${JSON.stringify(bad)}`);
      }
    } finally {
      await stop();
      close();
    }
  } finally {
    env.close();
  }
});

test('reassigning an owner with no Runs answers transferred 0 (idempotent, no error)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close } = makeApi(env, [], 'tok-admin');
    const { port, close: stop } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/runs/reassign`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-admin', 'content-type': 'application/json' },
        body: JSON.stringify({ fromOwner: 'bot-ghost', toOwner: 'alice' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { transferred: number };
      assert.equal(body.transferred, 0);
    } finally {
      await stop();
      close();
    }
  } finally {
    env.close();
  }
});

// Issue #185: a run reported `actual: 403, expected: 401` and nothing in src/ can return 403.
// Nothing was attributable, because the assertion reported only two numbers.
// These tests pin the DIAGNOSTIC, and they pin it by making it fire: a guard that is only ever
// observed staying silent is not known to work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { expectStatus, makeEnv } from './helpers.ts';
import { createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';

function foreignServer(status: number, body: string): Promise<{ port: number; close: () => Promise<void> }> {
  // A bare node:http server: it does NOT set x-powered-by, which is exactly the difference between
  // 'Mercury answered' and 'something else on this port answered'.
  const s = createServer((_req, res) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(body); });
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      resolve({ port, close: () => new Promise<void>((r) => s.close(() => r())) });
    });
  });
}

async function failureMessage(fn: () => Promise<void>): Promise<string> {
  try { await fn(); } catch (e) { return (e as Error).message; }
  assert.fail('expected expectStatus to fail, but it passed');
}

test('a 403 from a NON-Mercury responder is reported as not-from-the-app (issue #185)', async () => {
  const srv = await foreignServer(403, 'denied by something that is not mercury');
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/runs`);
    assert.equal(res.status, 403, 'fixture must actually produce the 403 this issue saw');
    const msg = await failureMessage(() => expectStatus(res, 401, 'no credential on /api/runs'));
    assert.match(msg, /not a Mercury response/i, `diagnostic must clear the app, got: ${msg}`);
    assert.match(msg, /got 403/, 'must name the status it saw');
    assert.match(msg, /denied by something that is not mercury/, 'must include the body it read');
  } finally {
    await srv.close();
  }
});

test('an unexpected status FROM the app is reported as from-the-app (issue #185)', async () => {
  // The other branch. If both branches said 'not the app', the discriminator would be decoration.
  const env = makeEnv({ workerEnabled: false });
  try {
    const stream = new EventStream(env.db, env.events, 250, 2000);
    stream.start();
    const app = createApp({
      runService: env.runService, events: env.events, stream,
      apiTokens: new Map([['tok-alice', 'alice']]), adminToken: null,
    });
    const srv = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        const port = (s.address() as { port: number }).port;
        resolve({ port, close: () => new Promise<void>((r) => s.close(() => r())) });
      });
    });
    try {
      // /healthz is public and answers 200; asking for 401 there is the mismatch, and the responder
      // is genuinely Mercury, so the message must say so.
      const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
      const msg = await failureMessage(() => expectStatus(res, 401, 'deliberate mismatch on /healthz'));
      assert.match(msg, /FROM THE APP/, `diagnostic must blame the app here, got: ${msg}`);
      assert.match(msg, /got 200/, 'must name the status it saw');
    } finally {
      await srv.close();
      stream.stop();
    }
  } finally {
    env.close();
  }
});

test('expectStatus passes silently on the expected status and does not drain the body', async () => {
  // The happy path must cost nothing: reading the body eagerly would break later assertions that
  // still expect it untouched (the trap recorded in auth.test.ts for issue #73 L5).
  const srv = await foreignServer(401, 'keep-me-intact');
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/x`);
    await expectStatus(res, 401, 'matching status');
    assert.ok(!res.bodyUsed, 'a passing assertion must not read the body');
    assert.equal(await res.text(), 'keep-me-intact', 'body must still be readable afterwards');
  } finally {
    await srv.close();
  }
});

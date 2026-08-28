// Session-cookie auth, rate limiting, and cookie owner-scoping (Mercury.md section 24).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/server.ts';
import { createSessionStore } from '../src/api/sessions.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { makeEnv, waitFor } from './helpers.ts';
import type { Express } from 'express';

type ApiOpts = {
  tokens?: [string, string][];
  admin?: string;
  rateLimits?: { login?: { windowMs: number; max: number }; createRun?: { windowMs: number; max: number } };
};

function makeApi(env: ReturnType<typeof makeEnv>, opts: ApiOpts = {}) {
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    apiTokens: new Map(opts.tokens ?? [['tok-alice', 'alice']]),
    adminToken: opts.admin ?? null,
    rateLimits: opts.rateLimits,
  });
  return { app, close: () => stream.stop() };
}

async function listen(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

async function login(base: string, token: string): Promise<Response> {
  return fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

function sidFrom(res: Response): string | null {
  const sc = res.headers.get('set-cookie');
  if (!sc) return null;
  const m = /^mercury_session=([^;]+);/.exec(sc);
  return m ? m[1] : null;
}

function cookieHeader(sid: string): Record<string, string> {
  return { cookie: `mercury_session=${sid}` };
}

test('login with valid token sets HttpOnly session cookie; cookie auth works on the API', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const res = await login(base, 'tok-alice');
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; ownerId: string; isAdmin: boolean };
      assert.equal(body.ok, true);
      assert.equal(body.ownerId, 'alice');
      assert.equal(body.isAdmin, false);

      const sc = res.headers.get('set-cookie');
      assert.ok(sc, 'Set-Cookie present');
      assert.match(sc, /^mercury_session=[a-f0-9]{64};/);
      assert.match(sc, /HttpOnly/);
      assert.match(sc, /SameSite=Strict/);
      assert.match(sc, /Path=\//);
      assert.match(sc, /Max-Age=604800/); // 7 days

      const sid = sidFrom(res)!;
      // cookie auth: no Authorization header at all
      const list = await fetch(`${base}/api/runs`, { headers: cookieHeader(sid) });
      assert.equal(list.status, 200);

      const me = await fetch(`${base}/api/auth/me`, { headers: cookieHeader(sid) });
      assert.equal(me.status, 200);
      const meBody = (await me.json()) as { ownerId: string; isAdmin: boolean };
      assert.equal(meBody.ownerId, 'alice');
      assert.equal(meBody.isAdmin, false);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('login with invalid or missing token -> 401, no cookie, generic error', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, { tokens: [['tok-alice', 'alice']] });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const bad = await login(base, 'wrong-token');
      assert.equal(bad.status, 401);
      assert.equal(bad.headers.get('set-cookie'), null);
      const badBody = (await bad.json()) as { error: string };

      const empty = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(empty.status, 401);
      assert.equal(empty.headers.get('set-cookie'), null);
      const emptyBody = (await empty.json()) as { error: string };

      // no oracle: same generic error for unknown token and missing token
      assert.equal(badBody.error, emptyBody.error);

      // a fake cookie never authenticates
      const fake = await fetch(`${base}/api/runs`, { headers: cookieHeader('deadbeef'.repeat(8)) });
      assert.equal(fake.status, 401);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('logout clears the cookie and invalidates the session', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const sid = sidFrom(await login(base, 'tok-alice'))!;
      const ok = await fetch(`${base}/api/runs`, { headers: cookieHeader(sid) });
      assert.equal(ok.status, 200);

      const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: cookieHeader(sid) });
      assert.equal(out.status, 200);
      assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);

      const after = await fetch(`${base}/api/runs`, { headers: cookieHeader(sid) });
      assert.equal(after.status, 401);
      const me = await fetch(`${base}/api/auth/me`, { headers: cookieHeader(sid) });
      assert.equal(me.status, 401);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('cookie auth respects owner scoping (cross-owner access is 404)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, { tokens: [['tok-alice', 'alice'], ['tok-bob', 'bob']] });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const aliceSid = sidFrom(await login(base, 'tok-alice'))!;
      const bobSid = sidFrom(await login(base, 'tok-bob'))!;

      const created = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { ...cookieHeader(aliceSid), 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'secret work', agent: 'fake' }),
      });
      assert.equal(created.status, 201);
      const { runId } = (await created.json()) as { runId: string };

      const aliceGets = await fetch(`${base}/api/runs/${runId}`, { headers: cookieHeader(aliceSid) });
      assert.equal(aliceGets.status, 200);

      const bobGets = await fetch(`${base}/api/runs/${runId}`, { headers: cookieHeader(bobSid) });
      assert.equal(bobGets.status, 404);

      const bobList = (await (await fetch(`${base}/api/runs`, { headers: cookieHeader(bobSid) })).json()) as { runs: unknown[] };
      assert.equal(bobList.runs.length, 0);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('admin token can log in to an admin session', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, { tokens: [['tok-alice', 'alice'], ['tok-bob', 'bob']], admin: 'admin-tok' });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'a', agent: 'fake' }),
      });
      const adminSid = sidFrom(await login(base, 'admin-tok'))!;
      const me = await fetch(`${base}/api/auth/me`, { headers: cookieHeader(adminSid) });
      const meBody = (await me.json()) as { ownerId: string; isAdmin: boolean };
      assert.equal(meBody.ownerId, '*');
      assert.equal(meBody.isAdmin, true);

      const list = (await (await fetch(`${base}/api/runs`, { headers: cookieHeader(adminSid) })).json()) as { runs: unknown[] };
      assert.equal(list.runs.length, 1);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('SSE stream works with cookie auth', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-sse-cookie-'));
  const env = makeEnv({
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'first' } } },
      { event: { type: 'agent.message', payload: { text: 'second' } } },
    ],
  });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const sid = sidFrom(await login(base, 'tok-alice'))!;
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { ...cookieHeader(sid), 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'x', agent: 'fake', repository: { localPath: repo } }),
      });
      assert.equal(created.status, 201);
      const { runId } = (await created.json()) as { runId: string };

      const ac = new AbortController();
      const streamPromise = (async () => {
        try {
          const res = await fetch(`${base}/api/runs/${runId}/stream`, { headers: cookieHeader(sid), signal: ac.signal });
          assert.equal(res.status, 200);
          assert.equal(res.headers.get('content-type')?.includes('text/event-stream'), true);
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let data = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            data += decoder.decode(value, { stream: true });
            if (data.includes('run.completed')) break;
          }
          return data;
        } finally {
          ac.abort();
        }
      })();

      await waitFor(() => env.runs.get(runId)!.status === 'COMPLETED', 10_000);
      const streamed = await streamPromise;
      assert.ok(streamed.includes('event: run.started'));
      assert.ok(streamed.includes('event: agent.message'));
      assert.ok(streamed.includes('event: run.completed'));
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('rate limit: login > limit -> 429 with Retry-After', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, { rateLimits: { login: { windowMs: 60_000, max: 3 } } });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const statuses: number[] = [];
      let rateLimited: Response | null = null;
      for (let i = 0; i < 6; i++) {
        const res = await login(base, 'tok-alice');
        statuses.push(res.status);
        if (res.status === 429) rateLimited = res;
      }
      // first 3 within the window succeed; the rest are limited
      assert.equal(statuses.slice(0, 3).every((s) => s === 200), true);
      assert.ok(statuses.slice(3).every((s) => s === 429));
      assert.ok(rateLimited, 'at least one 429');
      const retryAfter = Number(rateLimited!.headers.get('retry-after'));
      assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, 'Retry-After header');
      const body = (await rateLimited!.json()) as { error: string };
      assert.equal(body.error, 'rate limit exceeded');
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('rate limit: POST /api/runs > limit -> 429 with Retry-After (other methods unaffected)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, { rateLimits: { createRun: { windowMs: 60_000, max: 2 } } });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const r1 = await fetch(`${base}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ task: 'a', agent: 'fake' }) });
      const r2 = await fetch(`${base}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ task: 'b', agent: 'fake' }) });
      assert.equal(r1.status, 201);
      assert.equal(r2.status, 201);
      const r3 = await fetch(`${base}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ task: 'c', agent: 'fake' }) });
      assert.equal(r3.status, 429);
      const retryAfter = Number(r3.headers.get('retry-after'));
      assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, 'Retry-After header');
      const body = (await r3.json()) as { error: string };
      assert.equal(body.error, 'rate limit exceeded');

      // GET is not limited by the POST-only limiter
      const list = await fetch(`${base}/api/runs`, { headers });
      assert.equal(list.status, 200);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('session store: lazy expiry drops expired sessions on access', () => {
  const store = createSessionStore();
  store.set('expired', { ownerId: 'alice', isAdmin: false, expiresAt: Date.now() - 1000 });
  assert.equal(store.get('expired'), null);

  const live = { ownerId: 'alice', isAdmin: false, expiresAt: Date.now() + 60_000 };
  store.set('live', live);
  assert.deepEqual(store.get('live'), live);

  store.delete('live');
  assert.equal(store.get('live'), null);
});

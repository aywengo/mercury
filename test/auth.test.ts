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
  cookieSecure?: boolean;
  trustProxy?: number;
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
    cookieSecure: opts.cookieSecure,
    trustProxy: opts.trustProxy,
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

// --- session cookie `Secure` flag (issue #64) -------------------------------

/**
 * The Set-Cookie value under test.
 *
 * `getSetCookie()` rather than `get('set-cookie')`: the latter returns a single string with
 * multiple cookies comma-joined, which would silently concatenate the session cookie with any
 * other cookie the response sets. There is exactly one Set-Cookie here today so both work, but
 * the array API is the one that stays correct if that changes.
 */
function setCookie(res: globalThis.Response): string {
  return res.headers.getSetCookie()[0] ?? '';
}

async function loginAndGetCookie(port: number, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ token: 'tok-alice' }),
  });
  assert.equal(res.status, 200);
  return setCookie(res);
}

test('session cookie carries Secure when the request arrived over TLS (issue #64)', async () => {
  // Before the fix the cookie was written without `Secure` unconditionally -- including on a
  // MERCURY_TLS_* deployment -- so the session id went out in cleartext on any plain http://
  // request to the same host.
  const env = makeEnv({ workerEnabled: false });
  const { app, close } = makeApi(env);
  const srv = await listen(app);
  try {
    // A TLS-terminating proxy on loopback: this process speaks http, the client did not.
    const viaProxy = await loginAndGetCookie(srv.port, { 'x-forwarded-proto': 'https' });
    assert.ok(/; Secure/.test(viaProxy), `proxy-forwarded https must set Secure: ${viaProxy}`);
    assert.ok(/HttpOnly/.test(viaProxy) && /SameSite=Strict/.test(viaProxy), 'existing flags preserved');

    // Plain http with no forwarded proto: no Secure, or local dev over http would break.
    const plain = await loginAndGetCookie(srv.port);
    assert.ok(!/; Secure/.test(plain), `plain http must not set Secure: ${plain}`);
  } finally {
    await srv.close();
    close();
    env.close();
  }
});

test('cookieSecure forces the flag for proxies that do not forward the proto (issue #64)', async () => {
  const env = makeEnv({ workerEnabled: false });
  const { app, close } = makeApi(env, { cookieSecure: true });
  const srv = await listen(app);
  try {
    const cookie = await loginAndGetCookie(srv.port);
    assert.ok(/; Secure/.test(cookie), `forced Secure missing: ${cookie}`);
  } finally {
    await srv.close();
    close();
    env.close();
  }
});

test('the logout cookie carries the same Secure flag as the login cookie (issue #64)', async () => {
  // A clear-cookie without Secure lets the browser keep a stale session cookie alive over http.
  const env = makeEnv({ workerEnabled: false });
  const { app, close } = makeApi(env);
  const srv = await listen(app);
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ token: 'tok-alice' }),
    });
    const sid = (setCookie(login).match(/mercury_session=([^;]+)/) ?? [])[1];
    assert.ok(sid, 'login must return a session cookie');

    const out = await fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: { cookie: `mercury_session=${sid}`, 'x-forwarded-proto': 'https' },
    });
    assert.equal(out.status, 200);
    const cleared = setCookie(out);
    assert.ok(/Max-Age=0/.test(cleared), `logout must clear the cookie: ${cleared}`);
    assert.ok(/; Secure/.test(cleared), `cleared cookie must match the login flag: ${cleared}`);
  } finally {
    await srv.close();
    close();
    env.close();
  }
});

// --- trusted-proxy depth and rate-limit keying (issue #65) ------------------

// The limiter keys on req.ip. With no trusted proxy Express resolves that to the socket peer,
// which behind a reverse proxy is the PROXY -- so every client behind it shares one bucket.
// That fails in both directions at once: ordinary users collectively burn the login budget and
// lock each other out, while an attacker sharing that bucket is barely throttled.

async function loginFrom(port: number, clientIp: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': clientIp },
    body: JSON.stringify({ token: 'tok-alice' }),
  });
  return res.status;
}

test('without a trusted proxy, distinct clients share one rate-limit bucket (issue #65)', async () => {
  // Characterises the DEFAULT, which is the safe-but-blunt direct-bind case: X-Forwarded-For is
  // ignored entirely, so two different clients are indistinguishable. Asserted rather than
  // assumed, because it is what makes the depth knob opt-in and non-surprising.
  const env = makeEnv({ workerEnabled: false });
  const { app, close } = makeApi(env, { rateLimits: { login: { windowMs: 60_000, max: 2 } } });
  const srv = await listen(app);
  try {
    assert.equal(await loginFrom(srv.port, '203.0.113.1'), 200);
    assert.equal(await loginFrom(srv.port, '203.0.113.1'), 200);
    // A DIFFERENT client, but the same bucket, because req.ip is the proxy's address.
    assert.equal(
      await loginFrom(srv.port, '198.51.100.99'), 429,
      'unrelated client must not inherit another client bucket while depth is unset',
    );
  } finally {
    await srv.close(); close(); env.close();
  }
});

test('with trustProxy=1, distinct clients get independent rate-limit buckets (issue #65)', async () => {
  const env = makeEnv({ workerEnabled: false });
  const { app, close } = makeApi(env, {
    rateLimits: { login: { windowMs: 60_000, max: 2 } },
    trustProxy: 1,
  });
  const srv = await listen(app);
  try {
    assert.equal(await loginFrom(srv.port, '203.0.113.1'), 200);
    assert.equal(await loginFrom(srv.port, '203.0.113.1'), 200);
    // Same two requests from client A exhausted A's bucket; client B must be untouched.
    assert.equal(await loginFrom(srv.port, '198.51.100.99'), 200, 'client B must get its own bucket');
    // ...and A is still limited on its own key, so the fix narrows the bucket, it does not
    // remove the limit.
    assert.equal(await loginFrom(srv.port, '203.0.113.1'), 429);
  } finally {
    await srv.close(); close(); env.close();
  }
});

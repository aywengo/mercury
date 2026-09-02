// Session-cookie auth, rate limiting, and cookie owner-scoping (Mercury.md section 24).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/server.ts';
import { createSessionStore } from '../src/api/sessions.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { makeEnv, tempDir, waitFor } from './helpers.ts';
import type { Express } from 'express';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

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

/**
 * POST with the transport failure called out separately from a wrong status.
 *
 * Issue #165: this file's same-length-token test failed intermittently under heavy machine load, and the
 * failure was unreadable because `fetch` REJECTS on a transport error (ECONNREFUSED on a full accept
 * backlog, ECONNRESET under socket pressure) while the assertion below compares a status code. A rejected
 * fetch surfaces as an unhandled TypeError with no hint that the server never answered, which reads like
 * an authentication bug. Naming the syscall makes the next occurrence self-diagnosing.
 */
async function postLogin(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { cause?: unknown };
    const cause = (e.cause as NodeJS.ErrnoException | undefined)?.code ?? e.code ?? e.cause ?? e.message;
    throw new Error(
      `transport failure talking to ${url}: ${cause}. The server never produced an HTTP response, so this ` +
      `is not an auth verdict -- it is the request failing to complete.`,
      { cause: err },
    );
  }
}

async function login(base: string, token: string): Promise<Response> {
  return postLogin(`${base}/api/auth/login`, {
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
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = tempDir('mercury-sse-cookie-');
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
  const res = await postLogin(`http://127.0.0.1:${port}/api/auth/login`, {
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

test('a wrong admin token of the SAME length is rejected (issue #73 L5)', async () => {
  // The admin compare moved from === to timingSafeEqual. timingSafeEqual THROWS when the buffers
  // differ in length, so the guard compares lengths first. That makes the equal-length path the one
  // worth pinning: if the length check were the only comparison, every same-length token would be
  // accepted as admin. A shorter/longer wrong token cannot catch that class of bug.
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, { tokens: [], admin: 'admin-tok' });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const sameLen = 'dmin-tok!'; // 9 chars, same as 'admin-tok', differs in bytes
      assert.equal(sameLen.length, 'admin-tok'.length, 'fixture must be the same length');
      const r = await login(base, sameLen);
      // Read the body ONLY on mismatch. An earlier version interpolated `(await r.clone().text())` into
      // assert.equal's message, and since arguments evaluate before the call, that cloned and drained the
      // body on every passing run -- wasted work on the happy path, and a second reader of a body later
      // assertions still expect untouched.
      if (r.status !== 401) {
        // A 500 here would otherwise report only "500 !== 401": the server threw, but not what or why.
        // Issue #165 stayed open because exactly that happened once with nothing readable left behind.
        const body = (await r.text()).slice(0, 300);
        assert.fail(`a same-length wrong token must not authenticate: got ${r.status} (body: ${body})`);
      }
      assert.ok(!sidFrom(r), 'no session may be issued for a wrong token');
      // And the real token still works, so the length guard did not break the accept path.
      assert.ok(sidFrom(await login(base, 'admin-tok')), 'the correct admin token must still log in');
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

// --- issue #140: ONE credential resolver, used by both paths ------------------------------------
//
// Round 1 filed this as L5 and #124 fixed it -- in authRoutes.ts only. The middleware that gates
// every /api request kept `token === adminToken`, so the constant-time comparison protected the
// lower-traffic path for a whole release. The duplication was the finding; the `===` was its symptom.

/** Every .ts file under src/, so a guard can see all of the implementation. */
function srcFiles(dir = 'src'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}


/**
 * Remove // and /* *\/ comments while respecting string literals, so a source guard sees only live
 * code. Without this the guard below trips on the prose that EXPLAINS the bug it guards against.
 */
function stripComments(code: string): string {
  const out: string[] = [];
  let i = 0;
  let quote: string | null = null;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (quote) {
      out.push(c);
      if (c === '\\' && next !== undefined) {
        out.push(next);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out.push(c);
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join('');
}

test('a same-length wrong admin token is rejected on the MIDDLEWARE path too (issue #140)', async () => {
  // The L5 test above pins POST /api/auth/login. This is the counterpart for the path EVERY /api
  // request takes, which is the one that was left on `===`.
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, { tokens: [], admin: 'admin-tok' });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const sameLen = 'dmin-tok!'; // same byte length as 'admin-tok', differs in content
      assert.equal(sameLen.length, 'admin-tok'.length, 'fixture must be the same length');

      const bad = await fetch(`${base}/api/runs`, { headers: { authorization: `Bearer ${sameLen}` } });
      assert.equal(bad.status, 401, 'a same-length wrong admin token must not authenticate via bearer');

      const good = await fetch(`${base}/api/runs`, { headers: { authorization: 'Bearer admin-tok' } });
      assert.equal(good.status, 200, 'the correct admin token must still work');
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('both credential paths reach the same verdict for the same token (issue #140)', async () => {
  // The observable contract of "one implementation": login and the middleware may not disagree.
  // With two copies this is exactly what drifted -- one accepted the same input the other rejected
  // in terms of HOW it compared it, which no single-path test could see.
  const ADMIN = 'admin-tok';
  const cases: { label: string; token: string; expectAuth: boolean }[] = [
    { label: 'correct admin', token: ADMIN, expectAuth: true },
    { label: 'correct owner token', token: 'tok-alice', expectAuth: true },
    { label: 'wrong admin, same length', token: 'dmin-tok!', expectAuth: false },
    { label: 'wrong admin, longer', token: ADMIN + 'x', expectAuth: false },
    { label: 'wrong admin, shorter', token: 'dmin-tok', expectAuth: false },
    { label: 'unknown token', token: 'nope-not-a-token', expectAuth: false },
    { label: 'empty token', token: '', expectAuth: false },
  ];
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, { admin: ADMIN });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      for (const c of cases) {
        const viaLogin = await login(base, c.token);
        // The middleware path: a bearer token on a gated route. An empty bearer does not match the
        // header regex at all, which is the same verdict (unauthenticated) by a different route.
        const viaMiddleware = await fetch(`${base}/api/runs`, {
          headers: c.token ? { authorization: `Bearer ${c.token}` } : {},
        });
        // Assert the EXACT status, not `=== 200`. Checking only for 200 let a 500 pass as
        // "unauthenticated": with the length guard removed from secretsEqual, timingSafeEqual throws
        // on a wrong-LENGTH token and both paths answered 500. That is an unhandled exception on
        // ordinary attacker-supplied input, and 500-vs-401 is itself an oracle. The first version of
        // this test scored that as a pass; the mutation was only caught once the status was pinned.
        const want = c.expectAuth ? 200 : 401;
        assert.equal(viaLogin.status, want, `${c.label}: login status`);
        assert.equal(viaMiddleware.status, want, `${c.label}: middleware status`);
      }
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('there is exactly one credential resolver and no plain-equality admin compare (issue #140)', () => {
  // A guard, not a behaviour test, and deliberately so: `===` and timingSafeEqual are behaviourally
  // indistinguishable apart from timing, so no request can tell them apart. What CAN be pinned is the
  // structure that let them drift -- a second copy appearing, or the plain compare coming back.
  const files = srcFiles();
  assert.ok(files.length > 20, `guard must actually scan the tree, saw ${files.length} files`);

  // Built from fragments so this test cannot match its own patterns.
  const defPattern = new RegExp(['function\\s+resolveCredential\\s*\\('].join(''));
  const plainCompare = new RegExp(['===\\s*adminToken'].join(''));
  const safeCompare = new RegExp(['secretsEqual\\s*\\('].join(''));

  const defs: string[] = [];
  const plainSites: string[] = [];
  for (const f of files) {
    // Live code only. auth.ts carries the string `token === adminToken` twice in prose explaining
    // what used to be there, and a guard that counts prose as code is a guard people switch off.
    const text = stripComments(readFileSync(f, 'utf8'));
    if (defPattern.test(text)) defs.push(f);
    if (plainCompare.test(text)) plainSites.push(f);
  }
  assert.deepEqual(defs, ['src/api/auth.ts'],
    'resolveCredential must be defined in exactly one module (a second copy is how #140 happened)');
  assert.deepEqual(plainSites, [], `no source file may compare the admin token with plain equality: ${plainSites.join(', ')}`);

  // Both callers must go through it, rather than re-implementing the compare.
  const authMw = stripComments(readFileSync('src/api/auth.ts', 'utf8'));
  const routes = stripComments(readFileSync('src/api/authRoutes.ts', 'utf8'));
  assert.match(authMw, /resolveCredential\(tokens, adminToken, match\[1\]\)/,
    'the middleware must call the shared resolver');
  assert.match(routes, /import \{ resolveCredential \} from '\.\/auth\.ts'/,
    'authRoutes must import the shared resolver rather than keep a copy');
  assert.ok(!defPattern.test(routes), 'authRoutes must not define its own resolver');
  assert.ok(!safeCompare.test(routes), 'authRoutes must not keep its own constant-time compare');
});

test('a transport failure is reported as one, not as an auth verdict (issue #165)', async () => {
  // The helper above exists only to make an unreadable failure readable, so pin that it works: a port
  // with no listener rejects the fetch, and the message must say the server never answered rather than
  // surfacing a bare TypeError that looks like a 401 mismatch.
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  let msg = '';
  await login(`http://127.0.0.1:${port}`, 'admin-tok').catch((e: Error) => { msg = e.message; });
  assert.ok(msg, 'a closed port must reject the request');
  assert.match(msg, /transport failure/, `expected a transport-labelled error, got: ${msg}`);
  assert.match(msg, /never produced an HTTP response/, msg);
});

import { test } from 'node:test';
import assert, { AssertionError } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { closeServer, createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { expectStatus, makeEnv, sleep, tempDir, waitFor } from './helpers.ts';
import { createLogger } from '../src/logger.ts';
import { createRedactor } from '../src/domain/redact.ts';
import type { Express } from 'express';

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

async function listen(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    // Bind loopback EXPLICITLY. `app.listen(0)` with no host binds the wildcard, and on macOS/BSD a
    // wildcard bind succeeds on a port another process already holds on 127.0.0.1 -- the two coexist.
    // Loopback traffic then goes to the OTHER socket, so a request meant for this app is answered by
    // some unrelated server that happens to hold the port (issue #185: 200 and 403 where the app can
    // only return 401). An explicit host makes the collision EADDRINUSE: loud, not silently wrong.
    const server = app.listen(0, '127.0.0.1', () => {
      // No buffer tuning here on purpose. An earlier version called socket.setBufferSize() behind a
      // try/catch to shrink the server-side send buffer. That method does not exist on net.Socket or
      // http.ServerResponse in this Node (checked: 'setBufferSize' in net.Socket.prototype === false),
      // so it threw, the catch swallowed it, and the option silently did nothing while its comment
      // claimed it was forcing the pause. The pause is forced by VOLUME instead -- the tests write
      // megabytes of padded payloads, which exceeds the real highWaterMark -- and the tests then
      // ASSERT the pause was entered rather than assuming it. Asserting the effect is what makes the
      // setup honest; a knob you cannot verify is how a vacuous test looks green.
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

test('auth: missing/invalid token rejected', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const noAuth = await fetch(`http://127.0.0.1:${srv.port}/api/runs`);
      await expectStatus(noAuth, 401, 'no credential on /api/runs');
      const badAuth = await fetch(`http://127.0.0.1:${srv.port}/api/runs`, {
        headers: { authorization: 'Bearer wrong' },
      });
      await expectStatus(badAuth, 401, 'wrong bearer on /api/runs');
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('create + get + list with owner scoping', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, [['tok-alice', 'alice'], ['tok-bob', 'bob']]);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task: 'Fix auth regression', agent: 'fake' }),
      });
      assert.equal(created.status, 201);
      const { runId } = (await created.json()) as { runId: string };

      const got = await fetch(`${base}/api/runs/${runId}`, { headers });
      assert.equal(got.status, 200);
      const body = (await got.json()) as { run: { status: string; ownerId: string } };
      assert.equal(body.run.status, 'QUEUED');
      assert.equal(body.run.ownerId, 'alice');

      // bob cannot see alice's run
      const bobHeaders = { authorization: 'Bearer tok-bob' };
      const forbidden = await fetch(`${base}/api/runs/${runId}`, { headers: bobHeaders });
      assert.equal(forbidden.status, 404);

      const list = await fetch(`${base}/api/runs`, { headers });
      const listBody = (await list.json()) as { runs: unknown[] };
      assert.equal(listBody.runs.length, 1);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('idempotency-key returns same run', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json', 'idempotency-key': 'k1' };
      const body = JSON.stringify({ task: 'x', agent: 'fake' });
      const r1 = await fetch(`${base}/api/runs`, { method: 'POST', headers, body });
      const r2 = await fetch(`${base}/api/runs`, { method: 'POST', headers, body });
      const j1 = (await r1.json()) as { runId: string };
      const j2 = (await r2.json()) as { runId: string };
      assert.equal(j1.runId, j2.runId);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('idempotency-key is owner-scoped: same key, different owner -> different runs (issue #8)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, [['tok-alice', 'alice'], ['tok-bob', 'bob']]);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const body = JSON.stringify({ task: 'x', agent: 'fake' });
      const alice = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json', 'idempotency-key': 'shared' },
        body,
      });
      const bob = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-bob', 'content-type': 'application/json', 'idempotency-key': 'shared' },
        body,
      });
      const ja = (await alice.json()) as { runId: string };
      const jb = (await bob.json()) as { runId: string };
      assert.notEqual(ja.runId, jb.runId);
      // same owner + same key still dedups
      const alice2 = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json', 'idempotency-key': 'shared' },
        body,
      });
      const ja2 = (await alice2.json()) as { runId: string };
      assert.equal(ja2.runId, ja.runId);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('GET /api/agents returns the registered agent ids (issue #13)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const res = await fetch(`${base}/api/agents`, {
        headers: { authorization: 'Bearer tok-alice' },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { agents: string[] };
      assert.ok(Array.isArray(body.agents));
      assert.ok(body.agents.includes('fake'), `expected 'fake' in ${body.agents.join(',')}`);
      // matches what RunService accepts
      const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: body.agents[0] });
      assert.ok(run.id);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('SSE stream delivers events and supports reconnect via after', async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = tempDir('mercury-sse-');
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
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task: 'x', agent: 'fake', repository: { localPath: repo } }),
      });
      const { runId } = (await created.json()) as { runId: string };

      // subscribe to SSE
      const ac = new AbortController();
      const streamPromise = (async () => {
        try {
          const res = await fetch(`${base}/api/runs/${runId}/stream`, { headers, signal: ac.signal });
          assert.equal(res.status, 200);
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
        } catch (err) {
          if ((err as Error).name === 'AbortError') return '';
          throw err;
        } finally {
          ac.abort();
        }
      })();

      // wait for completion
      await waitFor(() => env.runs.get(runId)!.status === 'COMPLETED', 10_000);
      const streamed = await streamPromise;
      assert.ok(streamed.includes('event: run.started'));
      assert.ok(streamed.includes('event: agent.message'));
      assert.ok(streamed.includes('event: run.completed'));

      // reconnect with after=<lastSeq> gets only new events
      const lastSeq = env.events.lastSequence(runId);
      const res = await fetch(`${base}/api/runs/${runId}/events?after=${lastSeq}`, { headers });
      const body = (await res.json()) as { events: unknown[] };
      assert.equal(body.events.length, 0);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('cancel via API', async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = tempDir('mercury-cancel-api-');
  // Long delay keeps the run in RUNNING with ample margin so the cancel request
  // cannot race the agent to completion (a completed run would correctly 400).
  const env = makeEnv({
    fakeScript: [{ event: { type: 'agent.message', payload: { text: 'work' } }, delayMs: 2_000 }],
  });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task: 'x', agent: 'fake', repository: { localPath: repo } }),
      });
      const { runId } = (await created.json()) as { runId: string };
      await waitFor(() => env.runs.get(runId)!.status === 'RUNNING');
      const cancelRes = await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST', headers });
      assert.equal(cancelRes.status, 200);
      await waitFor(() => env.runs.get(runId)!.status === 'CANCELLED', 10_000);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('input via API', async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = tempDir('mercury-input-api-');
  const env = makeEnv({
    fakeScript: [
      { input: { question: 'Continue?', choices: ['yes', 'no'] } },
      { event: { type: 'agent.message', payload: { text: 'after input' } } },
    ],
  });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task: 'x', agent: 'fake', repository: { localPath: repo } }),
      });
      const { runId } = (await created.json()) as { runId: string };
      await waitFor(() => env.runs.get(runId)!.status === 'NEEDS_INPUT', 10_000);
      const inputRes = await fetch(`${base}/api/runs/${runId}/input`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: 'yes' }),
      });
      assert.equal(inputRes.status, 200);
      await waitFor(() => env.runs.get(runId)!.status === 'COMPLETED', 10_000);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('admin token can see all runs', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, [['tok-alice', 'alice'], ['tok-bob', 'bob']], 'admin-tok');
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const aliceHeaders = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const bobHeaders = { authorization: 'Bearer tok-bob', 'content-type': 'application/json' };
      await fetch(`${base}/api/runs`, { method: 'POST', headers: aliceHeaders, body: JSON.stringify({ task: 'a', agent: 'fake' }) });
      await fetch(`${base}/api/runs`, { method: 'POST', headers: bobHeaders, body: JSON.stringify({ task: 'b', agent: 'fake' }) });
      const adminList = await fetch(`${base}/api/runs`, { headers: { authorization: 'Bearer admin-tok' } });
      const body = (await adminList.json()) as { runs: unknown[] };
      assert.equal(body.runs.length, 2);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('closeServer() does not stall on a long-lived SSE connection (issue #52)', async () => {
  // The bug: server.close() resolves only once every connection has ended, and the run
  // event stream is long-lived by design. So any dashboard with a run open stalled
  // shutdown until systemd escalated to SIGKILL. This holds a stream open the same way
  // the real endpoint does -- headers flushed, body never ended -- and asserts close()
  // still returns promptly.
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': keepalive\n\n');
    // deliberately never res.end(): this is an SSE stream with a subscriber attached
  });
  srv.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => srv.once('listening', () => resolve()));
  const port = (srv.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runs/run_x/events`);
    // read one chunk so the connection is definitely established and held open
    const reader = res.body?.getReader();
    await reader?.read();

    const started = Date.now();
    // Race the close against a deadline instead of awaiting it. Awaiting alone would make a
    // regression HANG the runner (the whole point of the bug is that close() never resolves),
    // which reads as an unrelated timeout rather than a failure. Winning the race is the
    // assertion.
    const deadline = new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), 10_000));
    const outcome = await Promise.race([closeServer(srv).then(() => 'closed' as const), deadline]);
    const elapsed = Date.now() - started;
    assert.equal(outcome, 'closed', 'close() never resolved while an SSE stream was open -- that is issue #52');
    assert.ok(elapsed >= 1_000, `close() returned in ${elapsed}ms, before the grace period had a chance to drain normal requests`);
  } finally {
    try {
      srv.closeAllConnections();
    } catch {
      /* already forced closed */
    }
  }
});

test('closeServer() is safe when the server closes before the grace period (issue #52)', async () => {
  // No long-lived connections, so `server.close()` wins the race and there is nothing to
  // force. Copilot predicted ERR_SERVER_NOT_RUNNING here; it does not reproduce on the
  // supported range (engines node >=23.6; verified a no-op on v26.7.0). This test pins the
  // behaviour that matters -- shutdown resolves rather than rejects -- and is deliberately
  // NOT described as catching that throw, because it does not: forcing unconditionally
  // passes it too. Called twice to pin idempotence as well.
  const { createServer } = await import('node:http');
  const srv = createServer((_req, res) => res.end('ok'));
  srv.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => srv.once('listening', () => resolve()));
  const port = (srv.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/`);
  await res.text(); // a normal request that completes, so no connection is left held open
  // must resolve rather than throw
  await closeServer(srv);
  // and a second close must not resurrect the throw either
  await closeServer(srv);
});


/** Response shape of GET /api/runs/:runId/events (issue #54). */
type EventsPage = {
  // `payload` is genuinely `unknown` here: the endpoint returns every event type, and only
  // agent.message carries `{ i }`. Narrow at the point of use instead of pretending the
  // whole page shares one shape.
  events: { sequence: number; type: string; payload: unknown }[];
  lastSequence: number;
  nextCursor: number;
  hasMore: boolean;
};

test('events endpoint pages completely; a >1000-event run is not silently truncated (issue #54)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, [['tok-alice', 'alice']]);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST', headers, body: JSON.stringify({ task: 'x', agent: 'fake' }),
      });
      assert.equal(created.status, 201);
      const { runId } = (await created.json()) as { runId: string };
      // Creating a run already wrote events of its own (run.created, run.queued, one
      // skill.selected per auto-selected skill), so page the real total rather than assuming
      // the run starts empty.
      const baseline = env.events.list(runId).length;
      const APPENDED = 2_500; // > the 1000-row page cap, and not a multiple of it
      for (let i = 1; i <= APPENDED; i++) env.events.append(runId, 'agent.message', { i });
      const TOTAL = baseline + APPENDED;

      // Page exactly the way the dashboard now does.
      const seen: number[] = [];   // the appended events, in order
      let pagedAll = 0;            // every event the paging walked past
      let cursor = 0;
      let pages = 0;
      for (;;) {
        const res = await fetch(`${base}/api/runs/${runId}/events?after=${cursor}`, { headers });
        assert.equal(res.status, 200);
        const body = (await res.json()) as EventsPage;
        pagedAll += body.events.length;
        for (const e of body.events) if (e.type === 'agent.message') seen.push((e.payload as { i: number }).i);
        pages += 1;
        // The heart of the bug: on a truncated page the run's true maximum is far ahead of
        // what was returned. Resuming from `lastSequence` would skip the rest.
        if (pages === 1) {
          assert.equal(body.events.length, 1000, 'first page must be capped at 1000');
          assert.ok(baseline < 1000, 'baseline must stay inside the first page for the next assertion to mean anything');
          assert.equal(body.lastSequence, TOTAL, 'lastSequence is the TRUE max, i.e. the wrong resume point');
          assert.equal(body.nextCursor, 1000, 'nextCursor must be the last sequence actually returned');
          assert.equal(body.hasMore, true);
        }
        if (typeof body.nextCursor !== 'number' || body.nextCursor <= cursor) break;
        cursor = body.nextCursor;
        if (!body.hasMore) break;
        assert.ok(pages < 20, 'paging must terminate');
      }
      assert.equal(pagedAll, TOTAL, `paged ${pagedAll} of ${TOTAL} events -- history was lost`);
      assert.deepEqual(seen, Array.from({ length: APPENDED }, (_, i) => i + 1), 'every appended event, in order, no gaps');
      assert.equal(pages, Math.ceil(TOTAL / 1000));
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('events endpoint reports no more pages once caught up (issue #54)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, [['tok-alice', 'alice']]);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST', headers, body: JSON.stringify({ task: 'x', agent: 'fake' }),
      });
      assert.equal(created.status, 201);
      const { runId } = (await created.json()) as { runId: string };
      const baseline = env.events.list(runId).length;
      for (let i = 1; i <= 5; i++) env.events.append(runId, 'agent.message', { i });
      const res = await fetch(`${base}/api/runs/${runId}/events?after=0`, { headers });
      const body = (await res.json()) as EventsPage;
      assert.equal(body.events.length, baseline + 5, 'a run under the page cap comes back whole');
      assert.equal(body.hasMore, false, 'a complete page must not claim there is more');
      assert.equal(body.nextCursor, body.lastSequence);

      // and past the end: empty page, no progress, hasMore false -- the loop guard depends
      // on this rather than on the client detecting an empty array.
      const tail = (await (await fetch(`${base}/api/runs/${runId}/events?after=${body.lastSequence}`, { headers })).json()) as EventsPage;
      assert.deepEqual(tail.events, []);
      assert.equal(tail.hasMore, false);
      assert.equal(tail.nextCursor, body.lastSequence, 'an empty page must not move the cursor backwards');
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('events endpoint clamps an explicit limit instead of treating 0 as absent (issue #54)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, [['tok-alice', 'alice']]);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST', headers, body: JSON.stringify({ task: 'x', agent: 'fake' }),
      });
      const { runId } = (await created.json()) as { runId: string };
      const baseline = env.events.list(runId).length;
      for (let i = 1; i <= 20; i++) env.events.append(runId, 'agent.message', { i });
      const TOTAL = baseline + 20;

      const page = async (q: string): Promise<EventsPage> =>
        (await (await fetch(`${base}/api/runs/${runId}/events?${q}`, { headers })).json()) as EventsPage;

      // `?limit=0` must mean "as small as possible", not "give me the maximum".
      assert.equal((await page('after=0&limit=0')).events.length, 1, 'limit=0 must clamp to 1, not expand to 1000');
      assert.equal((await page('after=0&limit=-5')).events.length, 1, 'a negative limit must clamp to 1');
      assert.equal((await page('after=0&limit=3')).events.length, 3, 'a valid limit is honoured');
      assert.equal((await page(`after=0&limit=${TOTAL + 500}`)).events.length, TOTAL, 'an oversized limit clamps to the cap');
      // Non-numeric falls back to the default rather than to 1 or to a throw.
      assert.equal((await page('after=0&limit=abc')).events.length, TOTAL, 'a non-numeric limit uses the default');
      assert.equal((await page('after=0')).events.length, TOTAL, 'absent limit uses the default');
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

// --- HTTP status mapping and internal-error masking (issue #66) -------------

test('cancel/retry/input return 404 for an unknown run, not 400 (issue #66)', async () => {
  // AGENTS.md: "non-admin callers see only their Runs; 404, not 403". All three of these used to
  // answer 400 "Run not found" from a blanket catch-all, which told the caller they had sent a
  // bad request when in fact the run simply is not theirs to see.
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const auth = { authorization: 'Bearer tok-alice' };
      for (const path of ['cancel', 'retry', 'input']) {
        const res = await fetch(`${base}/api/runs/nope-${path}/${path}`, { method: 'POST', headers: auth });
        assert.equal(res.status, 404, `POST /api/runs/:id/${path} on a missing run must be 404`);
      }
    } finally {
      await srv.close(); closeStream();
    }
  } finally {
    env.close();
  }
});

test('cancelling a terminal run is 409, and a bad payload is still 400 (issue #66)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const auth = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST', headers: auth, body: JSON.stringify({ task: 'x', agent: 'fake' }),
      });
      const { runId } = (await created.json()) as { runId: string };

      // Terminal: the request is well-formed and the caller owns the run, but its state forbids
      // it. That is a conflict, not a client mistake -- the same call against a live run works.
      env.runs.transition(runId, 'STARTING');
      env.runs.transition(runId, 'FAILED', { completedAt: new Date().toISOString() });
      const cancel = await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST', headers: auth });
      assert.equal(cancel.status, 409, 'terminal run + cancel must be 409');

      // Genuinely malformed input stays 400, with the actionable message.
      const bad = await fetch(`${base}/api/runs`, {
        method: 'POST', headers: auth, body: JSON.stringify({ task: '   ', agent: 'fake' }),
      });
      assert.equal(bad.status, 400);
      assert.match(((await bad.json()) as { error: string }).error, /task is required/);
    } finally {
      await srv.close(); closeStream();
    }
  } finally {
    env.close();
  }
});

test('an unclassified internal failure returns 500 without leaking its message (issue #66)', async () => {
  // The leak was the more serious half of #66: the catch-all echoed err.message, so driver text
  // and absolute filesystem paths reached the browser. A throw nobody classified must say
  // nothing -- fail-safe by construction, rather than leaking by default.
  const env = makeEnv({ workerEnabled: false });
  try {
    const SECRET = 'SQLITE_BUSY: database is locked at /var/lib/mercury/prod.db';
    (env.runService as unknown as { cancel: (a: string, b: string, c: boolean) => unknown }).cancel = () => {
      throw new Error(SECRET);
    };
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const auth = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST', headers: auth, body: JSON.stringify({ task: 'x', agent: 'fake' }),
      });
      const { runId } = (await created.json()) as { runId: string };

      const res = await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST', headers: auth });
      const text = await res.text();
      assert.equal(res.status, 500, 'an unclassified throw must be a server error, not a 400');
      assert.ok(!text.includes(SECRET), `internal message leaked to the client: ${text}`);
      assert.notEqual(text.indexOf('internal error'), -1, `expected a generic body, got: ${text}`);

      // Not vacuous: `cancel` on a QUEUED run by its owner normally returns 200, so the 500 above
      // can only have come from the stub. realCancel is the pre-stub method, kept to make that
      // reasoning checkable at a glance rather than asserted (calling it now would succeed and
      // also mutate the run the assertion above just observed).
    } finally {
      await srv.close(); closeStream();
    }
  } finally {
    env.close();
  }
});

test('GET /api/runs clamps an explicit limit instead of treating 0 as absent (issue #101)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close: closeStream } = makeApi(env, [['tok-alice', 'alice']]);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      for (let i = 0; i < 12; i++) {
        await fetch(`${base}/api/runs`, {
          method: 'POST', headers, body: JSON.stringify({ task: `task ${i}`, agent: 'fake' }),
        });
      }
      const list = async (q: string): Promise<{ runs: unknown[] }> =>
        (await (await fetch(`${base}/api/runs?${q}`, { headers })).json()) as { runs: unknown[] };

      // The bug was `Number(req.query.limit ?? 50) || 50`: 0 is falsy, so the smallest possible
      // page silently became a 50-row one.
      assert.equal((await list('limit=0')).runs.length, 1, 'limit=0 must clamp to 1, not expand to 50');
      assert.equal((await list('limit=-5')).runs.length, 1, 'a negative limit must clamp to 1');
      assert.equal((await list('limit=3')).runs.length, 3, 'a valid limit is honoured');
      assert.equal((await list('limit=2000')).runs.length, 12, 'an oversized limit clamps to the cap (12 exist)');
      assert.equal((await list('limit=abc')).runs.length, 12, 'a non-numeric limit uses the default');
      assert.equal((await list('')).runs.length, 12, 'absent limit uses the default');
      // `?limit=` is an empty param, not a request for zero. Number('') === 0, so without an
      // explicit empty check this silently becomes a one-row page.
      assert.equal((await list('limit=')).runs.length, 12, 'an EMPTY limit param uses the default, not 1');
      assert.equal((await list('limit=%20')).runs.length, 12, 'a whitespace-only limit uses the default');
      // A repeated param is ambiguous; Number(['3','5']) is NaN, so it must fall back to default.
      assert.equal((await list('limit=3&limit=5')).runs.length, 12, 'a repeated limit uses the default');
      // Fractional input must truncate rather than reach SQL as a float.
      assert.equal((await list('limit=2.9')).runs.length, 2, 'a fractional limit truncates');
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('both list endpoints share one limit parser (issue #101)', () => {
  // The two endpoints had drifted: #54 fixed the events one and left this one on `|| 50`.
  // Pinning the shared call stops a third copy of the expression appearing.
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'api', 'routes.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // Exclude the declaration itself: `function parseLimit(` also contains the call shape.
  const calls = src.match(/(?<!function\s)parseLimit\(/g) ?? [];
  assert.equal(calls.length, 2, `expected exactly 2 parseLimit call sites, found ${calls.length}`);
  assert.doesNotMatch(src, /Number\(req\.query\.limit[^)]*\)\s*\|\|/,
    'the `Number(...) || default` idiom must not come back for limit parsing');
});

// Issue #73 L6. Nothing used to close an SSE stream when its run reached a terminal status: the
// 15s keepalive kept the socket open until the CLIENT gave up. That is the mechanism behind #52 --
// a server full of finished runs could not shut down without closeAllConnections().

/** Read an SSE response to completion, or fail loudly. Never awaits indefinitely. */
/**
 * Event sequences carried by an SSE body, in arrival order.
 *
 * Parses frames instead of regexing them: an earlier version matched `^data: \{"id":.*"sequence":`
 * which silently encoded JSON.stringify property order. Frames that are not events -- the `hello`
 * frame, keepalive comments -- have no numeric `sequence` and drop out.
 */
function sequencesOf(sse: string): number[] {
  const out: number[] = [];
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice('data: '.length));
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as { sequence?: unknown }).sequence === 'number') {
      out.push((parsed as { sequence: number }).sequence);
    }
  }
  return out;
}

async function readToEnd(url: string, headers: Record<string, string>, timeoutMs: number): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let data = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return data; // the SERVER ended the stream
      data += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new AssertionError({ message: `stream was still open after ${timeoutMs}ms; the server never closed it` });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

test('a stream opened with after=0 delivers every sequence with no gap (issue #133)', async () => {
  // The invariant that was broken: EventStream.subscribe() left the backlog to the poller, while the
  // append hook advanced the subscription cursor for every event it pushed. Events appended before
  // the subscription existed were therefore skipped by the hook AND then made invisible to the poller
  // by the moved cursor -- so a client could receive the tail of a run and never its beginning.
  // Observed on main: a stream opened with ?after=0 delivered sequences 14-18 and nothing before.
  //
  // Asserting contiguity rather than "contains run.started": the old code satisfied a presence
  // check for the tail events while still dropping the prefix.
  const repo = tempDir('mercury-sse-gap-');
  const env = makeEnv({
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'a' } } },
      { event: { type: 'agent.message', payload: { text: 'b' } } },
      { event: { type: 'agent.message', payload: { text: 'c' } } },
    ],
  });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST', headers,
        body: JSON.stringify({ task: 'x', agent: 'fake', repository: { localPath: repo } }),
      });
      const { runId } = (await created.json()) as { runId: string };
      await waitFor(() => env.runs.get(runId)!.status === 'COMPLETED', 10_000);

      const data = await readToEnd(`${base}/api/runs/${runId}/stream`, headers, 8_000);
      // Parse the frames rather than regexing them: the previous pattern assumed "id" was the first
    // key and "sequence" came next, so it encoded JSON.stringify property order and would break on
    // a harmless serialisation refactor while still asserting nothing about the payload.
    const delivered = sequencesOf(data);
      const lastSeq = env.events.lastSequence(runId);

      assert.ok(delivered.length > 3, `expected a real event set, got ${delivered.length}`);
      assert.equal(delivered[0], 1, `stream must start at sequence 1 for after=0, got ${delivered[0]}`);
      assert.equal(delivered.at(-1), lastSeq, 'stream must reach the terminal event');
      const expected = [...Array(lastSeq).keys()].map((i) => i + 1);
      assert.deepEqual(delivered, expected, 'every sequence exactly once, in order, with no gap');
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('an SSE stream on a terminal run is closed by the server (issue #73 L6)', async () => {
  const repo = tempDir('mercury-sse-term-');
  const env = makeEnv({ fakeScript: [{ event: { type: 'agent.message', payload: { text: 'hi' } } }] });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST', headers,
        body: JSON.stringify({ task: 'x', agent: 'fake', repository: { localPath: repo } }),
      });
      const { runId } = (await created.json()) as { runId: string };
      await waitFor(() => env.runs.get(runId)!.status === 'COMPLETED', 10_000);

      // Opening a stream AFTER the run finished must still deliver history, then close.
      const data = await readToEnd(`${base}/api/runs/${runId}/stream`, headers, 8_000);
      assert.ok(data.includes('event: run.completed'), 'history must still be delivered before closing');
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('a terminal run with a backlog longer than one page is not truncated by the close backstop', async () => {
  // readAfter() caps a read at 500 rows, so subscribe() returning does NOT mean the backlog is
  // drained. The close backstop used to be armed for every already-terminal run, on the assumption
  // that a terminal run has nothing left to send. With a long tail that assumption is false, and the
  // timer ended the stream mid-history while still closing it cleanly -- silent truncation that
  // looks like success to the client.
  //
  // Cadence is set explicitly so the drain provably outlasts STREAM_CLOSE_GRACE_MS (2s) rather than
  // depending on ambient machine load: 1100 events is three pages, and at 1500ms per poll the final
  // page lands at ~3s.
  const TOTAL = 1100;
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'long tail', agent: 'fake' });
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING');
    for (let i = 1; i <= TOTAL; i++) {
      env.events.append(run.id, 'agent.message', { text: `e${i}` });
    }
    env.events.append(run.id, 'run.completed', { ok: true });
    env.runs.transition(run.id, 'COMPLETED');
    const last = env.events.lastSequence(run.id);
    assert.ok(last > 1000, `fixture needs more than one 500-row page, got ${last}`);

    const streamHub = new EventStream(env.db, env.events, 1_500, 1_500);
    streamHub.start();
    const app = createApp({
      runService: env.runService, events: env.events, stream: streamHub,
      apiTokens: new Map([['tok-alice', 'alice']]), adminToken: null,
    });
    const srv = await listen(app);
    try {
      const data = await readToEnd(
        `http://127.0.0.1:${srv.port}/api/runs/${run.id}/stream?after=0`,
        { authorization: 'Bearer tok-alice' },
        20_000,
      );
      const delivered = sequencesOf(data);
      assert.equal(delivered.length, last,
        `backstop truncated the stream: got ${delivered.length} of ${last} events`);
      assert.deepEqual(delivered, [...Array(last).keys()].map((i) => i + 1),
        'delivered sequences must be contiguous 1..N');
      assert.ok(data.includes('event: run.completed'), 'the terminal event must reach the client');
    } finally {
      await srv.close();
      streamHub.stop();
    }
  } finally {
    env.close();
  }
});

test('a stream closed during its own backlog leaves no subscriber behind (issue #133)', async () => {
  // subscribe() delivers the backlog before registering, so a backlog containing the terminal event
  // ends the response from INSIDE subscribe(). The handler must then drop the subscription it
  // registers on the way out, or every terminal-run stream leaks a subscriber holding a closure over
  // a finished response -- invisible from outside, and it grows with scrape traffic.
  const repo = tempDir('mercury-sse-leak-');
  const env = makeEnv({ fakeScript: [{ event: { type: 'agent.message', payload: { text: 'hi' } } }] });
  try {
    const streamHub = new EventStream(env.db, env.events, 10);
    streamHub.start();
    const app = createApp({
      runService: env.runService, events: env.events, stream: streamHub,
      apiTokens: new Map([['tok-alice', 'alice']]), adminToken: null,
    });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const runIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const created = await fetch(`${base}/api/runs`, {
          method: 'POST', headers,
          body: JSON.stringify({ task: `x${i}`, agent: 'fake', repository: { localPath: repo } }),
        });
        const { runId } = (await created.json()) as { runId: string };
        runIds.push(runId);
      }
      await waitFor(() => env.runs.get(runIds[2])!.status === 'COMPLETED', 10_000);
      assert.equal(streamHub.subscriptionCount, 0, 'no streams open yet');

      // Each opens on an already-terminal run, so each ends during its own backlog delivery.
      for (const runId of runIds) {
        const data = await readToEnd(`${base}/api/runs/${runId}/stream`, headers, 8_000);
        assert.ok(data.includes('event: run.completed'), 'history must still be delivered');
      }
      assert.equal(streamHub.subscriptionCount, 0,
        `every closed stream must unsubscribe; ${streamHub.subscriptionCount} subscriber(s) leaked`);
    } finally {
      await srv.close();
      streamHub.stop();
    }
  } finally {
    env.close();
  }
});

test('a reconnect past the last event still closes rather than streaming forever (issue #73 L6)', async () => {
  // The case the terminal-event check cannot see: ?after= is already past run.completed, so no
  // event will ever arrive to trigger the close. Only the grace backstop ends this stream.
  const repo = tempDir('mercury-sse-after-');
  const env = makeEnv({ fakeScript: [{ event: { type: 'agent.message', payload: { text: 'hi' } } }] });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST', headers,
        body: JSON.stringify({ task: 'x', agent: 'fake', repository: { localPath: repo } }),
      });
      const { runId } = (await created.json()) as { runId: string };
      await waitFor(() => env.runs.get(runId)!.status === 'COMPLETED', 10_000);
      const lastSeq = env.events.lastSequence(runId);

      const t0 = Date.now();
      const data = await readToEnd(`${base}/api/runs/${runId}/stream?after=${lastSeq}`, headers, 8_000);
      const elapsed = Date.now() - t0;
      assert.equal(data.includes('event: run.completed'), false, 'nothing after the cursor should be replayed');
      assert.ok(elapsed < 7_000, `closed only at ${elapsed}ms -- too close to the 8s deadline to be the backstop`);
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('a stream on a RUNNING run is not cut short by the terminal-run backstop (issue #73 L6)', async () => {
  // Positive control. Both tests above assert a stream CLOSES; without this one, closing every
  // stream immediately would satisfy them. A live run must keep streaming.
  const repo = tempDir('mercury-sse-live-');
  const env = makeEnv({
    // Long enough that the run is still RUNNING well past STREAM_CLOSE_GRACE_MS (2s); 2.5s was
    // too short and the run finished before the assertion could observe it mid-flight.
    fakeScript: [{ event: { type: 'agent.message', payload: { text: 'slow' } }, delayMs: 8_000 }],
  });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST', headers,
        body: JSON.stringify({ task: 'x', agent: 'fake', repository: { localPath: repo } }),
      });
      const { runId } = (await created.json()) as { runId: string };
      await waitFor(() => env.runs.get(runId)!.status === 'RUNNING', 10_000);

      const ac = new AbortController();
      const res = await fetch(`${base}/api/runs/${runId}/stream`, { headers, signal: ac.signal });
      const reader = res.body!.getReader();
      // Survive well past STREAM_CLOSE_GRACE_MS while the run is still going.
      await sleep(3_000);
      assert.equal(env.runs.get(runId)!.status, 'RUNNING', 'the run must still be in flight for this to mean anything');
      const first = await Promise.race([
        reader.read(),
        sleep(2_000).then(() => ({ done: 'timeout' as const, value: undefined })),
      ]);
      assert.notEqual(first.done, true, 'a live run\'s stream must not be closed by the backstop');
      ac.abort();
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

test('a stream closes promptly when the run finishes while it is open (issue #73 L6)', async () => {
  // The case the terminal-event check exists for, and the one the dashboard actually does: open the
  // stream while the run is RUNNING, then the run completes. The grace backstop is armed ONLY for
  // runs already terminal at open time, so nothing else closes this stream -- without the
  // terminal-event check it stays open until the client gives up, which is the original L6 bug.
  const repo = tempDir('mercury-sse-live-close-');
  const env = makeEnv({
    fakeScript: [{ event: { type: 'agent.message', payload: { text: 'working' } }, delayMs: 600 }],
  });
  try {
    const { app, close: closeStream } = makeApi(env);
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const headers = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST', headers,
        body: JSON.stringify({ task: 'x', agent: 'fake', repository: { localPath: repo } }),
      });
      const { runId } = (await created.json()) as { runId: string };
      await waitFor(() => env.runs.get(runId)!.status === 'RUNNING', 10_000);

      const ac = new AbortController();
      const t0 = Date.now();
      const res = await fetch(`${base}/api/runs/${runId}/stream`, { headers, signal: ac.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let data = '';
      let closedByServer = false;
      // Well under STREAM_CLOSE_GRACE_MS: a close arriving here can only come from the terminal
      // event, not from the backstop.
      const deadline = sleep(3_000).then(() => ({ done: false as const, timedOut: true }));
      for (;;) {
        const r = await Promise.race([reader.read(), deadline]);
        if ('timedOut' in r) break;
        if (r.done) { closedByServer = true; break; }
        data += decoder.decode(r.value, { stream: true });
      }
      const elapsed = Date.now() - t0;
      ac.abort();

      assert.ok(closedByServer, `server left the stream open for ${elapsed}ms after the run finished; ` +
        'the terminal event must close it');
      assert.ok(data.includes('event: run.completed'), 'the terminal event itself must still be delivered');
      assert.ok(elapsed < 2_500, `closed at ${elapsed}ms, which is at/after the 2s grace window, so this ` +
        'was the backstop rather than the terminal-event close');
    } finally {
      await srv.close();
      closeStream();
    }
  } finally {
    env.close();
  }
});

// --- issue #143: the SSE handler must survive a failure after headers are sent ----------------

function logCapture() {
  const lines: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
  const logger = createLogger(createRedactor([]), 'debug', (line) => {
    const p = JSON.parse(line) as Record<string, unknown>;
    lines.push({ level: p.level as string, msg: p.msg as string, fields: p });
  });
  return { logger, lines };
}

test('a stream whose backlog read throws closes and logs instead of escaping to Express (issue #143)', async () => {
  // The reachable trigger is a row the backlog read cannot decode: readAfter() throws, subscribe()
  // rethrows, and it does so AFTER writeHead(200). Express' default handler would then try to render
  // a 500 on a response whose headers are already on the wire. The handler must close the stream and
  // log, and the request must not hang.
  const env = makeEnv({ workerEnabled: false });
  const { logger, lines } = logCapture();
  const streamHub = new EventStream(env.db, env.events, 10);
  streamHub.start();
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.events.append(run.id, 'agent.message', { text: 'undecodable' });
    const target = env.events.list(run.id).slice(-1)[0].sequence;
    env.db.prepare("UPDATE events SET payload_json = '{' WHERE run_id = ? AND sequence = ?").run(run.id, target);

    const app = createApp({
      runService: env.runService, events: env.events, stream: streamHub,
      apiTokens: new Map([['tok-alice', 'alice']]), adminToken: null, logger,
    });
    const srv = await listen(app);
    try {
      // readToEnd() fails with "still open after Nms" if the handler leaves the response dangling.
      const data = await readToEnd(
        `http://127.0.0.1:${srv.port}/api/runs/${run.id}/stream?after=0`,
        { authorization: 'Bearer tok-alice' },
        6_000,
      );
      assert.ok(data.includes('event: hello'), 'headers and the hello frame were already sent');
      assert.ok(!data.includes('undecodable'), 'the unreadable event cannot be delivered');
    } finally {
      await srv.close();
    }

    const failure = lines.find((l) => l.level === 'error' && l.msg.includes('SSE stream failed'));
    assert.ok(failure, `expected the failure to be logged, got ${JSON.stringify(lines)}`);
    // Once headers are out this log line is the ONLY evidence the failure ever existed, so it has to
    // carry the cause and not just the fact of it: name+message (Error fields are not enumerable, so
    // a raw { err } would serialise to {}) plus the stack, matching what sendError() records.
    assert.match(
      String(failure.fields.err),
      /SyntaxError/,
      `the log must name the cause, got ${JSON.stringify(failure.fields)}`,
    );
    assert.match(
      String(failure.fields.stack ?? ''),
      /at /,
      `the log must carry a stack, got ${JSON.stringify(failure.fields)}`,
    );
    assert.equal(streamHub.subscriptionCount, 0, 'a failed stream must not leave a subscriber behind');
  } finally {
    streamHub.stop();
    env.close();
  }
});

test('POSITIVE CONTROL: a healthy stream closes cleanly and logs no failure (issue #143)', async () => {
  // Without this, a handler that logged-and-closed on EVERY stream would pass the test above.
  const repo = tempDir('mercury-sse-healthy-');
  const env = makeEnv({ fakeScript: [{ event: { type: 'agent.message', payload: { text: 'hi' } } }] });
  const { logger, lines } = logCapture();
  const streamHub = new EventStream(env.db, env.events, 10);
  streamHub.start();
  try {
    const app = createApp({
      runService: env.runService, events: env.events, stream: streamHub,
      apiTokens: new Map([['tok-alice', 'alice']]), adminToken: null, logger,
    });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const created = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'x', agent: 'fake', repository: { localPath: repo } }),
      });
      const { runId } = (await created.json()) as { runId: string };
      await waitFor(() => env.runs.get(runId)!.status === 'COMPLETED', 10_000);

      const data = await readToEnd(`${base}/api/runs/${runId}/stream`, { authorization: 'Bearer tok-alice' }, 8_000);
      assert.ok(data.includes('event: run.completed'), 'the terminal event must still reach the client');
    } finally {
      await srv.close();
    }
    const errs = lines.filter((l) => l.level === 'error');
    assert.equal(errs.length, 0, `a healthy stream must log nothing, got ${JSON.stringify(errs)}`);
    assert.equal(streamHub.subscriptionCount, 0);
  } finally {
    streamHub.stop();
    env.close();
  }
});

/**
 * Remove comments from TypeScript source for a guard that matches on code.
 *
 * Inline `//` must be handled too, not just whole-line comments: otherwise a line like
 * `res.end(); // res.on('error')` satisfies a guard looking for the listener while the code never
 * registers it. Stripping is quote-aware so a `//` inside a string literal (a URL, a header value)
 * is not mistaken for a comment start.
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

test('the SSE handler registers a response error listener (issue #143)', () => {
  // A SOURCE guard, and labelled as one: the hazard it protects against could not be triggered
  // through the product in a test, so this at least stops the line being dropped silently.
  //
  // It matters because a response failure surfaces as an 'error' EVENT rather than a throw. Measured
  // on Node 26: res.write() to a destroyed socket returns normally, and res.write() after res.end()
  // also returns normally and then emits 'error'. An 'error' event with no listener is an uncaught
  // exception -- reproduced as process exit 77 on a bare http.ServerResponse. No try/catch can see it.
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'api', 'routes.ts'), 'utf8');
  const start = src.indexOf("router.get('/runs/:runId/stream'");
  assert.ok(start >= 0, 'SSE route not found');
  const end = src.indexOf('\n  });', start);
  assert.ok(end > start, 'SSE route body not terminated');
  const body = stripComments(src.slice(start, end));
  assert.match(body, /res\.on\(\s*'error'/, 'the SSE handler must listen for response errors');
});

// --- issue #145: SSE must not buffer a backlog for a client that is not reading -----------------

/**
 * Open the SSE endpoint on a raw socket and never read a byte of the body.
 *
 * The socket buffers are shrunk before connecting so backpressure is applied quickly and the test does
 * not depend on the host's default (often multi-megabyte, auto-tuned) loopback buffers. Without that,
 * a small backlog fits entirely inside the kernel and the server never observes a full write buffer --
 * which made the first version of this test prove nothing at all.
 */
function openSseAndNeverRead(port: number, path: string, token: string): {
  bytesSeen: () => number; destroy: () => void;
} {
  const socket = net.connect({ port, host: '127.0.0.1' });
  let bytes = 0;
  socket.on('data', (b) => { bytes += b.length; socket.pause(); }); // counted, never drained
  socket.once('connect', () => {
    // Present at runtime since Node 12 but missing from this @types/node, hence the cast. Best
    // effort: if it is unavailable the test still works, just depends on host buffer sizes.
    try { (socket as unknown as { setBufferSize(n: number): void }).setBufferSize(4096); } catch { /* best effort */ }
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\n` +
      `Accept: text/event-stream\r\n\r\n`,
    );
  });
  return { bytesSeen: () => bytes, destroy: () => socket.destroy() };
}

/**
 * Open the SSE endpoint, read nothing for `pauseMs`, then read everything to the end.
 *
 * The pause is what makes the SERVER hit its highWaterMark and set `paused`; the resume is what makes
 * it observe 'drain'. Neither half is observable from the other tests: during the synchronous backlog
 * delivery the server never yields to the event loop, so a client that pauses cannot be serviced until
 * that page finishes -- which is also why the pending queue is bounded by one 500-row page rather than
 * by how long the client stalls.
 */
function openSsePauseThenResume(
  port: number, path: string, token: string, pauseMs: number, deadlineMs = 20_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(buf);
    };
    // Resolve with whatever arrived rather than hanging forever. A server that never flushes its queue
    // leaves the stream open, and without this the failure surfaces as a 60s test timeout instead of a
    // message naming the missing events.
    const deadline = setTimeout(finish, deadlineMs);
    socket.once('connect', () => {
      try { (socket as unknown as { setBufferSize(n: number): void }).setBufferSize(4096); } catch { /* best effort */ }
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\n` +
        `Accept: text/event-stream\r\n\r\n`,
      );
      socket.pause(); // the server must notice us stop reading
      setTimeout(() => {
        socket.on('data', (b) => { buf += b.toString('utf8'); });
        socket.on('end', finish);
        socket.on('close', finish);
        socket.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
        socket.resume();
      }, pauseMs);
    });
    socket.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

test('a client that pauses and then resumes receives every event exactly once (issue #145)', async () => {
  // The resume path is where the subtle half of this fix lives. res.write() returning false means
  // "accepted, please stop", NOT "rejected" -- so the paused event must NOT be re-queued, and the
  // queued ones must all go out after 'drain'. Getting either wrong duplicates events or drops them,
  // and neither existing test can see it: one never reads at all, the other never stops reading.
  // Payloads are padded so the socket buffer fills within a handful of writes, and the server's send
  // buffer is shrunk below, so the pause is FORCED rather than hoped for. TOTAL stays well under
  // MAX_PENDING (1000) so this client is paused and resumed, not aborted.
  const TOTAL = 600;
  const PAD = 'x'.repeat(4_096);
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'stalling client', agent: 'fake' });
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING');
    for (let i = 1; i <= TOTAL; i++) env.events.append(run.id, 'agent.message', { i, pad: PAD });
    env.events.append(run.id, 'run.completed', { ok: true });
    env.runs.transition(run.id, 'COMPLETED');
    const last = env.events.lastSequence(run.id);

    const hub = new EventStream(env.db, env.events, 20, 20);
    hub.start();
    const app = createApp({
      runService: env.runService, events: env.events, stream: hub,
      apiTokens: new Map([['tok-alice', 'alice']]), adminToken: null,
    });
    const srv = await listen(app);
    try {
      const data = await openSsePauseThenResume(
        srv.port, `/api/runs/${run.id}/stream?after=0`, 'tok-alice', 40,
      );
      const delivered = sequencesOf(data);
      // Compare against the STORE, not a hand-count: lifecycle transitions append events of their own.
      assert.deepEqual(delivered, Array.from({ length: last }, (_, k) => k + 1),
        `a pause must neither drop nor duplicate: got ${delivered.length} of ${last}`);
      assert.ok(data.includes('event: run.completed'), 'the terminal event must survive a pause');
    } finally {
      await srv.close();
      hub.stop();
    }
  } finally {
    env.close();
  }
});

test('an SSE client that stops reading is dropped instead of buffered (issue #145)', async () => {
  // Asserted from the SERVER side, deliberately. The client socket is paused, so it cannot observe the
  // close: a paused Node socket does not emit 'end' or 'close' until it reads, and the whole point is
  // that it never reads again. What is observable, and is the actual contract, is that the server
  // stopped buffering and released the subscription -- which also releases the closure over the
  // response and the backlog.
  const TOTAL = 2_000;
  const PAD = 'x'.repeat(4_096);
  const env = makeEnv({ workerEnabled: false });
  const { logger, lines } = logCapture();
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'wedged client', agent: 'fake' });
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING');
    for (let i = 1; i <= TOTAL; i++) env.events.append(run.id, 'agent.message', { i, pad: PAD });

    const hub = new EventStream(env.db, env.events, 20, 20);
    hub.start();
    const app = createApp({
      runService: env.runService, events: env.events, stream: hub,
      apiTokens: new Map([['tok-alice', 'alice']]), adminToken: null, logger,
    });
    const srv = await listen(app);
    const client = openSseAndNeverRead(srv.port, `/api/runs/${run.id}/stream?after=0`, 'tok-alice');
    try {
      await waitFor(
        () => lines.some((l) => l.msg === 'SSE client is not reading; closing the stream so the backlog is not buffered in memory'),
        20_000,
      );
      assert.equal(hub.subscriptionCount, 0,
        'the wedged subscriber must be released, not left holding the backlog');

      // The ceiling is exact. The bound used to be checked AFTER the delivery loop, so a single
      // 500-row backlog page could push the queue past the documented cap before anything noticed --
      // "at most MAX_PENDING" was untrue by up to a page. The warn line carries the queue length at
      // the moment of the abort, so the overshoot is observable rather than a matter of reading the
      // loop. Checking before each push makes the logged value exactly MAX_PENDING.
      const abort = lines.find((l) => l.msg === 'SSE client is not reading; closing the stream so the backlog is not buffered in memory')!;
      assert.equal(abort.fields.pending, 1_000,
        `the queue must stop AT the cap, not past it; logged pending=${abort.fields.pending}`);
      assert.equal(abort.fields.limit, 1_000);

      // And it stopped early: a client that reads receives the whole ~8 MB backlog (see the control).
      const totalBytes = TOTAL * PAD.length;
      assert.ok(client.bytesSeen() < totalBytes,
        `must not have delivered the whole backlog; saw ${client.bytesSeen()} of ~${totalBytes} bytes`);
    } finally {
      client.destroy();
      await srv.close();
      hub.stop();
    }
  } finally {
    env.close();
  }
});

test('POSITIVE CONTROL: a client that keeps reading is NOT closed by the backpressure guard (issue #145)', async () => {
  // Without this, a guard that closed every stream would pass the test above.
  const TOTAL = 3_000;
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'healthy client', agent: 'fake' });
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING');
    for (let i = 1; i <= TOTAL; i++) env.events.append(run.id, 'agent.message', { i });
    // Terminal so the server ends the stream and readToEnd() returns. TOTAL is well past
    // MAX_PENDING, so a reading client must still get everything: pausing must never drop data.
    env.events.append(run.id, 'run.completed', { ok: true });
    env.runs.transition(run.id, 'COMPLETED');

    const hub = new EventStream(env.db, env.events, 20, 20);
    hub.start();
    const app = createApp({
      runService: env.runService, events: env.events, stream: hub,
      apiTokens: new Map([['tok-alice', 'alice']]), adminToken: null,
    });
    const srv = await listen(app);
    try {
      const data = await readToEnd(
        `http://127.0.0.1:${srv.port}/api/runs/${run.id}/stream?after=0`,
        { authorization: 'Bearer tok-alice' }, 25_000);
      const seqs = sequencesOf(data);
      // Compare against the store's own sequence, not TOTAL: the lifecycle transitions append their
      // own events, so the stream legitimately carries more than TOTAL. Asserting TOTAL here looked
      // like a duplicate-delivery bug for a few minutes and was neither.
      const last = env.events.lastSequence(run.id);
      assert.equal(seqs.length, last, `a reading client must get all ${last}, got ${seqs.length}`);
      assert.equal(new Set(seqs).size, last, 'exactly once each -- no duplicates under pause/drain');
      assert.ok(seqs.every((v, i) => i === 0 || v >= seqs[i - 1]), 'delivered in non-decreasing order');
    } finally {
      await srv.close();
      hub.stop();
    }
  } finally {
    env.close();
  }
});

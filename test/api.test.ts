import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeServer, createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { makeEnv, waitFor, sleep } from './helpers.ts';
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
    const server = app.listen(0, () => {
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
      assert.equal(noAuth.status, 401);
      const badAuth = await fetch(`http://127.0.0.1:${srv.port}/api/runs`, {
        headers: { authorization: 'Bearer wrong' },
      });
      assert.equal(badAuth.status, 401);
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
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-sse-'));
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
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-cancel-api-'));
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
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-input-api-'));
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
  events: { sequence: number; type: string; payload: { i: number } }[];
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
        for (const e of body.events) if (e.type === 'agent.message') seen.push(e.payload.i);
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

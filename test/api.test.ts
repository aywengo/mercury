import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/server.ts';
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

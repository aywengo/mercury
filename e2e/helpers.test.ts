/**
 * Control-flow tests for the E2E helpers.
 *
 * These need no Docker daemon: they drive pollRun() and the SSE parser against a stub HTTP server on
 * loopback. They exist because the interesting behaviour in those helpers is error handling, and the
 * Docker suite only exercises it by accident -- a wrong-terminal fast exit and a deadline message are
 * both invisible while every Run completes on the first try.
 *
 * Run with `npm run test:e2e` (it is collected with the rest of e2e/) or on its own:
 *   node --test e2e/helpers.test.ts
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { client, pollRun, readSse, TerminalStateError, HttpError, type RunView } from './helpers.ts';

let server: Server;
let base = '';
/** Scripted responses: each poll shifts the next status off this list. */
let script: { status: number; body: unknown }[] = [];
let requests = 0;

function runBody(status: string, extra: Partial<RunView> = {}): { run: RunView } {
  return { run: { id: 'run_test', status, ...extra } };
}

before(async () => {
  server = createServer((req, res) => {
    requests += 1;
    const next = script.length > 1 ? script.shift()! : script[0] ?? { status: 500, body: { error: 'exhausted' } };
    if (req.url?.endsWith('/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end();
      return;
    }
    res.writeHead(next.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(next.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('pollRun retries through transient 5xx and returns once the state matches', async () => {
  script = [{ status: 500, body: { error: 'boom' } }, { status: 503, body: { error: 'later' } },
            { status: 200, body: runBody('COMPLETED') }];
  const before = requests;
  const run = await pollRun(client(base, 'tok'), 'run_test', (r) => r.status === 'COMPLETED', 'COMPLETED', 10_000);
  assert.equal(run.status, 'COMPLETED');
  assert.ok(requests - before >= 3, 'it must have retried past the two failures');
});

test('pollRun gives up immediately on a wrong terminal state instead of spinning', async () => {
  script = [{ status: 200, body: runBody('FAILED', { error: 'agent exploded' }) }];
  const startedAt = Date.now();
  await assert.rejects(
    () => pollRun(client(base, 'tok'), 'run_test', (r) => r.status === 'COMPLETED', 'COMPLETED', 30_000),
    (err: unknown) => {
      assert.ok(err instanceof TerminalStateError,
        `a wrong terminal state must be typed, not matched by message wording: ${(err as Error).message}`);
      assert.match((err as Error).message, /agent exploded/, 'the run error must be surfaced');
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 5_000, 'it must not wait for the deadline it could already fail');
});

test('pollRun reports the last observation when its deadline passes', async () => {
  script = [{ status: 200, body: runBody('QUEUED') }];
  await assert.rejects(
    () => pollRun(client(base, 'tok'), 'run_stuck', (r) => r.status === 'COMPLETED', 'COMPLETED', 1_500),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(!(err instanceof TerminalStateError), 'a deadline is not a terminal state');
      assert.match(message, /run_stuck/, 'the failure must name the Run');
      assert.match(message, /last observed status=QUEUED/, `it must say what it saw: ${message}`);
      assert.match(message, /worker\.log/, `it must point at the logs: ${message}`);
      return true;
    },
  );
});

test('pollRun surfaces a 404 rather than polling a Run that does not exist', async () => {
  script = [{ status: 404, body: { error: 'run not found' } }];
  const startedAt = Date.now();
  await assert.rejects(
    () => pollRun(client(base, 'tok'), 'run_missing', (r) => r.status === 'COMPLETED', 'COMPLETED', 30_000),
    (err: unknown) => (err as HttpError).status === 404,
  );
  assert.ok(Date.now() - startedAt < 5_000, 'a 404 must not be retried until the deadline');
});

test('the SSE parser ignores the hello frame and keeps real sequences', async () => {
  // A second server that writes a realistic stream: hello, then events, then a terminal event.
  const frames = [
    'event: hello\ndata: {"runId":"run_x","after":0}\n\n',
    'event: run.created\ndata: {"type":"run.created","sequence":1,"runId":"run_x"}\n\n',
    ': keepalive\n\n',
    'event: run.completed\ndata: {"type":"run.completed","sequence":2,"runId":"run_x"}\n\n',
  ].join('');
  const sse = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Split mid-frame to prove the parser buffers across network reads.
    res.write(frames.slice(0, 40));
    setTimeout(() => { res.write(frames.slice(40)); res.end(); }, 20);
  });
  await new Promise<void>((resolve) => sse.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(sse.address() as AddressInfo).port}`;
  try {
    const { events } = await readSse(url, 'tok', 'run_x', 5_000);
    assert.deepEqual(events.map((e) => e.sequence), [1, 2],
      'the hello frame and keepalive must not become phantom events');
    assert.deepEqual(events.map((e) => e.type), ['run.created', 'run.completed']);
  } finally {
    await new Promise<void>((resolve) => sse.close(() => resolve()));
  }
});

test('the SSE parser names the raw frame when JSON is malformed', async () => {
  const sse = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: run.created\ndata: {"sequence":1, oops\n\n');
  });
  await new Promise<void>((resolve) => sse.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(sse.address() as AddressInfo).port}`;
  try {
    await assert.rejects(() => readSse(url, 'tok', 'run_x', 5_000), /malformed JSON frame.*oops/s);
  } finally {
    await new Promise<void>((resolve) => sse.close(() => resolve()));
  }
});

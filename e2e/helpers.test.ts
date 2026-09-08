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

test('a falsy JSON body still gets Content-Type, and no body gets none', async () => {
  // The header used `body ?` while the payload used `body === undefined`. Those disagree for every
  // falsy-but-real JSON value, so `post(path, 0)` sent "0" with no Content-Type and the server had to
  // guess. A POST with no body must still omit the header, or the server waits for a payload that never
  // arrives -- so both directions are pinned.
  const seen: { type?: string; body?: string }[] = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ type: req.headers['content-type'] as string | undefined, body: raw });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const c = client(url, 'tok');
    for (const v of [null, 0, false, '', { ok: true }] as unknown[]) {
      await c.post('/api/x', v, 'post');
    }
    await c.get('/api/y', 'get');
    for (const [i, v] of [null, 0, false, '', { ok: true }].entries()) {
      assert.equal(seen[i].type, 'application/json',
        `a body of ${JSON.stringify(v)} is a real JSON payload and must be typed`);
      assert.equal(seen[i].body, JSON.stringify(v),
        `the payload for ${JSON.stringify(v)} must be sent`);
    }
    // Five posts occupy 0..4; the GET is the sixth request.
    assert.equal(seen[5].type, undefined, 'a GET with no body must not claim a Content-Type');
    assert.equal(seen[5].body, '', 'a GET must send no payload');
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('a credential scan over exec output must not pass when the exec failed', async () => {
  // The real check runs `docker compose exec -T worker sh -c env`, and the helper that runs it folds
  // stderr into the same string as stdout. So a failed exec -- no worker, bad service name, daemon down --
  // yields NON-EMPTY output, the "did we read anything" guard passes, and a credential regex then matches
  // nothing in an error message. That is a green test that checked nothing. This reproduces the shape with
  // a command that fails and writes to stderr, so no Docker daemon is needed.
  const { spawnSync } = await import('node:child_process');
  const failed = spawnSync('/bin/sh', ['-c', 'echo "service not running" 1>&2; exit 1'], { encoding: 'utf8' });
  const out = failed.stdout + failed.stderr;   // exactly how the helper composes `out`
  const keys = out.split('\n').map((l) => l.split('=')[0]).filter(Boolean);
  const credential = /ANTHROPIC|OPENAI|GOOGLE_API|AWS_(ACCESS|SECRET)|AZURE_|NPM_TOKEN|GITHUB_TOKEN|XAI_|GEMINI/i;

  // The old logic, shown passing on a command that never read an environment.
  assert.ok(keys.length > 0, 'precondition: failed output is non-empty');
  assert.deepEqual(keys.filter((k) => credential.test(k)), [],
    'precondition: an error message contains nothing credential-shaped');

  // The exit code is the assertion that carries the weight: it is the only thing here that distinguishes
  // "the worker has no credentials" from "we never asked the worker".
  assert.notEqual(failed.status, 0,
    'control: the command failed, so a check that ignores the exit code would report clean credentials '
    + 'on a worker that was never read');
});

// Transport-level tests (docs/cli-tui-design.md §13).
//
// These drive MercuryClient against in-process servers built from node:http, because the behaviours
// under test -- a total deadline, an idle timeout, a response-size bound -- cannot be produced by the
// real Mercury server. They are what a broken or hostile endpoint does, not what a healthy one does.
//
// The deadline test exists because a review found the first implementation used req.setTimeout alone
// and described it as a total deadline. It is an idle timeout, and a server that drips bytes resets it
// forever. That was reproduced before being fixed, and this file is what keeps it fixed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { MercuryClient } from '../api/client.ts';
import { TransportError } from '../api/errors.ts';

/** Start a server on a free port and hand back its base URL plus a closer. */
async function serve(handler: RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

test('a slow-drip response cannot extend the deadline indefinitely', async () => {
  // The regression this file exists for. The server sends a valid JSON prefix and then one space every
  // 100ms, so: the size bound never trips (far below 16MB), the connection never goes idle long
  // enough for an idle timeout to fire, and the response never ends. Only a wall-clock bound stops
  // this. Before the fix the client waited forever past a 1s timeout.
  const { url, close } = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"agents":["a"],"defaultAgent":"a"');
    const timer = setInterval(() => res.write(' '), 100);
    _req.on('close', () => clearInterval(timer));
  });
  try {
    const client = new MercuryClient({ baseUrl: url, token: 't', timeoutMs: 1_000 });
    const started = Date.now();
    // Raced against a hard cap rather than awaited directly. If the total deadline regresses, the
    // client never rejects at all, and `await assert.rejects(...)` would then hang the whole suite --
    // which is exactly what happened when this mutation was tried, for 400 seconds, with no report.
    // A regression has to FAIL, not stall: the hang is indistinguishable from a slow run and costs
    // far more than the bug it is guarding.
    const HARD_CAP_MS = 6_000;
    const outcome = await Promise.race([
      client.listAgents().then(() => 'resolved' as const, (err: unknown) => err as Error),
      delay(HARD_CAP_MS).then(() => 'STALLED' as const),
    ]);
    const elapsed = Date.now() - started;
    assert.notEqual(outcome, 'STALLED', `deadline did not bound the request: still waiting after ${elapsed}ms`);
    assert.notEqual(outcome, 'resolved', 'a never-ending response must not resolve');
    assert.ok(outcome instanceof TransportError, `expected TransportError, got ${String(outcome)}`);
    // Generous bounds: the point is "bounded", not "exactly 1000ms". A tight window on a loaded CI
    // runner is a flaky test waiting to fail.
    assert.ok(elapsed < HARD_CAP_MS, `deadline fired too late: ${elapsed}ms`);
    assert.ok(elapsed >= 900, `returned before the deadline could have elapsed: ${elapsed}ms`);
  } finally {
    await close();
  }
});

test('a server that accepts and then goes silent is cut off', async () => {
  // The complementary case: no bytes at all after headers. Both the idle timeout and the total
  // deadline apply here, and whichever fires first must produce a TransportError rather than a hang.
  const { url, close } = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    // deliberately never finish
  });
  try {
    const client = new MercuryClient({ baseUrl: url, token: 't', timeoutMs: 800 });
    await assert.rejects(() => client.listAgents(), (err: Error) => err instanceof TransportError);
  } finally {
    await close();
  }
});

test('an oversized response body is refused rather than buffered', async () => {
  // 16MB + change. Without the bound, a hostile endpoint could make the client allocate without
  // limit while a script waits for a JSON document that never ends.
  const { url, close } = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(1024 * 1024, 0x61); // 'a' * 1MB, not valid JSON past the first byte
    let sent = 0;
    // `sent` must advance on EVERY write, not only when write() returns true. write() returns false to
    // signal backpressure AFTER queueing the data, so incrementing only on true leaves the counter at
    // zero forever and this handler streams without end. That is exactly what the first version did,
    // and it turned this test into "an endless stream trips the bound" -- which still passed when the
    // bound was raised to 1GB, hiding the mutation. The data is counted, so the counter tracks data.
    const pump = (): void => {
      while (sent < 20) {
        const flushed = res.write(chunk);
        sent += 1;
        if (!flushed) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });
  try {
    const client = new MercuryClient({ baseUrl: url, token: 't', timeoutMs: 30_000 });
    await assert.rejects(
      () => client.listAgents(),
      (err: Error) => err instanceof TransportError && /limit/i.test(err.message),
    );
  } finally {
    await close();
  }
});

test('a non-JSON success body is a transport error, not a crash', async () => {
  // A proxy or load balancer in front of Mercury can answer 200 with an HTML page. The operator needs
  // "the server returned a non-JSON body", not a JSON.parse stack trace.
  const { url, close } = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>502 from proxy</body></html>');
  });
  try {
    const client = new MercuryClient({ baseUrl: url, token: 't', timeoutMs: 5_000 });
    await assert.rejects(() => client.listAgents(), (err: Error) => err instanceof TransportError);
  } finally {
    await close();
  }
});

test('an unreadable CA file fails at construction, not on first request', () => {
  // Surfacing a bad trust store as a configuration error is actionable; surfacing it as a TLS failure
  // on the first call sends the operator looking at the network instead of at their config.
  assert.throws(
    () => new MercuryClient({ baseUrl: 'https://example.invalid', token: 't', timeoutMs: 1000, caFile: '/nonexistent/ca.pem' }),
    (err: Error) => err instanceof TransportError && /CA file/.test(err.message),
  );
});

test('the deadline timer does not keep the process alive after a fast response', async () => {
  // If the timer were not cleared on success, a short-timeout client would hold the event loop open
  // for the rest of the window after every request -- so `mercuryctl runs list --timeout 30s` would
  // take half a minute to exit even though the server answered instantly.
  //
  // Measured as a SUBPROCESS wall clock, not as the await duration. The await returns promptly either
  // way; only process exit reveals the lingering handle. The first version of this test asserted on
  // the await and therefore survived the mutation it was written to catch.
  const { url, close } = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ agents: ['a'], defaultAgent: 'a' }));
  });
  const script = `
    const { MercuryClient } = await import(${JSON.stringify(join(import.meta.dirname, '..', 'api', 'client.ts'))});
    const c = new MercuryClient({ baseUrl: ${JSON.stringify(url)}, token: 't', timeoutMs: 30000 });
    const r = await c.listAgents();
    if (r.agents[0] !== 'a') throw new Error('unexpected body');
    console.log('done');
  `;
  try {
    const started = Date.now();
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
      timeout: 25_000,
    });
    const output = await new Promise<string>((resolve, reject) => {
      let buf = '';
      child.stdout?.on('data', (d: Buffer) => { buf += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { buf += d.toString(); });
      child.on('error', reject);
      child.on('close', (code: number | null) => {
        if (code === 0) resolve(buf);
        else reject(new Error(`child exit ${code}: ${buf}`));
      });
    });
    const elapsed = Date.now() - started;
    assert.match(output, /done/);
    // The request itself is local and instant; anything approaching the 30s timeout means the timer
    // was left armed. The bound is deliberately far from both so a loaded runner cannot trip it.
    assert.ok(elapsed < 8_000, `process lingered ${elapsed}ms; the deadline timer was not cleared`);
  } finally {
    await close();
  }
});

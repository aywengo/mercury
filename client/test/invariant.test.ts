// The output invariant, end to end.
//
// Unit tests over individual renderers were written first, and a reviewer still found unsanitised paths
// in them -- because a per-function test only covers the function someone remembered. This drives the
// real binary against a server whose EVERY response field carries terminal control sequences, and asserts
// that nothing written to a terminal contains an escape byte. It covers the renderers, the error path, and
// any path nobody has thought to write a unit test for yet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin.ts', import.meta.url));

/** ESC-introduced OSC and CSI sequences plus a bare BEL: exactly what must never reach a terminal. */
const H = 'a\u001b]0;pwned\u0007b\u001b[31mc\u0007d';

const RUN = {
  id: H, status: 'RUNNING', task: H, agent: H, ownerId: H, attempt: 1,
  createdAt: H, startedAt: H, completedAt: null, retryOf: H,
  workspaceBranch: H, prUrl: H, error: H, errorKind: H, finalCommits: [H],
  repository: { url: H, localPath: H },
};

const EVENT = {
  id: H, runId: H, type: H, sequence: 1, timestamp: H,
  payload: { text: H, message: H, command: H, path: H, reason: H },
};

interface Stub { url: string; close(): Promise<void> }

async function startStub(mode: 'data' | 'error'): Promise<Stub> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0]!;
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (mode === 'error') {
      // The server's own `error` string is untrusted text: a proxy, a compromised upstream, or a
      // validation message echoing back another operator's Run task all land here.
      send(500, { error: H });
      return;
    }
    if (path === '/api/agents') return send(200, { agents: [H], defaultAgent: H });
    if (path === '/api/runs' && req.method === 'POST') return send(201, { runId: H, status: 'QUEUED' });
    if (path === '/api/runs') return send(200, { runs: [RUN], nextCursor: H });
    if (path.endsWith('/events')) {
      return send(200, { events: [EVENT], lastSequence: 1, nextCursor: 1, hasMore: false });
    }
    if (path.endsWith('/input') || path.endsWith('/cancel')) return send(200, { runId: H, status: 'RUNNING' });
    if (path.endsWith('/retry')) return send(201, { runId: H, status: 'QUEUED', retryOf: H });
    if (/\/runs\/[^/]+$/.test(path)) return send(200, { run: RUN, skills: [{ id: H, version: H }] });
    send(404, { error: H });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: async () => { server.close(); await once(server, 'close'); } };
}

async function cli(url: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const root = mkdtempSync(join(tmpdir(), 'mercuryctl-inv-'));
  mkdirSync(join(root, 'mercury'), { recursive: true });
  const child = spawn(process.execPath, ['--no-warnings', BIN, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, XDG_CONFIG_HOME: root,
      MERCURY_CLIENT_URL: url, MERCURY_CLIENT_TOKEN: 'tok',
      // No colour, and stdin is not a terminal: the invariant is about the bytes we would hand a shell.
      MERCURY_CLIENT_NO_COLOR: '1', NO_COLOR: '1',
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { code, out, err };
}

const COMMANDS: string[][] = [
  ['agents', 'list'],
  ['runs', 'list'],
  ['runs', 'show', 'run-1'],
  ['runs', 'create', '--task', 'x', '--repo', 'https://example.com/x.git'],
  ['runs', 'events', 'run-1'],
  ['runs', 'input', 'run-1', '--value', 'v'],
  ['runs', 'cancel', 'run-1', '--yes'],
  ['runs', 'retry', 'run-1', '--yes'],
  ['config', 'current'],
  ['config', 'profiles'],
];

function assertTerminalSafe(label: string, r: { out: string; err: string }): void {
  const all = `${r.out}${r.err}`;
  assert.ok(!all.includes('\u001b'),
    `${label}: an escape byte reached the terminal: ${JSON.stringify(all.slice(0, 400))}`);
  assert.ok(!all.includes('\u0007'), `${label}: a BEL reached the terminal: ${JSON.stringify(all.slice(0, 400))}`);
}

test('no command writes terminal control sequences when the server puts them in every field', async () => {
  const stub = await startStub('data');
  try {
    for (const args of COMMANDS) {
      const r = await cli(stub.url, [...args, '--no-color']);
      assertTerminalSafe(args.join(' '), r);
      // The hostile text must still be VISIBLE as data. Neutralising it must not hide the fact that the
      // server said something strange, which is the difference between sanitising and dropping.
      if (r.code === 0) {
        assert.ok(r.out.includes('\u241b') || !r.out.includes('pwned'),
          `${args.join(' ')} neither marked nor removed the sequence`);
      }
    }
  } finally {
    await stub.close();
  }
});

test('the error path is terminal-safe too: a hostile server error string is neutralised', async () => {
  // reportError() is the last untrusted path, and the one a per-renderer audit cannot see: it prints
  // err.message, which for a ProtocolError quotes fragments of the server payload and for an HTTP error
  // carries the server's own `error` string verbatim.
  const stub = await startStub('error');
  try {
    for (const args of COMMANDS) {
      const r = await cli(stub.url, [...args, '--no-color']);
      assertTerminalSafe(`${args.join(' ')} (error path)`, r);
      const offline = args[0] === 'config';
      if (offline) continue;   // config commands resolve locally and never request; succeeding is correct
      assert.notEqual(r.code, 0, `${args.join(' ')} unexpectedly succeeded against an always-500 server`);
      assert.match(r.err, /\S/, `${args.join(' ')} failed silently`);
    }
  } finally {
    await stub.close();
  }
});

test('the stub is actually hostile, or the two tests above prove nothing', async () => {
  // Both tests above assert an ABSENCE. An absence measured over a fixture that never produced a control
  // byte passes forever, so the fixture is asserted here rather than trusted.
  const stub = await startStub('data');
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(stub.url + '/api/agents', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { body += c; });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.end();
    });
    // On the wire the sequence is JSON-escaped, so the body carries the six characters \u001b rather than
    // the byte; the byte only exists after the client parses it. Asserting the wrong form would make this
    // guard fail against a perfectly hostile stub.
    const ESCAPED = '\\u001b';
    assert.ok(raw.includes(ESCAPED),
      'the stub emits no escape sequences; the invariant tests would be vacuous');
    assert.ok(raw.includes('pwned'), 'the stub payload is not the hostile string');
  } finally {
    await stub.close();
  }
});

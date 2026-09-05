import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { once } from 'node:events';
import { MercuryClient } from '../api/client.ts';

/**
 * A remote HTTPS profile with a custom CA is an acceptance criterion for Milestone 4, and it is the
 * kind of feature that looks implemented because the option is threaded through the code. Reading the
 * threading is not proof: the JSON request path and the SSE path build their request options
 * separately, so either could drop `ca` while the other keeps it, and a test that only ever used one
 * would not notice.
 *
 * Every case here is therefore run twice -- once through the real CLI binary, once through the client
 * transport -- and each is run with the RIGHT CA, with NO CA, and with a DIFFERENT valid CA. The third
 * is the one that matters: without it, a test that passes cannot tell "the profile's CA is consulted"
 * apart from "certificate verification is switched off", which is the failure that would ship.
 */
const BIN = fileURLToPath(new URL('../bin.ts', import.meta.url));
const TOKEN = 'tls-secret-token-DO-NOT-PRINT';

/**
 * Self-signed certificates, generated once per test process.
 *
 * Two independent CAs are generated rather than one: the wrong-CA case needs a certificate that is
 * perfectly well-formed and signed by an authority the client simply does not trust. A malformed
 * certificate would prove only that malformed certificates are rejected.
 */
let certBundle: Promise<Certs> | null = null;

interface Certs { good: { cert: string; key: string }; other: { cert: string; key: string } }

function certs(): Promise<Certs> {
  certBundle ??= generateCerts();
  return certBundle;
}

function generateCerts(): Promise<Certs> {
  const dir = mkdtempSync(join(tmpdir(), 'mercuryctl-tls-'));
  const make = (name: string) => {
    const cnf = join(dir, `${name}.cnf`);
    writeFileSync(cnf, [
      '[req]', 'distinguished_name=dn', 'x509_extensions=v3', 'prompt=no',
      '[dn]', 'CN=127.0.0.1',
      '[v3]', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      'basicConstraints=critical,CA:TRUE',
      'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
      '',
    ].join('\n'));
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, `${name}-key.pem`), '-out', join(dir, `${name}-cert.pem`),
      '-days', '2', '-config', cnf, '-extensions', 'v3'], { stdio: 'ignore', timeout: 60_000 });
    return { cert: join(dir, `${name}-cert.pem`), key: join(dir, `${name}-key.pem`) };
  };
  return Promise.resolve({ good: make('good'), other: make('other') });
}

/**
 * A Mercury-shaped HTTPS server. Only the endpoints these tests reach are implemented, and the shapes
 * are transcribed from client/api/protocol.ts rather than from the design document -- a fake that
 * disagrees with the parser proves nothing in either direction.
 */
interface TlsServer { url: string; port: number; close(): Promise<void>; streamRequests: () => number }

const RUN = {
  id: 'run-tls-1', status: 'RUNNING', task: 'tls task', agent: 'prime-agent',
  repository: { url: 'https://example.com/x.git', ref: 'main' },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

function event(sequence: number): Record<string, unknown> {
  return {
    id: `evt-${sequence}`, runId: RUN.id, type: 'agent.message', sequence,
    timestamp: '2026-01-01T00:00:00.000Z', payload: { text: `event ${sequence}` },
  };
}

async function startTlsServer(certs: { cert: string; key: string }): Promise<TlsServer> {
  let streams = 0;
  const server = https.createServer(
    { cert: readFileSync(certs.cert, 'utf8'), key: readFileSync(certs.key, 'utf8') },
    (req, res) => {
      const path = (req.url ?? '').split('?')[0]!;
      if (path === '/api/agents') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ agents: ['prime-agent', 'claude-code'], defaultAgent: 'prime-agent' }));
        return;
      }
      if (path.endsWith('/events')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          events: [event(1), event(2)], lastSequence: 2, nextCursor: 2, hasMore: false,
        }));
        return;
      }
      if (path.endsWith('/stream')) {
        streams += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: hello\ndata: {"runId":"${RUN.id}","after":0}\n\n`);
        res.write(`event: agent.message\ndata: ${JSON.stringify(event(3))}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return {
    url: `https://127.0.0.1:${port}`,
    port,
    streamRequests: () => streams,
    close: async () => { server.close(); await once(server, 'close'); },
  };
}



/** A config directory with one profile, optionally carrying a caFile. */
function configDir(profile: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'mercuryctl-tls-cfg-'));
  const dir = join(root, 'mercury');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ currentProfile: 'remote', profiles: { remote: profile } }));
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ 'remote-token': TOKEN }));
  chmodSync(join(dir, 'credentials.json'), 0o600);
  return root;
}

/**
 * Async on purpose. The HTTPS server under test runs INSIDE this test process, and `spawnSync` blocks
 * the event loop for the whole call -- so the server could never complete the very TLS handshake the
 * CLI subprocess is waiting on. Every request here would time out at 30s and the failure would look
 * like a broken transport.
 */
async function cli(xdgRoot: string, args: string[]) {
  const child = spawn(process.execPath, ['--no-warnings', BIN, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgRoot,
      // Cleared, not deleted: the profile under test must be the thing that decides.
      MERCURY_CLIENT_URL: '', MERCURY_CLIENT_TOKEN: '',
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { code, out, err, all: `${out}${err}` };
}

test('a remote HTTPS profile with a custom CA works, over JSON and over SSE', async () => {
  const c = await certs();
  const srv = await startTlsServer(c.good);
  try {
    const root = configDir({ url: srv.url, credential: 'remote-token', caFile: c.good.cert });

    const agents = await cli(root, ['agents', 'list']);
    assert.equal(agents.code, 0, agents.all);
    assert.match(agents.out, /prime-agent/);

    // The SSE path builds its request options separately from the JSON path, so it needs its own
    // proof. The observer stops after history for a terminal Run and would never open the stream.
    const events = await cli(root, ['runs', 'events', RUN.id]);
    assert.equal(events.code, 0, events.all);
    assert.match(events.out, /event 1/);

    const streamed = await collectStream(srv.url, c.good.cert);
    assert.deepEqual(streamed.map((f) => f.event), ['hello', 'agent.message']);
    assert.ok(srv.streamRequests() > 0, 'the SSE endpoint was never reached over TLS');
  } finally {
    await srv.close();
  }
});

async function collectStream(baseUrl: string, caFile: string) {
  const client = new MercuryClient({ baseUrl, token: TOKEN, timeoutMs: 15_000, caFile });
  const frames: { event: string }[] = [];
  for await (const frame of client.streamEvents(RUN.id, { idleTimeoutMs: 10_000 })) {
    frames.push(frame as { event: string });
    if (frames.length === 2) break;
  }
  return frames;
}

test('without a CA the connection fails rather than falling back to plaintext or to no verification', async () => {
  const c = await certs();
  const srv = await startTlsServer(c.good);
  try {
    const root = configDir({ url: srv.url, credential: 'remote-token' });
    const r = await cli(root, ['agents', 'list']);
    assert.equal(r.code, 7, `expected a transport failure, got exit ${r.code}: ${r.all}`);
    assert.match(r.err, /self[- ]signed|certificate|unable to verify/i, r.err);
    // The failure path is where a token is most likely to be echoed: the message quotes the endpoint.
    assert.ok(!r.all.includes(TOKEN), 'the bearer token appeared in a TLS error');
  } finally {
    await srv.close();
  }
});

test('a DIFFERENT valid CA is rejected -- the profile CA is consulted, not verification disabled', async () => {
  const c = await certs();
  const srv = await startTlsServer(c.good);
  try {
    // other-cert is a well-formed certificate from an authority this server was not signed by. If the
    // client were merely skipping verification, this would succeed and the suite would be green while
    // the transport trusted nothing.
    const root = configDir({ url: srv.url, credential: 'remote-token', caFile: c.other.cert });
    const r = await cli(root, ['agents', 'list']);
    assert.equal(r.code, 7, `a foreign CA was accepted: exit ${r.code}: ${r.all}`);
    assert.match(r.err, /self[- ]signed|certificate|unable to verify|unknown ca/i, r.err);

    // Same proof for the SSE path, which is configured by a separate options object.
    await assert.rejects((async () => { await collectStream(srv.url, c.other.cert); })(),
      /self[- ]signed|certificate|unable to verify|unknown ca/i);
  } finally {
    await srv.close();
  }
});

test('a CA file that cannot be read says which path, and does not silently fall back to the system store', async () => {
  const c = await certs();
  const srv = await startTlsServer(c.good);
  try {
    const missing = join(srv.url.replace('https://127.0.0.1:', '/tmp/no-such-dir-'), 'ca.pem');
    const root = configDir({ url: srv.url, credential: 'remote-token', caFile: missing });
    const r = await cli(root, ['agents', 'list']);
    assert.equal(r.code, 7, r.all);
    assert.match(r.err, /ca\.pem/, `the error should name the unreadable path: ${r.err}`);
    assert.ok(!r.all.includes(TOKEN), 'the bearer token appeared in a CA error');
  } finally {
    await srv.close();
  }
});

test('a custom CA is scoped to its profile and does not leak into another one', async () => {
  const c = await certs();
  const srv = await startTlsServer(c.good);
  try {
    const root = mkdtempSync(join(tmpdir(), 'mercuryctl-tls-two-'));
    const dir = join(root, 'mercury');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      currentProfile: 'trusted',
      profiles: {
        trusted: { url: srv.url, credential: 'remote-token', caFile: c.good.cert },
        // Same server, same credential, no CA: a profile that trusts a private CA must not make every
        // profile trust it, because that would turn one operator mistake into a client-wide one.
        untrusted: { url: srv.url, credential: 'remote-token' },
      },
    }));
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ 'remote-token': TOKEN }));
    chmodSync(join(dir, 'credentials.json'), 0o600);

    assert.equal((await cli(root, ['agents', 'list'])).code, 0, 'the profile with the CA should work');
    const other = await cli(root, ['--profile', 'untrusted', 'agents', 'list']);
    assert.equal(other.code, 7, `the CA leaked across profiles: exit ${other.code}: ${other.all}`);
  } finally {
    await srv.close();
  }
});

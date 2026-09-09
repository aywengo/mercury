import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ProbeRecord } from '../registry.ts';
import { FLEET_VERSION } from '../version.ts';

// The operator journey, through the real process boundary.
//
// The rest of the suite builds a server in-process with `createFleetServer(...)`, which is the right
// tool for testing routes and never once starts the thing users run. That gap is how Fleet shipped a
// `bin` pointing at a `.ts` file: every in-process test passed while the installed CLI could not
// start. This file therefore does not import the server at all. It spawns `fleet serve` as a child
// process with an environment a real operator would set, talks to it over HTTP, and points it at a
// stand-in Mercury, so the path covered is startup -> config -> auth -> registry -> probe.
//
// It stays in test:fleet rather than e2e/ on purpose: e2e/ brings up containers, and nothing here
// needs a container. A fake Mercury over loopback is enough to prove Fleet's own side of the wire.

const FLEET_DIR = resolve(import.meta.dirname, '..');
const CHILD_SECRET = 'journey-child-secret-9d2f4a';
const ADMIN_TOKEN = 'journey-admin-token-5c1b';
const CALLER_TOKEN = 'journey-caller-token-77ae';
const SCOPED_TOKEN = 'journey-scoped-token-3f90';

/** A stand-in Mercury: the three endpoints a probe actually reads. */
function fakeMercury(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    const known = url === '/healthz' || url === '/healthz/workers' || url === '/api/agents';
    res.writeHead(known ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(
      url === '/healthz/workers'
        ? { workers: [{ workerId: 'w1', activeRuns: 0 }], queueDepth: 0 }
        : url === '/api/agents' ? { agents: ['prime-agent'] } : { ok: true }));
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    done({
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    });
  }));
}

async function req(base: string, path: string, token: string | null, init?: RequestInit) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) as unknown };
}

async function waitForHealth(base: string, child: ChildProcess): Promise<void> {
  // Bounded, and it gives up with the child's own output: a service that never comes up is far more
  // likely to have died on a config error than to be slow, and the log is the only clue.
  const started = Date.now();
  let last = 'no response';
  while (Date.now() - started < 30_000) {
    if (child.exitCode !== null) {
      throw new Error(`fleet serve exited early with code ${child.exitCode}`);
    }
    try {
      const r = await req(base, '/healthz', null);
      if (r.status === 200) return;
      last = `${r.status} ${r.text.slice(0, 120)}`;
    } catch (e) { last = String(e).slice(0, 120); }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`fleet serve never became healthy within 30s; last: ${last}`);
}

test('the operator journey: serve, authenticate, register a host, probe it healthy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-journey-'));
  let child: ChildProcess | null = null;
  const mercury = await fakeMercury();
  const logs: string[] = [];
  try {
    // Credentials are refused unless mode 0600, so the fixture has to be a real file with real bits.
    const credFile = join(dir, 'credentials.json');
    writeFileSync(credFile, JSON.stringify({ 'journey-host': CHILD_SECRET }));
    chmodSync(credFile, 0o600);

    const port = 20_000 + (process.pid % 20_000);
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(FLEET_DIR, 'cli.ts'), 'serve'], {
      cwd: FLEET_DIR,
      env: {
        ...process.env,
        NO_COLOR: '1',
        FLEET_BIND_HOST: '127.0.0.1',
        FLEET_PORT: String(port),
        FLEET_DB: join(dir, 'fleet.db'),
        FLEET_CREDENTIALS_FILE: credFile,
        FLEET_ADMIN_TOKEN: ADMIN_TOKEN,
        // alice sees everything; bob is scoped to one host and must not be able to add another.
        FLEET_API_TOKENS: `${CALLER_TOKEN}:alice:*,${SCOPED_TOKEN}:bob:other-host`,
        FLEET_PROBE_INTERVAL_MS: '3600000', // no background sweeping; this test probes explicitly
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => logs.push(c));
    child.stderr!.on('data', (c: string) => logs.push(c));

    await waitForHealth(base, child);

    // /healthz is public and names the product and version it is serving.
    const health = await req(base, '/healthz', null);
    const healthBody = health.json() as { ok: boolean; ts: string; product: string; version: string };
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.product, 'fleet');
    assert.equal(healthBody.version, FLEET_VERSION);
    assert.ok(!Number.isNaN(Date.parse(healthBody.ts)), `healthz ts is not an ISO timestamp: ${healthBody.ts}`);

    // Everything else needs a token. An anonymous read must be refused, not answered with an empty list.
    const anon = await req(base, '/fleet/hosts', null);
    assert.equal(anon.status, 401, `anonymous read returned ${anon.status}: ${anon.text.slice(0, 160)}`);

    const empty = await req(base, '/fleet/hosts', CALLER_TOKEN);
    assert.equal(empty.status, 200);
    assert.deepEqual((empty.json() as { hosts: unknown[] }).hosts, []);

    // Registry writes are admin-only. A caller token gets a refusal, not a narrowed success.
    const forbidden = await req(base, '/fleet/hosts', CALLER_TOKEN, {
      method: 'POST', body: JSON.stringify({ id: 'lab-1', baseUrl: mercury.url, credentialRef: 'journey-host' }),
    });
    assert.equal(forbidden.status, 403, `caller write returned ${forbidden.status}: ${forbidden.text.slice(0, 160)}`);

    const added = await req(base, '/fleet/hosts', ADMIN_TOKEN, {
      method: 'POST', body: JSON.stringify({ id: 'lab-1', baseUrl: mercury.url, credentialRef: 'journey-host' }),
    });
    // 201, not 200: the route creates a resource. Asserting the exact code keeps a change of
    // contract from passing silently.
    assert.equal(added.status, 201, `registering a host failed: ${added.status} ${added.text.slice(0, 240)}`);

    // Probe explicitly. This is the one call that makes Fleet reach out to a host over the wire using
    // the credential reference rather than a secret from the request.
    const probed = await req(base, '/fleet/hosts/lab-1/probe', ADMIN_TOKEN, { method: 'POST' });
    assert.equal(probed.status, 200, `probe failed: ${probed.status} ${probed.text.slice(0, 240)}`);

    const listed = await req(base, '/fleet/hosts', CALLER_TOKEN);
    const hosts = (listed.json() as {
      hosts: Array<{ id: string; probe?: ProbeRecord | null }>;
    }).hosts;
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].id, 'lab-1');
    // `outcome`, not `status`: the probe reports what it observed, so a failure says whether the
    // host was unreachable, refused the credential, or answered but is unhealthy.
    assert.ok(hosts[0].probe, `no probe record was stored; body: ${listed.text.slice(0, 400)}`);
    assert.equal(hosts[0].probe!.outcome, 'ok',
      `probe outcome was ${hosts[0].probe!.outcome} (${hosts[0].probe!.detail}); body: ${listed.text.slice(0, 400)}`);
    // The probe read the child's real topology, not just a 200.
    assert.equal(hosts[0].probe!.workerCount, 1, `worker count: ${JSON.stringify(hosts[0].probe)}`);

    // A caller scoped to another host must not be able to act on this one.
    const scoped = await req(base, '/fleet/hosts/lab-1/probe', SCOPED_TOKEN, { method: 'POST' });
    assert.equal(scoped.status, 403, `scoped caller probed a host it may not see: ${scoped.status}`);

    // The child secret is the credential Fleet carries to Mercury. It must never surface in a
    // response, whatever the caller is allowed to read.
    const allBodies = [health, anon, empty, forbidden, added, probed, listed, scoped].map((r) => r.text).join('\n');
    assert.ok(!allBodies.includes(CHILD_SECRET), 'a child credential reached an HTTP response body');
    assert.ok(!logs.join('').includes(CHILD_SECRET), 'a child credential reached the service log');
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((done) => {
        const t = setTimeout(() => { child?.kill('SIGKILL'); done(); }, 5_000);
        child!.on('exit', () => { clearTimeout(t); done(); });
      });
    }
    await mercury.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

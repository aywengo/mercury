import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { openFleetDb } from '../db.ts';
import { createFleetServer, type FleetServer } from '../server.ts';
import { loadCredentials } from '../credentials.ts';
import { createRedactor } from '../redact.ts';
import { createLogger } from '../logger.ts';
import { assertServeable, loadConfig } from '../config.ts';
import { HostRegistry } from '../registry.ts';

const CHILD_SECRET = 'child-secret-abcdef123456';
const CALLER_TOKEN = 'caller-token-xyz789999';
const ADMIN_TOKEN = 'admin-token-999888777';

async function fakeMercury(healthy = true): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const known = ['/healthz', '/healthz/workers', '/api/agents'].includes(req.url ?? '');
    res.writeHead(known && healthy ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/healthz/workers'
      ? { workers: [{ workerId: 'w1', activeRuns: 1 }], queueDepth: 2 }
      : req.url === '/api/agents' ? { agents: ['prime-agent'] } : { ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function startService(opts: { apiTokens?: string } = {}): Promise<{
  base: string; svc: FleetServer; db: DatabaseSync; call: (m: string, p: string, o?: { token?: string; body?: unknown }) => Promise<{ status: number; json: any }>;
  close: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-svc-'));
  const credFile = join(dir, 'credentials.json');
  writeFileSync(credFile, JSON.stringify({ 'lan-ref': CHILD_SECRET }), { mode: 0o600 });
  chmodSync(credFile, 0o600);

  const config = loadConfig({
    FLEET_DB: join(dir, 'fleet.db'), FLEET_CREDENTIALS_FILE: credFile,
    FLEET_BIND_HOST: '127.0.0.1', FLEET_PORT: '0',
    FLEET_API_TOKENS: opts.apiTokens ?? `${CALLER_TOKEN}:alice:box-1`,
    FLEET_ADMIN_TOKEN: ADMIN_TOKEN, FLEET_PROBE_TIMEOUT_MS: '1500',
  });
  const { db } = openFleetDb(config.dbPath);
  const logger = createLogger(createRedactor([]), 'error');
  const svc = createFleetServer({ db, config, credentials: loadCredentials(credFile), logger });
  const addr = await svc.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (method: string, path: string, o: { token?: string; body?: unknown } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
                 ...(o.body ? { 'content-type': 'application/json' } : {}) },
      ...(o.body ? { body: JSON.stringify(o.body) } : {}),
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json: json as any };
  };
  return { base, svc, db, call, close: async () => { await svc.close(); db.close(); } };
}

test('/healthz is public, everything else is not', async () => {
  const s = await startService();
  try {
    assert.equal((await s.call('GET', '/healthz')).status, 200);
    assert.equal((await s.call('GET', '/fleet/hosts')).status, 401, 'no token');
    assert.equal((await s.call('GET', '/fleet/hosts', { token: 'wrong-token' })).status, 401);
    assert.equal((await s.call('GET', '/fleet/hosts', { token: CALLER_TOKEN })).status, 200);
  } finally { await s.close(); }
});

test('registry writes need the admin token, and a caller token gets 403 not 401', async () => {
  const s = await startService();
  try {
    const body = { id: 'box-1', baseUrl: 'http://127.0.0.1:1', credentialRef: 'lan-ref' };
    const asCaller = await s.call('POST', '/fleet/hosts', { token: CALLER_TOKEN, body });
    assert.equal(asCaller.status, 403, 'authenticated but not permitted');
    assert.equal((await s.call('POST', '/fleet/hosts', { token: ADMIN_TOKEN, body })).status, 201);
  } finally { await s.close(); }
});

test('a scoped caller sees only its own hosts', async () => {
  const s = await startService({ apiTokens: `${CALLER_TOKEN}:alice:box-1,other:carol:box-2` });
  try {
    for (const id of ['box-1', 'box-2']) {
      assert.equal((await s.call('POST', '/fleet/hosts',
        { token: ADMIN_TOKEN, body: { id, baseUrl: 'http://127.0.0.1:1', credentialRef: 'lan-ref' } })).status, 201);
    }
    const alice = await s.call('GET', '/fleet/hosts', { token: CALLER_TOKEN });
    assert.deepEqual(alice.json.hosts.map((h: { id: string }) => h.id), ['box-1']);
    const admin = await s.call('GET', '/fleet/hosts', { token: ADMIN_TOKEN });
    assert.equal(admin.json.hosts.length, 2);
  } finally { await s.close(); }
});

test('registering an unknown credential ref fails at registration, not at first probe', async () => {
  const s = await startService();
  try {
    const r = await s.call('POST', '/fleet/hosts', {
      token: ADMIN_TOKEN, body: { id: 'box-1', baseUrl: 'http://127.0.0.1:1', credentialRef: 'typo-ref' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /unknown credential ref/);
  } finally { await s.close(); }
});

test('probe reports a live child with capacity and agents', async () => {
  const child = await fakeMercury();
  const s = await startService();
  try {
    assert.equal((await s.call('POST', '/fleet/hosts',
      { token: ADMIN_TOKEN, body: { id: 'box-1', baseUrl: child.url, credentialRef: 'lan-ref' } })).status, 201);
    const r = await s.call('POST', '/fleet/hosts/box-1/probe', { token: ADMIN_TOKEN, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.probe.outcome, 'ok');
    assert.equal(r.json.probe.activeRuns, 1);
    assert.equal(r.json.probe.queueDepth, 2);
    assert.deepEqual(r.json.probe.agents, ['prime-agent']);
  } finally { await s.close(); await child.close(); }
});

test('unknown route, bad JSON and malformed body are each reported distinctly', async () => {
  const s = await startService();
  try {
    assert.equal((await s.call('GET', '/fleet/nope', { token: ADMIN_TOKEN })).status, 404);
    // Deleting a host that exists, then confirming it is gone. Asserting only "ghost -> 404" passed even
    // while the route handler was passing `undefined` to the registry, because an unknown id and a missing
    // id both 404 -- the positive case is what proves the id reached the registry.
    await s.call('POST', '/fleet/hosts',
      { token: ADMIN_TOKEN, body: { id: 'doomed', baseUrl: 'http://127.0.0.1:1', credentialRef: 'lan-ref' } });
    assert.equal((await s.call('DELETE', '/fleet/hosts/doomed', { token: ADMIN_TOKEN })).status, 200);
    const after = await s.call('GET', '/fleet/hosts', { token: ADMIN_TOKEN });
    assert.deepEqual(after.json.hosts.map((h: { id: string }) => h.id), []);
    assert.equal((await s.call('DELETE', '/fleet/hosts/ghost', { token: ADMIN_TOKEN })).status, 404);
    const res = await fetch(`${s.base}/fleet/hosts`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: 'not json',
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /not valid JSON/);
    const missing = await s.call('POST', '/fleet/hosts', { token: ADMIN_TOKEN, body: { id: 'x' } });
    assert.equal(missing.status, 400);
    // Which required field is reported first is an implementation detail; that a required-field error is
    // reported as 400 rather than 500 is the contract.
    assert.match(missing.json.error, /is required and must be a non-empty string/);
  } finally { await s.close(); }
});

test('a caller token never reaches a child: only the registry credential is used', async () => {
  // The two credential boundaries must not be conflated (design 15.3). The child accepts only CHILD_SECRET;
  // if Fleet forwarded the caller token the probe would report auth-fail.
  let seenAuth = '';
  const child = createServer((req, res) => {
    if (req.url === '/api/agents') seenAuth = String(req.headers.authorization ?? '');
    const ok = req.url === '/healthz' || req.url === '/healthz/workers' || req.url === '/api/agents';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/healthz/workers' ? { workers: [], queueDepth: 0 } : { agents: [], ok: true }));
  });
  await new Promise<void>((r) => child.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(child.address() as AddressInfo).port}`;
  const s = await startService();
  try {
    await s.call('POST', '/fleet/hosts', { token: ADMIN_TOKEN, body: { id: 'box-1', baseUrl: url, credentialRef: 'lan-ref' } });
    const r = await s.call('POST', '/fleet/hosts/box-1/probe', { token: ADMIN_TOKEN, body: {} });
    assert.equal(r.json.probe.outcome, 'ok');
    assert.equal(seenAuth, `Bearer ${CHILD_SECRET}`, 'the child must see the registry credential, never the caller token');
  } finally { await s.close(); await new Promise<void>((r) => child.close(() => r())); }
});

test('an oversized request body is rejected rather than buffered', async () => {
  // Without a bound, one request per connection is a memory-exhaustion route on a service whose whole job
  // is to be always-on.
  const s = await startService();
  try {
    const huge = { id: 'x', baseUrl: 'http://127.0.0.1:1', credentialRef: 'lan-ref', pad: 'a'.repeat(1_100_000) };
    const res = await fetch(`${s.base}/fleet/hosts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(huge),
    });
    assert.equal(res.status, 413);
    assert.match(((await res.json()) as { error: string }).error, /exceeds/);
  } finally { await s.close(); }
});

test('a route parameter reaches the registry, not undefined', async () => {
  // The handler used to read the wrong index of the captures array, so the id arrived undefined and the
  // registry raised a SQLite bind error that surfaced as a 500. A 404 on a made-up id cannot catch that.
  const s = await startService();
  try {
    await s.call('POST', '/fleet/hosts',
      { token: ADMIN_TOKEN, body: { id: 'named-host', baseUrl: 'http://127.0.0.1:1', credentialRef: 'lan-ref' } });
    const off = await s.call('POST', '/fleet/hosts/named-host/enable', { token: ADMIN_TOKEN, body: { enabled: false } });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal(off.json.host.enabled, false, 'the enable must have applied to THAT host');
    const missing = await s.call('POST', '/fleet/hosts/no-such-host/enable', { token: ADMIN_TOKEN, body: {} });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /no such host/);
  } finally { await s.close(); }
});

test('no response ever carries a secret', async () => {
  const s = await startService();
  try {
    const r = await s.call('POST', '/fleet/hosts', {
      token: ADMIN_TOKEN, body: { id: 'box-1', baseUrl: 'http://127.0.0.1:1', credentialRef: 'typo' } });
    const text = JSON.stringify(r.json);
    assert.ok(!text.includes(CHILD_SECRET), text);
    assert.ok(!text.includes(CALLER_TOKEN), text);
    assert.ok(!text.includes(ADMIN_TOKEN), text);
  } finally { await s.close(); }
});

test('binding beyond loopback without TLS is refused at startup', () => {
  const base = { FLEET_CREDENTIALS_FILE: '/nope', FLEET_ADMIN_TOKEN: 'x' };
  assert.throws(() => assertServeable(loadConfig({ ...base, FLEET_BIND_HOST: '0.0.0.0' })),
    /without TLS/);
  assert.doesNotThrow(() => assertServeable(loadConfig({ ...base, FLEET_BIND_HOST: '127.0.0.1' })));
  assert.throws(() => assertServeable(loadConfig({ ...base, FLEET_BIND_HOST: '0.0.0.0', FLEET_TLS_CERT: '/c' })),
    /both be set or both unset/);
  // With no caller tokens at all the service would reject everything and look broken rather than insecure.
  assert.throws(() => assertServeable(loadConfig({ FLEET_CREDENTIALS_FILE: '/nope' })),
    /no caller tokens configured/);
});

test('close() stops the prober so the process can exit', async () => {
  const s = await startService();
  try {
    assert.equal(s.svc.prober.running, true, 'listen() starts the sweep');
  } finally { await s.close(); }
  assert.equal(s.svc.prober.running, false);
});

test('close() stops the reconciliation sweeper too', async () => {
  // The sweeper is a second long-lived timer, and a timer left running after close() is the difference between
  // a clean `systemctl stop` and a SIGKILL at the timeout. The prober assertion above does not cover it:
  // they are independent handles with independent lifecycles.
  const s = await startService();
  try {
    assert.notEqual(s.svc.sweeper, null, 'listen() starts reconciliation');
    assert.equal(typeof s.svc.sweeper!.running, 'boolean');
  } finally { await s.close(); }
  assert.equal(s.svc.sweeper, null, 'close() releases the handle so nothing can fire after shutdown');
});

test('the mirrored event window is readable through Fleet, scoped to the caller', async () => {
  // Seeded directly: this test is about Fleet's own read path and authorization, and driving a real child
  // through a full Run would test Phase 2 again rather than this route.
  const s = await startService();
  try {
    const { db } = s;
    db.prepare(
      `INSERT INTO hosts (id, base_url, credential_ref, enabled, labels, local_paths, agents_cache, added_at)
       VALUES ('box-1', 'http://127.0.0.1:1', 'lan-ref', 1, '{}', '[]', '[]', ?)`,
    ).run(new Date().toISOString());
    db.prepare(
      `INSERT INTO fleet_runs (fleet_run_id, host_id, owner_id, child_run_id, requested, created_at)
       VALUES ('fr_evt_1', 'box-1', 'alice', 'run_1', '{}', ?)`,
    ).run(new Date().toISOString());
    const ins = db.prepare('INSERT INTO fleet_events (fleet_run_id, sequence, type, timestamp, payload) VALUES (?,?,?,?,?)');
    for (let i = 1; i <= 5; i++) ins.run('fr_evt_1', i, 'run.log', '2026-01-01T00:00:00.000Z', null);

    const ok = await s.call('GET', '/fleet/runs/fr_evt_1/events?after=2', { token: CALLER_TOKEN });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.events.map((e: any) => e.sequence), [3, 4, 5], 'resumes from the cursor');
    assert.equal(ok.json.nextCursor, 5);
    assert.equal(ok.json.hasMore, false);
    assert.equal(ok.json.events[0].payload, undefined, 'metadata only unless the host opted into bodies');

    const capped = await s.call('GET', '/fleet/runs/fr_evt_1/events?limit=2', { token: CALLER_TOKEN });
    assert.equal(capped.json.events.length, 2);
    assert.equal(capped.json.hasMore, true, 'a partial page must say more exists');

    // A caller scoped to box-1 may not read a run on another host, and must not learn it exists on a host
    // it can see either way.
    db.prepare(
      `INSERT INTO hosts (id, base_url, credential_ref, enabled, labels, local_paths, agents_cache, added_at)
       VALUES ('other', 'http://127.0.0.1:1', 'lan-ref', 1, '{}', '[]', '[]', ?)`,
    ).run(new Date().toISOString());
    db.prepare(
      `INSERT INTO fleet_runs (fleet_run_id, host_id, owner_id, child_run_id, requested, created_at)
       VALUES ('fr_evt_2', 'other', 'bob', 'run_2', '{}', ?)`,
    ).run(new Date().toISOString());
    assert.equal((await s.call('GET', '/fleet/runs/fr_evt_2/events', { token: CALLER_TOKEN })).status, 403);
    assert.equal((await s.call('GET', '/fleet/runs/fr_nope/events', { token: CALLER_TOKEN })).status, 404);
    assert.equal((await s.call('GET', '/fleet/runs/fr_evt_1/events')).status, 401);
  } finally { await s.close(); }
});

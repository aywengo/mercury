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

test('nonsense pagination parameters fall back instead of reaching the database', async () => {
  const s = await startService();
  try {
    const { db } = s;
    db.prepare(
      `INSERT INTO hosts (id, base_url, credential_ref, enabled, labels, local_paths, agents_cache, added_at)
       VALUES ('box-1', 'http://127.0.0.1:1', 'lan-ref', 1, '{}', '[]', '[]', ?)`,
    ).run(new Date().toISOString());
    db.prepare(
      `INSERT INTO fleet_runs (fleet_run_id, host_id, owner_id, child_run_id, requested, created_at)
       VALUES ('fr_q_1', 'box-1', 'alice', 'run_1', '{}', ?)`,
    ).run(new Date().toISOString());
    const ins = db.prepare('INSERT INTO fleet_events (fleet_run_id, sequence, type, timestamp, payload) VALUES (?,?,?,?,?)');
    for (let i = 1; i <= 6; i++) ins.run('fr_q_1', i, 'run.log', '2026-01-01T00:00:00.000Z', null);

    // Infinity is truthy, so the usual `|| 0` fallback would have let it through to a SQLite bind.
    for (const q of ['after=Infinity', 'limit=2.5', 'limit=-5', 'after=abc', 'after=-1', 'limit=0', 'after=', 'limit=1e309']) {
      const r = await s.call('GET', `/fleet/runs/fr_q_1/events?${q}`, { token: CALLER_TOKEN });
      assert.equal(r.status, 200, `${q} must fall back rather than error`);
      assert.ok(Array.isArray(r.json.events), `${q} returned no event array`);
      for (const e of r.json.events) {
        assert.ok(Number.isInteger(e.sequence), `${q} produced a non-integer sequence`);
      }
    }
    // A valid cursor still works alongside the guards.
    const ok = await s.call('GET', '/fleet/runs/fr_q_1/events?after=4&limit=1', { token: CALLER_TOKEN });
    assert.deepEqual(ok.json.events.map((e: any) => e.sequence), [5]);
    assert.equal(ok.json.hasMore, true);
  } finally { await s.close(); }
});

test('a huge limit is capped rather than pulling the whole transcript', async () => {
  // The cap only exists to bound one caller's memory, and a cap no test exercises is a comment.
  const s = await startService();
  try {
    const { db } = s;
    db.prepare(
      `INSERT INTO hosts (id, base_url, credential_ref, enabled, labels, local_paths, agents_cache, added_at)
       VALUES ('box-1', 'http://127.0.0.1:1', 'lan-ref', 1, '{}', '[]', '[]', ?)`,
    ).run(new Date().toISOString());
    db.prepare(
      `INSERT INTO fleet_runs (fleet_run_id, host_id, owner_id, child_run_id, requested, created_at)
       VALUES ('fr_cap_1', 'box-1', 'alice', 'run_1', '{}', ?)`,
    ).run(new Date().toISOString());
    const ins = db.prepare('INSERT INTO fleet_events (fleet_run_id, sequence, type, timestamp, payload) VALUES (?,?,?,?,?)');
    for (let i = 1; i <= 1001; i++) ins.run('fr_cap_1', i, 'run.log', '2026-01-01T00:00:00.000Z', null);

    const r = await s.call('GET', '/fleet/runs/fr_cap_1/events?limit=99999', { token: CALLER_TOKEN });
    assert.equal(r.json.events.length, 1000, 'the request must be bounded regardless of what was asked for');
    assert.equal(r.json.hasMore, true, 'and must say the rest is still there');
    assert.equal(r.json.nextCursor, 1000);
  } finally { await s.close(); }
});

/** Seed a host, a binding, a cached state row and a mirrored event window. The caller picks the run id. */
function seedStreamableRun(db: DatabaseSync, opts: {
  id: string; hostId?: string; status?: string; events?: number; drained?: boolean;
}): void {
  const hostId = opts.hostId ?? 'box-1';
  db.prepare(
    `INSERT OR IGNORE INTO hosts (id, base_url, credential_ref, enabled, labels, local_paths, agents_cache, added_at)
     VALUES (?, 'http://127.0.0.1:1', 'lan-ref', 1, '{}', '[]', '[]', ?)`,
  ).run(hostId, new Date().toISOString());
  db.prepare(
    `INSERT INTO fleet_runs (fleet_run_id, host_id, owner_id, child_run_id, requested, created_at)
     VALUES (?, ?, 'alice', 'run_1', '{}', ?)`,
  ).run(opts.id, hostId, new Date().toISOString());
  db.prepare(
    `INSERT INTO run_state (fleet_run_id, status, cursor, last_seen_at, last_error, events_drained)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(opts.id, opts.status ?? 'RUNNING', opts.events ?? 0, new Date().toISOString(), opts.drained ? 1 : 0);
  const ins = db.prepare('INSERT INTO fleet_events (fleet_run_id, sequence, type, timestamp, payload) VALUES (?,?,?,?,?)');
  for (let i = 1; i <= (opts.events ?? 0); i++) {
    ins.run(opts.id, i, 'run.log', '2026-01-01T00:00:00.000Z', null);
  }
}

/** Read SSE frames until `until` matches or the deadline passes. */
async function readSse(url: string, token: string, until: (frames: any[]) => boolean, ms = 6000) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const frames: any[] = [];
  const reader = (res.body as any).getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const race = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r('timeout'), Math.max(50, deadline - Date.now()))),
    ]);
    if (race === 'timeout') break;
    const { done, value } = race as { done: boolean; value?: Uint8Array };
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /^event: (.+)$/m.exec(raw)?.[1];
      const data = /^data: (.+)$/m.exec(raw)?.[1];
      if (ev) frames.push({ event: ev, data: data ? JSON.parse(data) : null });
    }
    if (until(frames)) break;
  }
  reader.cancel().catch(() => {});
  return { status: res.status, frames };
}

test('the SSE stream delivers mirrored events and ends on a drained terminal Run', async () => {
  const s = await startService();
  try {
    seedStreamableRun(s.db, { id: 'fr_sse_1', status: 'COMPLETED', events: 4, drained: true });
    const { status, frames } = await readSse(
      `${s.base}/fleet/runs/fr_sse_1/stream`, CALLER_TOKEN,
      (f) => f.some((x) => x.event === 'done'),
    );
    assert.equal(status, 200);
    const ids = frames.filter((f) => f.event === 'event').map((f) => f.data.sequence);
    assert.deepEqual(ids, [1, 2, 3, 4], 'the backlog arrives in order');
    assert.ok(frames.some((f) => f.event === 'snapshot'), 'the client is told where it stands');
    const done = frames.find((f) => f.event === 'done');
    assert.ok(done, 'a finished, drained Run ends the stream rather than holding it open');
    assert.equal(done.data.status, 'COMPLETED');
  } finally { await s.close(); }
});

test('?after resumes without replaying what the client already has', async () => {
  const s = await startService();
  try {
    seedStreamableRun(s.db, { id: 'fr_sse_2', status: 'COMPLETED', events: 6, drained: true });
    const { frames } = await readSse(
      `${s.base}/fleet/runs/fr_sse_2/stream?after=4`, CALLER_TOKEN,
      (f) => f.some((x) => x.event === 'done'),
    );
    const ids = frames.filter((f) => f.event === 'event').map((f) => f.data.sequence);
    assert.deepEqual(ids, [5, 6], 'the cursor is the resume point, exactly as on the poll path');
  } finally { await s.close(); }
});

test('a live Run keeps the stream open and receives events as they are mirrored', async () => {
  const s = await startService();
  try {
    seedStreamableRun(s.db, { id: 'fr_sse_3', status: 'RUNNING', events: 1 });
    const got = readSse(`${s.base}/fleet/runs/fr_sse_3/stream`, CALLER_TOKEN,
      (f) => f.filter((x) => x.event === 'event').length >= 3);
    // Let the stream attach before appending, so this proves live delivery rather than backlog replay.
    await new Promise((r) => setTimeout(r, 300));
    const ins = s.db.prepare('INSERT INTO fleet_events (fleet_run_id, sequence, type, timestamp, payload) VALUES (?,?,?,?,?)');
    ins.run('fr_sse_3', 2, 'run.output', new Date().toISOString(), null);
    ins.run('fr_sse_3', 3, 'run.output', new Date().toISOString(), null);
    const { frames } = await got;
    const ids = frames.filter((f) => f.event === 'event').map((f) => f.data.sequence);
    assert.deepEqual(ids, [1, 2, 3], 'events mirrored after connect arrive on the open stream');
    assert.ok(!frames.some((f) => f.event === 'done'), 'a live Run must not end the stream');
  } finally { await s.close(); }
});

test('the stream is scoped and authenticated like every other read', async () => {
  const s = await startService();
  try {
    seedStreamableRun(s.db, { id: 'fr_sse_4', status: 'COMPLETED', events: 1, drained: true });
    seedStreamableRun(s.db, { id: 'fr_sse_5', hostId: 'other', status: 'COMPLETED', events: 1, drained: true });
    const noAuth = await fetch(`${s.base}/fleet/runs/fr_sse_4/stream`);
    assert.equal(noAuth.status, 401);
    assert.equal((await fetch(`${s.base}/fleet/runs/fr_nope/stream`,
      { headers: { authorization: `Bearer ${CALLER_TOKEN}` } })).status, 404);
    assert.equal((await fetch(`${s.base}/fleet/runs/fr_sse_5/stream`,
      { headers: { authorization: `Bearer ${CALLER_TOKEN}` } })).status, 403);
  } finally { await s.close(); }
});

test('a finished Run that still owes its log keeps the stream open', async () => {
  // Terminal and drained are different questions. A Run can be COMPLETED with its event log unread -- the
  // exact state the drain flag exists to notice. Ending the stream here would tell the client it had seen
  // everything when it had seen nothing.
  const s = await startService();
  try {
    seedStreamableRun(s.db, { id: 'fr_sse_6', status: 'COMPLETED', events: 2, drained: false });
    const { frames } = await readSse(
      `${s.base}/fleet/runs/fr_sse_6/stream`, CALLER_TOKEN,
      (f) => f.some((x) => x.event === 'done'),
      2500,
    );
    assert.deepEqual(frames.filter((f) => f.event === 'event').map((f) => f.data.sequence), [1, 2]);
    assert.ok(!frames.some((f) => f.event === 'done'),
      'a terminal Run with an undrained log must not claim the stream is finished');
  } finally { await s.close(); }
});

/** Register a host with declared local paths and labels, bypassing the admin API to keep the test focused. */
function seedHost(db: DatabaseSync, id: string, opts: { localPaths?: string[]; labels?: Record<string, string> } = {}): void {
  db.prepare(
    `INSERT INTO hosts (id, base_url, credential_ref, enabled, labels, local_paths, agents_cache, added_at, mirror_bodies)
     VALUES (?, ?, 'lan-ref', 1, ?, ?, '["claude"]', ?, 0)`,
  ).run(id, `http://${id}:1`, JSON.stringify(opts.labels ?? {}), JSON.stringify(opts.localPaths ?? []),
    new Date().toISOString());
}

test('routing places work without the caller naming a host', async () => {
  const s = await startService({ apiTokens: `${CALLER_TOKEN}:alice:*` });
  try {
    seedHost(s.db, 'laptop', { localPaths: ['/Users/roman/devops/mercury'] });
    seedHost(s.db, 'gpu-box', { localPaths: ['/srv/other'] });
    const r = await s.call('POST', '/fleet/runs', {
      token: CALLER_TOKEN,
      body: { task: 'fix tests', repository: { localPath: '/Users/roman/devops/mercury' } },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.hostId, 'laptop', 'the only host that declares the path');
  } finally { await s.close(); }
});

test('an unroutable localPath is refused with every host accounted for', async () => {
  const s = await startService({ apiTokens: `${CALLER_TOKEN}:alice:*` });
  try {
    seedHost(s.db, 'laptop', { localPaths: ['/elsewhere'] });
    seedHost(s.db, 'gpu-box', { localPaths: [] });
    const r = await s.call('POST', '/fleet/runs', {
      token: CALLER_TOKEN, body: { task: 'x', repository: { localPath: '/nowhere' } },
    });
    assert.equal(r.status, 400);
    assert.ok(Array.isArray(r.json.details), 'the response must carry the exclusions, not just a sentence');
    const ids = r.json.details.map((d: any) => d.hostId).sort();
    assert.deepEqual(ids, ['gpu-box', 'laptop']);
    assert.ok(r.json.details.every((d: any) => typeof d.reason === 'string' && d.reason.length > 0));
    // Nothing was written: a refused submission leaves no binding behind.
    const list = await s.call('GET', '/fleet/runs', { token: CALLER_TOKEN });
    assert.equal(list.json.runs.length, 0);
  } finally { await s.close(); }
});

test('routing can only place work on hosts the caller may see', async () => {
  // The router is fed the caller-visible set, so a hidden host cannot be reached by omitting `host` even
  // though it is the better machine.
  const s = await startService();  // scoped to box-1
  try {
    seedHost(s.db, 'box-1');
    seedHost(s.db, 'secret-box');
    const r = await s.call('POST', '/fleet/runs', { token: CALLER_TOKEN, body: { task: 'x' } });
    assert.equal(r.status, 201);
    assert.equal(r.json.hostId, 'box-1');
  } finally { await s.close(); }
});

test('a caller cannot route onto a host outside their allowlist by naming it', async () => {
  const s = await startService();
  try {
    seedHost(s.db, 'box-1');
    seedHost(s.db, 'secret-box');
    const r = await s.call('POST', '/fleet/runs', {
      token: CALLER_TOKEN, body: { task: 'x', host: 'secret-box' },
    });
    // 404 rather than 403, matching how Mercury scopes Runs: confirming that a hidden host exists is itself
    // a leak. The caller learns "no such host", which is all they are entitled to know.
    assert.equal(r.status, 404);
    assert.match(r.json.error, /not registered/);
  } finally { await s.close(); }
});

// --- Phase 5 interaction routes, driven through HTTP -----------------------------------------------
//
// These exist because the unit tests for dispatch called submitRun directly and never crossed the HTTP
// boundary, which is exactly where a real defect lived: DispatchError was unmapped and answered 500.

test('an unknown Fleet Run is a 404 through HTTP, not a 500', async () => {
  const s = await startService();
  try {
    for (const verb of ['input', 'cancel', 'retry']) {
      const r = await s.call('POST', `/fleet/runs/fr_missing/${verb}`, { token: CALLER_TOKEN, body: { input: 'x' } });
      assert.equal(r.status, 404, `${verb} on an unknown run must not be a server fault`);
    }
  } finally { await s.close(); }
});

test('a DispatchError reaches the caller with its own status, not 500', async () => {
  // A Run whose dispatch never got an answer has no child to act on. That is a 409 the caller can act on --
  // resubmit, or wait -- and it is raised as a DispatchError deep in the interaction layer, so it is the path
  // that proves the error mapping covers that type. Without the mapping it answers 500 and sends the operator
  // to logs for something their own request can fix.
  const s = await startService();
  try {
    const add = await s.call('POST', '/fleet/hosts', {
      token: ADMIN_TOKEN,
      body: { id: 'box-1', baseUrl: 'http://127.0.0.1:1', credentialRef: 'lan-ref' },
    });
    assert.equal(add.status, 201);
    const { BindingStore } = await import('../bindings.ts');
    new BindingStore(s.db).createPending({
      fleetRunId: 'fr_pending', hostId: 'box-1', ownerId: 'alice', requested: {},
    });
    const r = await s.call('POST', '/fleet/runs/fr_pending/cancel', { token: CALLER_TOKEN });
    assert.equal(r.status, 409, 'a pending dispatch is a conflict, not a server fault');
    assert.match(String(r.json.error), /no child Run yet/);
  } finally { await s.close(); }
});

test('a caller may not act on a Run bound to a host they cannot see', async () => {
  const s = await startService();
  try {
    // box-1 is the only host the CALLER token may see; register a different one as admin.
    const add = await s.call('POST', '/fleet/hosts', {
      token: ADMIN_TOKEN,
      body: { id: 'elsewhere', baseUrl: 'http://127.0.0.1:1', credentialRef: 'lan-ref' },
    });
    assert.equal(add.status, 201);
    const { BindingStore } = await import('../bindings.ts');
    new BindingStore(s.db).createPending({
      fleetRunId: 'fr_hidden', hostId: 'elsewhere', ownerId: 'alice', requested: {},
    });
    const r = await s.call('POST', '/fleet/runs/fr_hidden/cancel', { token: CALLER_TOKEN });
    assert.equal(r.status, 403, 'acting must be scoped as tightly as reading');
  } finally { await s.close(); }
});

test('the input body is forwarded without inventing or swallowing a value', async () => {
  // Records exactly what the child receives, so the wrapper rules are proven rather than asserted in a unit
  // test that calls the unwrapper directly.
  const received: unknown[] = [];
  const child = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if ((req.url ?? '').endsWith('/input')) received.push(JSON.parse(raw).input);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runId: 'run_1', status: 'QUEUED' }));
    });
  });
  await new Promise<void>((r) => child.listen(0, '127.0.0.1', r));
  const s = await startService();
  try {
    const { port } = child.address() as AddressInfo;
    const add = await s.call('POST', '/fleet/hosts', {
      token: ADMIN_TOKEN,
      body: { id: 'box-1', baseUrl: `http://127.0.0.1:${port}`, credentialRef: 'lan-ref' },
    });
    assert.equal(add.status, 201);
    const { BindingStore } = await import('../bindings.ts');
    new BindingStore(s.db).createPending({
      fleetRunId: 'fr_in', hostId: 'box-1', ownerId: 'alice', requested: {},
    });
    // Bind it: the routes refuse to act on a Run with no child yet.
    s.db.prepare('UPDATE fleet_runs SET child_run_id = ? WHERE fleet_run_id = ?').run('child_1', 'fr_in');

    const cases: Array<[unknown, unknown, string]> = [
      [{ input: { answer: 'go' } }, { answer: 'go' }, 'the wrapper is unwrapped'],
      [{ input: null }, null, 'an explicit null is a real value, not a missing key'],
      ['plain text', 'plain text', 'a bare string is valid JSON and reaches the child as-is'],
      [42, 42, 'a bare number likewise'],
      [{ answer: 'no wrapper' }, { answer: 'no wrapper' }, 'an unwrapped object passes through'],
    ];
    for (const [sent, expected, why] of cases) {
      received.length = 0;
      const r = await s.call('POST', '/fleet/runs/fr_in/input', { token: CALLER_TOKEN, body: sent });
      assert.equal(r.status, 200, `${why} -- status`);
      assert.deepEqual(received[0], expected, why);
    }
  } finally {
    await s.close();
    await new Promise<void>((r) => { child.closeAllConnections?.(); child.close(() => r()); });
  }
});

// --- Phase 6: metrics rollup -----------------------------------------------------------------------

test('/metrics requires authentication', async () => {
  const s = await startService();
  try {
    const r = await fetch(s.base + '/metrics');
    assert.equal(r.status, 401);
  } finally { await s.close(); }
});

test('/metrics exposes only the hosts a caller may see', async () => {
  // The aggregate leaks queue depth, run counts and worker topology. A caller scoped to one host must not read
  // another host's numbers out of a summary endpoint that never checks who is asking.
  const s = await startService();
  try {
    for (const [id, port] of [['box-1', 1], ['elsewhere', 2]] as Array<[string, number]>) {
      const add = await s.call('POST', '/fleet/hosts', {
        token: ADMIN_TOKEN,
        body: { id, baseUrl: `http://127.0.0.1:${port}`, credentialRef: 'lan-ref' },
      });
      assert.equal(add.status, 201);
    }
    const scoped = await fetch(s.base + '/metrics', { headers: { authorization: `Bearer ${CALLER_TOKEN}` } });
    assert.equal(scoped.status, 200);
    const scopedText = await scoped.text();
    assert.match(scopedText, /host="box-1"/, 'the caller sees its own host');
    assert.doesNotMatch(scopedText, /host="elsewhere"/, 'and not the other one');

    const admin = await fetch(s.base + '/metrics', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    const adminText = await admin.text();
    assert.match(adminText, /host="box-1"/);
    assert.match(adminText, /host="elsewhere"/, 'an admin sees the whole fleet');
    // Both hosts are unreachable here, which is exactly the case that must be visible rather than absent.
    assert.match(adminText, /mercury_fleet_scrape_success\{host="box-1"\} 0/);
  } finally { await s.close(); }
});

test('/metrics is served as Prometheus text, not JSON', async () => {
  const s = await startService();
  try {
    const r = await fetch(s.base + '/metrics', { headers: { authorization: `Bearer ${CALLER_TOKEN}` } });
    assert.match(r.headers.get('content-type') ?? '', /text\/plain/);
    assert.match(r.headers.get('content-type') ?? '', /version=0\.0\.4/);
  } finally { await s.close(); }
});

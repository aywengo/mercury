import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openFleetDb } from '../db.ts';
import { probeAndRecord } from '../probe.ts';
import { HostRegistry, RegistryError, normalizeBaseUrl } from '../registry.ts';

function fresh() {
  const { db } = openFleetDb(':memory:');
  return { db, registry: new HostRegistry(db) };
}

/** Every value in every row of every table. A leak anywhere shows up here, not just in one column. */
function dumpAll(db: DatabaseSync): string {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .flatMap((row) => (db.prepare(`SELECT * FROM "${row.name}"`).all() as unknown[]))
    .map((row) => JSON.stringify(row))
    .join('\n');
}

test('add stores the credential NAME, not the secret', () => {
  const { registry } = fresh();
  registry.add({ id: 'box-1', baseUrl: 'http://127.0.0.1:3000', credentialRef: 'lan-token' });
  assert.equal(registry.get('box-1')!.credentialRef, 'lan-token');
});

/**
 * The guarantee that actually matters, and the reason this is not asserted on `add` alone.
 *
 * An earlier version of this test declared a secret, added a host with only its NAME, and asserted the
 * secret was absent from the database. Copilot correctly called that vacuous: the registry never receives
 * the secret, so the assertion could not fail for any value of the code under test.
 *
 * The path where a secret really is in hand is the probe: it holds the resolved token, and it writes
 * `detail` and `last_error` text that a future change could build out of a failing request's headers. So
 * the test puts a token in play, drives a real probe against a host that rejects it, and then reads the
 * whole database back.
 */
test('a token in play during a probe never reaches the database', async () => {
  const TOKEN = 'tok-live-abc123-must-never-be-stored';
  const server = createServer((req, res) => {
    // Only /api/agents rejects. A server that 401s everything fails the liveness check first, and the probe
    // never reaches the credential path this test is about.
    const authed = req.url === '/api/agents';
    res.writeHead(authed ? 401 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(authed ? { error: 'authentication required' }
      : req.url === '/healthz/workers' ? { workers: [], queueDepth: 0 } : { ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const { db, registry } = fresh();
  try {
    registry.add({ id: 'box-1', baseUrl: `http://127.0.0.1:${port}`, credentialRef: 'lan-token' });
    const rec = await probeAndRecord({
      hostId: 'box-1', baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, timeoutMs: 1000,
    });
    registry.recordProbe(rec);
    assert.equal(rec.outcome, 'unauthorized', 'the probe must have actually run and failed on auth');
    const dump = dumpAll(db);
    assert.ok(dump.includes('lan-token'), 'the ref should be present, so the dump is not empty by accident');
    assert.ok(!dump.includes(TOKEN), 'the resolved token must never be persisted');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
});

test('base url is normalized and validated', () => {
  assert.equal(normalizeBaseUrl('https://host:3000/'), 'https://host:3000');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3000///'), 'http://127.0.0.1:3000');
  assert.throws(() => normalizeBaseUrl('ftp://host'), /must be http or https/);
  assert.throws(() => normalizeBaseUrl('not a url'), /not a valid URL/);
  // Embedded credentials would put the secret in a table that has no 0600 protection.
  assert.throws(() => normalizeBaseUrl('https://user:tok@host:3000'), /must not embed credentials/);
});

test('duplicate ids are refused because bindings refer to hosts by id', () => {
  const { registry } = fresh();
  registry.add({ id: 'box-1', baseUrl: 'http://a:1', credentialRef: 'r' });
  assert.throws(() => registry.add({ id: 'box-1', baseUrl: 'http://b:2', credentialRef: 'r' }), RegistryError);
  assert.equal(registry.get('box-1')!.baseUrl, 'http://a:1', 'the first record must survive');
});

test('host ids are constrained to stable slugs', () => {
  const { registry } = fresh();
  for (const bad of ['Box-1', 'has space', '-lead', 'trail-', '', 'x'.repeat(70), 'semi;colon']) {
    assert.throws(() => registry.add({ id: bad, baseUrl: 'http://a:1', credentialRef: 'r' }),
      /not usable/, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  for (const good of ['a', 'mac-studio', 'box-lan-2', 'host.internal']) {
    registry.add({ id: good, baseUrl: 'http://a:1', credentialRef: 'r' });
  }
  assert.equal(registry.list().length, 4);
});

test('local paths must be absolute, since they describe the worker filesystem', () => {
  const { registry } = fresh();
  assert.throws(
    () => registry.add({ id: 'b', baseUrl: 'http://a:1', credentialRef: 'r', localPaths: ['repos/mercury'] }),
    /not absolute/,
  );
  const h = registry.add({ id: 'b', baseUrl: 'http://a:1', credentialRef: 'r', localPaths: ['/Users/x/mercury'] });
  assert.deepEqual(h.localPaths, ['/Users/x/mercury']);
});

test('labels round-trip and enable/disable persists', () => {
  const { registry } = fresh();
  registry.add({ id: 'gpu-1', baseUrl: 'http://a:1', credentialRef: 'r',
    labels: { gpu: 'true', repo: 'mercury' }, enabled: false });
  const h = registry.get('gpu-1')!;
  assert.deepEqual(h.labels, { gpu: 'true', repo: 'mercury' });
  assert.equal(h.enabled, false);
  assert.equal(registry.setEnabled('gpu-1', true).enabled, true);
  assert.equal(registry.get('gpu-1')!.enabled, true);
  assert.throws(() => registry.setEnabled('ghost', true), /no such host/);
});

test('last_seen_at advances only on a successful probe', () => {
  const { registry } = fresh();
  registry.add({ id: 'b', baseUrl: 'http://a:1', credentialRef: 'r' });
  const base = { hostId: 'b', detail: null, activeRuns: null, queueDepth: null, workerCount: null,
    workerId: null, agents: null, lastError: null };

  registry.recordProbe({ ...base, outcome: 'unauthorized', probedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(registry.get('b')!.lastSeenAt, null, 'a 401 does not prove the host was alive');
  assert.equal(registry.probeFor('b')!.outcome, 'unauthorized', 'but the failure is still recorded');

  registry.recordProbe({ ...base, outcome: 'ok', agents: ['prime-agent'], probedAt: '2026-01-01T00:01:00.000Z' });
  assert.equal(registry.get('b')!.lastSeenAt, '2026-01-01T00:01:00.000Z');
  assert.deepEqual(registry.get('b')!.agentsCache, ['prime-agent']);

  // A later failure must not rewind last_seen_at: it records when we last KNEW it was alive.
  registry.recordProbe({ ...base, outcome: 'unreachable', probedAt: '2026-01-01T00:02:00.000Z' });
  assert.equal(registry.get('b')!.lastSeenAt, '2026-01-01T00:01:00.000Z');
  assert.equal(registry.probeFor('b')!.outcome, 'unreachable');
});

test('probe cache is rebuilt in place, not appended to', () => {
  const { db, registry } = fresh();
  registry.add({ id: 'b', baseUrl: 'http://a:1', credentialRef: 'r' });
  const base = { hostId: 'b', detail: null, activeRuns: 1, queueDepth: 0, workerCount: 1,
    workerId: 'w', agents: [], lastError: null };
  registry.recordProbe({ ...base, outcome: 'ok', probedAt: '2026-01-01T00:00:00.000Z' });
  registry.recordProbe({ ...base, outcome: 'ok', probedAt: '2026-01-01T00:01:00.000Z' });
  const rows = db.prepare('SELECT COUNT(*) AS n FROM host_probe').get() as { n: number };
  assert.equal(Number(rows.n), 1, 'one row per host, updated in place');
});

test('removing a host cascades its cache row', () => {
  const { db, registry } = fresh();
  registry.add({ id: 'b', baseUrl: 'http://a:1', credentialRef: 'r' });
  registry.recordProbe({ hostId: 'b', outcome: 'ok', detail: null, activeRuns: 0, queueDepth: 0,
    workerCount: 1, workerId: 'w', agents: [], probedAt: new Date().toISOString(), lastError: null });
  assert.equal(registry.remove('b'), true);
  assert.equal(registry.remove('b'), false);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM host_probe').get() as { n: number }).n, 0);
});

test('recordProbe refuses an unknown host instead of writing an orphan', () => {
  const { registry } = fresh();
  assert.throws(() => registry.recordProbe({ hostId: 'ghost', outcome: 'ok', detail: null, activeRuns: null,
    queueDepth: null, workerCount: null, workerId: null, agents: null,
    probedAt: new Date().toISOString(), lastError: null }), /unknown host/);
});

test('migrations apply once per database file, not once per open', () => {
  // The first version of this test called openFleetDb(':memory:') twice and compared the results. Each call
  // makes a brand-new database, so it proved only that a fresh database applies migration 1 -- never that a
  // REOPEN leaves an applied migration alone, which is the behaviour that matters once Phase 1 adds one.
  const dir = mkdtempSync(join(tmpdir(), 'fleet-db-'));
  const path = join(dir, 'fleet.db');
  const first = openFleetDb(path);
  try {
    assert.deepEqual(first.appliedVersions, [1]);
    new HostRegistry(first.db).add({ id: 'b', baseUrl: 'http://a:1', credentialRef: 'r' });
  } finally {
    first.db.close();
  }

  const second = openFleetDb(path);
  try {
    assert.deepEqual(second.appliedVersions, [], 'a reopen must not re-apply migration 1');
    assert.equal(new HostRegistry(second.db).get('b')?.baseUrl, 'http://a:1', 'data must survive the reopen');
  } finally {
    second.db.close();
  }

  // A third open stays quiet too, so the version bookkeeping is durable rather than cached.
  const third = openFleetDb(path);
  try {
    assert.deepEqual(third.appliedVersions, []);
  } finally {
    third.db.close();
  }
});

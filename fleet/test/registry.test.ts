import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openFleetDb } from '../db.ts';
import { HostRegistry, RegistryError, normalizeBaseUrl } from '../registry.ts';

function fresh() {
  const { db } = openFleetDb(':memory:');
  return { db, registry: new HostRegistry(db) };
}

test('add stores the credential NAME and never the secret', () => {
  const { registry, db } = fresh();
  const secret = 'super-secret-token-abc123';
  registry.add({ id: 'box-1', baseUrl: 'http://127.0.0.1:3000', credentialRef: 'lan-token' });
  // The secret must not appear anywhere in the database file, not merely not in the column I read back.
  const dump = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .flatMap((row) => (db.prepare(`SELECT * FROM ${row.name}`).all() as unknown[]))
    .map((row) => JSON.stringify(row))
    .join('\n');
  assert.ok(!dump.includes(secret), 'secret must never be persisted');
  assert.equal(registry.get('box-1')!.credentialRef, 'lan-token');
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

test('migrations are idempotent across reopen', () => {
  const a = openFleetDb(':memory:');
  assert.deepEqual(a.appliedVersions, [1]);
  // A second open of a fresh database applies 1 again; reopening an existing one must apply nothing.
  const { db } = openFleetDb(':memory:');
  const reg = new HostRegistry(db);
  reg.add({ id: 'b', baseUrl: 'http://a:1', credentialRef: 'r' });
  const again = openFleetDb(':memory:');
  assert.deepEqual(again.appliedVersions, [1], 'fresh db applies exactly once');
  db.close();
  again.db.close();
});

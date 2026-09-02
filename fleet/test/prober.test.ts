import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openFleetDb } from '../db.ts';
import { HostRegistry } from '../registry.ts';
import { createProber } from '../prober.ts';

async function fake(urlPath: string, body: unknown, opts: { status?: number; delayMs?: number } = {}) {
  const server = createServer((req, res) => {
    const serve = () => {
      const isTarget = req.url === urlPath;
      res.writeHead(isTarget ? (opts.status ?? 200) : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(isTarget ? body : { ok: true }));
    };
    if (opts.delayMs) setTimeout(serve, opts.delayMs);
    else serve();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const CRED = { 'good-ref': 'tok' };

test('a sweep probes enabled hosts and writes the cache', async () => {
  const healthy = await fake('/healthz/workers', { workers: [{ workerId: 'w', activeRuns: 1 }], queueDepth: 0 });
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  try {
    registry.add({ id: 'live', baseUrl: healthy.url, credentialRef: 'good-ref' });
    const prober = createProber({
      registry, resolveToken: (r) => { const s = CRED[r as keyof typeof CRED]; if (!s) throw new Error('unknown'); return s; },
      intervalMs: 10_000, timeoutMs: 1000,
    });
    const results = await prober.sweepOnce();
    assert.equal(results.length, 1);
    assert.equal(results[0]!.outcome, 'ok');
    assert.equal(registry.probeFor('live')!.outcome, 'ok');
    assert.equal(registry.get('live')!.lastSeenAt, results[0]!.probedAt);
  } finally { await healthy.close(); db.close(); }
});

test('disabled hosts are never probed', async () => {
  const healthy = await fake('/healthz/workers', { workers: [], queueDepth: 0 });
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  try {
    registry.add({ id: 'off', baseUrl: healthy.url, credentialRef: 'good-ref', enabled: false });
    const prober = createProber({ registry, resolveToken: () => 'tok', intervalMs: 10_000, timeoutMs: 1000 });
    assert.equal((await prober.sweepOnce()).length, 0);
    assert.equal(registry.probeFor('off'), null, 'a disabled host must not gain a cache row');
  } finally { await healthy.close(); db.close(); }
});

test('an unresolvable credential ref is recorded without contacting the host', async () => {
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  try {
    // Port 1 is not going to answer, so a contact attempt would show up as unreachable rather than auth-fail.
    registry.add({ id: 'typo', baseUrl: 'http://127.0.0.1:1', credentialRef: 'missing-ref' });
    const prober = createProber({
      registry, resolveToken: () => { throw new Error('unknown credential ref "missing-ref"'); },
      intervalMs: 10_000, timeoutMs: 500,
    });
    const [rec] = await prober.sweepOnce();
    assert.equal(rec!.outcome, 'unauthorized');
    assert.match(rec!.detail ?? '', /Host not contacted/);
  } finally { db.close(); }
});

test('overlapping sweeps do not stack up', async () => {
  const slow = await fake('/healthz/workers', { workers: [], queueDepth: 0 }, { delayMs: 120 });
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  try {
    registry.add({ id: 'slow', baseUrl: slow.url, credentialRef: 'good-ref' });
    const prober = createProber({ registry, resolveToken: () => 'tok', intervalMs: 10_000, timeoutMs: 2000 });
    const [a, b] = await Promise.all([prober.sweepOnce(), prober.sweepOnce()]);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0]!.probedAt, b[0]!.probedAt, 'the second caller joins the in-flight sweep instead of starting another');
  } finally { await slow.close(); db.close(); }
});

test('start schedules sweeps and stop cancels them', async () => {
  const healthy = await fake('/healthz/workers', { workers: [], queueDepth: 0 });
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  const prober = createProber({ registry, resolveToken: () => 'tok', intervalMs: 40, timeoutMs: 1000 });
  try {
    registry.add({ id: 'tick', baseUrl: healthy.url, credentialRef: 'good-ref' });
    assert.equal(prober.running, false);
    prober.start();
    prober.start(); // idempotent: a second start must not schedule a second timer
    assert.equal(prober.running, true);
    await new Promise((r) => setTimeout(r, 150));
    const row = registry.probeFor('tick');
    assert.ok(row, 'the timer must have swept at least once');
    prober.stop();
    assert.equal(prober.running, false);
    const at = row!.probedAt;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(registry.probeFor('tick')!.probedAt, at, 'stop() must actually stop the timer');
  } finally {
    prober.stop();
    db.close();
    await healthy.close();
  }
});

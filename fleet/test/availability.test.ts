import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openFleetDb } from '../db.ts';
import { HostRegistry } from '../registry.ts';
import { createProber } from '../prober.ts';
import { loadConfig } from '../config.ts';

/**
 * FB0 (#970) regression tests: the per-host availability snapshot and its read-only view.
 *
 * The fake host answers every path 200 by default, so each test names only the paths it wants to
 * misbehave -- the same shape as the fake Mercury in probe.test.ts.
 */
interface Routes {
  [path: string]: { status?: number; body?: unknown };
}

async function fakeHost(routes: Routes = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const route = routes[req.url ?? ''];
    res.writeHead(route?.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(
      req.url === '/healthz/workers'
        ? { workers: [{ workerId: 'w1', activeRuns: 0 }], queueDepth: 0 }
        : req.url === '/api/agents' ? { agents: ['prime-agent'] }
        : route?.body ?? {},
    ));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function makeProber(registry: HostRegistry) {
  return createProber({
    registry, resolveToken: () => 'tok', intervalMs: 10_000, timeoutMs: 1000,
  });
}

const TWO_PRESETS = {
  presets: [
    { id: 'reviewer', role: 'reviewer', version: '1.2.0', enabled: true, contentHash: 'hash-a' },
    { id: 'implementer', role: 'implementer', version: '2.0.0', enabled: false, contentHash: 'hash-b' },
  ],
};

test('a probe of a host with two presets stores both, with versions and hashes', async () => {
  const host = await fakeHost({ '/api/presets': { body: TWO_PRESETS } });
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  try {
    registry.add({ id: 'box', baseUrl: host.url, credentialRef: 'ref' });
    const prober = makeProber(registry);
    const results = await prober.sweepOnce();
    assert.equal(results[0]!.outcome, 'ok', 'the availability read must not degrade the probe outcome');
    const snap = registry.availabilityFor('box');
    assert.ok(snap, 'a successful probe stores a snapshot');
    assert.deepEqual(snap.presets, [
      { id: 'reviewer', version: '1.2.0', enabled: true, contentHash: 'hash-a' },
      { id: 'implementer', version: '2.0.0', enabled: false, contentHash: 'hash-b' },
    ]);
    assert.equal(snap.stale, false);
  } finally { await host.close(); db.close(); }
});

test('a failed presets read leaves the previous snapshot in place, marked stale, never empty', async () => {
  // Mutable so the second sweep can point /api/presets at a failure while the host itself stays up:
  // a host Fleet can reach but whose availability read failed is exactly the "could not see" case.
  const routes: Routes = { '/api/presets': { body: TWO_PRESETS } };
  const host = await fakeHost(routes);
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  try {
    registry.add({ id: 'box', baseUrl: host.url, credentialRef: 'ref' });
    assert.equal((await makeProber(registry).sweepOnce())[0]!.outcome, 'ok');
    assert.equal(registry.availabilityFor('box')!.presets.length, 2);

    routes['/api/presets'] = { status: 500, body: { error: 'boom' } };
    const second = await makeProber(registry).sweepOnce();
    assert.equal(second[0]!.outcome, 'ok', 'a failed availability read does not fail the probe');
    const snap = registry.availabilityFor('box');
    assert.ok(snap, 'a failed read must not delete the snapshot');
    assert.equal(snap!.presets.length, 2, 'the previous preset list is kept, never emptied');
    assert.equal(snap!.stale, true, 'the failed read marks the snapshot stale');
  } finally { await host.close(); db.close(); }
});

test('a partial read (workflows failing, presets fine) keeps the previous workflows and marks stale', async () => {
  const routes: Routes = {
    '/api/presets': { body: TWO_PRESETS },
    '/api/workflows': { body: { workflows: [{ id: 'wf', version: '1.0.0', enabled: true, contentHash: 'h' }] } },
  };
  const host = await fakeHost(routes);
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  try {
    registry.add({ id: 'box', baseUrl: host.url, credentialRef: 'ref' });
    await makeProber(registry).sweepOnce();
    assert.equal(registry.availabilityFor('box')!.workflows!.length, 1);

    routes['/api/workflows'] = { status: 500, body: { error: 'boom' } };
    await makeProber(registry).sweepOnce();
    const snap = registry.availabilityFor('box');
    assert.equal(snap!.presets.length, 2, 'the successful half still refreshes');
    assert.equal(snap!.workflows!.length, 1, 'the failed half keeps the previous value');
    assert.equal(snap!.stale, true);
  } finally { await host.close(); db.close(); }
});

test('a host answering 404 on /api/workflows has workflows: null and still probes healthy', async () => {
  // Default fake answers unknown paths 404 already; make it explicit.
  const host = await fakeHost({ '/api/workflows': { status: 404, body: { error: 'not found' } } });
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  try {
    registry.add({ id: 'box', baseUrl: host.url, credentialRef: 'ref' });
    const results = await makeProber(registry).sweepOnce();
    assert.equal(results[0]!.outcome, 'ok');
    const snap = registry.availabilityFor('box');
    assert.ok(snap);
    assert.equal(snap.workflows, null);
    assert.equal(snap.stale, false, 'a 404 is "not served", not a failed read');
  } finally { await host.close(); db.close(); }
});

test('an unreachable host does not mark the snapshot stale by itself', async () => {
  // A credential that cannot be resolved contacts nothing; the snapshot must keep its stale flag
  // from the last real read rather than flip on a sweep that never reached the host.
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  try {
    registry.add({ id: 'box', baseUrl: 'http://127.0.0.1:1', credentialRef: 'ref' });
    registry.recordAvailability('box', { presets: [], workflows: null, workflowsFailed: false }, new Date().toISOString());
    // Unknown ref -> sweep records unauthorized without contacting the host.
    const prober = createProber({
      registry,
      resolveToken: () => { throw new Error('unknown ref'); },
      intervalMs: 10_000, timeoutMs: 1000,
    });
    await prober.sweepOnce();
    const snap = registry.availabilityFor('box');
    assert.ok(snap);
    assert.equal(snap.stale, false, 'no contact means no new information about availability');
  } finally { db.close(); }
});

test('availabilityStaleMs defaults to 3x the probe interval (fleet-bots-design.md section 9.3)', () => {
  const config = loadConfig({ FLEET_PROBE_INTERVAL_MS: '10000' });
  assert.equal(config.availabilityStaleMs, 30_000);
  const explicit = loadConfig({ FLEET_PROBE_INTERVAL_MS: '10000', FLEET_AVAILABILITY_STALE_MS: '5000' });
  assert.equal(explicit.availabilityStaleMs, 5_000);
});

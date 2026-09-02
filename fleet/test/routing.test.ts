import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostView } from '../registry.ts';
import { routeRun, RoutingError } from '../routing.ts';

/**
 * Hosts are built as plain objects rather than through the registry. The router is pure over declared facts,
 * so the tests can state a fleet exactly and assert what the router SAID about each host -- which an
 * integration test through the registry could only observe indirectly.
 */
function host(id: string, over: Partial<HostView> = {}): HostView {
  return {
    id,
    baseUrl: `http://${id}:3000`,
    credentialRef: 'ref',
    enabled: true,
    labels: {},
    localPaths: [],
    agentsCache: ['claude'],
    addedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: null,
    probe: null,
    ...over,
  };
}
const ok = (over: Record<string, unknown> = {}) => ({
  hostId: 'x', outcome: 'ok', detail: null, activeRuns: 0, queueDepth: 0, workerCount: 1,
  workerId: 'w', agents: ['claude'], probedAt: '2026-01-01T00:00:00.000Z', lastError: null, ...over,
}) as HostView['probe'];

test('locality is a hard filter, and the rejected hosts say why', async () => {
  const hosts = [
    host('laptop', { localPaths: ['/Users/roman/devops/mercury'] }),
    host('gpu-box', { localPaths: ['/srv/other'] }),
  ];
  const d = routeRun(hosts, { repository: { localPath: '/Users/roman/devops/mercury' } });
  assert.equal(d.hostId, 'laptop');
  assert.deepEqual(d.considered, ['laptop', 'gpu-box']);
});

test('a declared path covers everything beneath it', async () => {
  const hosts = [host('laptop', { localPaths: ['/Users/roman/devops/mercury'] })];
  const d = routeRun(hosts, { repository: { localPath: '/Users/roman/devops/mercury/src/api' } });
  assert.equal(d.hostId, 'laptop');
  // Trailing slashes must not defeat the comparison.
  assert.equal(routeRun(hosts, { repository: { localPath: '/Users/roman/devops/mercury/' } }).hostId, 'laptop');
});

test('no matching host is a submission error naming every host and reason', async () => {
  // Section 6: not a scheduling wait. Silence here costs an hour of confusion.
  const hosts = [
    host('laptop', { localPaths: ['/elsewhere'] }),
    host('gpu', { localPaths: [] }),
    host('retired', { enabled: false, localPaths: ['/repo'] }),
  ];
  const err = (() => {
    try {
      routeRun(hosts, { repository: { localPath: '/repo' } });
      return null;
    } catch (e) {
      return e as RoutingError;
    }
  })();
  assert.ok(err instanceof RoutingError, 'must reject rather than queue');
  assert.equal(err!.status, 400);
  assert.equal(err!.exclusions.length, 3, 'every considered host is accounted for');
  const byId = Object.fromEntries(err!.exclusions.map((e) => [e.hostId, e.reason]));
  assert.match(byId.laptop, /does not declare \/repo/);
  assert.match(byId.gpu, /none declared/);
  assert.equal(byId.retired, 'disabled');
  assert.match(err!.message, /Declare the path on a host/);
});

test('a known clone URL removes the locality constraint', async () => {
  const hosts = [host('cloud', { localPaths: [] })];
  const d = routeRun(hosts, { repository: { localPath: '/repo' } },
    { resolveCloneUrl: (p) => (p === '/repo' ? 'https://github.com/o/r.git' : null) });
  assert.equal(d.hostId, 'cloud');
  assert.equal(d.rewroteLocalPath, true);
  assert.equal(d.repository?.url, 'https://github.com/o/r.git');
  assert.equal(d.repository?.localPath, undefined, 'the local path must not survive the rewrite');
});

test('a caller-supplied url needs no resolver and constrains nothing', async () => {
  const hosts = [host('cloud', { localPaths: [] })];
  const d = routeRun(hosts, { repository: { url: 'https://github.com/o/r.git', localPath: '/repo' } });
  assert.equal(d.hostId, 'cloud');
  assert.equal(d.rewroteLocalPath, false, 'nothing was rewritten; the caller already gave a URL');
});

test('the agent filter prefers a fresh probe over the advisory cache', async () => {
  const hosts = [
    host('stale-cache', { agentsCache: ['claude', 'codex'], probe: ok({ agents: ['claude'] }) }),
    host('fresh', { agentsCache: ['claude'], probe: ok({ agents: ['claude', 'codex'] }) }),
  ];
  const d = routeRun(hosts, { agent: 'codex' });
  assert.equal(d.hostId, 'fresh', 'the cached list is advisory and must not win against a live answer');
  const err = (() => {
    try { routeRun([hosts[0]], { agent: 'codex' }); return null; } catch (e) { return e as RoutingError; }
  })();
  assert.match(err!.exclusions[0].reason, /does not offer agent "codex"/);
});

test('label selectors exclude with the pairs that failed', async () => {
  const hosts = [
    host('a', { labels: { tier: 'gpu', region: 'eu' } }),
    host('b', { labels: { tier: 'cpu' } }),
  ];
  assert.equal(routeRun(hosts, { labels: { tier: 'gpu' } }).hostId, 'a');
  const err = (() => {
    try { routeRun(hosts, { labels: { tier: 'gpu', region: 'us' } }); return null; }
    catch (e) { return e as RoutingError; }
  })();
  // 'a' matches tier but not region; 'b' matches neither.
  assert.equal(err!.exclusions.length, 2);
  assert.match(err!.exclusions[0].reason, /needs region=us/);
  assert.match(err!.exclusions[1].reason, /needs tier=gpu, region=us/);
});

test('capacity breaks ties but never overrides a hard filter', async () => {
  const hosts = [
    host('busy', { probe: ok({ activeRuns: 4, queueDepth: 3, workerCount: 2 }) }),
    host('idle', { probe: ok({ activeRuns: 0, queueDepth: 0, workerCount: 2 }) }),
  ];
  assert.equal(routeRun(hosts, {}).hostId, 'idle');
  // An unprobed host is neutral, not free: it must not look like the emptiest machine in the fleet.
  // The busy/idle pair above cannot show this, because 'idle' scores 0 and ties with a mutated unprobed score
  // of 0, and the id tie-break then picks 'idle' for an unrelated reason. Here the known host carries real
  // load, so choosing the unknown one is only possible if unknown is scored as free.
  const loaded = host('known-loaded', { probe: ok({ activeRuns: 1, queueDepth: 0, workerCount: 1 }) });
  const withUnknown = [host('aaa-never-probed'), loaded];
  assert.equal(routeRun(withUnknown, {}).hostId, 'known-loaded',
    'a host nobody has probed must not beat one that is measurably busy');
});

test('an explicit host wins without scoring', async () => {
  const hosts = [
    host('busy', { probe: ok({ activeRuns: 9, queueDepth: 9 }) }),
    host('idle', { probe: ok() }),
  ];
  assert.equal(routeRun(hosts, { host: 'busy' }).hostId, 'busy');
});

test('an explicit host that cannot take the work is an error, not a fallback', async () => {
  const hosts = [host('off', { enabled: false }), host('on')];
  const disabled = (() => {
    try { routeRun(hosts, { host: 'off' }); return null; } catch (e) { return e as RoutingError; }
  })();
  assert.equal(disabled!.status, 409);
  const missing = (() => {
    try { routeRun(hosts, { host: 'typo' }); return null; } catch (e) { return e as RoutingError; }
  })();
  assert.equal(missing!.status, 404);
  assert.match(missing!.message, /Known hosts: off, on/);
});

test('an empty fleet is refused before any filtering', async () => {
  assert.throws(() => routeRun([], {}), /no hosts are registered/);
});

test('malformed routing input is a 400 rather than a crash inside a filter', async () => {
  // Each of these used to reach a string method on a non-string and surface as a 500, which sends the operator
  // to the service logs for a mistake sitting in their own request body.
  const hosts = [host('a', { localPaths: ['/repo'] })];
  const bad: Array<[string, unknown]> = [
    ['repository.localPath', { repository: { localPath: 123 } }],
    ['repository.url', { repository: { url: '' } }],
    ['repository as array', { repository: [] }],
    ['repository as string', { repository: '/repo' }],
    ['labels as array', { labels: ['tier=gpu'] }],
    ['labels value non-string', { labels: { tier: 4 } }],
    ['agent non-string', { agent: 7 }],
    ['host non-string', { host: {} }],
  ];
  for (const [label, req] of bad) {
    let err: RoutingError | null = null;
    try { routeRun(hosts, req as never); } catch (e) { err = e as RoutingError; }
    assert.ok(err, `${label} must be rejected`);
    assert.equal(err!.status, 400, `${label} must be a client error, got ${err!.status}`);
  }
});

test('the rewrite also applies when the caller names a host', async () => {
  // Naming a host removes locality as a filter, but a localPath the child does not have still fails -- as a
  // Run failure, which is the worse place to learn it.
  const hosts = [host('cloud', { localPaths: [] })];
  const d = routeRun(hosts, { host: 'cloud', repository: { localPath: '/repo' } },
    { resolveCloneUrl: (p) => (p === '/repo' ? 'https://github.com/o/r.git' : null) });
  assert.equal(d.rewroteLocalPath, true);
  assert.equal(d.repository?.url, 'https://github.com/o/r.git');
  assert.equal(d.repository?.localPath, undefined);
});

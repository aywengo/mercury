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


// --- knowledge freshness as a SOFT signal only (docs/knowledge-base.md section 14) ---------------

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const HOUR = 3_600_000;
const fresh = () => new Date(NOW - 60_000).toISOString();
const stale = () => new Date(NOW - 6 * HOUR).toISOString();
const opts = { knowledgeStaleMs: HOUR, now: () => NOW };

test('a stale host is ranked below a fresh one, and the decision says so', () => {
  // The ids are chosen so the ordinary tie-break picks the STALE host. Otherwise the fresh host would
  // win with the signal switched off too, and the test would pass against a scorer that ignores
  // knowledge entirely -- which is the same reason the "off" test below uses the same pair.
  const hosts = [
    host('a-stale', { probe: ok({ knowledgeEnabled: true, knowledgePullAt: stale() }) }),
    host('z-fresh', { probe: ok({ knowledgeEnabled: true, knowledgePullAt: fresh() }) }),
  ];
  const d = routeRun(hosts, {}, opts);
  assert.equal(d.hostId, 'z-fresh');
  assert.ok(d.softRankNote, 'a placement the signal decided must explain itself (section 4)');
  assert.match(d.softRankNote!, /a-stale/, 'the note must name the host it passed over');
});

test('ONE stale host still gets the work -- the signal never filters', async () => {
  // Section 14: "refusing to place work because a note is two minutes old would be a Run lost to a
  // cache". This is the invariant the whole feature hangs on, and it is the one a future
  // "optimisation" is most likely to break by turning the penalty into an exclusion.
  const hosts = [host('only-box', { probe: ok({ knowledgeEnabled: true, knowledgePullAt: stale() }) })];
  const d = routeRun(hosts, {}, opts);
  assert.equal(d.hostId, 'only-box');
  // And a fleet of nothing but stale hosts places too, rather than throwing like a hard filter would.
  const many = ['a', 'b'].map((id) => host(id, { probe: ok({ knowledgeEnabled: true, knowledgePullAt: stale() }) }));
  assert.ok(['a', 'b'].includes(routeRun(many, {}, opts).hostId));
});

test('the signal is off unless an operator turns it on', () => {
  // Default-off is load-bearing: this changes which machine a Run lands on, and nobody opts in by
  // upgrading Fleet. Same hosts as the test above, opposite expectation, so the pair together proves
  // the flag is what moves the decision and not something incidental in the fixture.
  const hosts = [
    host('a-stale', { probe: ok({ knowledgeEnabled: true, knowledgePullAt: stale() }) }),
    host('z-fresh', { probe: ok({ knowledgeEnabled: true, knowledgePullAt: fresh() }) }),
  ];
  const off = routeRun(hosts, {}, { now: () => NOW });
  assert.equal(off.hostId, 'a-stale', 'with the signal off, the tie breaks on id as it always did');
  assert.equal(off.softRankNote, null);
});

test('a host Fleet knows nothing about is never penalised', () => {
  // Four different kinds of ignorance, all of which must cost nothing. If any were read as stale,
  // upgrading Fleet or adding a host without an admin credential would quietly demote healthy machines.
  //
  // A FAILED PROBE is deliberately not in this list. It scores 1_000 for a reason that predates this
  // feature and has nothing to do with knowledge, so it belongs to the capacity rules and would only
  // muddy what "no opinion about knowledge" means.
  const unknowable: [string, Record<string, unknown>][] = [
    ['a-no-atlas', { knowledgeEnabled: false }],
    ['b-predates-route', { knowledgeEnabled: null, knowledgePullAt: null }],
    ['c-not-admin', { knowledgeEnabled: null, knowledgePullAt: null }],
    ['d-never-pulled', { knowledgeEnabled: true, knowledgePullAt: null }],
  ];
  for (const [id, over] of unknowable) {
    const hosts = [
      host(id, { probe: ok(over) }),
      host('z-fresh', { probe: ok({ knowledgeEnabled: true, knowledgePullAt: fresh() }) }),
    ];
    const d = routeRun(hosts, {}, opts);
    // Each id sorts before 'z-fresh', so the ignorant host wins on the ordinary tie-break unless a
    // penalty was wrongly applied. This assertion fails against a scorer that treats unknown as stale.
    assert.equal(d.hostId, id, `${id} was penalised for something Fleet could not have known`);
    assert.equal(d.softRankNote, null);
  }
});

test('a replica under the threshold is not stale', () => {
  const hosts = [
    host('a', { probe: ok({ knowledgeEnabled: true, knowledgePullAt: fresh() }) }),
    host('b', { probe: ok({ knowledgeEnabled: true, knowledgePullAt: new Date(NOW - 20 * 60_000).toISOString() }) }),
  ];
  const d = routeRun(hosts, {}, { knowledgeStaleMs: HOUR, now: () => NOW });
  assert.equal(d.hostId, 'a', 'both are fresh, so the tie-break must be the ordinary one');
  assert.equal(d.softRankNote, null, 'a note that fires when nothing was decided is noise at 3am');
});

test('the note appears only when the signal changed the winner', () => {
  // Both hosts stale: the signal is present and active but decides nothing, because it demotes both
  // equally. Reporting it anyway would train an operator to ignore the field.
  const hosts = [
    host('a', { probe: ok({ knowledgeEnabled: true, knowledgePullAt: stale() }) }),
    host('b', { probe: ok({ knowledgeEnabled: true, knowledgePullAt: stale() }) }),
  ];
  assert.equal(routeRun(hosts, {}, opts).softRankNote, null);
});

test('capacity still outranks freshness when the gap is real', () => {
  // The signal is a tiebreaker between comparable machines, not a licence to pile work onto an idle
  // box with old knowledge while a busy-but-fresh one sits there. It is one penalty, not a reordering.
  const hosts = [
    host('fresh-but-saturated', {
      probe: ok({ knowledgeEnabled: true, knowledgePullAt: fresh(), activeRuns: 40, queueDepth: 20, workerCount: 2 }),
    }),
    host('stale-but-idle', { probe: ok({ knowledgeEnabled: true, knowledgePullAt: stale() }) }),
  ];
  const d = routeRun(hosts, {}, opts);
  assert.equal(d.hostId, 'stale-but-idle');
});

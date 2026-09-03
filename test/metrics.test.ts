import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeServer, createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { collectMetrics } from '../src/metrics/collect.ts';
import { escapeLabelValue, renderPrometheus } from '../src/metrics/prometheus.ts';
import { EventStore } from '../src/events/eventStore.ts';
import { makeEnv, waitFor } from './helpers.ts';
import type { ErrorKind, RunStatus } from '../src/domain/types.ts';
import type { Express } from 'express';
import { ACTIVE_WORK_STATUSES, isTerminal, LEASE_HOLDING_STATUSES, STUCK_CANDIDATE_STATUSES, TERMINAL_STATUSES } from '../src/domain/stateMachine.ts';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const MIN = 60_000;

/**
 * Seed a run with exact timestamps.
 *
 * Inserted through RunStore so the row goes through the real persistence path, then the timestamp
 * columns are set directly: the whole point of these tests is the arithmetic over those columns,
 * and driving them through the worker would mean sleeping for minutes to produce a known duration.
 */
function seedRun(
  env: ReturnType<typeof makeEnv>,
  over: Partial<{
    id: string; status: RunStatus; agent: string; errorKind: ErrorKind;
    created: number; started: number | null; completed: number | null;
    leaseOwner: string | null; leaseExpires: number | null;
  }>,
): void {
  const id = over.id ?? `run-${Math.random().toString(36).slice(2, 10)}`;
  env.runs.insert({
    id,
    ownerId: 'alice',
    task: 't',
    repository: { path: '/tmp/repo', ref: 'main' } as never,
    workspaceBranch: null,
    workspacePath: null,
    agent: over.agent ?? 'fake',
    status: over.status ?? 'QUEUED',
    attempt: 1,
    retryOf: null,
    error: null,
    errorKind: over.errorKind ?? null,
    constraints: { maxDurationMs: 1000, maxRetries: 0 },
    createdAt: iso(over.created ?? 0),
    startedAt: over.started === null || over.started === undefined ? null : iso(over.started),
    completedAt: over.completed === null || over.completed === undefined ? null : iso(over.completed),
    leaseOwner: over.leaseOwner ?? null,
    leaseExpiresAt: over.leaseExpires === null || over.leaseExpires === undefined ? null : iso(over.leaseExpires),
    cancellationRequestedAt: null,
    finalCommits: [],
    prUrl: null,
  });
}

function parse(body: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of body.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (m) out.set(m[1], Number(m[2]));
  }
  return out;
}

/**
 * Look up a sample by metric name + labels, independent of label ORDER.
 *
 * The renderer sorts labels (so output is stable and diffable) and Prometheus treats label order
 * as insignificant. Hardcoding one order in a test would assert a formatting detail that carries
 * no meaning, and would break the moment the sort changed.
 */
function get(m: Map<string, number>, name: string, labels: Record<string, string> = {}): number | undefined {
  const key = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
  const sel = key.length === 0 ? '' : `{${key.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
  return m.get(`${name}${sel}`);
}

function makeMetricsApp(env: ReturnType<typeof makeEnv>, tokens: [string, string][] = [['tok-alice', 'alice']]) {
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    queue: env.queue,
    db: env.db,
    apiTokens: new Map(tokens),
    adminToken: null,
  });
  // Returns the stream so a test can drive real subscriptions and then scrape what the endpoint
  // reports about them. Without this the /metrics wiring is untested: the unit tests call
  // collectMetrics directly, so deleting `eventStream: deps.stream.metrics()` from the route would
  // leave every one of them green while the endpoint silently stopped exporting the series.
  return { app, stream, close: () => stream.stop() };
}

async function listen(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

test('/metrics requires authentication', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const { app, close } = makeMetricsApp(env);
    const srv = await listen(app);
    try {
      const anon = await fetch(`http://127.0.0.1:${srv.port}/metrics`);
      assert.equal(anon.status, 401, 'an unauthenticated scrape must not read operational metrics');
      const bad = await fetch(`http://127.0.0.1:${srv.port}/metrics`, { headers: { authorization: 'Bearer nope' } });
      assert.equal(bad.status, 401);
      const ok = await fetch(`http://127.0.0.1:${srv.port}/metrics`, { headers: { authorization: 'Bearer tok-alice' } });
      assert.equal(ok.status, 200);
      // Exact, not a substring match: Express's res.send() reorders the media parameters to
      // `charset=utf-8; version=0.0.4`, which is equivalent per RFC 2045 but not what the exposition
      // spec documents, and string-matching scrapers reject it.
      assert.equal(ok.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8',
        'the Content-Type must match the exposition format spec byte for byte');
    } finally {
      await srv.close();
      close();
    }
  } finally {
    env.close();
  }
});

test('/metrics reports run counts, durations and queue wait', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    // A 90-second COMPLETED run and a 400-second FAILED run.
    // Deliberately NOT on bucket boundaries. julianday() is float64 days (~100us resolution), so an
    // observation exactly on a boundary can compute to either side; see the note in collect.ts.
    seedRun(env, { id: 'ok', status: 'COMPLETED', created: 0, started: 10_000, completed: 100_000 });
    seedRun(env, { id: 'bad', status: 'FAILED', errorKind: 'infrastructure', created: 0, started: 4_000, completed: 404_000 });
    seedRun(env, { id: 'queued', status: 'QUEUED', created: 0, started: null, completed: null });

    const { app, close } = makeMetricsApp(env);
    const srv = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/metrics`, { headers: { authorization: 'Bearer tok-alice' } });
      const body = await res.text();
      const m = parse(body);

      assert.equal(get(m, 'mercury_runs_in_status', { status: 'COMPLETED' }), 1);
      assert.equal(get(m, 'mercury_runs_in_status', { status: 'FAILED' }), 1);
      assert.equal(get(m, 'mercury_runs_in_status', { status: 'QUEUED' }), 1);

      // 90s falls in the "<120" band and NOT in "<60"; 400s in "<600" and not "<300".
      assert.equal(get(m, 'mercury_run_duration_seconds_bucket', { status: 'COMPLETED', le: '60' }), 0);
      assert.equal(get(m, 'mercury_run_duration_seconds_bucket', { status: 'COMPLETED', le: '120' }), 1);
      assert.equal(get(m, 'mercury_run_duration_seconds_bucket', { status: 'FAILED', le: '300' }), 0);
      assert.equal(get(m, 'mercury_run_duration_seconds_bucket', { status: 'FAILED', le: '600' }), 1);
      assert.equal(get(m, 'mercury_run_duration_seconds_count', { status: 'COMPLETED' }), 1);

      // Queue wait: 10s and 4s. The 4s run is below le="5", the 10s run is not.
      assert.equal(get(m, 'mercury_run_queue_wait_seconds_count'), 2);
      assert.equal(get(m, 'mercury_run_queue_wait_seconds_bucket', { le: '5' }), 1);
      assert.equal(get(m, 'mercury_run_queue_wait_seconds_bucket', { le: '15' }), 2);
      // A band that must be empty is as important to assert as one that is not: an off-by-one in
      // the cumulative copy would fill it.
      assert.equal(get(m, 'mercury_run_queue_wait_seconds_bucket', { le: '1' }), 0);

      assert.equal(get(m, 'mercury_run_errors_total', { kind: 'infrastructure' }), 1);
      assert.equal(get(m, 'mercury_runs_total'), 3);
    } finally {
      await srv.close();
      close();
    }
  } finally {
    env.close();
  }
});

test('histogram buckets are cumulative and end at +Inf', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    seedRun(env, { id: 'a', status: 'COMPLETED', created: 0, started: 0, completed: 2_000 });
    seedRun(env, { id: 'b', status: 'COMPLETED', created: 0, started: 0, completed: 200_000 });
    const snap = collectMetrics(env.db);
    const h = snap.durationByStatus.get('COMPLETED');
    assert.ok(h, 'expected a duration histogram for COMPLETED');

    const counts = [...h.buckets.values()];
    // Non-decreasing is the definition of cumulative; a per-band (non-cumulative) export would
    // make Prometheus undercount every quantile.
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i] >= counts[i - 1], `bucket ${i} (${counts[i]}) < bucket ${i - 1} (${counts[i - 1]}): not cumulative`);
    }
    assert.equal([...h.buckets.keys()].at(-1), '+Inf', 'the +Inf bucket is mandatory');
    assert.equal(h.buckets.get('+Inf'), h.count);
    assert.equal(h.count, 2);
  } finally {
    env.close();
  }
});

test('lease gauge is omitted when nothing is claimed, and reports the soonest expiry', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const empty = collectMetrics(env.db, { leases: [], now: T0 });
    assert.equal(empty.leaseExpiresInSeconds, null);
    const body = renderPrometheus(empty);
    // Exporting 0 here would read as "a lease is expiring right now" and page someone.
    assert.ok(!body.includes('mercury_lease_expires_in_seconds'), 'must be absent, not zero');

    const snap = collectMetrics(env.db, {
      now: T0,
      leases: [
        { workerId: 'w1', activeRuns: 2, oldestLeaseExpiresAt: iso(30_000) },
        { workerId: 'w2', activeRuns: 1, oldestLeaseExpiresAt: iso(90_000) },
      ],
    });
    assert.equal(snap.workers, 2);
    assert.equal(snap.claimedRuns, 3);
    // The SOONEST expiry, not the latest: that is the one worth alerting on.
    assert.equal(snap.leaseExpiresInSeconds, 30);
  } finally {
    env.close();
  }
});

test('sandbox enablement counts distinct runs, not events', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    seedRun(env, { id: 's1', status: 'COMPLETED', created: 0, started: 0, completed: 1000 });
    seedRun(env, { id: 's2', status: 'COMPLETED', created: 0, started: 0, completed: 1000 });
    // Two sandbox events for one run must count as ONE enabled run.
    env.events.append('s1', 'sandbox.enabled', { policy: 'docker' });
    env.events.append('s1', 'sandbox.enabled', { policy: 'docker' });
    env.events.append('s2', 'sandbox.enabled', { policy: 'docker' });

    const snap = collectMetrics(env.db);
    assert.equal(snap.sandboxEnabled, 2, 'COUNT(DISTINCT run_id) must collapse repeat events');
    assert.equal(snap.runsTotal, 2);
  } finally {
    env.close();
  }
});

test('label values are escaped so a value cannot forge metric lines', () => {
  assert.equal(escapeLabelValue('plain'), 'plain');
  assert.equal(escapeLabelValue('a"b'), 'a\\"b');
  assert.equal(escapeLabelValue('a\\b'), 'a\\\\b');
  assert.equal(escapeLabelValue('a\nb'), 'a\\nb');

  // The injection this prevents: an unescaped quote closes the label early and the remainder
  // becomes a new metric line that Prometheus will trust.
  const evil = 'x",le="1}\nmercury_runs_total 9999';
  const rendered = renderPrometheus({
    runsByStatus: { [evil]: 1 },
    durationByStatus: new Map(),
    queueWait: { buckets: new Map([['+Inf', 0]]), sum: 0, count: 0 },
    errorsByKind: {},
    sandboxEnabled: 0,
    runsTotal: 0,
    workers: 0,
    claimedRuns: 0,
    leaseExpiresInSeconds: null,
  });
  const lines = rendered.trim().split('\n');
  const samples = lines.filter((l) => l && !l.startsWith('#'));
  assert.ok(!samples.some((l) => l === 'mercury_runs_total 9999'), 'injected line must not appear as a real sample');
  // Count SAMPLE lines, not raw occurrences: the metric's own # HELP and # TYPE lines legitimately
  // name it, and an earlier version of this assertion counted those too and failed on correct code.
  assert.equal(samples.filter((l) => l.startsWith('mercury_runs_total')).length, 1,
    'the injected text must not create a second series');
  assert.ok(samples.some((l) => l.startsWith('mercury_runs_in_status{')), 'the hostile status must still be emitted, escaped');
});

test('metrics output carries no unbounded label values', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    // A run id that would be visible if anything were labelled by id.
    seedRun(env, { id: 'CANARY-RUN-ID', status: 'COMPLETED', created: 0, started: 0, completed: 1000 });
    const body = renderPrometheus(collectMetrics(env.db));
    assert.ok(!body.includes('CANARY-RUN-ID'), 'run ids must never become label values (series cardinality)');
    assert.ok(!body.includes('alice'), 'owner ids must never become label values');
  } finally {
    env.close();
  }
});

test('histogram monotonicity precondition: nothing deletes runs', () => {
  // Prometheus rate()/increase() assume _count never decreases. That holds ONLY because runs are
  // append-only. If run retention is ever added, these histograms go backwards and every rate
  // alert silently starts lying -- so this is a precondition of the metrics design, not trivia.
  const src = join(import.meta.dirname, '..', 'src');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        const text = readFileSync(p, 'utf8').replace(/^\/\/.*$/gm, '');
        if (/DELETE\s+FROM\s+runs/i.test(text)) offenders.push(p);
      }
    }
  };
  walk(src);
  assert.deepEqual(offenders, [], `DELETE FROM runs would make mercury_run_duration_* non-monotonic: ${offenders.join(', ')}`);
});

test('migration adds the events(type) index the sandbox count needs', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const rows = env.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'").all() as { name: string }[];
    assert.ok(rows.some((r) => r.name === 'idx_events_type'), 'without this index the sandbox count full-scans events on every scrape');
    const plan = env.db
      .prepare("EXPLAIN QUERY PLAN SELECT COUNT(DISTINCT run_id) AS n FROM events WHERE type = 'sandbox.enabled'")
      .all() as { detail: string }[];
    assert.match(plan.map((p) => p.detail).join(' '), /idx_events_type/, 'planner must actually use the index');
  } finally {
    env.close();
  }
});

test('the exported label sets match the domain unions they mirror', () => {
  // collect.ts duplicates the RunStatus / ErrorKind value sets so it can declare every series at
  // zero on a fresh install. A duplicated set with no guard silently falls out of step the first
  // time someone adds a status, and the symptom is a missing series rather than an error.
  const collectSrc = readFileSync(join(import.meta.dirname, '..', 'src', 'metrics', 'collect.ts'), 'utf8');
  const typesSrc = readFileSync(join(import.meta.dirname, '..', 'src', 'domain', 'types.ts'), 'utf8');

  const unionValues = (name: string): string[] => {
    // \s* because RunStatus is written as a multi-line union (`=\n  | 'QUEUED'`), so the
    // character after `=` is a newline, not a space.
    const m = new RegExp(`export type ${name} =\\s*([^;]+);`).exec(typesSrc);
    assert.ok(m, `could not find "export type ${name}" in domain/types.ts -- the parser needs updating`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  const arrayValues = (name: string): string[] => {
    const m = new RegExp(`const ${name} = \\[[^\\]]*\\]`).exec(collectSrc);
    assert.ok(m, `could not find "const ${name}" in metrics/collect.ts`);
    return [...m[0].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };

  // RunStatus mirrors exactly.
  assert.deepEqual(arrayValues('RUN_STATUS_VALUES').sort(), unionValues('RunStatus').sort());

  // ErrorKind plus the 'unspecified' bucket the exporter adds for NULL error_kind.
  const kinds = unionValues('ErrorKind').filter((k) => k !== 'null');
  assert.deepEqual(arrayValues('ERROR_KIND_VALUES').sort(), [...kinds, 'unspecified'].sort());
});

test('every status and error kind is exported even when the database is empty', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const body = renderPrometheus(collectMetrics(env.db));
    for (const st of ['QUEUED', 'RUNNING', 'COMPLETED', 'TIMED_OUT']) {
      assert.match(body, new RegExp(`mercury_runs_in_status\\{status="${st}"\\} 0`), `${st} must be present at zero, not absent`);
    }
    for (const kind of ['infrastructure', 'agent', 'task']) {
      assert.match(body, new RegExp(`mercury_run_errors_total\\{kind="${kind}"\\} 0`), `${kind} must be present at zero`);
    }
  } finally {
    env.close();
  }
});

test('metric family names do not collide after Prometheus suffix normalisation', () => {
  // Prometheus derives a family name by STRIPPING the mandatory suffixes (_total on counters,
  // _bucket/_sum/_count on histograms). Two metrics whose names differ only by such a suffix are
  // the SAME family with conflicting TYPEs, and the whole scrape is rejected -- not just the one
  // metric. This is invisible to per-line assertions: every line is individually valid.
  //
  // It bit the first version of this exporter, which exposed a gauge `mercury_runs` alongside the
  // counter `mercury_runs_total`. The official prometheus_client parser reported the family
  // `mercury_runs` twice; a real Prometheus would have refused the scrape.
  const env = makeEnv({ workerEnabled: false });
  try {
    seedRun(env, { id: 'x', status: 'COMPLETED', created: 0, started: 1000, completed: 61_000 });
    const body = renderPrometheus(collectMetrics(env.db));

    const SUFFIXES = ['_total', '_bucket', '_sum', '_count'];
    const declared = new Map<string, string>(); // family -> TYPE
    const violations: string[] = [];

    for (const line of body.split('\n')) {
      if (line.startsWith('# TYPE ')) {
        const [, , name, type] = line.split(/\s+/);
        const family = SUFFIXES.reduce((n, suf) => (n.endsWith(suf) ? n.slice(0, -suf.length) : n), name);
        const prev = declared.get(family);
        if (prev && prev !== type) violations.push(`${family}: declared as both ${prev} and ${type}`);
        declared.set(family, type);
        continue;
      }
      if (!line || line.startsWith('#')) continue;
      const name = line.slice(0, line.search(/[\s{]/));
      const family = SUFFIXES.reduce((n, suf) => (n.endsWith(suf) ? n.slice(0, -suf.length) : n), name);
      const type = declared.get(family);
      if (!type) violations.push(`${name}: sample for undeclared family "${family}"`);
    }
    assert.deepEqual(violations, [], `exposition would be rejected: ${violations.join('; ')}`);
    assert.ok(declared.size >= 7, `expected the full metric set, saw ${declared.size} families`);
  } finally {
    env.close();
  }
});

test('a duration landing exactly on a bucket bound is counted in that bucket', () => {
  // Prometheus `le` is LESS THAN OR EQUAL. The first implementation used `d < bound`, which pushed
  // an on-bound observation one bucket up and under-counted every band. That was also untestable at
  // the time: julianday() is float64 days, so a clean 60s gap computed as 59.99999642372131 and
  // "exactly on the bound" was not expressible. strftime('%s') yields exact integer seconds, which
  // is what makes this assertion meaningful.
  const env = makeEnv({ workerEnabled: false });
  try {
    seedRun(env, { id: 'exact60', status: 'COMPLETED', created: 0, started: 0, completed: 60_000 });
    seedRun(env, { id: 'exact300', status: 'COMPLETED', created: 0, started: 0, completed: 300_000 });
    const h = collectMetrics(env.db).durationByStatus.get('COMPLETED');
    assert.ok(h);

    assert.equal(h.buckets.get('60'), 1, 'a 60s run must be inside le="60"');
    assert.equal(h.buckets.get('30'), 0, 'and not in the band below');
    assert.equal(h.buckets.get('300'), 2, 'a 300s run must be inside le="300"');
    assert.equal(h.count, 2);
    // Exactness, not approximation: the durations must be the integers, not 59.9999...
    assert.equal(h.sum, 360, `expected exact whole seconds, got ${h.sum}`);
  } finally {
    env.close();
  }
});

test('lease expiry is non-negative because one clock feeds both calls', () => {
  // The server reads Date.now() ONCE and passes it to both activeLeases(now) and collectMetrics
  // ({ now }). activeLeases keeps a lease while expires_at > now, so with a shared instant the
  // remaining time is positive by construction. Two readings let the second land after expiry and
  // produced a NEGATIVE "seconds until expiry".
  const env = makeEnv({ workerEnabled: false });
  try {
    seedRun(env, {
      id: 'leased', status: 'RUNNING', created: 0, started: 0,
      leaseOwner: 'w1', leaseExpires: 60_000,
    });
    const shared = T0;
    const leases = env.queue.activeLeases(shared);
    assert.equal(leases.length, 1, 'the lease must be considered live at the shared instant');
    assert.ok(collectMetrics(env.db, { leases, now: shared }).leaseExpiresInSeconds! >= 0,
      'shared clock must never yield a negative remaining time');

    // And the hazard the shared clock removes, demonstrated rather than asserted away: the same
    // lease, measured against a later instant, goes negative. If this ever stops being true the
    // two-clock bug cannot recur and the shared clock is no longer load-bearing.
    const later = T0 + 61_000;
    const stale = env.queue.activeLeases(shared);
    assert.ok(collectMetrics(env.db, { leases: stale, now: later }).leaseExpiresInSeconds! < 0,
      'expected two clocks to produce a negative remaining time');
  } finally {
    env.close();
  }
});

// --- issue #141: NEEDS_INPUT must count as live everywhere a lease is read ----------------------
//
// Four subsystems each decided which statuses count as live and gave three different answers.
// activeLeases was the outlier: it omitted NEEDS_INPUT while the reaper included it, so a worker
// parked on a human -- still holding its lease and a live agent process -- reported nothing.

test('activeLeases counts a run parked in NEEDS_INPUT (issue #141)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    seedRun(env, { id: 'parked', status: 'NEEDS_INPUT', created: 0, started: 0,
      leaseOwner: 'w1', leaseExpires: 60_000 });
    const leases = env.queue.activeLeases(T0);
    assert.equal(leases.length, 1, 'a worker whose only run awaits input is still working');
    assert.equal(leases[0].workerId, 'w1');
    assert.equal(leases[0].activeRuns, 1);
  } finally {
    env.close();
  }
});

test('a worker whose only run needs input is visible on /metrics (issue #141)', () => {
  // The consequence the finding names: zero workers and zero claimed runs while holding a live
  // lease, and a lease gauge blind to the lease most likely to be near expiry.
  const env = makeEnv({ workerEnabled: false });
  try {
    seedRun(env, { id: 'parked', status: 'NEEDS_INPUT', created: 0, started: 0,
      leaseOwner: 'w1', leaseExpires: 60_000 });
    const now = T0;
    const leases = env.queue.activeLeases(now);
    const m = collectMetrics(env.db, { leases, now });
    assert.equal(m.workers, 1, 'one worker is alive and holding a lease');
    assert.equal(m.claimedRuns, 1, 'and it has one claimed run');
    assert.notEqual(m.leaseExpiresInSeconds, null,
      'the lease gauge must see a NEEDS_INPUT lease; it is the one most likely to be near expiry');
    assert.ok(m.leaseExpiresInSeconds! >= 0, 'and must not go negative on the shared clock');

    // Positive control: with the run terminal instead, the worker genuinely is gone. Without this
    // an implementation that counted EVERY status would pass the assertions above.
    env.runs.transition('parked', 'FAILED');
    const after = env.queue.activeLeases(now);
    assert.deepEqual(after, [], 'a terminal run must not keep a worker alive');
    const m2 = collectMetrics(env.db, { leases: after, now });
    assert.equal(m2.workers, 0);
    assert.equal(m2.claimedRuns, 0);
  } finally {
    env.close();
  }
});

test('a QUEUED run holding a lease is NOT reported as an active worker (issue #141)', () => {
  // The other half of the distinction, pinned behaviourally rather than only as a set membership.
  // RunQueue.claim sets lease_owner and lease_expires_at BEFORE the run transitions to STARTING, so
  // this state is reachable on every claim, not just after a crash. Counting it would inflate
  // mercury_workers with queue depth. It must still be reaped, which is why the reaper's set is
  // wider than the active-worker set -- the two differ on QUEUED on purpose.
  const env = makeEnv({ workerEnabled: false });
  try {
    seedRun(env, { id: 'claimed-not-started', status: 'QUEUED', created: 0, started: null,
      leaseOwner: 'w1', leaseExpires: 60_000 });
    const leases = env.queue.activeLeases(T0);
    assert.deepEqual(leases, [], 'a QUEUED run is queue depth, not a live worker');
    const m = collectMetrics(env.db, { leases, now: T0 });
    assert.equal(m.workers, 0);
    assert.equal(m.claimedRuns, 0);

    // And the reaper DOES see it -- otherwise this run would be invisible to every subsystem, which
    // would make the narrow active-worker set a bug rather than a distinction.
    const reaped = env.queue.reapExpiredLeases(T0 + 61_000);
    assert.deepEqual(reaped.requeued, ['claimed-not-started'],
      'an expired lease on a QUEUED run must still be reaped');
  } finally {
    env.close();
  }
});

test('the live-status sets agree and are derived from the machine (issue #141)', () => {
  // The finding's table, pinned. The sets are allowed to DIFFER -- a QUEUED run holds a lease but is
  // not evidence of a live worker, and a STARTING run is a lease-expiry case rather than a stuck one
  // -- but the differences must be declared, not accidental. Before this, activeLeases disagreed with
  // the reaper about NEEDS_INPUT for no stated reason.
  assert.deepEqual([...LEASE_HOLDING_STATUSES].sort(),
    ['NEEDS_INPUT', 'QUEUED', 'RUNNING', 'STARTING'], 'a lease exists in every non-terminal status');
  assert.deepEqual([...ACTIVE_WORK_STATUSES].sort(),
    ['NEEDS_INPUT', 'RUNNING', 'STARTING'], 'QUEUED is not evidence of a live worker');
  assert.deepEqual([...STUCK_CANDIDATE_STATUSES].sort(),
    ['NEEDS_INPUT', 'RUNNING'], 'STARTING is a lease-expiry case, not an idle-agent one');

  // Derived, not restated. LEASE_HOLDING_STATUSES must equal "everything the machine says is not
  // terminal", computed here from the machine's OWN predicate rather than from the constant. If
  // someone swaps the derivation for a hardcoded list, or adds a status to the machine and forgets
  // this test, the two disagree.
  const everyStatus: RunStatus[] = [
    'QUEUED', 'STARTING', 'RUNNING', 'NEEDS_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT',
  ];
  assert.deepEqual([...LEASE_HOLDING_STATUSES].sort(),
    everyStatus.filter((s) => !isTerminal(s)).sort(),
    'LEASE_HOLDING_STATUSES must stay equal to the non-terminal half of the machine');
  // The enumeration above must itself stay complete, or the check above is vacuous.
  for (const t of TERMINAL_STATUSES) {
    assert.ok(everyStatus.includes(t), `this test's status list is missing terminal status ${t}`);
  }
  assert.equal(LEASE_HOLDING_STATUSES.length + TERMINAL_STATUSES.length, everyStatus.length,
    'every status must be either lease-holding or terminal; a new status needs adding here');

  // And each set is a subset of the one above it, so no set can invent a status.
  for (const smaller of [ACTIVE_WORK_STATUSES, STUCK_CANDIDATE_STATUSES]) {
    for (const s of smaller) {
      assert.ok(LEASE_HOLDING_STATUSES.includes(s), `${s} must be lease-holding`);
    }
  }
});


// ------ event-delivery observability (docs/cross-process-event-push.md §12) ------

test('event-delivery metrics are exported when a poller is wired', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const body = renderPrometheus(
      collectMetrics(env.db, {
        eventStream: { pollIterations: 42, pollLagSeconds: 0.25, streamsActive: 3, relaxedStreams: 1 },
      }),
    );
    assert.match(body, /mercury_event_poll_iterations_total 42$/m);
    assert.match(body, /mercury_event_poll_lag_seconds 0\.25$/m);
    assert.match(body, /mercury_sse_streams_active 3$/m);
    assert.match(body, /mercury_sse_streams_relaxed 1$/m);
  } finally { env.close(); }
});

test('event-delivery metrics are ABSENT, not zero, when no poller is wired', () => {
  // Exporting zeros here would assert "a poller exists and has found nothing". The truth in a process
  // with no EventStream is that there is no poller, and an all-zero series is how a dead fallback gets
  // read as a healthy one -- the exact blindness P7 exists to prevent.
  const env = makeEnv({ workerEnabled: false });
  try {
    const snap = collectMetrics(env.db);
    assert.equal(snap.eventStream, null, 'collectMetrics must set it explicitly, not leave it undefined');
    const body = renderPrometheus(snap);
    for (const name of [
      'mercury_event_poll_iterations_total',
      'mercury_event_poll_lag_seconds',
      'mercury_sse_streams_active',
      'mercury_sse_streams_relaxed',
    ]) {
      assert.ok(!body.includes(name), `${name} must not be exported without a poller`);
    }
  } finally { env.close(); }
});

test('the cross-process poll read uses idx_events_run_seq and does not sort', () => {
  // Stage 0 guard, matching how the /metrics index plan is pinned above. The poll runs this query for
  // every due subscription every fast tick, so a planner regression here is not a slow endpoint -- it is
  // a load generator on the same database the workers are contending for. The ORDER BY half matters as
  // much as the index half: "USE TEMP B-TREE FOR ORDER BY" would mean the 500-row page is being sorted
  // on every tick even though the index already yields sequence order.
  const env = makeEnv({ workerEnabled: false });
  try {
    const detail = (env.db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT 500')
      .all('run_x', 0) as { detail: string }[])
      .map((r) => r.detail)
      .join(' ');
    assert.match(detail, /idx_events_run_seq/, `planner must use the explicit index, got: ${detail}`);

    // Honest scope on this second assertion: it CANNOT fail on today's schema, and it is kept anyway
    // with that stated rather than implied. Measured -- drop idx_events_run_seq and the plan becomes
    // `SEARCH events USING INDEX sqlite_autoindex_events_2 (run_id=? AND sequence>?)`, still with no
    // TEMP B-TREE, because the UNIQUE (run_id, sequence) autoindex supplies the order just as well. So
    // this line does not prove the first line's point and must not be read as doing so.
    //
    // What it does guard is a future schema change that removes the UNIQUE constraint and leaves only a
    // non-covering index; at that point the 500-row page really would be sorted per tick. If the UNIQUE
    // constraint is ever dropped, this assertion becomes live -- which is the only reason it is worth
    // carrying rather than deleting.
    assert.doesNotMatch(detail, /TEMP B-TREE/, `the index must supply the order, got: ${detail}`);
  } finally { env.close(); }
});

test('the /metrics endpoint exports live event-delivery state end to end (issue #198)', async () => {
  // The wiring test. Every other metrics test hands collectMetrics an eventStream object, so none of
  // them can see whether the ROUTE supplies one -- and the entire point of these metrics is that a
  // silent regression here is invisible from outside the process. Deleting the wiring from the route
  // fails this test and leaves all the others green.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'scraped', agent: 'fake' });
    const { app, stream, close } = makeMetricsApp(env);
    const srv = await listen(app);
    try {
      // Subscribe AT THE HEAD so the backlog is empty: then the only way `delivered` can move is a
      // poll. Subscribing from 0 let subscribe() deliver the backlog synchronously, which satisfied
      // the wait before the poller had necessarily ticked once -- the assertion below then raced the
      // first tick and read 0 iterations.
      const backlog = env.events.list(run.id);
      const head = backlog.length ? backlog[backlog.length - 1].sequence : 0;
      let delivered = 0;
      const unsubscribe = stream.subscribe(run.id, head, () => { delivered += 1; });
      // A cross-process append, so the poller -- not the in-process push hook -- has to do the work.
      new EventStore(env.db).append(run.id, 'agent.message', { n: 1 });
      await waitFor(() => delivered > 0);

      const scrape = () => fetch(`http://127.0.0.1:${srv.port}/metrics`,
        { headers: { authorization: 'Bearer tok-alice' } }).then((r) => r.text());

      const m = parse(await scrape());
      assert.equal(get(m, 'mercury_sse_streams_active'), 1,
        'the live subscription must be visible on the endpoint');
      const iters = get(m, 'mercury_event_poll_iterations_total');
      assert.ok(iters !== undefined && iters >= 1,
        `a poll that delivered must be counted on the endpoint, got ${iters}`);
      const lag = get(m, 'mercury_event_poll_lag_seconds');
      assert.ok(lag !== undefined && lag >= 0 && Number.isFinite(lag),
        `lag must be exported as a finite non-negative number, got ${lag}`);

      unsubscribe();
      const after = parse(await scrape());
      assert.equal(get(after, 'mercury_sse_streams_active'), 0,
        'the gauge must follow unsubscribes, or it cannot detect the leak it exists for');
    } finally {
      await srv.close();
      close();
    }
  } finally { env.close(); }
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeServer, createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { collectMetrics } from '../src/metrics/collect.ts';
import { escapeLabelValue, renderPrometheus } from '../src/metrics/prometheus.ts';
import { makeEnv } from './helpers.ts';
import type { ErrorKind, RunStatus } from '../src/domain/types.ts';
import type { Express } from 'express';

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
  return { app, close: () => stream.stop() };
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

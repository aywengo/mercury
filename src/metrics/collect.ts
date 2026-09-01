// Aggregate operational metrics computed from persisted state (issue #131).
//
// DESIGN DECISIONS
//
// 1. READ FROM THE DATABASE, DO NOT KEEP COUNTERS.
//    The runs table already holds created_at / started_at / completed_at / status, so every metric
//    here is a query. In-memory counters would need incrementing at every state transition, would
//    reset on restart, and would create a second source of truth that can disagree with the runs
//    table. The database is the record; this module only projects it.
//
// 2. LABELS ARE BOUNDED BY CONSTRUCTION.
//    Every label here comes from a closed set: RunStatus (8 values), ErrorKind (3 + null), and
//    agent (validated against the registered adapter set in runService.ts:62). Nothing is labelled
//    by run id, owner id, repository, or workspace path. That is the difference between a metrics
//    endpoint and a denial-of-service against your own monitoring: an unbounded label makes the
//    series count grow with traffic, and Prometheus retention collapses first.
//
// 3. HISTOGRAMS ARE LEGITIMATELY MONOTONIC HERE.
//    Prometheus treats _bucket/_sum/_count as ever-increasing, and rate()/increase() assume it.
//    That holds because nothing deletes runs: there is no `DELETE FROM runs` anywhere in src/, and
//    workspace GC (workspaceGC.ts) removes directories on disk, never run rows. If run retention is
//    ever added, these histograms go backwards and rate() starts lying -- see the guard in
//    test/metrics.test.ts that asserts the absence of a DELETE.

import type { DatabaseSync } from 'node:sqlite';
import type { ActiveLease } from '../queue/runQueue.ts';

/**
 * Upper bounds, in seconds, for the run-duration histogram.
 *
 * Chosen around the shape of the workload: sub-minute runs are mostly failures or trivial tasks,
 * the interesting mass for a coding agent is minutes-to-tens-of-minutes, and maxDurationMs defaults
 * put a ceiling on the tail. Buckets are cumulative in Prometheus, so these are "<" bounds.
 */
export const DURATION_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200] as const;

/**
 * Upper bounds, in seconds, for the queue-wait histogram (claim time minus creation time).
 *
 * Weighted far lower than the duration buckets: a healthy queue starts a run in about one claim
 * poll interval, so anything past a minute is already the signal operators care about.
 */
export const QUEUE_WAIT_BUCKETS = [0.5, 1, 5, 15, 30, 60, 120, 300, 900] as const;

export interface Histogram {
  /** Cumulative counts keyed by the "<=" bound rendered the way Prometheus wants it. */
  buckets: Map<string, number>;
  sum: number;
  count: number;
}

export interface MetricsSnapshot {
  /** Runs currently in each status. */
  runsByStatus: Record<string, number>;
  /** Completed runs bucketed by wall-clock duration, split by terminal status. */
  durationByStatus: Map<string, Histogram>;
  /** Runs that have started, bucketed by time spent QUEUED before being claimed. */
  queueWait: Histogram;
  /** Failed runs by error kind. */
  errorsByKind: Record<string, number>;
  /** Runs that ever had a sandbox policy applied. */
  sandboxEnabled: number;
  /** Total runs ever created. Pair with sandboxEnabled in PromQL for an enablement RATE. */
  runsTotal: number;
  /** Workers currently holding a live lease. */
  workers: number;
  /** Runs currently claimed across all workers. */
  claimedRuns: number;
  /**
   * Seconds until the SOONEST live lease expires, or null when nothing is claimed.
   *
   * This is deliberately NOT the "lease age" the issue asked for. Age is not recorded: the runs
   * table stores lease_expires_at only, and expiry minus now cannot be turned back into an age
   * without also knowing the lease duration, which is a per-claim parameter (leaseMs) that is not
   * persisted. Remaining-time is both derivable and the thing you actually want to alert on --
   * a lease close to expiry means the holder has stopped renewing.
   */
  leaseExpiresInSeconds: number | null;
}

/**
 * SQL expression for a whole-second duration between two ISO-8601 TEXT columns.
 *
 * strftime('%s') yields an exact integer epoch second, so a run of exactly 60s computes to 60 and
 * lands in le="60" -- bucket boundaries are exact and the behaviour is testable.
 *
 * The obvious alternative, (julianday(b) - julianday(a)) * 86400.0, was what this used first and it
 * is float64 arithmetic on a day number near 2.46e6, so resolution is only ~100us. Measured: a
 * clean 60-second gap came out as 59.99999642372131. That is far finer than any bucket here, but it
 * makes every bucket boundary ambiguous -- an observation ON a boundary falls either side depending
 * on rounding, so inclusive `le` semantics could not be tested, and two runs of identical length
 * could land in different buckets. Whole-second precision is the right granularity for run
 * durations anyway: they are minutes to hours long.
 */
function secondsBetween(from: string, to: string): string {
  return `(strftime('%s', ${to}) - strftime('%s', ${from}))`;
}


/**
 * Build one SELECT that buckets a duration expression server-side.
 *
 * The bucket list is the single source of truth: the SQL is generated from it, so the set of
 * buckets reported and the set of boundaries evaluated cannot drift apart. A hand-written version
 * of this query would silently keep reporting stale buckets after someone edited the array.
 */
function bucketedQuery(expr: string, buckets: readonly number[], groupBy: string | null): string {
  // `<=`, not `<`. Prometheus defines the histogram bound label `le` as LESS THAN OR EQUAL, so an
  // observation landing exactly on a bound belongs in that bucket. Using `<` here silently dropped
  // those observations into the next bucket up, which under-counts the interesting bands (a run
  // that took exactly 60s would not appear in le="60").
  const cols = buckets
    .map((b, i) => `SUM(CASE WHEN d <= ${b} THEN 1 ELSE 0 END) AS b${i}`)
    .join(',\n           ');
  const sel = groupBy ? `${groupBy},\n           ` : '';
  // The GROUP BY is load-bearing, not decoration. Without it SQLite treats the whole result as ONE
  // group, still returns a row, and takes `status` from an arbitrary member of it -- so every
  // terminal status collapsed into a single histogram labelled with whichever status the planner
  // happened to read first. Observed on this commit: a FAILED run's 400s duration was reported
  // under status="COMPLETED" with count 2. Nothing errors; the metric is just quietly wrong.
  const tail = groupBy ? `\n      GROUP BY ${groupBy}` : '';
  return `SELECT ${sel}${cols},\n           SUM(d) AS total,\n           COUNT(*) AS n\n      FROM (SELECT ${sel}${expr} AS d FROM runs WHERE {where})${tail}`;
}

function readHistogram(
  db: DatabaseSync,
  sql: string,
  buckets: readonly number[],
  groupBy: string | null,
  labelOf?: (row: Record<string, unknown>) => string,
): Map<string, Histogram> | Histogram {
  const rows = db.prepare(sql).all() as Record<string, unknown>[];
  const make = (): Histogram => ({
    // Prometheus wants the cumulative count at or below each bound (le is inclusive), plus +Inf.
    buckets: new Map<string, number>([...buckets.map((b) => [String(b), 0] as const), ['+Inf', 0]]),
    sum: 0,
    count: 0,
  });

  if (!groupBy) {
    const h = make();
    const row = rows[0];
    if (row) fill(h, row, buckets);
    return h;
  }

  const out = new Map<string, Histogram>();
  for (const row of rows) {
    const key = labelOf ? labelOf(row) : String(row.status ?? 'unknown');
    const h = make();
    fill(h, row, buckets);
    out.set(key, h);
  }
  return out;
}

function fill(h: Histogram, row: Record<string, unknown>, buckets: readonly number[]): void {
  // The SQL columns are ALREADY cumulative: each is `SUM(CASE WHEN d <= bound ...)`, and an
  // observation below a small bound is below every larger bound too, so the columns are
  // non-decreasing by construction. Copy them straight across.
  //
  // This function previously treated them as per-band counts and accumulated a running total,
  // which double-counted: a 2-second run sits in the "<5", "<15", "<30" ... buckets, so the
  // reported count climbed by one at every bucket and reached 10 for a single run. The comment
  // here asserted the per-band reading confidently and was wrong, which is how the bug survived
  // being read.
  buckets.forEach((b, i) => {
    h.buckets.set(String(b), Number(row[`b${i}`] ?? 0) || 0);
  });
  h.count = Number(row.n ?? 0) || 0;
  h.sum = Number(row.total ?? 0) || 0;
  // +Inf is every observation, including any above the largest bucket.
  h.buckets.set('+Inf', h.count);
}

/**
 * The closed label sets, kept here so the exporter can declare every series at zero.
 *
 * These duplicate the RunStatus / ErrorKind unions in domain/types.ts at the value level. That is
 * deliberate and safe: types.ts cannot be iterated at runtime, and a test (metrics.test.ts) asserts
 * these arrays match the union, so drift fails loudly instead of silently dropping a series.
 */
const RUN_STATUS_VALUES = ['QUEUED', 'STARTING', 'RUNNING', 'NEEDS_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const;
const ERROR_KIND_VALUES = ['infrastructure', 'agent', 'task', 'unspecified'] as const;

const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

export interface CollectOptions {
  /** Live leases from RunQueue.activeLeases(); omitted when no queue is wired (same as /healthz/workers). */
  leases?: ActiveLease[];
  /** Clock injection for deterministic lease-age maths. */
  now?: number;
}

/** Compute the current metrics snapshot. Read-only; safe to call on every scrape. */
export function collectMetrics(db: DatabaseSync, opts: CollectOptions = {}): MetricsSnapshot {
  const now = opts.now ?? Date.now();

  // Seed every status at 0 before filling in the counts. A GROUP BY returns nothing for a status
  // with no runs, so on a fresh install the gauge would expose NO series at all and every panel
  // would read "no data" rather than zero. Absent and zero mean different things to Prometheus and
  // to the people paging on them, so the series are declared up front. The status set is closed,
  // so this cannot grow the cardinality.
  const runsByStatus: Record<string, number> = {};
  for (const st of RUN_STATUS_VALUES) runsByStatus[st] = 0;
  const statusRows = db
    .prepare('SELECT status, COUNT(*) AS n FROM runs GROUP BY status')
    .all() as { status: string; n: number }[];
  for (const r of statusRows) runsByStatus[r.status] = Number(r.n);

  const durationSql = bucketedQuery(
    secondsBetween('started_at', 'completed_at'),
    DURATION_BUCKETS,
    'status',
  ).replace('{where}', `started_at IS NOT NULL AND completed_at IS NOT NULL AND status IN (${TERMINAL_STATUSES.map((s) => `'${s}'`).join(', ')})`);
  const durationByStatus = readHistogram(db, durationSql, DURATION_BUCKETS, 'status') as Map<string, Histogram>;

  // Queue wait is measured over every run that was ever claimed, not just terminal ones: a long
  // queue is worth knowing about while it is still backing up.
  const waitSql = bucketedQuery(secondsBetween('created_at', 'started_at'), QUEUE_WAIT_BUCKETS, null)
    .replace('{where}', 'started_at IS NOT NULL');
  const queueWait = readHistogram(db, waitSql, QUEUE_WAIT_BUCKETS, null) as Histogram;

  const errRows = db
    .prepare("SELECT COALESCE(error_kind, 'unspecified') AS kind, COUNT(*) AS n FROM runs WHERE status = 'FAILED' GROUP BY COALESCE(error_kind, 'unspecified')")
    .all() as { kind: string; n: number }[];
  // Same reasoning as runsByStatus: a counter that only appears once the first failure happens
  // gives rate() no baseline to start from.
  const errorsByKind: Record<string, number> = {};
  for (const k of ERROR_KIND_VALUES) errorsByKind[k] = 0;
  for (const r of errRows) errorsByKind[r.kind] = Number(r.n);

  // Needs the idx_events_type index added in migration v4. Without it this is a full scan of the
  // largest table, on an endpoint a scraper hits every few seconds.
  const sandboxRow = db
    .prepare("SELECT COUNT(DISTINCT run_id) AS n FROM events WHERE type = 'sandbox.enabled'")
    .get() as { n: number };
  const totalRow = db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };

  const leases = opts.leases ?? [];
  let leaseExpiresInSeconds: number | null = null;
  for (const lease of leases) {
    if (!lease.oldestLeaseExpiresAt) continue;
    const remaining = (Date.parse(lease.oldestLeaseExpiresAt) - now) / 1000;
    if (leaseExpiresInSeconds === null || remaining < leaseExpiresInSeconds) leaseExpiresInSeconds = remaining;
  }

  return {
    runsByStatus,
    durationByStatus,
    queueWait,
    errorsByKind,
    sandboxEnabled: Number(sandboxRow.n) || 0,
    runsTotal: Number(totalRow.n) || 0,
    workers: leases.length,
    claimedRuns: leases.reduce((acc, l) => acc + l.activeRuns, 0),
    leaseExpiresInSeconds,
  };
}

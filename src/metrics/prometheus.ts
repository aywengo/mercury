// Prometheus text exposition format (issue #131).
//
// Kept separate from collect.ts so the parsing/rendering concern can be tested without a database,
// and so the wire format has one obvious owner.
//
// Format reference: the official text format spec. The parts that are easy to get wrong and are
// handled here deliberately:
//   - `le` bucket labels are CUMULATIVE and the +Inf bucket is mandatory.
//   - A metric must not be emitted with zero series unless it is declared; declaring TYPE with no
//     samples is fine and is what a freshly-initialised counter looks like.
//   - Label VALUES must escape backslash, double quote, and newline. Failing to escape a quote in
//     a label value lets a value break out of its quotes and inject arbitrary extra labels or
//     entirely new metric lines.

import type { Histogram, MetricsSnapshot } from './collect.ts';

/**
 * Escape a label value for the text format.
 *
 * Every label value in this module currently comes from a closed enum, so nothing reaches here
 * untrusted today. The escaping exists because that is a property of today's call sites, not of
 * the function: the moment someone labels a metric by a run id or an agent string from a new
 * source, an unescaped quote would let that value inject labels or forge metric lines into a
 * stream that Prometheus trusts.
 */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labels(base: Record<string, string>): string {
  const entries = Object.entries(base).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  const inner = entries
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
  return `{${inner}}`;
}

/** Emit one histogram: cumulative buckets, then _sum and _count. */
function writeHistogram(out: string[], name: string, help: string, series: Array<[Record<string, string>, Histogram]>): void {
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
  for (const [lbl, h] of series) {
    for (const [le, count] of h.buckets) {
      out.push(`${name}_bucket${labels({ ...lbl, le })} ${count}`);
    }
    out.push(`${name}_sum${labels(lbl)} ${h.sum}`, `${name}_count${labels(lbl)} ${h.count}`);
  }
}

function writeGauge(out: string[], name: string, help: string, series: Array<[Record<string, string>, number]>): void {
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  for (const [lbl, v] of series) out.push(`${name}${labels(lbl)} ${v}`);
}

function writeCounter(out: string[], name: string, help: string, series: Array<[Record<string, string>, number]>): void {
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
  for (const [lbl, v] of series) out.push(`${name}${labels(lbl)} ${v}`);
}

/** Render a snapshot as a Prometheus text-format body. Ends with a trailing newline. */
export function renderPrometheus(m: MetricsSnapshot): string {
  const out: string[] = [];

  // NOT named mercury_runs. Prometheus normalises a counter's mandatory _total suffix away when it
  // forms the metric family name, so a gauge called mercury_runs and a counter called
  // mercury_runs_total both arrive as the family mercury_runs with conflicting TYPEs, and the
  // scrape is rejected outright. Found by parsing the output with the official prometheus_client
  // parser, which reported mercury_runs twice -- something no per-line assertion can see, because
  // every individual line is perfectly well formed.
  writeGauge(
    out,
    'mercury_runs_in_status',
    'Runs currently in each status.',
    Object.entries(m.runsByStatus)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([status, n]) => [{ status }, n]),
  );

  writeHistogram(
    out,
    'mercury_run_duration_seconds',
    'Wall-clock run duration, from claim to terminal status, by terminal status.',
    [...m.durationByStatus.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([status, h]) => [{ status }, h]),
  );

  writeHistogram(
    out,
    'mercury_run_queue_wait_seconds',
    'Time a run spent QUEUED before being claimed.',
    [[{}, m.queueWait]],
  );

  writeCounter(
    out,
    'mercury_run_errors_total',
    'Failed runs by error kind.',
    Object.entries(m.errorsByKind)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([kind, n]) => [{ kind }, n]),
  );

  // Enablement RATE is intentionally not precomputed. A ratio is not aggregatable: averaging the
  // per-instance ratios of a fleet with unequal traffic is wrong, while dividing two exported
  // counters in PromQL is always right.
  writeCounter(out, 'mercury_sandbox_enabled_total', 'Runs that had a sandbox policy applied.', [[{}, m.sandboxEnabled]]);
  writeCounter(out, 'mercury_runs_total', 'Runs ever created.', [[{}, m.runsTotal]]);

  writeGauge(out, 'mercury_workers', 'Workers currently holding a live lease.', [[{}, m.workers]]);
  writeGauge(out, 'mercury_claimed_runs', 'Runs currently claimed by a worker.', [[{}, m.claimedRuns]]);

  // Omitted entirely rather than exported as 0 or NaN when nothing is claimed: 0 would read as
  // "a lease is expiring right now", which is the opposite of the truth and would page someone.
  if (m.leaseExpiresInSeconds !== null) {
    writeGauge(out, 'mercury_lease_expires_in_seconds', 'Seconds until the soonest live lease expires.', [
      [{}, m.leaseExpiresInSeconds],
    ]);
  }

  // Event-delivery counters (docs/cross-process-event-push.md §12). Omitted when this process has no
  // EventStream, following mercury_lease_expires_in_seconds: exporting zeros would assert that a
  // poller exists and has found nothing, which is a different fact from there being no poller here.
  //
  // These are the observability half of P7. Issue #196 was invisible for exactly as long as it existed
  // because nothing exposed WHICH streams were being polled slowly; lag and iteration count are what
  // make a silent revert to the slow cadence visible from outside the process.
  if (m.eventStream) {
    const es = m.eventStream;
    writeCounter(out, 'mercury_event_poll_iterations_total', 'Poll ticks that issued at least one read; proves the cross-process fallback is alive.', [
      [{}, es.pollIterations],
    ]);
    writeGauge(out, 'mercury_event_poll_lag_seconds', 'Age in seconds of the newest row the last delivering poll handed to a client; holds its value when idle.', [
      [{}, es.pollLagSeconds],
    ]);
    writeGauge(out, 'mercury_sse_streams_active', 'Live SSE subscriptions; a set that only grows is a leak (issue #133).', [
      [{}, es.streamsActive],
    ]);
    writeGauge(out, 'mercury_sse_streams_relaxed', 'Subscriptions currently on the relaxed backstop cadence (issue #196).', [
      [{}, es.relaxedStreams],
    ]);
  }

  return out.join('\n') + '\n';
}

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

  // Carries `attempted` alongside `status` so the signal is separable from the noise (issue #489).
  // `unmet` alone conflates "the harness held the objective and never declared it met" with "the
  // Run died before the harness ever received it", and the second includes ordinary infrastructure
  // failures. The query an operator wants is {status="unmet",attempted="true"}.
  //
  // The full cross product is emitted, including attempted="unknown" for statuses that are never
  // settled. Omitting those would make an absent series ambiguous between "zero" and "not
  // applicable", which is the ambiguity that produced the bug.
  writeGauge(
    out,
    'mercury_goals_in_status',
    'Goals currently in each goal status. Independent of run status: a COMPLETED run with an '
      + 'unmet goal is the pair this metric exists to expose. attempted is "true" when the Run '
      + 'reached RUNNING, "false" when it reached a terminal status without starting, and '
      + '"unknown" while the goal is unsettled.',
    Object.entries(m.goalsByStatusAndAttempted)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .flatMap(([status, byAttempted]) =>
        Object.entries(byAttempted)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([attempted, n]) => [{ status, attempted }, n] as [{ status: string; attempted: string }, number])),
  );

  // Knowledge synchronization (docs/knowledge-base.md section 8.5). These two are the only
  // knowledge metrics that describe a push, and both exist because a push failure is deliberately
  // NOT a Run event: a batch is not a Run, so Crew invariant 4 says it is a log line and a metric.
  // Without these two series the whole failure mode is invisible to a scraper.
  writeGauge(
    out,
    'mercury_knowledge_outbox_depth',
    'Notes harvested and awaiting acknowledgement from Atlas. A depth that grows monotonically '
      + 'means Atlas is unreachable or rejecting everything; Runs keep completing either way, which '
      + 'is why this is the surface that shows it.',
    [[{}, m.knowledgeOutboxDepth]],
  );
  // A counter, not a gauge: the name ends in _total, and Prometheus derives the family name by
  // stripping that suffix and requires the TYPE to agree. Declaring it a gauge would make the
  // scrape fail on the family, which is the same class of mistake the comment above
  // mercury_runs_in_status records.
  writeCounter(
    out,
    'mercury_knowledge_push_failures_total',
    'Cumulative failed attempts to deliver a knowledge batch to Atlas, across every worker. Counted '
      + 'in the database rather than per process, because the API serves this endpoint and the worker '
      + 'does the pushing.',
    [[{}, m.knowledgePushFailures]],
  );

  writeGauge(
    out,
    'mercury_knowledge_replica_seq',
    "Highest Atlas sequence number this host has durably applied to its local replica. Alert when "
      + 'this stops advancing while mercury_knowledge_pull_failures_total keeps rising: a replica that '
      + 'is merely stale still serves packs, so nothing else about the host looks wrong.',
    [[{}, m.knowledgeReplicaSeq]],
  );

  writeGauge(
    out,
    'mercury_knowledge_replica_notes',
    'Promoted notes in the local replica. The number of notes a new Run can be given right now.',
    [[{}, m.knowledgeReplicaNotes]],
  );

  writeCounter(
    out,
    'mercury_knowledge_pull_failures_total',
    'Cumulative failed attempts to refresh the local replica from Atlas. Counted in the database for '
      + 'the same reason as the push counter: the API serves this endpoint, the worker does the pulling.',
    [[{}, m.knowledgePullFailures]],
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

  // Stage 1 wake-ups. Omitted when the socket is not configured (the default), for the same reason the
  // delivery counters are omitted without a poller: a zero here would read as "push is working and
  // nothing is being lost" in a deployment where push does not exist.
  if (m.wakeupsReceived !== null && m.wakeupsReceived !== undefined) {
    writeCounter(out, 'mercury_event_wakeups_total', 'Wake-up notifications received by this process.', [
      [{ source: 'socket' }, m.wakeupsReceived],
    ]);
  }

  return out.join('\n') + '\n';
}

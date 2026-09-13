/**
 * The pusher: outbox out (docs/knowledge-base.md section 8.2).
 *
 * It runs on **its own timer**, never inside the claim loop. AGENTS.md names this as a common
 * mistake -- periodic work that must happen *while* a Run executes cannot live in the claim loop,
 * because the claim loop is blocked for the whole duration of a Run -- and `worker.ts` already does
 * it this way twice, for the stuck-run check and for backlog alerting. This is the third instance of
 * that pattern, and it follows it for the same reason rather than by imitation.
 *
 * Nothing is ever dropped for being undeliverable. A transport failure leaves every row in place and
 * backs off; only an explicit per-item answer from Atlas deletes a row. An outbox that grows is an
 * operator signal, not a problem to solve by discarding the evidence.
 */

import { createHash } from 'node:crypto';
import type { Logger } from '../logger.ts';
import type { AtlasClient } from './client.ts';
import { AtlasHttpError, AtlasTransportError } from './client.ts';
import { bumpCounter, SYNC_KEYS, type OutboxRow, type OutboxStore } from './outbox.ts';
import type { ContributionResult } from './types.ts';

// The repository's own Logger, not a narrower local shape. Two reasons: the pusher's log lines can
// carry an Atlas error message that quotes part of a note, and the redaction the real Logger applies
// is the only thing standing between that and a secret in a log line. A hand-rolled `{msg, fields}`
// interface here would have been a second logging convention and an unredacted one.
type PusherLog = Logger;

export interface PusherDeps {
  outbox: OutboxStore;
  client: AtlasClient;
  project: string;
  intervalMs: number;
  batch: number;
  log: PusherLog;
  /** Appends `knowledge.rejected` on the originating Run. Absent means the host has no event sink
   *  wired (a worker-less API process), which is a legitimate configuration. */
  events?: { append(runId: string, type: string, payload: unknown): unknown };
  /** Used only to check the Run still exists before appending to it. */
  runs?: { get(id: string): { status: string } | null };
  /** Outbox depth at which to warn. 0 disables. */
  alertDepth?: number;
  /**
   * A client carrying the admin token, used ONLY for rows whose source is `operator`.
   *
   * Absent means operator notes cannot leave this host. They are then kept and reported rather than
   * dropped: the outbox's contract is that nothing is lost for being undeliverable, and an operator note
   * that cannot be delivered is an operator-visible configuration gap, not a note to discard.
   */
  adminClient?: AtlasClient;
  /** Clock, for tests. */
  now?: () => number;
}

export interface PushOutcome {
  /** Rows this pass attempted to send. */
  attempted: number;
  accepted: number;
  duplicate: number;
  rejected: number;
  /** True when the batch could not be delivered at all; every row stayed in the outbox. */
  failed: boolean;
  lastError: string | null;
  /** How long the next tick will wait before trying again, in ms. 0 when not backing off. */
  backoffMs: number;
}

/** Ceiling on exponential backoff: ten minutes, per section 8.2. */
export const MAX_BACKOFF_MS = 10 * 60 * 1000;

export class KnowledgePusher {
  private readonly deps: PusherDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  /** Next time at which a tick is allowed to send. Zero means immediately. */
  private notBefore = 0;
  /** Guards against a slow push overlapping the next tick. */
  private inFlight = false;
  /** Whether the current depth has already been warned about, so a stuck outbox warns once per rise. */
  private alerted = false;

  constructor(deps: PusherDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer || this.deps.intervalMs <= 0) return;
    this.timer = setInterval(() => { void this.tick(); }, this.deps.intervalMs);
    // Never hold the process open: a pusher that has not drained must not be a reason a shutdown
    // hangs, and the outbox is durable so there is nothing to lose by exiting.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    if (this.now() < this.notBefore) return;
    this.inFlight = true;
    try {
      await this.pushOnce();
    } catch (err) {
      // pushOnce catches its own transport failures. Reaching here means a bug or a database error,
      // and a pusher that dies silently is worse than one that logs loudly: the outbox would keep
      // growing with nothing saying so.
      this.deps.log.warn({ error: (err as Error).message }, 'knowledge pusher tick failed unexpectedly');
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * One push pass. Synchronous in the sense that it runs to completion before resolving, which is
   * what `node src/cli.ts knowledge flush` needs and what a test asserts against.
   */
  /**
   * One push pass.
   *
   * A batch is split by provenance source and each half is sent under the token that is allowed to post
   * it, in the SAME pass.
   *
   * The split is forced by two rules that are each correct alone: an operator note lands promoted, so
   * section 11.1 restricts it to an admin token, and section 11.4 gives every host a contributor token
   * precisely so it cannot promote. A first attempt at this pushed only the non-operator half and left
   * the operator rows for the next tick, which was not data loss but was still wrong in two ways worth
   * naming, because both are the kind that no test notices: the outcome reported `attempted` for rows
   * that were never sent, so a log line said two notes went out when one did; and the pass recorded a
   * successful push timestamp while a note was still queued, which is the exact field an operator reads
   * to decide the outbox is healthy.
   *
   * Delivery is still per-group and never all-or-nothing. If the operator half cannot be authorised, the
   * non-operator notes already accepted stay deleted and only the operator rows are retained and counted
   * -- deleting a delivered row because a DIFFERENT row failed would be its own kind of loss.
   */
  async pushOnce(): Promise<PushOutcome> {
    const { outbox, project, batch } = this.deps;
    const rows = outbox.takeBatch(batch);
    const outcome: PushOutcome = { attempted: rows.length, accepted: 0, duplicate: 0, rejected: 0, failed: false, lastError: null, backoffMs: 0 };
    this.checkDepth(outbox.depth());
    if (rows.length === 0) {
      // A drained outbox clears the alert latch, so the next time it fills the operator hears about
      // it again rather than once per process lifetime.
      this.alerted = false;
      return outcome;
    }

    const ordinary = rows.filter((r) => r.contribution.provenance.source !== 'operator');
    const operator = rows.filter((r) => r.contribution.provenance.source === 'operator');
    const groups: { label: string; rows: OutboxRow[]; client: AtlasClient | null }[] = [];
    if (ordinary.length > 0) groups.push({ label: 'contributor', rows: ordinary, client: this.deps.client });
    if (operator.length > 0) groups.push({ label: 'admin', rows: operator, client: this.deps.adminClient ?? null });

    let deliveredAny = false;
    for (const group of groups) {
      if (!group.client) {
        // Named specifically rather than reported as a transport failure: the service is reachable and
        // the operator's note is refused by this host's own configuration.
        const err = new AtlasTransportError(
          `${group.rows.length} operator note(s) cannot be delivered: MERCURY_ATLAS_ADMIN_TOKEN is not `
          + 'set, and Atlas accepts a note that lands promoted only from an admin token',
        );
        this.recordFailure(outcome, group.rows, err);
        continue;
      }
      const result = await this.deliver(outcome, group.rows, group.client);
      if (!result.ok) {
        this.recordFailure(outcome, group.rows, result.err);
        continue;
      }
      deliveredAny = true;
    }

    if (!deliveredAny) return outcome;
    // Only a pass that got at least one group through counts as a successful push. The failure path has
    // already written lastPushError and armed the backoff; clearing them here would erase the evidence a
    // partially-failed pass leaves behind.
    outbox.setState(SYNC_KEYS.lastPushAt, new Date(this.now()).toISOString());
    this.consecutiveFailures = 0;
    this.notBefore = 0;
    this.deps.log.info({
      project, attempted: outcome.attempted, accepted: outcome.accepted,
      duplicate: outcome.duplicate, rejected: outcome.rejected,
      retained: outbox.depth(), partial: outcome.failed,
    }, 'knowledge pushed');
    return outcome;
  }

  /**
   * Send one group and classify Atlas's per-item answers.
   *
   * Returns rather than recording, so the caller can decide whether a failure is the whole pass or one
   * group of it.
   */
  private async deliver(
    outcome: PushOutcome,
    rows: OutboxRow[],
    client: AtlasClient,
  ): Promise<{ ok: true } | { ok: false; err: unknown }> {
    const { outbox, project } = this.deps;
    let results: ContributionResult[];
    try {
      const response = await client.pushBatch(project, rows.map((r) => r.contribution), batchIdempotencyKey(rows));
      results = response.results;
    } catch (err) {
      return { ok: false, err };
    }

    // A short result list is treated as a failure, not as "the rest were ignored". The caller's next
    // move on a result is to DELETE rows, and deleting rows on a partial protocol answer is how
    // knowledge is lost silently.
    if (results.length < rows.length) {
      return { ok: false, err: new AtlasTransportError(
        `Atlas answered for ${results.length} of ${rows.length} contributions; keeping every row`,
      ) };
    }

    const drop: number[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const result = results[i]!;
      if ('accepted' in result) { outcome.accepted += 1; drop.push(row.id); }
      else if ('duplicate' in result) { outcome.duplicate += 1; drop.push(row.id); }
      else if ('rejected' in result) {
        outcome.rejected += 1;
        drop.push(row.id);
        this.recordRejection(row, result.rejected);
      }
    }
    // Deletions happen once, after every row has been classified. Deleting inside the loop would
    // leave the outbox half-drained if a later row threw.
    outbox.remove(drop);
    return { ok: true };
  }

  /**
   * A delivery failure: keep every row, count it, back off.
   *
   * The counter lives in the database rather than in a field because the API process serves
   * `/metrics` and the worker is the one that pushes. A per-process counter would report zero
   * failures from the process an operator actually queries.
   */
  private recordFailure(outcome: PushOutcome, rows: OutboxRow[], err: unknown): PushOutcome {
    const message = err instanceof Error ? err.message : String(err);
    const { outbox } = this.deps;
    outbox.markFailure(rows.map((r) => r.id), message);
    outbox.setState(SYNC_KEYS.lastPushError, message);
    bumpCounter(outbox, 'push_failures_total');
    this.consecutiveFailures += 1;
    const backoff = Math.min(this.deps.intervalMs * 2 ** (this.consecutiveFailures - 1), MAX_BACKOFF_MS);
    this.notBefore = this.now() + backoff;
    outcome.failed = true;
    outcome.lastError = message;
    outcome.backoffMs = backoff;
    // Transport failures are NOT Run events. A batch is not a Run, and Crew invariant 4 is explicit
    // that store synchronization with no Run behind it is a log line and a metric.
    const kind = err instanceof AtlasHttpError ? 'atlas_http_error'
      : err instanceof AtlasTransportError ? 'atlas_transport_error' : 'push_error';
    this.deps.log.warn({
      kind, error: message, retained: rows.length, backoffMs: backoff,
      attempts: this.consecutiveFailures,
    }, 'knowledge push failed; rows retained');
    return outcome;
  }

  /**
   * Atlas refused a note. The row goes away -- Atlas will never accept it -- and the reason is
   * recorded where an operator looks: on the Run that produced it.
   */
  private recordRejection(row: OutboxRow, reason: string): void {
    if (!row.runId || !this.deps.events || !this.deps.runs) return;
    // Appending to a Run that no longer exists would create an orphan event, and the events table
    // has no cascade to clean it up.
    if (!this.deps.runs.get(row.runId)) return;
    try {
      this.deps.events.append(row.runId, 'knowledge.rejected', {
        reason, source: row.contribution.provenance.source,
        kind: row.contribution.kind, scope: row.contribution.scope,
      });
    } catch (err) {
      // Losing one rejection event must not abort the drain of the rest of the batch.
      this.deps.log.warn({ runId: row.runId, error: (err as Error).message }, 'could not record knowledge rejection');
    }
  }

  /** Depth alerting in the style of the backlog alert: warn on the rising edge, not every tick. */
  private checkDepth(depth: number): void {
    const threshold = this.deps.alertDepth ?? 0;
    if (threshold <= 0) return;
    if (depth >= threshold && !this.alerted) {
      this.alerted = true;
      this.deps.log.warn({
        depth, threshold, project: this.deps.project,
        hint: 'Atlas may be unreachable or rejecting everything; check last_push_error on /api/knowledge/status',
      }, 'knowledge outbox is growing');
    } else if (depth < threshold) {
      this.alerted = false;
    }
  }
}

/**
 * One idempotency key per batch, derived from the rows in it.
 *
 * Derived rather than random so that re-sending the same undelivered batch is recognized by Atlas as
 * the same batch. A random key would make every retry a fresh contribution, which is exactly the
 * double-count section 8.1 introduces idempotency to prevent.
 */
export function batchIdempotencyKey(rows: readonly OutboxRow[]): string {
  return createHash('sha256').update(rows.map((r) => r.idempotencyKey).join('\n'), 'utf8').digest('hex');
}

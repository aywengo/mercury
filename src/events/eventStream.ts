// SSE fan-out: in-process push via an EventStore append hook, with an adaptive
// DB poller as the cross-process fallback (worker may be a separate process).
// Cadence: 250 ms idle; after a push, 2 s (the poller only exists to catch events
// appended by other processes). Reconnect via ?after=<sequence> (Mercury.md §15).
//
// CURSOR RULE -- every delivery path in this file hands the events to the subscriber BEFORE moving
// `sub.afterSeq`, and never the other way round. The cursor is the only record of what the client has,
// so claiming a batch was delivered before it was accepted forfeits the rest of it permanently: poll()
// reads `WHERE sequence > afterSeq` and the skipped rows are never returned again. This is the rule
// docs/cross-process-event-push.md states for push in general, and issue #133 was a lost event prefix
// caused by breaking it. Consequence, accepted deliberately: a failed delivery can re-send events the
// client already saw, because the cursor never got that far. A duplicated timeline row is a cosmetic
// bug; a missing one is a lie.

import type { DatabaseSync } from 'node:sqlite';
import type { MercuryEvent } from '../domain/types.ts';
import type { EventStore } from './eventStore.ts';
import { nullLogger, type Logger } from '../logger.ts';

/**
 * Error detail that survives the logger.
 *
 * The logger serialises fields with JSON.stringify, and `message`/`stack` are NOT enumerable on an
 * Error -- measured, `JSON.stringify({ err })` yields `{"err":{}}`. Passing the raw error would have
 * made every line added here say nothing but "an error happened", which is the exact blindness this
 * issue is about.
 */
function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

interface Subscription {
  runId: string;
  afterSeq: number;
  onEvents: (events: MercuryEvent[]) => void;
  /**
   * Whether THIS subscription's backstop poll may run at the slow cadence.
   *
   * Per-subscription and deliberately not process-wide. One timer for the whole process meant that any
   * run served by the in-process push hook relaxed the cadence for every other subscriber, so a browser
   * tab open on run A added ~1.75 s of latency to run B's cross-process stream (issue #196, measured:
   * 29 poll reads in 300 ms down to 1).
   *
   * Set when a push actually delivers to this subscription. Cleared when a poll finds NEW rows for it,
   * because that is the moment the poller is doing real work and must stay sharp -- the inverse of the
   * old global `if (!anyNew)` rule, which restored the fast cadence only while nothing was arriving and
   * so pinned the slow cadence exactly while cross-process events were flowing.
   */
  slow: boolean;
  /** When this subscription was last actually read; drives the slow-cadence due check. */
  lastPollAt: number;
}

const FAST_MS = 250;
const SLOW_MS = 2_000;

export class EventStream {
  private subs = new Set<Subscription>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private db: DatabaseSync;
  private store: EventStore;
  private fastMs: number;
  private slowMs: number;
  private detachHook: (() => void) | null = null;
  private log: Logger;
  /**
   * runIds whose most recent poll read failed. Read failures are logged on the edges of a streak
   * rather than once per tick -- a busy or closed database fails every subscriber every 250 ms, which
   * would bury everything else the process logs -- and the streak is tracked PER RUN on purpose. A
   * single global flag cleared by the first successful read would make one healthy subscriber log a
   * "recovery" every tick while a poisoned row kept failing another run, so the recovery line would be
   * describing a run that never recovered.
   */
  private failingReads = new Set<string>();
  /**
   * Ticks on which the poller actually issued at least one read.
   *
   * Counted per tick-with-work rather than per timer firing: a tick with no subscribers, or with every
   * subscriber relaxed and not yet due, does nothing, and counting it would make this counter measure
   * "the process is up" instead of the thing §12 asks it to prove -- that the cross-process FALLBACK is
   * still running. If this counter stops climbing while runs are active, push is the only path left and
   * nobody can tell from outside.
   */
  private pollIterations = 0;
  /**
   * Age in seconds of the newest row the last delivering poll handed to a client.
   *
   * The direct measure of G1 (bounded cross-process latency) and the only way P7 holds: without it a
   * silent regression to the slow cadence looks identical to a healthy system from the outside, which is
   * exactly how issue #196 stayed invisible.
   *
   * HOLDS its last value when a poll delivers nothing, rather than falling to 0. This is a gauge of the
   * latency of the last real delivery, not a per-tick average; zeroing it on an idle tick would report
   * "zero lag" at the moment there is nothing to be fast about, and an alert on `> 1` would clear
   * precisely when it should not.
   */
  private pollLagSeconds = 0;

  constructor(
    db: DatabaseSync,
    store: EventStore,
    fastMs = FAST_MS,
    slowMs = SLOW_MS,
    logger: Logger = nullLogger,
  ) {
    this.db = db;
    this.store = store;
    this.fastMs = fastMs;
    this.slowMs = slowMs;
    this.log = logger;
  }

  start(): void {
    if (this.timer) return;
    // One driving timer, always at the fast cadence. Per-subscription due-checking in poll() is what
    // relaxes a backstop now, so the interval itself never changes: re-creating it globally is how one
    // run's traffic set another run's latency (issue #196).
    this.detachHook = this.store.onAppend((runId, event) => {
      // In-process push: wake matching subscribers immediately on append.
      for (const sub of [...this.subs]) {
        if (sub.runId !== runId) continue;
        if (event.sequence <= sub.afterSeq) continue;
        try {
          // Deliver first, then advance (cursor rule at the top of this file).
          sub.onEvents([event]);
          sub.afterSeq = event.sequence;
          // Only THIS subscription relaxes. An append nobody subscribed to reaches this line for
          // nobody, so the backstop stays sharp (issue R2-11), and an append served here no longer
          // relaxes the subscribers of unrelated runs (issue #196).
          this.relax(sub);
        } catch (err) {
          // Advancing after delivery is NOT enough on this path. The cursor is a single scalar, so
          // the NEXT successful push moves it past the refused sequence and poll() -- which reads
          // `WHERE sequence > afterSeq` -- can never return it. Measured: refusing sequence 3 of six
          // still delivered [1,2,4,5,6] and lost 3 permanently, with the subscription alive.
          //
          // So a push-path throw is treated exactly like a poll-path one (issue #143): the
          // subscriber is dead, drop it and say so. The client's own lastSeq is what a reconnect
          // resends from, so dropping is what actually converts silent loss into recovery.
          this.subs.delete(sub);
          this.log.error(
            { err: describeError(err), runId, sequence: event.sequence },
            'event subscriber dropped after delivery failure',
          );
        }
      }
    });
    this.timer = setInterval(() => this.poll(), this.fastMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.detachHook?.();
    this.detachHook = null;
    this.subs.clear();
    this.failingReads.clear();
  }

  /**
   * Register a subscriber and deliver the first page of what it has already missed BEFORE returning.
   *
   * "First page" is deliberate and must not be read as "everything". readAfter() caps a read at 500
   * rows, so a backlog longer than that is delivered across subsequent polls; the guarantee here is
   * that delivery STARTS synchronously, not that it finishes. Callers must not treat a fixed timer as
   * a safe truncation point on the assumption the backlog is drained -- see the close backstop in
   * src/api/routes.ts, which had exactly that wrong assumption.
   *
   * The backlog used to be left to poll(), which is wrong for two reasons and both were observed.
   *
   * (1) Event loss. The append hook advances `sub.afterSeq` for every event it pushes. Events
   *     appended between the requested cursor and the first push are never seen by the hook (the
   *     subscription did not exist yet) and are then invisible to poll() as well, because the
   *     cursor has already moved past them. A client subscribing mid-run permanently lost that
   *     prefix: reproduced on main, where a stream opened with ?after=0 received sequences 14-18
   *     and never 1-13. The poller is supposed to be the safety net, and the cursor advance
   *     silently defeated it.
   *
   * (2) Latency. Even with no push at all, the first backlog delivery waited for a poll tick, and
   *     the poller sits on the 2s slow cadence after any push -- so a reconnect could stare at an
   *     empty stream for two seconds before showing anything.
   *
   * Reading the backlog here closes both. Anything appended between this read and the subs.add
   * below is not lost: the hook will not see it (not registered yet), but the cursor still points
   * at the last delivered row, so the next poll picks it up. That trades latency for no loss,
   * which is the right way round.
   */
  subscribe(runId: string, afterSeq: number, onEvents: (events: MercuryEvent[]) => void): () => void {
    // Starts sharp: a subscription whose events can only arrive by poll() must be polled at the fast
    // cadence until something proves otherwise (issue #196).
    const sub: Subscription = { runId, afterSeq, onEvents, slow: false, lastPollAt: 0 };
    const backlog = this.readAfter(runId, afterSeq);
    if (backlog.length > 0) {
      // Deliver first, then advance. A throw here propagates to the caller (src/api/routes.ts
      // handles it per issue #143); leaving the cursor where it started is what lets a reconnect with
      // the ORIGINAL ?after= re-read the whole page instead of losing it (issue #138).
      onEvents(backlog);
      sub.afterSeq = backlog[backlog.length - 1].sequence;
    }
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  /**
   * Events for a run with sequence strictly greater than `afterSeq`, oldest first.
   *
   * Shared by subscribe() and poll() on purpose: the two must agree exactly on what "already seen"
   * means, or a row can be skipped by one and not returned by the other. That disagreement is
   * precisely how the backlog loss above happened.
   */
  private readAfter(runId: string, afterSeq: number): MercuryEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT 500')
      .all(runId, afterSeq) as {
      id: string; run_id: string; type: string; sequence: number; timestamp: string; payload_json: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      type: r.type,
      sequence: r.sequence,
      timestamp: r.timestamp,
      payload: JSON.parse(r.payload_json),
    }));
  }

  /**
   * Live subscriber count. Read-only, and useful beyond tests: a stream that fails to unsubscribe
   * is invisible from the outside, and this is the only way to see it.
   */
  get subscriptionCount(): number {
    return this.subs.size;
  }

  /**
   * Relax ONE subscription's backstop to the slow cadence.
   *
   * Replaces the old process-wide `slowDown()`, which cleared and re-created the single shared interval
   * and so applied one run's push traffic to every other subscriber (issue #196).
   */
  private relax(sub: Subscription): void {
    sub.slow = true;
    sub.lastPollAt = Date.now();
  }

  /**
   * Subscriptions currently sitting on the slow backstop cadence.
   *
   * Read-only, and the observable form of the property issue #196 is about: it answers "how many streams
   * are currently being polled slowly, and why" instead of the old unanswerable "what is the process
   * cadence". Also the natural source for the Stage 0 metrics in docs/cross-process-event-push.md §12.
   */
  /**
   * Process-local delivery counters for `/metrics` (design §12).
   *
   * Deliberately NOT SQL aggregates like the rest of `/metrics`: these describe what THIS process's
   * poller did, and the poller exists only in the API process. Deriving them from the database would
   * report another process's inactivity as this one's health.
   */
  metrics(): {
    pollIterations: number;
    pollLagSeconds: number;
    streamsActive: number;
    relaxedStreams: number;
  } {
    return {
      pollIterations: this.pollIterations,
      pollLagSeconds: this.pollLagSeconds,
      // Via the named accessor, not this.subs.size: §12 names subscriptionCount as the seam that
      // feeds this gauge, and going through it keeps one definition of "live subscription".
      streamsActive: this.subscriptionCount,
      relaxedStreams: this.relaxedCount,
    };
  }

  /**
   * Drain one run NOW, because another process said it may have new rows (Stage 1, issue #202).
   *
   * Deliberately tiny. It sharpens the affected subscriptions and re-enters the SAME poll path the
   * timer uses, rather than growing a second delivery route: a second route is a second place for the
   * cursor rule to be wrong, and getting it wrong is exactly how #133 lost events. The notification
   * carries a run id and nothing else, and no cursor is advanced here -- `afterSeq` still moves only
   * after rows have been handed to a client inside poll().
   *
   * A wake-up for a run nobody watches is a no-op by construction, which is the fan-out property of
   * section 8.2: the worker never needs to know who is listening.
   */
  wakeRun(runId: string): void {
    let touched = false;
    for (const sub of this.subs) {
      if (sub.runId !== runId) continue;
      sub.slow = false;
      sub.lastPollAt = 0;
      touched = true;
    }
    // Nothing watching this run: do not walk the whole subscription set to discover that.
    if (!touched) return;
    this.poll();
  }

  get relaxedCount(): number {
    let n = 0;
    for (const sub of this.subs) if (sub.slow) n += 1;
    return n;
  }

  /**
   * One poll tick for every subscriber.
   *
   * The two failure sources here are NOT the same failure and must not share a handler. This used to
   * be one `catch {}` around the whole body with a comment claiming the subscription was dropped --
   * nothing was dropped, nothing was logged, and the subscription was retried forever (issue #139).
   *
   *   - readAfter() throwing is the DATABASE's fault: a busy or closed handle, and it hits every
   *     subscriber on that tick. Dropping all of them would convert a transient into a mass SSE
   *     disconnect, so the subscription is kept and retried on the next tick.
   *   - onEvents() throwing is the SUBSCRIBER's fault: that callback owns a client response and a
   *     throw means the stream behind it is gone. Keeping it means retrying a dead client forever.
   *     So exactly that subscription is dropped.
   */
  private poll(): void {
    const now = Date.now();

    // Group subscriptions that would issue the IDENTICAL read, so N tabs on one run cost one query
    // instead of N (issue #146). Ten subscribers on one run were ten `SELECT ... LIMIT 500` four
    // times a second, all returning the same rows.
    //
    // Grouped by (runId, cursor) and NOT by runId alone. A run's subscribers each carry their own
    // cursor, and reading once for the whole run means reading from the SLOWEST one: everyone else
    // would then get nothing until that subscriber had paged through its backlog, because readAfter()
    // caps a page at 500 rows from the cursor it was given. That trades a delivery property for a
    // performance one. Grouping on the cursor pair dedupes the case the finding describes -- fresh
    // subscribers on the same run are always at the same cursor -- and changes nothing else.
    const groups = new Map<string, { runId: string; afterSeq: number; subs: Subscription[] }>();
    for (const sub of this.subs) {
      // Due check, per subscription. A relaxed subscription is only read once its slow interval has
      // elapsed; a sharp one is read every tick. This is the whole of issue #196 -- the cadence decision
      // moved from "what is this process's interval" to "what has THIS stream been doing".
      if (sub.slow && now - sub.lastPollAt < this.slowMs) continue;
      sub.lastPollAt = now;
      const key = `${sub.runId}\u0000${sub.afterSeq}`;
      const g = groups.get(key);
      if (g) g.subs.push(sub);
      else groups.set(key, { runId: sub.runId, afterSeq: sub.afterSeq, subs: [sub] });
    }
    if (groups.size === 0) return;
    this.pollIterations += 1;

    // A run can appear in SEVERAL groups in one tick, one per distinct cursor, so the failure streak
    // cannot be cleared by whichever group succeeds first. Doing that logged "recovered" while another
    // group on the same run was still failing, then "failed" again on the next tick -- the exact spam
    // this streak tracker exists to prevent. Collect the tick's outcome per run and settle each streak
    // once, after the loop.
    const failedRuns = new Set<string>();
    const okRuns = new Set<string>();

    for (const group of groups.values()) {
      let events: MercuryEvent[];
      try {
        events = this.readAfter(group.runId, group.afterSeq);
        okRuns.add(group.runId);
      } catch (err) {
        // Transient and shared across subscribers, so keep the subscriptions. Logged on the leading
        // edge of this run's failure streak only -- see failingReads.
        failedRuns.add(group.runId);
        if (!this.failingReads.has(group.runId)) {
          this.failingReads.add(group.runId);
          this.log.error(
            { err: describeError(err), runId: group.runId, subs: this.subs.size },
            'event poll read failed; retrying',
          );
        }
        continue;
      }
      if (events.length === 0) continue;
      // The poll found real rows, so for these subscriptions the poller is the delivery path and must
      // stay at the fast cadence. This is the inverse of the old global `if (!anyNew)` rule, which
      // relaxed precisely while a cross-process run was streaming (issue #196).
      // One read, many deliveries -- but each delivery stays isolated. A subscriber that throws owns a
      // client response, so it is dropped on its own; failing to isolate here let one bad subscriber
      // starve every later subscriber (issue #138).
      // Lag is measured against the newest row in the batch about to be handed over, read from the row
      // itself rather than from a counter, so it reflects what a client is actually waiting on.
      const newest = events[events.length - 1];
      const newestAt = Date.parse(newest.timestamp);
      if (Number.isFinite(newestAt)) this.pollLagSeconds = Math.max(0, (now - newestAt) / 1000);

      for (const sub of group.subs) {
        sub.slow = false;
        try {
          // Advance only once the batch is accepted. Advancing first meant a throw partway through a
          // page silently forfeited the rest of it for the life of the subscription (issue #138).
          sub.onEvents(events);
          sub.afterSeq = events[events.length - 1].sequence;
        } catch (err) {
          // Dead client: drop this one subscriber and say so. This is the only place that can observe
          // a delivery failure at all, so a silent handler here means nobody ever learns.
          this.subs.delete(sub);
          this.log.error(
            { err: describeError(err), runId: group.runId },
            'event subscriber dropped after delivery failure',
          );
        }
      }
    }
    for (const runId of okRuns) {
      // Only a run whose every group read cleanly has recovered.
      if (failedRuns.has(runId)) continue;
      if (this.failingReads.delete(runId)) {
        this.log.info({ runId }, 'event poll read recovered');
      }
    }

    // No cadence switch here any more. The driving timer always runs at fastMs and each subscription
    // decides for itself whether it is due (issue #196).
  }
}

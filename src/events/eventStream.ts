// SSE fan-out: in-process push via an EventStore append hook, with an adaptive
// DB poller as the cross-process fallback (worker may be a separate process).
// Cadence: 250 ms idle; after a push, 2 s (the poller only exists to catch events
// appended by other processes). Reconnect via ?after=<sequence> (Mercury.md §15).

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
    // In-process push: wake matching subscribers immediately on append.
    this.detachHook = this.store.onAppend((runId, event) => {
      for (const sub of [...this.subs]) {
        if (sub.runId !== runId) continue;
        if (event.sequence <= sub.afterSeq) continue;
        sub.afterSeq = event.sequence;
        sub.onEvents([event]);
      }
      this.slowDown();
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
    const sub: Subscription = { runId, afterSeq, onEvents };
    const backlog = this.readAfter(runId, afterSeq);
    if (backlog.length > 0) {
      sub.afterSeq = backlog[backlog.length - 1].sequence;
      onEvents(backlog);
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

  /** Switch to the slow cadence after a push; the next empty poll restores fast. */
  private slowDown(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), this.slowMs);
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
    let anyNew = false;
    for (const sub of [...this.subs]) {
      let events: MercuryEvent[];
      try {
        events = this.readAfter(sub.runId, sub.afterSeq);
      } catch (err) {
        // Transient and shared across subscribers, so keep the subscription. Logged on the leading
        // edge of this run's failure streak only -- see failingReads.
        if (!this.failingReads.has(sub.runId)) {
          this.failingReads.add(sub.runId);
          this.log.error(
            { err: describeError(err), runId: sub.runId, subs: this.subs.size },
            'event poll read failed; retrying',
          );
        }
        continue;
      }
      if (this.failingReads.delete(sub.runId)) {
        this.log.info({ runId: sub.runId }, 'event poll read recovered');
      }
      if (events.length === 0) continue;
      anyNew = true;
      sub.afterSeq = events[events.length - 1].sequence;
      try {
        sub.onEvents(events);
      } catch (err) {
        // Dead client: drop this one subscriber and say so. This is the only place that can observe
        // a delivery failure at all, so a silent handler here means nobody ever learns.
        this.subs.delete(sub);
        this.log.error(
          { err: describeError(err), runId: sub.runId },
          'event subscriber dropped after delivery failure',
        );
      }
    }
    // Back to fast cadence when the poll found nothing new (idle).
    if (!anyNew && this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.poll(), this.fastMs);
    }
  }
}

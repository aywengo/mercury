// SSE fan-out: in-process push via an EventStore append hook, with an adaptive
// DB poller as the cross-process fallback (worker may be a separate process).
// Cadence: 250 ms idle; after a push, 2 s (the poller only exists to catch events
// appended by other processes). Reconnect via ?after=<sequence> (Mercury.md §15).

import type { DatabaseSync } from 'node:sqlite';
import type { MercuryEvent } from '../domain/types.ts';
import type { EventStore } from './eventStore.ts';

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

  constructor(db: DatabaseSync, store: EventStore, fastMs = FAST_MS, slowMs = SLOW_MS) {
    this.db = db;
    this.store = store;
    this.fastMs = fastMs;
    this.slowMs = slowMs;
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
  }

  /**
   * Register a subscriber and deliver what it has already missed BEFORE returning.
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

  private poll(): void {
    let anyNew = false;
    for (const sub of [...this.subs]) {
      try {
        const events = this.readAfter(sub.runId, sub.afterSeq);
        if (events.length === 0) continue;
        anyNew = true;
        sub.afterSeq = events[events.length - 1].sequence;
        sub.onEvents(events);
      } catch {
        // drop failing subscription on next poll
      }
    }
    // Back to fast cadence when the poll found nothing new (idle).
    if (!anyNew && this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.poll(), this.fastMs);
    }
  }
}

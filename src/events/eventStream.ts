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

  subscribe(runId: string, afterSeq: number, onEvents: (events: MercuryEvent[]) => void): () => void {
    const sub: Subscription = { runId, afterSeq, onEvents };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
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
        const rows = this.db
          .prepare('SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT 500')
          .all(sub.runId, sub.afterSeq) as {
          id: string; run_id: string; type: string; sequence: number; timestamp: string; payload_json: string;
        }[];
        if (rows.length === 0) continue;
        anyNew = true;
        const events = rows.map((r) => ({
          id: r.id,
          runId: r.run_id,
          type: r.type,
          sequence: r.sequence,
          timestamp: r.timestamp,
          payload: JSON.parse(r.payload_json),
        }));
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

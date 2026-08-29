// Structured event persistence with per-run monotonic sequences (Mercury.md section 14).

import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tx } from '../db/database.ts';
import type { MercuryEvent } from '../domain/types.ts';
import type { Redactor } from '../domain/redact.ts';

export interface EventRow {
  id: string;
  run_id: string;
  type: string;
  sequence: number;
  timestamp: string;
  payload_json: string;
}

export class EventStore {
  private db: DatabaseSync;
  private redactor: Redactor | null;
  private appendListeners = new Set<(runId: string, event: MercuryEvent) => void>();

  constructor(db: DatabaseSync, redactor?: Redactor) {
    this.db = db;
    this.redactor = redactor ?? null;
  }

  /** Register a callback invoked after every append (in-process push hook). */
  onAppend(listener: (runId: string, event: MercuryEvent) => void): () => void {
    this.appendListeners.add(listener);
    return () => {
      this.appendListeners.delete(listener);
    };
  }

  /** Append an event; sequence is assigned by the DB (single writer). */
  append(runId: string, type: string, payload: unknown): MercuryEvent {
    return tx(this.db, () => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM events WHERE run_id = ?')
        .get(runId) as { max_seq: number };
      const sequence = row.max_seq + 1;
      // Secrets are redacted at the single write choke point (Mercury.md section 24):
      // every event (agent messages, tool args, errors) passes through append().
      // Payloads must be JSON-serializable plain values (objects/arrays/strings/
      // numbers/booleans/null); non-plain values (Date, Buffer) are not preserved.
      const safePayload = this.redactor ? this.redactor.redactJson(payload) : payload;
      const event: MercuryEvent = {
        id: 'evt_' + randomUUID().replace(/-/g, '').slice(0, 16),
        runId,
        type,
        sequence,
        timestamp: new Date().toISOString(),
        payload: safePayload,
      };
      this.db
        .prepare('INSERT INTO events (id, run_id, type, sequence, timestamp, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(event.id, runId, type, sequence, event.timestamp, JSON.stringify(safePayload));
      for (const listener of [...this.appendListeners]) {
        try {
          listener(runId, event);
        } catch {
          // listener failures must not break appends
        }
      }
      return event;
    });
  }

  list(runId: string, afterSeq = 0, limit = 1000): MercuryEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?')
      .all(runId, afterSeq, limit) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  lastSequence(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM events WHERE run_id = ?')
      .get(runId) as { max_seq: number };
    return row.max_seq;
  }

  /** Timestamp of the most recent event for a run (null if it has none). */
  lastActivity(runId: string): string | null {
    const row = this.db
      .prepare('SELECT MAX(timestamp) AS last_ts FROM events WHERE run_id = ?')
      .get(runId) as { last_ts: string | null };
    return row.last_ts;
  }
}

function rowToEvent(row: EventRow): MercuryEvent {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    sequence: row.sequence,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload_json),
  };
}

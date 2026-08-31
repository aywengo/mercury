// Structured event persistence with per-run monotonic sequences (Mercury.md section 14).

import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tx } from '../db/database.ts';
import { isEventType, type MercuryEvent } from '../domain/types.ts';
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

  /**
   * Append an event; sequence is assigned by the DB (single writer).
   *
   * `type` must be in EVENT_TYPES. This is the only place all events pass through, so it
   * is where the section 14 contract is enforced (issue #60). The check is not cosmetic:
   * the worker forwards `ev.type` from the adapter, and routes.ts writes that type raw
   * into an SSE frame as `event: <type>`. A type containing a blank line therefore let an
   * agent, or a compromised repository driving one, inject arbitrary SSE frames into every
   * subscriber of the run (issue #50). Rejecting at the choke point closes it for every
   * present and future caller, not only for the one that was reported.
   */
  append(runId: string, type: string, payload: unknown): MercuryEvent {
    if (!isEventType(type)) {
      throw new Error('Unknown event type: ' + JSON.stringify(type));
    }
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

  /**
   * Retroactive redaction (issue #18): re-run redactJson over every persisted
   * event payload. Events written before write-time redaction existed may
   * contain secrets; this one-shot backfill rewrites them in place.
   * Returns the number of rows whose payload actually changed.
   */
  backfillRedact(): number {
    const redactor = this.redactor;
    if (!redactor) return 0;
    // Keyset paging: never materialize the whole events table (production DBs
    // can be multi-GB). Each chunk runs in its own transaction, so a crash
    // mid-pass is safe to re-run (idempotent). Rows written between a chunk's
    // SELECT and COMMIT are skipped — acceptable for a one-shot backfill.
    const CHUNK = 1000;
    let changed = 0;
    let lastId = '';
    for (;;) {
      const rows = this.db
        .prepare('SELECT id, payload_json FROM events WHERE id > ? ORDER BY id ASC LIMIT ?')
        .all(lastId, CHUNK) as unknown as { id: string; payload_json: string }[];
      if (rows.length === 0) break;
      lastId = rows[rows.length - 1].id;
      tx(this.db, () => {
        const update = this.db.prepare('UPDATE events SET payload_json = ? WHERE id = ?');
        for (const row of rows) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.payload_json);
          } catch {
            continue; // leave malformed rows untouched
          }
          const redacted = redactor.redactJson(parsed);
          const next = JSON.stringify(redacted);
          // Compare against the parsed-then-re-serialized form so formatting-only
          // differences (whitespace, key order) don't count as changes.
          if (next !== JSON.stringify(parsed)) {
            update.run(next, row.id);
            changed++;
          }
        }
      });
    }
    // run_inputs.input_json (user-submitted input; issue #36)
    let lastInputId = '';
    for (;;) {
      const rows = this.db
        .prepare('SELECT id, input_json FROM run_inputs WHERE id > ? ORDER BY id ASC LIMIT ?')
        .all(lastInputId, CHUNK) as unknown as { id: string; input_json: string }[];
      if (rows.length === 0) break;
      lastInputId = rows[rows.length - 1].id;
      tx(this.db, () => {
        const update = this.db.prepare('UPDATE run_inputs SET input_json = ? WHERE id = ?');
        for (const row of rows) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.input_json);
          } catch {
            continue; // leave malformed rows untouched
          }
          const redacted = redactor.redactJson(parsed);
          const next = JSON.stringify(redacted);
          if (next !== JSON.stringify(parsed)) {
            update.run(next, row.id);
            changed++;
          }
        }
      });
    }
    // runs.error (worker crash / agent failure messages; issue #36)
    let lastRunId = '';
    for (;;) {
      const rows = this.db
        .prepare('SELECT id, error FROM runs WHERE id > ? AND error IS NOT NULL ORDER BY id ASC LIMIT ?')
        .all(lastRunId, CHUNK) as unknown as { id: string; error: string }[];
      if (rows.length === 0) break;
      lastRunId = rows[rows.length - 1].id;
      tx(this.db, () => {
        const update = this.db.prepare('UPDATE runs SET error = ? WHERE id = ?');
        for (const row of rows) {
          const redacted = redactor.redact(row.error);
          if (redacted !== row.error) {
            update.run(redacted, row.id);
            changed++;
          }
        }
      });
    }
    // runs.task (user-submitted task text; issue #43)
    let lastTaskId = '';
    for (;;) {
      const rows = this.db
        .prepare('SELECT id, task FROM runs WHERE id > ? ORDER BY id ASC LIMIT ?')
        .all(lastTaskId, CHUNK) as unknown as { id: string; task: string }[];
      if (rows.length === 0) break;
      lastTaskId = rows[rows.length - 1].id;
      tx(this.db, () => {
        const update = this.db.prepare('UPDATE runs SET task = ? WHERE id = ?');
        for (const row of rows) {
          const redacted = redactor.redact(row.task);
          if (redacted !== row.task) {
            update.run(redacted, row.id);
            changed++;
          }
        }
      });
    }
    // runs.repository_json (repo URLs can embed credentials; issue #43)
    let lastRepoId = '';
    for (;;) {
      const rows = this.db
        .prepare('SELECT id, repository_json FROM runs WHERE id > ? ORDER BY id ASC LIMIT ?')
        .all(lastRepoId, CHUNK) as unknown as { id: string; repository_json: string }[];
      if (rows.length === 0) break;
      lastRepoId = rows[rows.length - 1].id;
      tx(this.db, () => {
        const update = this.db.prepare('UPDATE runs SET repository_json = ? WHERE id = ?');
        for (const row of rows) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.repository_json);
          } catch {
            continue; // leave malformed rows untouched
          }
          const redacted = redactor.redactJson(parsed);
          const next = JSON.stringify(redacted);
          if (next !== JSON.stringify(parsed)) {
            update.run(next, row.id);
            changed++;
          }
        }
      });
    }
    // runs.repositories_json (additional repos, v2 column; issue #43)
    let lastReposId = '';
    for (;;) {
      const rows = this.db
        .prepare('SELECT id, repositories_json FROM runs WHERE id > ? AND repositories_json IS NOT NULL ORDER BY id ASC LIMIT ?')
        .all(lastReposId, CHUNK) as unknown as { id: string; repositories_json: string }[];
      if (rows.length === 0) break;
      lastReposId = rows[rows.length - 1].id;
      tx(this.db, () => {
        const update = this.db.prepare('UPDATE runs SET repositories_json = ? WHERE id = ?');
        for (const row of rows) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.repositories_json);
          } catch {
            continue; // leave malformed rows untouched
          }
          const redacted = redactor.redactJson(parsed);
          const next = JSON.stringify(redacted);
          if (next !== JSON.stringify(parsed)) {
            update.run(next, row.id);
            changed++;
          }
        }
      });
    }
    return changed;
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

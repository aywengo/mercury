/**
 * The binding table: which host owns which Run.
 *
 * This is Fleet's second piece of truth, and the one the design singles out. Losing `hosts` means Fleet does
 * not know what to talk to; losing `fleet_runs` means Runs are executing on machines nobody can name. So the
 * operations here are written so that a binding exists BEFORE Fleet asks a child for anything, and the
 * child's id is filled in afterwards.
 */

import type { DatabaseSync } from 'node:sqlite';

export interface Binding {
  fleetRunId: string;
  hostId: string;
  /** Null until the child has answered. Null is "unknown", never "failed". */
  childRunId: string | null;
  clientToken: string | null;
  requested: Record<string, unknown>;
  createdAt: string;
  boundAt: string | null;
}

export interface RunState {
  fleetRunId: string;
  status: string;
  cursor: number;
  lastSeenAt: string | null;
  lastError: string | null;
}

export interface BindingView extends Binding {
  state: RunState | null;
}

/** Status recorded for a Run whose child could not be reached. Distinct from every real child status. */
export const UNKNOWN = 'UNKNOWN';

interface BindingRow {
  fleet_run_id: string;
  host_id: string;
  child_run_id: string | null;
  client_token: string | null;
  requested: string;
  created_at: string;
  bound_at: string | null;
}

interface StateRow {
  fleet_run_id: string;
  status: string;
  cursor: number;
  last_seen_at: string | null;
  last_error: string | null;
}

function toBinding(row: BindingRow): Binding {
  let requested: Record<string, unknown> = {};
  try {
    requested = JSON.parse(row.requested) as Record<string, unknown>;
  } catch {
    // A corrupt payload must not make the binding unreadable. The binding is the thing that matters; the
    // echo of the request is a convenience.
    requested = { _unparseable: true };
  }
  return {
    fleetRunId: row.fleet_run_id,
    hostId: row.host_id,
    childRunId: row.child_run_id,
    clientToken: row.client_token,
    requested,
    createdAt: row.created_at,
    boundAt: row.bound_at,
  };
}

function toState(row: StateRow): RunState {
  return {
    fleetRunId: row.fleet_run_id,
    status: row.status,
    cursor: Number(row.cursor),
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error,
  };
}

export class BindingStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Record the intent to dispatch, before contacting the child.
   *
   * `requested` is stored as received so a later retry after a crash re-sends exactly the same payload; a
   * payload that drifted between attempts would defeat the child's idempotency key.
   */
  createPending(input: {
    fleetRunId: string;
    hostId: string;
    requested: Record<string, unknown>;
    clientToken?: string | null;
  }): Binding {
    this.db
      .prepare(
        `INSERT INTO fleet_runs (fleet_run_id, host_id, child_run_id, client_token, requested, created_at)
         VALUES (?, ?, NULL, ?, ?, ?)`,
      )
      .run(input.fleetRunId, input.hostId, input.clientToken ?? null,
        JSON.stringify(input.requested), new Date().toISOString());
    return this.get(input.fleetRunId)!;
  }

  get(fleetRunId: string): Binding | null {
    const row = this.db.prepare('SELECT * FROM fleet_runs WHERE fleet_run_id = ?').get(fleetRunId) as
      | BindingRow
      | undefined;
    return row ? toBinding(row) : null;
  }

  findByClientToken(token: string): Binding | null {
    const row = this.db.prepare('SELECT * FROM fleet_runs WHERE client_token = ?').get(token) as
      | BindingRow
      | undefined;
    return row ? toBinding(row) : null;
  }

  bind(fleetRunId: string, childRunId: string): Binding {
    this.db
      .prepare('UPDATE fleet_runs SET child_run_id = ?, bound_at = ? WHERE fleet_run_id = ?')
      .run(childRunId, new Date().toISOString(), fleetRunId);
    return this.get(fleetRunId)!;
  }

  /**
   * Drop a binding when the child definitively refused.
   *
   * Only reachable for a 4xx, where no Run was created. A transport failure or a 5xx must leave the binding
   * in place with child_run_id NULL, because the Run may exist and a deleted binding is how it becomes an
   * orphan.
   */
  discard(fleetRunId: string): void {
    this.db.prepare('DELETE FROM fleet_runs WHERE fleet_run_id = ?').run(fleetRunId);
  }

  /** Bindings whose child answer was never recorded: the crash-recovery worklist. */
  pending(): Binding[] {
    const rows = this.db
      .prepare('SELECT * FROM fleet_runs WHERE child_run_id IS NULL ORDER BY created_at')
      .all() as unknown as BindingRow[];
    return rows.map(toBinding);
  }

  /**
   * Bindings scoped to the hosts the caller may see. An empty allowlist yields no rows rather than all of
   * them -- the same fail-closed reading the caller allowlist uses.
   */
  list(hostIds: '*' | string[]): BindingView[] {
    if (hostIds === '*') {
      const all = this.db.prepare('SELECT * FROM fleet_runs ORDER BY created_at DESC').all();
      return (all as unknown as BindingRow[]).map((row) => ({ ...toBinding(row), state: this.state(row.fleet_run_id) }));
    }
    if (hostIds.length === 0) return [];
    const placeholders = hostIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM fleet_runs WHERE host_id IN (${placeholders}) ORDER BY created_at DESC`)
      .all(...hostIds) as unknown as BindingRow[];
    return rows.map((row) => ({ ...toBinding(row), state: this.state(row.fleet_run_id) }));
  }

  recordState(input: RunState): void {
    this.db
      .prepare(
        `INSERT INTO run_state (fleet_run_id, status, cursor, last_seen_at, last_error)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fleet_run_id) DO UPDATE SET
           status = excluded.status, cursor = excluded.cursor,
           last_seen_at = excluded.last_seen_at, last_error = excluded.last_error`,
      )
      .run(input.fleetRunId, input.status, input.cursor, input.lastSeenAt, input.lastError);
  }

  state(fleetRunId: string): RunState | null {
    const row = this.db.prepare('SELECT * FROM run_state WHERE fleet_run_id = ?').get(fleetRunId) as
      | StateRow
      | undefined;
    return row ? toState(row) : null;
  }
}

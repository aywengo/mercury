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
  /** The authenticated caller that created this binding. Idempotency is scoped to it. */
  ownerId: string;
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
  /** True once the event log has been read to the end; one-way, see setCursor. */
  eventsDrained: boolean;
}

/**
 * What a status write supplies. eventsDrained is deliberately absent: reconciliation owns status and
 * staleness, mirroring owns the drain flag, and neither should be able to reset the other by writing a
 * complete row.
 */
export type RunStateWrite = Omit<RunState, 'eventsDrained'>;

export interface BindingView extends Binding {
  state: RunState | null;
}

/** Status recorded for a Run whose child could not be reached. Distinct from every real child status. */
export const UNKNOWN = 'UNKNOWN';

interface BindingRow {
  fleet_run_id: string;
  host_id: string;
  owner_id: string;
  child_run_id: string | null;
  client_token: string | null;
  requested: string;
  created_at: string;
  bound_at: string | null;
}

interface StateRow {
  events_drained?: number | null;
  fleet_run_id: string;
  status: string;
  cursor: number;
  last_seen_at: string | null;
  last_error: string | null;
}

/** Shape produced by list()'s LEFT JOIN: the binding columns plus nullable run_state columns. */
interface JoinedRow extends BindingRow {
  state_status: string | null;
  state_cursor: number | null;
  state_last_seen_at: string | null;
  state_last_error: string | null;
  state_events_drained: number | null;
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
    ownerId: row.owner_id,
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
    eventsDrained: Number(row.events_drained ?? 0) === 1,
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
    ownerId: string;
    requested: Record<string, unknown>;
    clientToken?: string | null;
  }): Binding {
    this.db
      .prepare(
        `INSERT INTO fleet_runs (fleet_run_id, host_id, owner_id, child_run_id, client_token, requested, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(input.fleetRunId, input.hostId, input.ownerId, input.clientToken ?? null,
        JSON.stringify(input.requested), new Date().toISOString());
    return this.get(input.fleetRunId)!;
  }

  get(fleetRunId: string): Binding | null {
    const row = this.db.prepare('SELECT * FROM fleet_runs WHERE fleet_run_id = ?').get(fleetRunId) as
      | BindingRow
      | undefined;
    return row ? toBinding(row) : null;
  }

  /**
   * Look up by idempotency token WITHIN one owner. Unscoped lookup was a leak: two callers reusing the same
   * memorable token collided, and the second received the first one's run id, host and status.
   */
  findByClientToken(ownerId: string, token: string): Binding | null {
    const row = this.db
      .prepare('SELECT * FROM fleet_runs WHERE owner_id = ? AND client_token = ?')
      .get(ownerId, token) as BindingRow | undefined;
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
  /**
   * Bindings scoped to the hosts the caller may see. An empty allowlist yields no rows rather than all of
   * them -- the same fail-closed reading the caller allowlist uses.
   *
   * run_state is joined rather than fetched per row. The previous shape issued one extra SELECT per binding,
   * so a list of N Runs cost N+1 queries on the endpoint operators hit most often.
   */
  list(hostIds: '*' | string[]): BindingView[] {
    // Fail closed on an empty allowlist. node:sqlite happens to accept `IN ()` and return no rows, so the
    // query would also come back empty without this line -- but that is one driver's behaviour, not a
    // guarantee worth depending on for an authorization decision. The order matters too: '*' is a string of
    // length 1, so an emptiness test written first would never catch the wildcard.
    if (hostIds !== '*' && hostIds.length === 0) return [];
    const where = hostIds === '*' ? '' : `WHERE fleet_runs.host_id IN (${hostIds.map(() => '?').join(',')})`;
    const args = hostIds === '*' ? [] : hostIds;
    const rows = this.db
      .prepare(
        `SELECT fleet_runs.*,
                run_state.status AS state_status, run_state.cursor AS state_cursor,
                run_state.last_seen_at AS state_last_seen_at, run_state.last_error AS state_last_error,
                run_state.events_drained AS state_events_drained
           FROM fleet_runs
           LEFT JOIN run_state ON run_state.fleet_run_id = fleet_runs.fleet_run_id
           ${where}
          ORDER BY fleet_runs.created_at DESC`,
      )
      .all(...args) as unknown as JoinedRow[];
    return rows.map((row) => ({
      ...toBinding(row),
      state: row.state_status === null || row.state_status === undefined
        ? null
        : {
          fleetRunId: row.fleet_run_id, status: row.state_status, cursor: Number(row.state_cursor ?? 0),
          lastSeenAt: row.state_last_seen_at ?? null, lastError: row.state_last_error ?? null,
          eventsDrained: Number(row.state_events_drained ?? 0) === 1,
        },
    }));
  }

  recordState(input: RunStateWrite): void {
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

  /**
   * Advance only the event cursor, leaving status and staleness alone.
   *
   * Mirroring events and reconciling status are separate concerns with separate failure modes: a successful
   * event read must not imply anything about the Run's state, and going through recordState() would overwrite
   * a status the reconciliation sweep had just decided.
   */
  /**
   * Record how far the event log has been read, and whether it is finished.
   *
   * The flag reports what the last pass saw rather than being one-way: a Run's log can only stop growing once
   * the Run is terminal, and a terminal Run that still owes a log is re-read by the sweep regardless of this
   * value, so an occasional false here costs one extra read rather than missing events.
   */
  setCursor(fleetRunId: string, cursor: number, drained?: boolean): void {
    this.db
      .prepare(
        `INSERT INTO run_state (fleet_run_id, status, cursor, last_seen_at, last_error, events_drained)
         VALUES (?, ?, ?, NULL, NULL, ?)
         ON CONFLICT(fleet_run_id) DO UPDATE SET
           cursor = excluded.cursor,
           events_drained = excluded.events_drained`,
      )
      .run(fleetRunId, UNKNOWN, cursor, drained ? 1 : 0);
  }

  state(fleetRunId: string): RunState | null {
    const row = this.db.prepare('SELECT * FROM run_state WHERE fleet_run_id = ?').get(fleetRunId) as
      | StateRow
      | undefined;
    return row ? toState(row) : null;
  }
}

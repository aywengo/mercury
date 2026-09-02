import type { DatabaseSync } from 'node:sqlite';
import type { BindingStore } from './bindings.ts';
import type { ChildClient } from './child.ts';
import type { HostRegistry } from './registry.ts';
import { DispatchError, resolveHost } from './dispatch.ts';

/**
 * Event mirroring (docs/fleet-design.md section 8).
 *
 * The cursor is the correctness mechanism; SSE is only a latency optimisation. Everything here is therefore
 * built on `GET /events?after=<cursor>`, which is resumable, survives a Fleet restart, and cannot miss: the
 * child answers with the last sequence it actually returned, so paging from that value sees every event even
 * when a page is truncated. Mirroring by holding long-lived child connections instead would silently drop
 * events, because a child's SSE deliberately drops a wedged subscriber (Mercury issue #145) -- correct for a
 * browser tab, wrong for a federation layer that must not miss.
 */

export interface EventMirrorDeps {
  db: DatabaseSync;
  bindings: BindingStore;
  registry: HostRegistry;
  child: ChildClient;
  resolveToken: (credentialRef: string) => string;
}

export interface MirrorResult {
  fleetRunId: string;
  /** Events inserted this call. Zero is normal: most sweeps have nothing new. */
  inserted: number;
  /** Cursor after this call -- the sequence to resume from next time. */
  cursor: number;
  /** True when the child had more than one page, so the next sweep should continue promptly. */
  hasMore: boolean;
  /**
   * True only when the log was genuinely read to its end. Distinct from `!hasMore`: a child that refuses to
   * advance its cursor, a read that failed part way, or a page cap that stopped early all leave hasMore false
   * without the log having been drained. Persisting that as drained would tell a later sweep a terminal Run
   * owes nothing, and its log would go unread forever.
   */
  drained: boolean;
  /** Pages read in this call, capped so one chatty Run cannot monopolise a sweep. */
  pages: number;
}

export interface MirroredEvent {
  sequence: number;
  type: string;
  timestamp: string;
  /** Present only when the host opted into body mirroring. */
  payload?: unknown;
}

interface EventRow {
  sequence: number;
  type: string;
  timestamp: string;
  payload: string | null;
}

/**
 * Pages are capped per call rather than drained until exhausted. A Run emitting thousands of events per
 * second would otherwise hold the sweep open indefinitely and starve every other Run of reconciliation --
 * the same class of mistake as letting one slow host stall a probe sweep.
 */
const MAX_PAGES_PER_RUN = 5;
const PAGE_LIMIT = 1000;

function mirrorBodiesEnabled(db: DatabaseSync, hostId: string): boolean {
  const row = db.prepare('SELECT mirror_bodies FROM hosts WHERE id = ?').get(hostId) as
    | { mirror_bodies: number }
    | undefined;
  return row?.mirror_bodies === 1;
}

/**
 * Pull the next window of a Run's events and store them.
 *
 * Idempotent by construction: the primary key is the child's own (run, sequence) pair and inserts are
 * INSERT OR IGNORE, so re-reading a window after a crash costs nothing. That is what makes it safe to call
 * this from a timer that may be interrupted at any point.
 */
export async function mirrorEvents(
  deps: EventMirrorDeps,
  fleetRunId: string,
): Promise<MirrorResult> {
  const binding = deps.bindings.get(fleetRunId);
  if (!binding) throw new DispatchError(404, `no Fleet Run ${fleetRunId}`);
  if (!binding.childRunId) {
    // Not drained: there is no child Run to read yet, so nothing has been learned about any log.
    return { fleetRunId, inserted: 0, cursor: 0, hasMore: false, drained: false, pages: 0 };
  }
  const host = resolveHost(deps, binding.hostId);
  const withBodies = mirrorBodiesEnabled(deps.db, binding.hostId);
  const state = deps.bindings.state(fleetRunId);
  let cursor = state?.cursor ?? 0;

  const insert = deps.db.prepare(
    `INSERT OR IGNORE INTO fleet_events (fleet_run_id, sequence, type, timestamp, payload)
     VALUES (?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  let hasMore = false;
  let drained = false;
  let pages = 0;

  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const res = await deps.child.getEvents(host, binding.childRunId, cursor, PAGE_LIMIT);
    if (res.kind !== 'ok') {
      // Nothing is lost: the stored cursor still points at the last event actually mirrored, so the next
      // sweep resumes from here. A failed read must never advance the cursor.
      if (pages === 0) {
        throw new DispatchError(res.kind === 'rejected' ? res.status : 502,
          res.kind === 'rejected' ? `child refused events: ${res.detail}` : `events unreadable: ${res.reason}`);
      }
      break;
    }
    pages++;
    const events = res.value.events ?? [];
    if (events.length === 0) {
      // Nothing beyond the cursor and the child says so: the log is drained.
      hasMore = false;
      drained = !res.value.hasMore;
      break;
    }
    for (const ev of events) {
      const payload = withBodies && ev.payload !== undefined ? JSON.stringify(ev.payload) : null;
      const r = insert.run(fleetRunId, ev.sequence, ev.type, ev.timestamp, payload);
      if (r.changes > 0) inserted++;
    }
    // Resume from what the child says it returned, never from lastSequence. That distinction is the whole
    // content of Mercury issue #54 and the reason a truncated page is still safe to page from.
    const next = res.value.nextCursor;
    if (typeof next !== 'number' || next <= cursor) {
      // A child that will not advance the cursor would spin this loop forever. Stop rather than repeat -- but
      // do NOT call this drained. The log may hold plenty more; we simply cannot make progress right now, and
      // recording drained here is what would make a terminal Run's missing log permanent.
      hasMore = false;
      drained = false;
      break;
    }
    cursor = next;
    hasMore = Boolean(res.value.hasMore);
    if (!hasMore) {
      drained = true;
      break;
    }
  }

  // Reaching the per-call page cap with more still pending is explicitly not drained; the next pass continues.
  deps.bindings.setCursor(fleetRunId, cursor, drained);
  return { fleetRunId, inserted, cursor, hasMore, drained, pages };
}

/**
 * Read the mirrored window back out, in the same cursor shape the child uses, so a Fleet client resumes the
 * same way whether it is talking to Fleet or to a host directly.
 */
export function listMirroredEvents(
  db: DatabaseSync,
  fleetRunId: string,
  after: number,
  limit: number,
): { events: MirroredEvent[]; nextCursor: number; hasMore: boolean } {
  const rows = db
    .prepare(
      `SELECT sequence, type, timestamp, payload FROM fleet_events
        WHERE fleet_run_id = ? AND sequence > ?
        ORDER BY sequence ASC LIMIT ?`,
    )
    .all(fleetRunId, after, limit) as unknown as EventRow[];
  const events: MirroredEvent[] = rows.map((r) => {
    const base: MirroredEvent = { sequence: Number(r.sequence), type: r.type, timestamp: r.timestamp };
    if (r.payload !== null && r.payload !== undefined) {
      try {
        base.payload = JSON.parse(r.payload);
      } catch {
        // A payload that will not parse is still worth surfacing as text rather than dropping the event.
        base.payload = r.payload;
      }
    }
    return base;
  });
  const last = events.length > 0 ? events[events.length - 1].sequence : after;
  // Same rule as the child: the resume point is the last sequence returned, and hasMore is decided by whether
  // anything further exists -- not by the page size, which lies on the final partial page.
  const more = db
    .prepare('SELECT 1 AS x FROM fleet_events WHERE fleet_run_id = ? AND sequence > ? LIMIT 1')
    .get(fleetRunId, last) as unknown as { x: number } | undefined;
  return { events, nextCursor: last, hasMore: more !== undefined };
}

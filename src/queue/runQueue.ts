// SQLite-backed durable queue with leases (Mercury.md sections 16-17).
// Claim is atomic: UPDATE ... WHERE status='QUEUED' AND lease not held.

import type { DatabaseSync } from 'node:sqlite';
import { tx } from '../db/database.ts';
import type { Run } from '../domain/types.ts';
import { RunStore, type RunRow, rowToRun } from '../runs/runStore.ts';

/** Error recorded when a run's lease expires (worker crash); shared with the worker's event payload. */
export const LEASE_EXPIRED_ERROR = 'Worker lease expired (worker crash?)';

export class RunQueue {
  private db: DatabaseSync;
  private runs: RunStore;

  constructor(db: DatabaseSync, runs: RunStore) {
    this.db = db;
    this.runs = runs;
  }

  /** Atomically claim the oldest QUEUED run whose lease is free/expired. */
  claim(workerId: string, leaseMs: number, now = Date.now()): Run | null {
    const nowIso = new Date(now).toISOString();
    const candidate = this.db
      .prepare(
        `SELECT id FROM runs
         WHERE status = 'QUEUED' AND (lease_expires_at IS NULL OR lease_expires_at < ?)
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(nowIso) as { id: string } | undefined;
    if (!candidate) return null;
    const expiresAt = new Date(now + leaseMs).toISOString();
    const res = this.db
      .prepare(
        `UPDATE runs SET lease_owner = ?, lease_expires_at = ?
         WHERE id = ? AND status = 'QUEUED' AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
      )
      .run(workerId, expiresAt, candidate.id, nowIso);
    if (res.changes === 0) return null; // lost the race
    return this.runs.get(candidate.id);
  }

  renewLease(runId: string, workerId: string, leaseMs: number): boolean {
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const res = this.db
      .prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?')
      .run(expiresAt, runId, workerId);
    return res.changes === 1;
  }

  releaseLease(runId: string, workerId: string): void {
    this.db
      .prepare('UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?')
      .run(runId, workerId);
  }

  /** Number of runs currently QUEUED (queue backlog; Mercury.md section 25 alerting). */
  queuedCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE status = \'QUEUED\'').get() as { n: number };
    return Number(row.n);
  }

  /**
   * Requeue a run whose lease was lost (renew failed: owner changed, lease cleared,
   * or the run was reaped). Resume-from-scratch is the documented recovery path for
   * non-checkpointable agent state (Mercury.md section 16).
   * Returns true if the run was moved back to QUEUED; false if it was already
   * terminal or no longer in a requeueable state.
   */
  requeueLostLease(runId: string, fromWorker: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE runs
         SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL, started_at = NULL
         WHERE id = ? AND lease_owner IS NOT NULL AND lease_owner != ?
           AND status IN ('STARTING', 'RUNNING', 'NEEDS_INPUT')`,
      )
      .run(runId, fromWorker);
    return res.changes === 1;
  }

  /**
   * Reap runs whose lease expired (worker crashed).
   * QUEUED -> lease cleared (re-claimable). Active -> FAILED (infrastructure), per Mercury.md section 17.
   */
  reapExpiredLeases(now = Date.now()): { requeued: string[]; failed: string[] } {
    const nowIso = new Date(now).toISOString();
    const expired = this.db
      .prepare(
        `SELECT * FROM runs WHERE lease_expires_at IS NOT NULL AND lease_expires_at < ?
         AND status IN ('QUEUED', 'STARTING', 'RUNNING', 'NEEDS_INPUT')`,
      )
      .all(nowIso) as unknown as RunRow[];
    const requeued: string[] = [];
    const failed: string[] = [];
    // All-or-nothing: if the loop throws (e.g. SQLITE_BUSY under concurrent
    // writers), no partial reaping is left behind with events missing.
    tx(this.db, () => {
      for (const row of expired) {
        if (row.status === 'QUEUED') {
          const res = this.db
            .prepare('UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?')
            .run(row.id);
          if (res.changes === 1) requeued.push(row.id);
        } else {
          const res = this.db
            .prepare(
              `UPDATE runs SET status = 'FAILED', error = ?, error_kind = 'infrastructure', completed_at = ?
               WHERE id = ? AND status = ?`,
            )
            .run(LEASE_EXPIRED_ERROR, nowIso, row.id, row.status);
          // Only report runs this worker actually transitioned (a concurrent
          // reaper or the owning worker's finalize may have won the race).
          if (res.changes === 1) failed.push(row.id);
        }
      }
    });
    return { requeued, failed };
  }

  /**
   * Active lease owners for worker health reporting (GET /healthz/workers,
   * Mercury.md section 25): distinct lease_owner over RUNNING/STARTING runs with
   * unexpired leases, grouped with counts and the oldest (soonest-expiring) lease.
   */
  activeLeases(now = Date.now()): ActiveLease[] {
    const nowIso = new Date(now).toISOString();
    const rows = this.db
      .prepare(
        `SELECT lease_owner, COUNT(*) AS active_runs, MIN(lease_expires_at) AS oldest_expires
         FROM runs
         WHERE status IN ('RUNNING', 'STARTING')
           AND lease_owner IS NOT NULL
           AND (lease_expires_at IS NULL OR lease_expires_at > ?)
         GROUP BY lease_owner
         ORDER BY lease_owner ASC`,
      )
      .all(nowIso) as { lease_owner: string; active_runs: number; oldest_expires: string | null }[];
    return rows.map((r) => ({
      workerId: r.lease_owner,
      activeRuns: Number(r.active_runs),
      oldestLeaseExpiresAt: r.oldest_expires,
    }));
  }
}

export interface ActiveLease {
  workerId: string;
  activeRuns: number;
  oldestLeaseExpiresAt: string | null;
}

export { rowToRun };

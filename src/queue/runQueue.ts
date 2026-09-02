// SQLite-backed durable queue with leases (Mercury.md sections 16-17).
// Claim is atomic: UPDATE ... WHERE status='QUEUED' AND lease not held.

import type { DatabaseSync } from 'node:sqlite';
import { tx } from '../db/database.ts';
import type { Run } from '../domain/types.ts';
import { ACTIVE_WORK_STATUSES, isTerminal, LEASE_HOLDING_STATUSES, shutdownRequeueSources } from '../domain/stateMachine.ts';
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

  /**
   * Drop this worker's lease. Only does anything once the run is TERMINAL (issue #51).
   *
   * Clearing the lease on a still-active run strands it permanently, and this used to be a
   * silent footgun rather than a documented one: releaseLease sets lease_expires_at to NULL,
   * while reapExpiredLeases only selects rows with `lease_expires_at IS NOT NULL`. A
   * STARTING/RUNNING/NEEDS_INPUT run with a NULL lease is therefore invisible to the reaper
   * forever, and is not claimable either because its status is not QUEUED. Verified directly:
   *
   *   after releaseLease:  {"status":"RUNNING","leaseOwner":null,"leaseExpiresAt":null}
   *   reaper after +10min: {"requeued":[],"failed":[]}
   *   another worker can claim it: NO -> run is stuck
   *
   * Every legitimate caller (execute()'s finally) runs after finalize, so the run is already
   * terminal in the normal case and this guard is a no-op. What it prevents is the tempting
   * shortcut of calling releaseLease from a shutdown path -- which is exactly what issue #51
   * proposed, and which would have converted "fails after 60s and auto-retries" into "stuck
   * in RUNNING forever, no reaper, no retry, no operator signal".
   *
   * An active run that needs its lease dropped must be REQUEUED instead: see
   * requeueForShutdown. (Lease loss is NOT such a caller: the reaper owns that.)
   */
  releaseLease(runId: string, workerId: string): void {
    const row = this.runs.get(runId);
    if (!row || !isTerminal(row.status)) return;
    this.db
      .prepare('UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?')
      .run(runId, workerId);
  }

  /**
   * Hand an active run back to the queue because this worker is shutting down (issue #51).
   *
   * Matches `lease_owner = ?`: only the worker that actually holds the run may hand it back. That
   * scoping is what separates this from the removed requeueLostLease -- a shutdown requeue is the
   * owner returning its own run, not a bystander resetting somebody else's.
   *
   * Without this, SIGTERM left in-flight runs RUNNING until lease expiry (60s default), where the
   * reaper marked them FAILED(infrastructure) and they were auto-retried -- every deploy turned
   * running work into spurious infrastructure failures and duplicate agent spend.
   *
   * The status filter is GENERATED from the state machine (issue #59) rather than hardcoded, so
   * this cannot requeue from a state the §6 machine does not allow. The previous version hardcoded
   * ('STARTING','RUNNING','NEEDS_INPUT') and never consulted the machine at all, which is the
   * "bypasses the state machine" complaint: the write was in fact safe today, but only by
   * coincidence, and nothing would have noticed the machine and the SQL diverging.
   */
  requeueForShutdown(runId: string, workerId: string): boolean {
    const sources = shutdownRequeueSources();
    const placeholders = sources.map(() => '?').join(', ');
    const res = this.db
      .prepare(
        `UPDATE runs
         SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL, started_at = NULL
         WHERE id = ? AND lease_owner = ?
           AND status IN (${placeholders})`,
      )
      .run(runId, workerId, ...sources);
    return res.changes === 1;
  }

  /**
   * Claim the right to emit a given alert, across the WHOLE cluster (issue #142).
   *
   * Returns true for at most one worker per `intervalMs`. Both alert paths measure a cluster-global
   * quantity -- queue depth, and runs stuck with no owner filter -- and deduped with a per-process
   * boolean, so a 4-worker deployment sent 4 copies of one incident.
   *
   * One atomic statement, so two workers racing cannot both win. SQLite serialises writers (WAL plus
   * busy_timeout), and the ON CONFLICT ... WHERE means the loser's UPDATE is skipped rather than
   * queued: `changes === 0` is the "someone else already alerted" answer.
   *
   * A claim is released by {@link releaseAlert} when the condition clears, so the claim models an
   * EPISODE rather than a window. `intervalMs` is only the floor for a worker that JOINS an episode
   * already in progress, and the fallback bound if the holder never releases (see releaseAlert).
   */
  claimAlert(key: string, workerId: string, intervalMs: number, now = Date.now()): boolean {
    const nowIso = new Date(now).toISOString();
    const staleBeforeIso = new Date(now - intervalMs).toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO alert_claims (key, claimed_at, worker_id) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE
           SET claimed_at = excluded.claimed_at, worker_id = excluded.worker_id
          WHERE alert_claims.claimed_at <= ?`,
      )
      .run(key, nowIso, workerId, staleBeforeIso);
    return res.changes === 1;
  }

  /**
   * Release an alert claim held by this worker, so the NEXT episode can alert again (issue #142).
   *
   * Without this, a time-window claim would swallow a genuinely new episode: the backlog drains and
   * refills minutes later, and the floor silently suppresses the second alert. An existing test caught
   * exactly that. The claim therefore models the EPISODE, not a time window -- the interval passed to
   * claimAlert is only a floor for a worker that JOINS an episode already in progress.
   *
   * Scoped to worker_id so a worker that never won the claim cannot delete somebody else's.
   */
  releaseAlert(key: string, workerId: string): boolean {
    const res = this.db.prepare('DELETE FROM alert_claims WHERE key = ? AND worker_id = ?').run(key, workerId);
    return res.changes === 1;
  }

  /** Number of runs currently QUEUED (queue backlog; Mercury.md section 25 alerting). */
  queuedCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE status = \'QUEUED\'').get() as { n: number };
    return Number(row.n);
  }

  // requeueLostLease was REMOVED here (issue #59). Do not reintroduce it.
  //
  // It ran `SET status = 'QUEUED' ... WHERE lease_owner IS NOT NULL AND lease_owner != ?`, i.e.
  // it acted on a run whose lease belonged to SOMEONE ELSE. Proven on main 397f1b5: a worker with
  // no lease at all took a RUNNING run owned by an actively-executing worker and left it
  //
  //   status = RUNNING -> QUEUED,  lease_owner = worker-B -> null
  //
  // so a third worker could claim a run that a second worker was still executing: two agents, one
  // workspace, one set of git worktree writes. Its doc comment claimed the opposite ("executes
  // exactly once, on the worker that holds the lease now") while the SQL cleared that worker's
  // lease, and it cited section 16 to justify a same-runId requeue that section 21 forbids
  // ("Retry ... creates a new Run with a fresh runId").
  //
  // Lease-expiry recovery has exactly one owner: reapExpiredLeases, which takes the path section 6
  // sanctions (FAILED with error_kind=infrastructure, then retry-as-new-run). A worker that loses
  // its lease no longer owns the run and must not touch its state; see Worker.finalize.

  /**
   * Reap runs whose lease expired (worker crashed).
   * QUEUED -> lease cleared (re-claimable). Active -> FAILED (infrastructure), per Mercury.md section 17.
   *
   * @param onFailed invoked INSIDE the transaction, once per run this reaper actually
   *   transitioned to FAILED. Issue #61: the caller used to append the `error` and
   *   `run.failed` events AFTER this transaction committed, so a crash in that window left a
   *   run marked FAILED with no failure event at all -- the timeline silently contradicted the
   *   state, and an operator reading the run saw it stop with no explanation. Events and the
   *   state they describe must become visible together. If the callback throws, the whole reap
   *   rolls back, leaving the run RUNNING with its lease intact so it stays recoverable.
   *
   *   Safe to call EventStore.append from here: tx() is re-entrant (it tracks depth per
   *   connection), so the nested BEGIN joins this transaction instead of erroring.
   */
  reapExpiredLeases(
    now = Date.now(),
    onFailed?: (runId: string) => void,
  ): { requeued: string[]; failed: string[] } {
    const nowIso = new Date(now).toISOString();
    const expired = this.db
      .prepare(
        `SELECT * FROM runs WHERE lease_expires_at IS NOT NULL AND lease_expires_at < ?
         AND status IN (${placeholdersFor(LEASE_HOLDING_STATUSES)})`,
      )
      .all(nowIso, ...LEASE_HOLDING_STATUSES) as unknown as RunRow[];
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
          // NOTE: this raw-SQL error write bypasses the redactor (issue #36).
          // Safe only because LEASE_EXPIRED_ERROR is a static constant with no
          // dynamic content; if it is ever parameterized (worker id, run detail),
          // route it through a redacting path (RunStore.setError + redactor).
          // Clearing the lease here is the whole point of this statement (issue #53).
          // Marking the run FAILED while leaving lease_owner pointing at the dead worker
          // made the lease-loss recovery path unreachable in three linked ways:
          //   - renewLease matches `WHERE lease_owner = ?`, so it kept returning true and
          //     the owning worker never set leaseLost;
          //   - the run could never be resumed, since nothing else cleared the stale owner;
          //   - the worker therefore kept driving the agent -- burning compute and model
          //     spend on a run the database already called FAILED -- and then threw on an
          //     invalid state transition at finalize.
          // With the lease cleared, renewLease returns false and the abort path that
          // already exists lights up. Requeue still declines (the run is terminal), which
          // finalize already handles by leaving it FAILED; making the run resumable again
          // is M3, not this.
          const res = this.db
            .prepare(
              `UPDATE runs SET status = 'FAILED', error = ?, error_kind = 'infrastructure', completed_at = ?,
                      lease_owner = NULL, lease_expires_at = NULL
               WHERE id = ? AND status = ?`,
            )
            .run(LEASE_EXPIRED_ERROR, nowIso, row.id, row.status);
          // Only report runs this worker actually transitioned (a concurrent
          // reaper or the owning worker's finalize may have won the race).
          if (res.changes === 1) {
            failed.push(row.id);
            // Inside the tx, deliberately: see the onFailed contract above. If it throws, the
            // whole reap rolls back rather than leaving a FAILED run whose events never landed.
            onFailed?.(row.id);
          }
        }
      }
    });
    return { requeued, failed };
  }

  /**
   * Active lease owners for worker health reporting (GET /healthz/workers,
   * Mercury.md section 25): distinct lease_owner over ACTIVE_WORK_STATUSES runs with unexpired
   * leases, grouped with counts and the oldest (soonest-expiring) lease.
   *
   * The status set is DERIVED, not listed here. It used to be `('RUNNING','STARTING')`, which omitted
   * NEEDS_INPUT: a worker whose only run was parked waiting on a human reported zero workers and
   * zero claimed runs while holding a live lease and a live agent process, and the lease gauge was
   * blind to the lease most likely to be near expiry (issue #141).
   */
  activeLeases(now = Date.now()): ActiveLease[] {
    const nowIso = new Date(now).toISOString();
    const rows = this.db
      .prepare(
        `SELECT lease_owner, COUNT(*) AS active_runs, MIN(lease_expires_at) AS oldest_expires
         FROM runs
         WHERE status IN (${placeholdersFor(ACTIVE_WORK_STATUSES)})
           AND lease_owner IS NOT NULL
           AND (lease_expires_at IS NULL OR lease_expires_at > ?)
         GROUP BY lease_owner
         ORDER BY lease_owner ASC`,
      )
      // Statuses bind BEFORE the timestamp: the IN (...) list appears first in the statement and
      // SQLite binds positionally, not by name.
      .all(...ACTIVE_WORK_STATUSES, nowIso) as { lease_owner: string; active_runs: number; oldest_expires: string | null }[];
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

/** `?, ?, ?` for an IN (...) list. Values are still bound as parameters, never interpolated. */
function placeholdersFor(statuses: readonly string[]): string {
  return statuses.map(() => '?').join(', ');
}

export { rowToRun };

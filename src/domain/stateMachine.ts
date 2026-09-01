// Run lifecycle state machine (Mercury.md section 6).

import type { RunStatus } from './types.ts';

const TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  QUEUED: ['STARTING', 'CANCELLED'],
  STARTING: ['RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'QUEUED'],
  RUNNING: ['NEEDS_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'QUEUED'],
  NEEDS_INPUT: ['RUNNING', 'CANCELLED', 'TIMED_OUT', 'FAILED', 'QUEUED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
};

/**
 * The only reason an active run may go back to QUEUED (issue #59).
 *
 * Section 6 says the state machine is single-pass and section 21 says "Retry is not a state
 * transition: it creates a new Run". A back-edge to QUEUED therefore needs a justification that
 * retry does not have, and there is exactly one: graceful shutdown. When the worker holding a run
 * is asked to exit, the run is not finished and no work was lost -- failing it would turn every
 * deploy into spurious FAILED(infrastructure) records plus duplicate agent spend, and merely
 * releasing the lease would strand it in RUNNING forever (RunQueue.releaseLease explains why).
 *
 * This is deliberately NOT available for lease loss. Losing a lease means somebody else owns the
 * run now, and requeueing from there hands it to a THIRD worker while the second is still
 * executing -- two agents, one workspace. Lease-expiry recovery belongs to the reaper alone,
 * which takes the path section 6 sanctions: FAILED(infrastructure), then retry-as-new-run.
 *
 * RunQueue.requeueForShutdown is the sole caller and is owner-scoped (`lease_owner = ?`), so this
 * edge cannot be reached by a worker that does not hold the run.
 */
export const SHUTDOWN_REQUEUE_TARGET: RunStatus = 'QUEUED';

export const TERMINAL_STATUSES: RunStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid transition ${from} -> ${to}`);
  }
}

/**
 * Active statuses from which a graceful-shutdown requeue to QUEUED is legal.
 *
 * Derived from TRANSITIONS rather than restated, so the SQL guard in
 * RunQueue.requeueForShutdown cannot drift away from the declared machine. Restating the list in
 * both places is what let the two disagree in the first place.
 */
/**
 * Every status a run can hold a lease in, DERIVED from the machine: a lease exists only while the
 * run is still owned by a worker, and every terminal status clears it.
 *
 * Derived rather than restated for the reason issue #59 established for shutdownRequeueSources: the
 * list appears in SQL, and a list in SQL that is not generated from the machine can drift from it
 * with nothing noticing.
 *
 * QUEUED is in here and is not a mistake. RunQueue.claim sets lease_owner and lease_expires_at
 * BEFORE the run transitions to STARTING, so a worker that dies in that window leaves a QUEUED run
 * holding a lease. That is why reapExpiredLeases clears rather than fails on QUEUED.
 */
export const LEASE_HOLDING_STATUSES: readonly RunStatus[] = (
  Object.keys(TRANSITIONS) as RunStatus[]
).filter((s) => !isTerminal(s));

/**
 * Statuses in which a worker is ACTUALLY executing a run it owns: it has left the queue and has not
 * finished. QUEUED is excluded because a QUEUED run is not evidence of a live worker -- it is either
 * waiting to be claimed or sitting in the claim-to-STARTING window described above.
 *
 * This is the set behind worker health and the worker/claimed-run metrics. It used to be hardcoded
 * as ('RUNNING','STARTING') in RunQueue.activeLeases, which is why a run parked in NEEDS_INPUT --
 * still holding its lease, still holding a live agent process -- made that worker report zero
 * workers and zero claimed runs, and made the lease gauge blind to the lease most likely to be near
 * expiry (issue #141).
 */
export const ACTIVE_WORK_STATUSES: readonly RunStatus[] = LEASE_HOLDING_STATUSES.filter(
  (s) => s !== 'QUEUED',
);

/**
 * Statuses the stuck-run check examines. Deliberately narrower than ACTIVE_WORK_STATUSES: a run
 * stalled in STARTING never began executing, so it is a lease-expiry case for the reaper, not an
 * idle-agent case. That distinction is a judgement, so it is stated rather than derived.
 */
export const STUCK_CANDIDATE_STATUSES: readonly RunStatus[] = ACTIVE_WORK_STATUSES.filter(
  (s) => s !== 'STARTING',
);

export function shutdownRequeueSources(): RunStatus[] {
  return (Object.keys(TRANSITIONS) as RunStatus[]).filter((from) =>
    canTransition(from, SHUTDOWN_REQUEUE_TARGET),
  );
}

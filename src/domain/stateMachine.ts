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
export function shutdownRequeueSources(): RunStatus[] {
  return (Object.keys(TRANSITIONS) as RunStatus[]).filter((from) =>
    canTransition(from, SHUTDOWN_REQUEUE_TARGET),
  );
}

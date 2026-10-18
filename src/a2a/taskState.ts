// Run chain -> A2A task state (A0-4, issue #990; docs/a2a-design.md section 6.5).
//
// Every A2A response that carries a task state goes through `toTaskState`, so this file is the only
// place the mapping exists. Getting it wrong is not cosmetic: A2A terminal states are FINAL, so
// reporting FAILED for an attempt that is about to be retried tells a conforming client the work is
// over while Mercury is still going to do it, and reporting SUBMITTED for a task the caller already
// saw WORKING (a shutdown requeue, issue #51) reads as the work restarting from nothing.
//
// No SDK here, and nothing outside `src/domain` and `src/runs` types. Converting these names into
// SDK types is the boundary's job: the mapping has to be testable, and the spec's state names are
// stable strings, so a dependency would buy nothing and would put an SDK between the table in
// section 6.5 and the tests that pin it.

import type { GoalStatus, Run } from '../domain/types.ts';
import { hasStarted } from '../domain/types.ts';
import { chainState } from '../domain/runChain.ts';

/**
 * The task states Mercury can report, named exactly as the spec names them.
 *
 * A closed union rather than a string: `TASK_STATE_REJECTED`, `TASK_STATE_AUTH_REQUIRED` and
 * `TASK_STATE_UNSPECIFIED` are deliberately absent, so emitting one is a compile error rather than
 * a runtime possibility (section 6.5: a request that cannot become a Run gets an error and no task,
 * so there is nothing to reject and nothing to leave unspecified).
 */
export type TaskStateName =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED';

/** Every member of {@link TaskStateName}, as a runtime list, so tests can iterate the closed set. */
export const TASK_STATE_NAMES: readonly TaskStateName[] = [
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
];

export interface TaskStateResult {
  state: TaskStateName;
  /**
   * The latest attempt's `statusChangedAt` (#906), omitted when the row has none -- never
   * fabricated from `createdAt`, which measures when the Run was created, not how long it has been
   * in this state.
   */
  timestamp?: string;
  /** Why, for the states that report a failure. Omitted rather than blanked when there is nothing. */
  message?: string;
  /** Non-task metadata. Currently only the goal status, which is NEVER derived from the task state. */
  metadata?: { goalStatus: GoalStatus };
}

export interface TaskStateInput {
  /** The chain, in any order, with at least one attempt. See `chainState`. */
  chain: readonly Run[];
  /**
   * The latest attempt's goal status, or `null`/absent when the Run has no goal.
   *
   * Passed IN rather than read here, because a goal is a second store with its own lifecycle and
   * this module is pure. It rides along as metadata and changes nothing about `state`: a Run can be
   * COMPLETED with its goal `unmet`, and folding the two axes together would destroy the pair an
   * operator most needs to see (docs/goals.md).
   */
  goal?: GoalStatus | null;
}

/**
 * The chain's state, as an A2A task state.
 *
 * `retryPending` is what makes the FAILED and TIMED_OUT rows honest: a terminal attempt with a
 * recorded retry intent has NOT finished, so it reports WORKING. `final` is deliberately not
 * consulted -- it is a statement about the whole chain, and this maps the latest attempt's status,
 * with the retry rule as the one exception the design calls for.
 */
export function toTaskState(input: TaskStateInput): TaskStateResult {
  const { latest, retryPending } = chainState(input.chain);
  const mapped = mapLatest(latest, retryPending);
  const goalStatus = input.goal ?? null;
  return {
    state: mapped.state,
    ...(latest.statusChangedAt != null ? { timestamp: latest.statusChangedAt } : {}),
    ...(mapped.message !== undefined ? { message: mapped.message } : {}),
    // `absent` is the domain's word for "this Run has no goal row", not a goal state (see
    // metrics/collect.ts, which excludes it from the labelled series for the same reason), so it
    // must not be reported as a goal that exists.
    ...(goalStatus !== null && goalStatus !== 'absent' ? { metadata: { goalStatus } } : {}),
  };
}

/**
 * One arm per §6.5 row, EXHAUSTIVE over `RunStatus` with a `never` check: a new status is a compile
 * error here, not a silent `TASK_STATE_UNSPECIFIED` that a client reads as "the server is confused".
 *
 * `retryPending` is passed in rather than read from the Run because it is a property of the CHAIN
 * (the latest attempt is terminal, childless and still holding an intent), and only `chainState`
 * knows that.
 */
function mapLatest(latest: Run, retryPending: boolean): { state: TaskStateName; message?: string } {
  switch (latest.status) {
    case 'QUEUED':
    case 'STARTING':
      // A requeued attempt (issue #51) is back in QUEUED and passes through STARTING on the way out
      // again. It has already run, so it stays WORKING: reporting SUBMITTED would tell the caller the
      // work restarted from nothing on every deploy. `hasStarted` reads the persisted first-start
      // stamp, which the requeue deliberately does not clear.
      return { state: hasStarted(latest) ? 'TASK_STATE_WORKING' : 'TASK_STATE_SUBMITTED' };
    case 'RUNNING':
      return { state: 'TASK_STATE_WORKING' };
    case 'NEEDS_INPUT':
      return { state: 'TASK_STATE_INPUT_REQUIRED' };
    case 'COMPLETED':
      return { state: 'TASK_STATE_COMPLETED' };
    case 'FAILED':
      // A retry is pending: the chain is working, not failed. The alternative reports a terminal
      // state that the next attempt contradicts, which a conforming client has already acted on.
      if (retryPending) return { state: 'TASK_STATE_WORKING' };
      return { state: 'TASK_STATE_FAILED', ...(latest.error != null ? { message: latest.error } : {}) };
    case 'TIMED_OUT':
      if (retryPending) return { state: 'TASK_STATE_WORKING' };
      // A timed-out Run carries no `error` on the row -- the worker records the reason on the
      // `run.timed_out` event and transitions without setting one -- so the message is stated here
      // rather than read. Reading `error` alone would report a bare FAILED with no reason.
      return { state: 'TASK_STATE_FAILED', message: 'timed out' };
    case 'CANCELLED':
      return { state: 'TASK_STATE_CANCELED' };
    default: {
      const unreachable: never = latest.status;
      throw new Error(`unmapped RunStatus: ${String(unreachable)}`);
    }
  }
}

import type { GoalPatch, GoalStatus } from './types.ts';

/**
 * Translating a harness goal report into Mercury goal state (docs/goals.md sections 2, 6).
 *
 * Pure by design: the mapping is where a wrong assumption becomes a wrong status, so it is
 * isolated from process handling and tested directly.
 */

/**
 * What a harness reports. Field names follow PrimeAgent's `GoalState`
 * (`dist/core/goals.d.ts`), read from the type declaration rather than inferred from
 * emitted samples -- the two differ, and samples only show the states a run happened to hit.
 *
 * Deliberately loose: unknown extra fields are ignored, and a missing field is absent rather
 * than zero, because a zero reported as usage would silently overwrite real usage.
 */
export interface HarnessGoalReport {
  active?: boolean;
  status?: unknown;
  goalId?: unknown;
  objective?: unknown;
  tokenBudget?: unknown;
  tokensUsed?: unknown;
  timeUsedSeconds?: unknown;
  continuationsUsed?: unknown;
  lastReason?: unknown;
  lastError?: unknown;
}

/** A report translated into something to append and something to persist. */
export interface TranslatedGoalReport {
  eventType:
    | 'goal.updated'
    | 'goal.paused'
    | 'goal.budget_limited'
    | 'goal.error'
    | 'goal.completed';
  patch: GoalPatch;
  /** True when the harness reported a status Mercury could not interpret. */
  unrecognized?: string;
}

/**
 * Statuses only Mercury may write.
 *
 * `unmet` is Mercury's own inference at finalisation and `cancelled` is an operator action; a
 * harness that could set either could erase the distinction between "the harness said so" and
 * "Mercury inferred this", which is the one thing the whole design rests on. `absent` means
 * "no goal row at all" and is not a state anything can report.
 */
export const MERCURY_ONLY_GOAL_STATUSES: ReadonlySet<string> = new Set(['absent', 'cancelled', 'unmet']);

/** Harness statuses that mean "there is no goal", so there is nothing to record. */
const NO_GOAL_STATUSES: ReadonlySet<string> = new Set(['idle']);

const EVENT_BY_STATUS: Partial<Record<GoalStatus, TranslatedGoalReport['eventType']>> = {
  active: 'goal.updated',
  paused: 'goal.paused',
  budget_limited: 'goal.budget_limited',
  error: 'goal.error',
  complete: 'goal.completed',
};

function num(value: unknown): number | undefined {
  // Only a real number counts. `null` and `undefined` mean "not reported" and must stay
  // undefined: coercing them to 0 would overwrite recorded usage with a fabricated zero.
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Goal statuses no harness report may move away from.
 *
 * Without this guard a report arriving after `complete` -- a late frame, a resumed session
 * replaying its state, or any harness bug -- puts the row back to `active`. The Run then
 * finishes, Phase 1's settlement sees `active`, and Mercury writes `unmet` over the harness's
 * own `complete`. That is the one promise this whole feature exists to keep: Mercury never
 * overwrites the harness's verdict with an inference.
 *
 * `paused`, `budget_limited` and `error` are deliberately NOT here. Those are recoverable -- a
 * human resumes a paused goal, a budget is raised -- so a later report must be able to move
 * them. Only genuinely final statuses are protected.
 */
export const TERMINAL_GOAL_STATUSES: ReadonlySet<string> = new Set(['complete', 'cancelled', 'unmet']);

/** True when a harness report may change the status away from `current`. */
export function harnessMayRevise(current: string): boolean {
  return !TERMINAL_GOAL_STATUSES.has(current);
}

/**
 * Translate one harness goal report.
 *
 * Returns null when there is nothing to record: no status at all, or a status meaning "no goal
 * is set". Every other case produces an event, including an unrecognised status -- dropping
 * those quietly is the accept-and-ignore failure this feature was built to remove, so the
 * anomaly is reported instead of discarded.
 */
export function translateHarnessGoal(report: HarnessGoalReport | null | undefined): TranslatedGoalReport | null {
  if (!report || typeof report !== 'object') return null;
  const raw = typeof report.status === 'string' ? report.status : undefined;
  if (raw === undefined) return null;
  if (NO_GOAL_STATUSES.has(raw)) return null;

  const usage: GoalPatch = {
    // The objective is not immutable in Mercury's hands. PrimeAgent replaces a live objective
    // when a new one is set while one is active -- it does this on purpose, so the objective
    // survives context compaction -- and docs/goals.md 9 requires each change to be recorded
    // rather than treated as a protocol violation. Before this, the field was accepted and
    // dropped, which is worse than dropping it unseen: the dashboard kept rendering the ORIGINAL
    // objective as if it were current, showing the operator a success condition the harness had
    // already replaced.
    objective: text(report.objective),
    tokensUsed: num(report.tokensUsed),
    timeUsedSeconds: num(report.timeUsedSeconds),
    // PrimeAgent counts continuations, Hermes counts turns against --goal-max-turns. Same idea,
    // different denominators: they share a column and must never be compared across backends.
    turnsUsed: num(report.continuationsUsed),
    lastReason: text(report.lastReason),
    lastError: text(report.lastError),
    // Everything persisted here came from the harness, so the row says so. Only a harness may
    // set `complete`; an operator path is separate.
    source: 'harness',
  };

  if (MERCURY_ONLY_GOAL_STATUSES.has(raw)) {
    // A harness claiming one of these is reporting something Mercury cannot mean by it. Record
    // the anomaly as an error detail without changing the status: overwriting `active` with
    // `unmet` on a harness message would attribute a Mercury inference to the harness.
    return {
      eventType: 'goal.error',
      patch: {
        ...usage,
        lastError: `harness reported goal status "${raw}", which only Mercury may set`,
      },
      unrecognized: raw,
    };
  }

  const status = raw as GoalStatus;
  const eventType = EVENT_BY_STATUS[status];
  if (!eventType) {
    // Unknown status: surface it, do not invent a state for it. The stored status is left
    // alone because Mercury genuinely does not know what the goal is now.
    return {
      eventType: 'goal.error',
      patch: { ...usage, lastError: `unrecognized harness goal status "${raw}"` },
      unrecognized: raw,
    };
  }

  if (status === 'paused') {
    // `paused` is the one status whose operator response is a human action, so the reason has
    // to survive into its own field rather than only the event payload.
    return { eventType, patch: { ...usage, status, pausedReason: text(report.lastReason) ?? text(report.objective) } };
  }
  return { eventType, patch: { ...usage, status } };
}

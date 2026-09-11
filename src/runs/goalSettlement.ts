import type { Run, RunStatus } from '../domain/types.ts';
import type { GoalStore } from './goalStore.ts';

/**
 * Settles an abandoned goal when its Run reaches a terminal status.
 *
 * This is the ONLY goal status Mercury originates. Every other status is a harness report
 * relayed verbatim; Mercury never judges whether work was good, only whether the harness ever
 * said the objective was met. See docs/goals.md section 4: goal status is a separate axis from
 * Run status and is never derived from it.
 *
 * The row that matters is `Run = COMPLETED` with `goal = active`. That combination is invisible
 * today, and it is the whole reason this feature exists.
 */
export interface GoalSettlementDeps {
  goals: GoalStore;
  events: { append(runId: string, type: string, payload: Record<string, unknown>): unknown };
  now?: () => string;
}

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

/**
 * Why the goal stopped short, phrased so the operator has something to act on. Distinct per
 * terminal status: a cancelled Run and a timed-out Run and a failed Run want different next
 * actions, and collapsing them into one reason would lose the only useful part.
 */
function unmetReason(terminal: RunStatus, started: boolean): string {
  if (!started) {
    // Never reached RUNNING, so the harness never had the goal at all. Saying so keeps this
    // distinct from "attempted and stopped short" without needing a separate status.
    return `the Run reached terminal status ${terminal} before it ever started, so the goal was never attempted`;
  }
  switch (terminal) {
    case 'COMPLETED':
      // The headline case: the agent finished and never declared the objective met. This is
      // NOT a verdict that the work is bad -- the harness stopped reporting before saying
      // complete, which includes the agent simply never calling goal.complete().
      return 'the Run completed without the harness ever reporting the objective met';
    case 'TIMED_OUT':
      return 'the Run hit its duration limit while the goal was still active';
    case 'CANCELLED':
      return 'the Run was cancelled while the goal was still active';
    case 'FAILED':
      return 'the Run failed while the goal was still active';
    default:
      return `the Run reached terminal status ${terminal} while the goal was still active`;
  }
}

/**
 * Marks an still-open goal `unmet` and appends `goal.unmet`.
 *
 * Called from the single Run status-transition choke point, so it covers every exit route --
 * worker completion, failure, timeout, cancellation, the API cancel path and lease loss --
 * without each of them having to remember to do it.
 *
 * Every terminal Run with a still-open goal closes that goal. Leaving it `active` on a Run
 * that will never run again is the dangling state this feature exists to remove, so there is
 * deliberately no "leave it alone if it never started" escape: a Run cancelled while QUEUED
 * closes its goal too. What separates "never attempted" from "attempted and stopped short" is
 * the reason text and the `attempted` flag, not a status that silently stays open.
 */
export function settleGoalOnTerminal(deps: GoalSettlementDeps, run: Run, to: RunStatus): void {
  if (!TERMINAL_STATUSES.has(to)) return;
  const goal = deps.goals.get(run.id);
  if (!goal) return;
  // Only an `active` goal is settled. If the harness reported `complete`, `cancelled`,
  // `budget_limited` or `error`, that report stands -- overwriting the harness's own word with
  // Mercury's inference would destroy the more truthful record and invent a verdict.
  if (goal.status !== 'active') return;

  const started = run.startedAt !== null && run.startedAt !== undefined;
  const now = (deps.now ?? (() => new Date().toISOString()))();
  deps.goals.update(run.id, { status: 'unmet' }, now);
  deps.events.append(run.id, 'goal.unmet', {
    runId: run.id,
    status: 'unmet',
    reason: unmetReason(to, started),
    terminalStatus: to,
    // Distinguishes "never attempted" from "attempted and stopped short" without a second
    // status value, so a dashboard can separate them and the row still closes either way.
    attempted: started,
    // Carried through so the timeline entry reads on its own, without a join.
    objective: goal.objective,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    turnsUsed: goal.turnsUsed,
  });
}

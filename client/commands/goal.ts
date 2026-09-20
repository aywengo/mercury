// Goal commands: `runs goal` and `runs goal-cancel` (docs/goals.md §8, §13.6).
//
// The client-surface gap recorded in docs/status.md ("Goal setting has no client surface"): the
// server has served these two routes since the goal feature shipped, and the dashboard and CLI
// read goal state, but nothing in `mercuryctl` could call them. `runs goal` closes the read;
// `runs goal-cancel` closes the one mutation the API exposes -- cancel is deliberately the ONLY
// goal mutation, because it asserts nothing about whether the work was done (goals.md §12).
//
// Rendering reuses the `runs show` goal block: one renderer for goal state, or two renderings
// that drift the way a second command list would.

import type { GoalState } from '../api/protocol.ts';
import { makeColorizer, sanitizeForTerminal, type ColorName } from '../output/human.ts';
import type { CommandContext } from './context.ts';

/** Shared field renderer: label padded past the longest label any goal line can emit. */
function goalField(color: (c: ColorName, s: string) => string): (label: string, value: string) => string {
  return (label, value) => `${color('dim', label.padEnd(14))}${value}`;
}

/** `unmet` is the one status Mercury originates and the one an operator most needs to see. */
export function goalColor(status: string): ColorName {
  if (status === 'complete') return 'green';
  if (status === 'unmet' || status === 'error') return 'red';
  if (status === 'paused' || status === 'budget_limited') return 'yellow';
  if (status === 'cancelled') return 'dim';
  return 'cyan';
}

function goalContractLines(
  contract: GoalState['contract'],
  field: (label: string, value: string) => string,
  color: (c: ColorName, s: string) => string,
): string[] {
  if (!contract) return [];
  const labels: [keyof NonNullable<GoalState['contract']>, string][] = [
    ['outcome', 'must achieve'],
    ['verification', 'verified by'],
    ['constraints', 'constraints'],
    ['boundaries', 'out of scope'],
    ['stopWhen', 'stop when'],
  ];
  const lines: string[] = [];
  for (const [key, label] of labels) {
    const value = contract[key];
    if (value === undefined || value.length === 0) continue;
    lines.push(field(label, color('dim', sanitizeForTerminal(value))));
  }
  return lines;
}

/**
 * One line per declared gate, rendered as what was ASKED FOR, never as an outcome: Mercury
 * records the spec and does not execute gates (docs/goals.md §5), so a gate list must not read
 * as a passing test report -- no tick, no success colour.
 */
function goalGateLines(
  gates: GoalState['gates'],
  field: (label: string, value: string) => string,
  color: (c: ColorName, s: string) => string,
): string[] {
  if (!gates || gates.length === 0) return [];
  return gates.map((g, i) => {
    const seconds = g.timeoutMs / 1000;
    const timeout = Number.isInteger(seconds) && seconds >= 1
      ? `${seconds}s`
      : `${g.timeoutMs}ms`;
    const retries = g.maxRetries > 0 ? `, ${g.maxRetries} ${g.maxRetries === 1 ? 'retry' : 'retries'}` : '';
    const meta = color('dim', ` (timeout ${timeout}${retries})`);
    return field(`gate ${i + 1}`, `${sanitizeForTerminal(g.command)}${meta}`);
  });
}

/** The full human rendering of one goal state -- the same block `runs show` prints. */
export function goalDetailLines(goal: GoalState, color: (c: ColorName, s: string) => string): string[] {
  const field = goalField(color);
  const lines = [field('goal', color(goalColor(goal.status), sanitizeForTerminal(goal.status)))];
  lines.push(field('objective', sanitizeForTerminal(goal.objective)));
  for (const line of goalContractLines(goal.contract, field, color)) lines.push(line);
  if (goal.tokenBudget !== undefined) {
    const used = goal.tokensUsed ?? 0;
    lines.push(field('goal tokens', `${used} / ${goal.tokenBudget}`));
  } else if (goal.tokensUsed !== undefined) {
    lines.push(field('goal tokens', String(goal.tokensUsed)));
  }
  if (goal.turnsUsed !== undefined) lines.push(field('goal turns', String(goal.turnsUsed)));
  for (const line of goalGateLines(goal.gates, field, color)) lines.push(line);
  // `unmet` alone does not say whether the harness ever held the objective; the two cases want
  // opposite reactions (issue #489). Printed only when it is false.
  if (goal.status === 'unmet' && goal.attempted === false) {
    lines.push(field('goal started', color('yellow', 'never -- the harness never received the objective')));
  }
  if (goal.pausedReason) lines.push(field('goal paused', sanitizeForTerminal(goal.pausedReason)));
  if (goal.lastError) lines.push(field('goal error', color('red', sanitizeForTerminal(goal.lastError))));
  if (goal.lastReason && !goal.pausedReason) lines.push(field('goal reason', sanitizeForTerminal(goal.lastReason)));
  return lines;
}

/** Human output for `runs goal <run-id>`. */
export function renderGoalDetail(runId: string, goal: GoalState, ctx: CommandContext, isTty: boolean): string {
  if (ctx.json) return JSON.stringify({ runId, goal });
  const { color } = makeColorizer({ noColor: ctx.noColor, isTty, json: ctx.json });
  return [`run ${sanitizeForTerminal(runId)}`, ...goalDetailLines(goal, color)].join('\n');
}

/**
 * Human output for `runs goal-cancel <run-id>`.
 *
 * States the verdict rule the server enforces: cancelling an already-terminal goal is a 409,
 * because `complete` and `unmet` are records, and a cancel that erased one would destroy the
 * thing the feature exists to keep (goals.md §12).
 */
export function renderGoalCancel(runId: string, goal: GoalState, ctx: CommandContext, isTty: boolean): string {
  if (ctx.json) return JSON.stringify({ runId, goal });
  const { color } = makeColorizer({ noColor: ctx.noColor, isTty, json: ctx.json });
  return [
    `${color('green', 'goal cancelled')} for ${color('cyan', sanitizeForTerminal(runId))}`,
    ...goalDetailLines(goal, color),
  ].join('\n');
}

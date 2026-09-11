// `mercuryctl runs show <run-id>` (§6.1).
//
// A terminal status is DATA, not a command failure: showing a failed Run exits 0. Only a command
// that explicitly waits for an outcome encodes that outcome in its exit status, otherwise
// `mercuryctl runs show $id || ...` would treat "I successfully told you it failed" as a new failure.

import type { RunDetailResponse } from '../api/protocol.ts';
import { makeColorizer, sanitizeForTerminal, statusColor, type ColorName } from '../output/human.ts';
import type { CommandContext } from './context.ts';


/**
 * Goal lines for human output.
 *
 * Three states, all rendered differently, because they mean different things:
 *   GoalState -- there is a goal, and this is its status
 *   null      -- the server answered and the Run has no goal
 *   undefined -- the server predates goals, so nothing is known
 *
 * The last one must not print as "none". That would tell an operator a Run was never given an
 * objective on the strength of a server that never had the field.
 */
function goalLines(response: RunDetailResponse, color: (c: ColorName, s: string) => string): string[] {
  const goal = response.goal;
  const field = (label: string, value: string): string => `${color('dim', label.padEnd(12))}${value}`;
  if (goal === undefined) {
    return [field('goal', color('dim', 'unknown (server does not report goals)'))];
  }
  if (goal === null) {
    return [field('goal', color('dim', 'none'))];
  }
  const lines = [field('goal', color(goalColor(goal.status), sanitizeForTerminal(goal.status)))];
  lines.push(field('objective', sanitizeForTerminal(goal.objective)));
  if (goal.tokenBudget !== undefined) {
    const used = goal.tokensUsed ?? 0;
    lines.push(field('goal tokens', `${used} / ${goal.tokenBudget}`));
  } else if (goal.tokensUsed !== undefined) {
    lines.push(field('goal tokens', String(goal.tokensUsed)));
  }
  if (goal.turnsUsed !== undefined) lines.push(field('goal turns', String(goal.turnsUsed)));
  if (goal.pausedReason) lines.push(field('goal paused', sanitizeForTerminal(goal.pausedReason)));
  if (goal.lastError) lines.push(field('goal error', color('red', sanitizeForTerminal(goal.lastError))));
  if (goal.lastReason && !goal.pausedReason) lines.push(field('goal reason', sanitizeForTerminal(goal.lastReason)));
  return lines;
}

/** `unmet` is the one status Mercury originates and the one an operator most needs to see. */
function goalColor(status: string): ColorName {
  if (status === 'complete') return 'green';
  if (status === 'unmet' || status === 'error') return 'red';
  if (status === 'paused' || status === 'budget_limited') return 'yellow';
  if (status === 'cancelled') return 'dim';
  return 'cyan';
}

export function renderRunDetail(response: RunDetailResponse, ctx: CommandContext, isTty: boolean): string {
  if (ctx.json) return JSON.stringify(response);
  const { color } = makeColorizer({ noColor: ctx.noColor, isTty, json: ctx.json });
  const run = response.run;
  const field = (label: string, value: string): string =>
    `${color('dim', `${label.padEnd(12)}`)}${value}`;

  // Every value below is sanitised at the point it enters the line, BEFORE colouring -- sanitising after
  // colouring would strip the colour codes along with any injected sequence. A reviewer caught that
  // `agent` was sanitised in `runs list` and left raw here: the same field, two render paths, and fixing
  // one of them is exactly the mistake a field-by-field audit makes. The invariant test in
  // client/test/output.test.ts now asserts that human output with colour off contains no escape bytes at
  // all, so the next path that forgets fails a test rather than waiting for an audit.
  const lines: string[] = [
    field('run', color('cyan', sanitizeForTerminal(run.id))),
    field('status', color(statusColor(run.status), sanitizeForTerminal(run.status))),
    // Printed on the line directly under Run status, and never in place of it. A Run that
    // COMPLETED with the goal unmet has to show both words; showing only one reproduces the
    // problem this feature exists to expose (docs/goals.md 4).
    ...goalLines(response, color),
    field('agent', sanitizeForTerminal(run.agent)),
    field('owner', sanitizeForTerminal(run.ownerId)),
    field('attempt', String(run.attempt)),
    field('created', sanitizeForTerminal(run.createdAt)),
    field('started', sanitizeForTerminal(run.startedAt ?? '-')),
    field('completed', sanitizeForTerminal(run.completedAt ?? '-')),
  ];
  if (run.retryOf) lines.push(field('retry of', color('cyan', sanitizeForTerminal(run.retryOf))));
  const repo = run.repository.url ?? run.repository.localPath ?? '-';
  lines.push(field('repository', sanitizeForTerminal(repo)));
  if (run.workspaceBranch) lines.push(field('branch', sanitizeForTerminal(run.workspaceBranch)));
  if (run.prUrl) lines.push(field('pr', sanitizeForTerminal(run.prUrl)));
  if (run.finalCommits.length > 0) {
    lines.push(field('commits', run.finalCommits.map(sanitizeForTerminal).join(', ')));
  }
  if (run.error) lines.push(field('error', color('red', sanitizeForTerminal(run.error))));
  if (run.errorKind) lines.push(field('caused by', sanitizeForTerminal(run.errorKind)));

  lines.push('', color('dim', 'task'), sanitizeForTerminal(run.task));

  if (response.skills.length > 0) {
    lines.push('', color('dim', `skills (${response.skills.length})`));
    for (const skill of response.skills) {
      lines.push(`  ${sanitizeForTerminal(skill.id)} ${color('dim', sanitizeForTerminal(skill.version))}`);
    }
  }
  return lines.join('\n');
}

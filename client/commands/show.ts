// `mercuryctl runs show <run-id>` (§6.1).
//
// A terminal status is DATA, not a command failure: showing a failed Run exits 0. Only a command
// that explicitly waits for an outcome encodes that outcome in its exit status, otherwise
// `mercuryctl runs show $id || ...` would treat "I successfully told you it failed" as a new failure.

import type { GoalState, RunDetailResponse } from '../api/protocol.ts';
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
  for (const line of goalGateLines(goal.gates, field, color)) {
    lines.push(line);
  }
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
    ...harnessVersionLines(run, field, color),
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
/**
 * One line per declared gate.
 *
 * Rendered as what was ASKED FOR, never as an outcome: Mercury records the spec and does not
 * execute gates (docs/goals.md 5), so a gate list next to a COMPLETED Run must not read as a
 * passing test report. The label says "gate" and nothing else -- no tick, no colour implying
 * success -- because the nearest thing to that misreading this repo already has a number
 * (`test.*` events cover real results).
 *
 * The command is attacker-influenced text that came from the caller and came back around, so it
 * goes through sanitizeForTerminal like every other free-text field here.
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
/**
 * Which harness actually executed the Run (docs/goals.md 13.1).
 *
 * Rendered as its own line rather than folded into `agent`, because the two answer different
 * questions and the second is the one that made issue #465 hard to close: `agent` says which
 * adapter ran, this says which binary it talked to. "unknown" is printed in full rather than
 * left blank -- 13.7 requires undetermined to render as itself, and a blank reads as "same as
 * always" to someone skimming, which is exactly the wrong inference when the whole point is that
 * the installed artifact may not be what `main` expects.
 */
function harnessVersionLines(
  run: RunDetailResponse['run'],
  field: (label: string, value: string) => string,
  color: (c: ColorName, s: string) => string,
): string[] {
  const version = run.agentVersion;
  if (version) {
    const raw = run.agentVersionRaw && run.agentVersionRaw !== version
      ? color('dim', ` (${sanitizeForTerminal(run.agentVersionRaw)})`)
      : '';
    return [field('harness', `${sanitizeForTerminal(version)}${raw}`)];
  }
  const raw = run.agentVersionRaw;
  if (raw) {
    // Probed and got something, but it was not a parsable version. Showing the raw output is the
    // difference between "the probe is broken" being diagnosable and being a mystery.
    return [field('harness', color('yellow', `version unknown (${sanitizeForTerminal(raw)})`))];
  }
  return [field('harness', color('dim', 'version unknown'))];
}

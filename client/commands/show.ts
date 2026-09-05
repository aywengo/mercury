// `mercuryctl runs show <run-id>` (§6.1).
//
// A terminal status is DATA, not a command failure: showing a failed Run exits 0. Only a command
// that explicitly waits for an outcome encodes that outcome in its exit status, otherwise
// `mercuryctl runs show $id || ...` would treat "I successfully told you it failed" as a new failure.

import type { RunDetailResponse } from '../api/protocol.ts';
import { makeColorizer, sanitizeForTerminal, statusColor } from '../output/human.ts';
import type { CommandContext } from './context.ts';

export function renderRunDetail(response: RunDetailResponse, ctx: CommandContext, isTty: boolean): string {
  if (ctx.json) return JSON.stringify(response);
  const { color } = makeColorizer({ noColor: ctx.noColor, isTty, json: ctx.json });
  const run = response.run;
  const field = (label: string, value: string): string =>
    `${color('dim', `${label.padEnd(12)}`)}${value}`;

  const lines: string[] = [
    field('run', color('cyan', run.id)),
    field('status', color(statusColor(run.status), run.status)),
    field('agent', run.agent),
    field('owner', run.ownerId),
    field('attempt', String(run.attempt)),
    field('created', run.createdAt),
    field('started', run.startedAt ?? '-'),
    field('completed', run.completedAt ?? '-'),
  ];
  if (run.retryOf) lines.push(field('retry of', color('cyan', run.retryOf)));
  const repo = run.repository.url ?? run.repository.localPath ?? '-';
  lines.push(field('repository', sanitizeForTerminal(repo)));
  if (run.workspaceBranch) lines.push(field('branch', sanitizeForTerminal(run.workspaceBranch)));
  if (run.prUrl) lines.push(field('pr', sanitizeForTerminal(run.prUrl)));
  if (run.finalCommits.length > 0) lines.push(field('commits', run.finalCommits.join(', ')));
  if (run.error) lines.push(field('error', color('red', sanitizeForTerminal(run.error))));
  if (run.errorKind) lines.push(field('caused by', sanitizeForTerminal(run.errorKind)));

  lines.push('', color('dim', 'task'), sanitizeForTerminal(run.task));

  if (response.skills.length > 0) {
    lines.push('', color('dim', `skills (${response.skills.length})`));
    for (const skill of response.skills) {
      lines.push(`  ${sanitizeForTerminal(skill.id)} ${color('dim', skill.version)}`);
    }
  }
  return lines.join('\n');
}

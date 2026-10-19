// plan-sync: the post-merge half of the PLAN.md tracker (issue #1004).
//
// Runs in the `plan-sync` workflow on every push to main. It finds the PR(s) that produced the
// pushed commit, reads their closing issues, and sets each tracked PLAN.md row to `done` with that
// PR's number -- in ONE commit, as the Actions bot. This is what replaced the per-PR row edit,
// which made two open PRs in one workstream conflict on adjacent rows every time one merged first.
//
// Idempotent by construction: a row already `done` with the PR number is left alone, and a commit
// with no closing issues (including this workflow's own commit) changes nothing -- which is also
// what stops the workflow from re-triggering itself forever. A concurrent plan-sync is handled by
// rebasing and retrying the push.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { applyClosing, parsePlan } from './planTracker.ts';

const repo = process.env.GITHUB_REPOSITORY ?? '';
const sha = process.env.GITHUB_SHA ?? '';
if (!repo || !sha) {
  console.error('plan-sync: GITHUB_REPOSITORY and GITHUB_SHA are required');
  process.exit(2);
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

// The PR(s) that produced this commit. A direct push (including this workflow's own commit) has none.
const prs = JSON.parse(
  gh(['api', `/repos/${repo}/commits/${sha}/pulls`, '--jq', 'map(.number)']).trim(),
) as number[];

const closing: { issue: number; pr: number }[] = [];
for (const pr of prs) {
  // GraphQL rather than `gh pr view --json closingIssuesReferences`: that field is only a `--json`
  // field in newer gh, and the REST PR object does not carry it, so the GraphQL query is the one
  // form that works on every runner.
  const refs = JSON.parse(
    gh(['api', 'graphql', '-f', 'query=query($n:Int!){ repository(owner:"' + repo.split('/')[0] + '", name:"' + repo.split('/')[1] + '"){ pullRequest(number:$n){ closingIssuesReferences(first:10){ nodes{ number } } } } }', '-F', 'n=' + pr, '--jq', '.data.repository.pullRequest.closingIssuesReferences.nodes[].number']).trim(),
  ) as number[];
  for (const issue of refs) closing.push({ issue, pr });
}
if (closing.length === 0) {
  console.log('plan-sync: no closing issues for this commit; nothing to do');
  process.exit(0);
}

const plan = readFileSync('PLAN.md', 'utf8');
const { errors } = parsePlan(plan);
if (errors.length) {
  console.error('plan-sync: PLAN.md is malformed:\n' + errors.join('\n'));
  process.exit(1);
}
const { plan: next, changed } = applyClosing(plan, closing);
if (!changed) {
  console.log(`plan-sync: no PLAN.md changes needed for ${closing.map((c) => `#${c.issue}`).join(', ')}`);
  process.exit(0);
}

writeFileSync('PLAN.md', next);
const summary = closing.map((c) => `#${c.issue} via #${c.pr}`).join(', ');
execFileSync('git', ['config', 'user.name', 'github-actions[bot]']);
execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
execFileSync('git', ['add', 'PLAN.md']);
execFileSync('git', ['commit', '-m', `PLAN.md: mark ${summary} done (plan-sync)`]);
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    execFileSync('git', ['push', 'origin', 'HEAD:main']);
    console.log(`plan-sync: pushed PLAN.md update for ${summary}`);
    process.exit(0);
  } catch {
    // A concurrent plan-sync landed first; rebase onto it and try again.
    execFileSync('git', ['pull', '--rebase', 'origin', 'main']);
  }
}
console.error('plan-sync: could not push after 5 attempts');
process.exit(1);

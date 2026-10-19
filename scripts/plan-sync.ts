// plan-sync: the post-merge half of the PLAN.md tracker (issue #1004).
//
// Runs in the `plan-sync` workflow on every push to main. It finds the PR(s) that produced the
// pushed commit, reads their closing issues, and sets each tracked PLAN.md row to `done` with that
// PR's number -- in ONE commit, as the Actions bot. This is what replaced the per-PR row edit,
// which made two open PRs in one workstream conflict on adjacent rows every time one merged first.
//
// It also keeps `docs/status.md` consistent: the status-consistency guard fails when status.md calls
// a merged PR "in review", and "merged" is derived from PLAN.md `done` rows. Because the row becomes
// `done` here (post-merge), plan-sync must remove the "in review" description of the PRs it marks
// done, or the guard would fail on a later run.
//
// Idempotent by construction: a row already `done` with the PR number is left alone, and a commit
// with no closing issues (including this workflow's own commit) changes nothing -- which is also
// what stops the workflow from re-triggering itself forever. A concurrent plan-sync is handled by
// regenerating the update against the fresh main and retrying the push.
//
// CI: the push uses the operator PAT, so it fires `push` workflows and `ci` runs on the generated
// commit automatically (the repo's "any push to main runs the full suite" policy).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { applyClosing, parsePlan, syncStatusForMerged } from './planTracker.ts';

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
    gh(['api', 'graphql', '-f', 'query=query($n:Int!){ repository(owner:"' + repo.split('/')[0] + '", name:"' + repo.split('/')[1] + '"){ pullRequest(number:$n){ closingIssuesReferences(first:10){ nodes{ number } } } } }', '-F', 'n=' + pr, '--jq', '.data.repository.pullRequest.closingIssuesReferences.nodes | map(.number)']).trim(),
  ) as number[];
  for (const issue of refs) closing.push({ issue, pr });
}
if (closing.length === 0) {
  console.log('plan-sync: no closing issues for this commit; nothing to do');
  process.exit(0);
}

const summary = closing.map((c) => `#${c.issue} via #${c.pr}`).join(', ');
const mergedPrs = new Set(closing.map((c) => c.pr));
execFileSync('git', ['config', 'user.name', 'github-actions[bot]']);
execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);

// Build the plan+status commit from the current working tree. Returns false when nothing changed.
function buildCommit(): boolean {
  const plan = readFileSync('PLAN.md', 'utf8');
  const { errors } = parsePlan(plan);
  if (errors.length) {
    console.error('plan-sync: PLAN.md is malformed:\n' + errors.join('\n'));
    process.exit(1);
  }
  const applied = applyClosing(plan, closing);
  let nextStatus: string | undefined;
  let statusChanged = false;
  if (existsSync('docs/status.md')) {
    const status = readFileSync('docs/status.md', 'utf8');
    const synced = syncStatusForMerged(status, mergedPrs);
    nextStatus = synced.text;
    statusChanged = synced.changed;
  }
  if (!applied.changed && !statusChanged) {
    console.log(`plan-sync: no PLAN.md/status.md changes needed for ${summary}`);
    return false;
  }
  writeFileSync('PLAN.md', applied.plan);
  execFileSync('git', ['add', 'PLAN.md']);
  if (statusChanged && nextStatus !== undefined) {
    writeFileSync('docs/status.md', nextStatus);
    execFileSync('git', ['add', 'docs/status.md']);
  }
  execFileSync('git', ['commit', '-m', `PLAN.md: mark ${summary} done (plan-sync)`]);
  return true;
}

if (!buildCommit()) process.exit(0);

for (let attempt = 0; attempt < 5; attempt++) {
  try {
    execFileSync('git', ['push', 'origin', 'HEAD:main']);
    console.log(`plan-sync: pushed PLAN.md update for ${summary}`);
    // The push uses the operator PAT, so it fires `push` workflows: `ci` runs on the generated
    // commit automatically (the repo's "any push to main runs the full suite" policy).
    process.exit(0);
  } catch {
    // A concurrent plan-sync landed first. Regenerate the update against the fresh main instead of
    // rebasing the stale edit: two runs editing adjacent rows would otherwise hit the very merge
    // conflict this workflow exists to remove. Discard our commit and re-apply to origin/main.
    execFileSync('git', ['fetch', 'origin', 'main']);
    execFileSync('git', ['reset', '--hard', 'origin/main']);
    if (!buildCommit()) process.exit(0);
  }
}
console.error('plan-sync: could not push after 5 attempts');
process.exit(1);

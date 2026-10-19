// PLAN.md tracker check (PLAN.md "Rules" 2 and 4).
//
// The tracker has two readers with different jobs:
//
//   - PR time (`plan-tracker` in ci.yml): a pull request that closes an issue (`Closes #N` /
//     `Fixes #N`, i.e. GitHub's closingIssuesReferences) must have a PLAN.md row for that issue
//     (rule 1), or mark it explicitly untracked. It does NOT have to set the row `done` -- that
//     moved to the post-merge workflow (issue #1004), because two open PRs in one workstream
//     touching adjacent rows conflicted on every merge that landed first. The whole file is also
//     checked for well-formed rows: a known state and no duplicate issue rows.
//   - Post-merge (`plan-sync` workflow): reads the merged PR's closing issues and sets each
//     tracked row to `done` with that PR's number, in one commit on main.
//
// Usage (CI): node scripts/planTracker.ts <pr.json> <PLAN.md>
//   pr.json = `gh pr view <n> --json number,closingIssuesReferences`

import { readFileSync } from 'node:fs';

export const PLAN_STATES = ['open', 'in progress', 'done', 'dropped', 'untracked'] as const;

export interface PlanRow {
  issue: number;
  state: string;
  prs: number[];
  /** 1-based line number in PLAN.md, for error messages. */
  line: number;
}

/** Rows look like `| #123 | title | state | #456, #789 |`; the title may contain escaped pipes. */
const ROW = /^\|\s*#(\d+)\s*\|(.*)\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*$/;

export function parsePlan(md: string): { rows: Map<number, PlanRow>; errors: string[] } {
  const rows = new Map<number, PlanRow>();
  const errors: string[] = [];
  md.split('\n').forEach((text, idx) => {
    const m = ROW.exec(text.replace(/\\\|/g, '\u0000'));
    if (!m) return;
    const issue = Number(m[1]);
    const state = m[3]!.trim();
    const prs = [...m[4]!.matchAll(/#(\d+)/g)].map((x) => Number(x[1]));
    const line = idx + 1;
    if (!(PLAN_STATES as readonly string[]).includes(state)) {
      errors.push(`PLAN.md:${line}: #${issue} has state "${state}"; allowed: ${PLAN_STATES.join(', ')}`);
    }
    const prev = rows.get(issue);
    if (prev) {
      errors.push(`PLAN.md:${line}: #${issue} has a second row (first at line ${prev.line}); one row per issue`);
      return;
    }
    rows.set(issue, { issue, state, prs, line });
  });
  return { rows, errors };
}

/**
 * Rule 1 at PR time: every closing issue must have a row, or be explicitly untracked.
 *
 * The row's STATE is not checked here: setting it `done` is the post-merge workflow's job (#1004),
 * so a feature PR that touches no PLAN.md row still passes as long as its closing issues are
 * tracked. An issue with no row fails, naming the issue and pointing at rule 1.
 */
export function checkClosingIssues(rows: Map<number, PlanRow>, closing: number[]): string[] {
  const errors: string[] = [];
  for (const issue of closing) {
    const row = rows.get(issue);
    if (!row) {
      errors.push(
        `this PR closes #${issue}, which has no PLAN.md row; add one (rule 1) or mark it untracked`,
      );
    }
  }
  return errors;
}

/**
 * The post-merge update: set each closing issue's row to `done` with the merged PR's number.
 *
 * Skips an issue with no row (nothing to mark) and an explicitly untracked row (rule 4: untracked
 * means "not part of a tracked set", so it stays untracked). Returns the updated document and
 * whether anything changed, so the workflow can avoid committing when there is nothing to do --
 * which is also what stops the workflow from re-triggering itself forever.
 */
export function applyClosing(md: string, closing: { issue: number; pr: number }[]): { plan: string; changed: boolean } {
  const { rows } = parsePlan(md);
  const targets = new Map<number, number>(); // line -> pr
  for (const c of closing) {
    const row = rows.get(c.issue);
    if (!row || row.state === 'untracked') continue;
    targets.set(row.line, c.pr);
  }
  if (targets.size === 0) return { plan: md, changed: false };
  const lines = md.split('\n');
  let changed = false;
  for (const [line, pr] of targets) {
    const updated = updateRow(lines[line - 1]!, pr);
    if (updated !== lines[line - 1]) {
      lines[line - 1] = updated;
      changed = true;
    }
  }
  return { plan: lines.join('\n'), changed };
}

/** Rewrite one row line to `done` with `pr` in the PR column, if it is not already there. */
function updateRow(line: string, pr: number): string {
  const m = ROW.exec(line.replace(/\\\|/g, '\u0000'));
  if (!m) return line;
  const issue = Number(m[1]);
  const title = m[2]!.replace(/\u0000/g, '\|').trim();
  const prs = m[4]!.trim();
  const prsList = [...prs.matchAll(/#(\d+)/g)].map((x) => Number(x[1]));
  if (prsList.includes(pr)) return line;
  const newPrs = prsList.length ? `${prs}, #${pr}` : `#${pr}`;
  return `| #${issue} | ${title} | done | ${newPrs} |`;
}

function main(argv: string[]): number {
  const [prJsonPath, planPath] = argv;
  if (!prJsonPath || !planPath) {
    console.error('usage: node scripts/planTracker.ts <pr.json> <PLAN.md>');
    return 2;
  }
  const pr = JSON.parse(readFileSync(prJsonPath, 'utf8')) as {
    number?: number;
    closingIssuesReferences?: { number?: number }[];
  };
  if (!Number.isInteger(pr.number)) {
    console.error(`${prJsonPath}: no PR number`);
    return 2;
  }
  const closing = (pr.closingIssuesReferences ?? []).map((r) => r.number).filter((n): n is number => Number.isInteger(n));
  const { rows, errors } = parsePlan(readFileSync(planPath, 'utf8'));
  errors.push(...checkClosingIssues(rows, closing));
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error(`\nPLAN.md rules: see the "Rules" section at the top of PLAN.md.`);
    return 1;
  }
  console.log(`PLAN.md ok: ${rows.size} rows; closing ${closing.length ? closing.map((n) => '#' + n).join(', ') : 'nothing'}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}

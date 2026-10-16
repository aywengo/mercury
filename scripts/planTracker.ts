// PLAN.md tracker check (PLAN.md "Rules" 2 and 4).
//
// A pull request that closes an issue (`Closes #N` / `Fixes #N`, i.e. GitHub's
// closingIssuesReferences) must update that issue's PLAN.md row in the same PR: state `done` and the
// PR's own number in the PR column. Issues without a row pass, because not every issue belongs to a
// tracked issue set. The whole file is also checked for well-formed rows: a known state and no
// duplicate issue rows. A malformed tracker is a failure on every PR, not only the one that broke it.
//
// Usage (CI): node scripts/planTracker.ts <pr.json> <PLAN.md>
//   pr.json = `gh pr view <n> --json number,closingIssuesReferences`

import { readFileSync } from 'node:fs';

export const PLAN_STATES = ['open', 'in progress', 'done', 'dropped'] as const;

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

/** Rule 2: every closing issue that has a row must be `done` with this PR's number. */
export function checkClosingIssues(rows: Map<number, PlanRow>, prNumber: number, closing: number[]): string[] {
  const errors: string[] = [];
  for (const issue of closing) {
    const row = rows.get(issue);
    if (!row) continue;
    if (row.state !== 'done' || !row.prs.includes(prNumber)) {
      errors.push(
        `PLAN.md:${row.line}: this PR closes #${issue}, so its row must read state "done" with #${prNumber} ` +
        `in the PR column (found state "${row.state}", PR ${row.prs.length ? row.prs.map((p) => '#' + p).join(', ') : '—'})`,
      );
    }
  }
  return errors;
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
  errors.push(...checkClosingIssues(rows, pr.number!, closing));
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

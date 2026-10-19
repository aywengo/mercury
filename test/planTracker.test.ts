import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyClosing, checkClosingIssues, parsePlan } from '../scripts/planTracker.ts';

const SAMPLE = [
  '# PLAN',
  '| Issue | Title | State | PR |',
  '| --- | --- | --- | --- |',
  '| #10 | first | done | #11 |',
  '| #12 | a title with an escaped \\| pipe | open | — |',
  '| #13 | in flight | in progress | #14, #15 |',
  '| #16 | not tracked | untracked | — |',
].join('\n');

test('planTracker: rows parse, escaped pipes in titles do not split columns', () => {
  const { rows, errors } = parsePlan(SAMPLE);
  assert.deepEqual(errors, []);
  assert.equal(rows.size, 4);
  assert.deepEqual(rows.get(12), { issue: 12, state: 'open', prs: [], line: 5 });
  assert.deepEqual(rows.get(13)!.prs, [14, 15]);
  assert.equal(rows.get(16)!.state, 'untracked');
});

test('planTracker: a PR closing a tracked issue passes whatever its row state is (issue #1004)', () => {
  // The row update moved to the post-merge workflow, so a feature PR that does not touch PLAN.md
  // must pass as long as its closing issues have rows. This is the issue's regression test: on the
  // base it fails, because rule 2 was enforced at PR time.
  const { rows } = parsePlan(SAMPLE);
  assert.deepEqual(checkClosingIssues(rows, [12]), [], 'open row: ok');
  assert.deepEqual(checkClosingIssues(rows, [10]), [], 'already-done row: ok');
  assert.deepEqual(checkClosingIssues(rows, [13]), [], 'in-progress row: ok');
  assert.deepEqual(checkClosingIssues(rows, [16]), [], 'explicitly untracked row: ok');
});

test('planTracker: a PR closing an issue with no row fails, naming it and pointing at rule 1', () => {
  const { rows } = parsePlan(SAMPLE);
  const errors = checkClosingIssues(rows, [4242]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /closes #4242/);
  assert.match(errors[0]!, /no PLAN.md row/);
  assert.match(errors[0]!, /rule 1/);
  // Multiple missing rows are all reported.
  assert.equal(checkClosingIssues(rows, [4242, 4243]).length, 2);
});

test('planTracker: an issue without a row passes (not every issue belongs to a tracked set)', () => {
  const { rows } = parsePlan(SAMPLE);
  assert.deepEqual(checkClosingIssues(rows, []), []);
});

test('planTracker: unknown states and duplicate rows are errors on every PR', () => {
  const bad = SAMPLE + '\n| #10 | again | done | #11 |\n| #20 | x | finished | — |';
  const { errors } = parsePlan(bad);
  assert.equal(errors.length, 2);
  assert.match(errors.join('\n'), /#10 has a second row \(first at line 4\)/);
  assert.match(errors.join('\n'), /#20 has state "finished"/);
});

test('planTracker: applyClosing sets a closing issue to done with the merged PR number', () => {
  const { plan, changed } = applyClosing(SAMPLE, [{ issue: 12, pr: 99 }]);
  assert.equal(changed, true);
  const { rows } = parsePlan(plan);
  assert.equal(rows.get(12)!.state, 'done');
  assert.deepEqual(rows.get(12)!.prs, [99]);
  // Other rows are untouched.
  assert.equal(rows.get(10)!.state, 'done');
  assert.equal(rows.get(13)!.state, 'in progress');
});

test('planTracker: applyClosing appends to an existing PR column and is idempotent', () => {
  const { plan, changed } = applyClosing(SAMPLE, [{ issue: 13, pr: 99 }]);
  assert.equal(changed, true);
  assert.deepEqual(parsePlan(plan).rows.get(13)!.prs, [14, 15, 99]);
  // A second pass changes nothing.
  const again = applyClosing(plan, [{ issue: 13, pr: 99 }]);
  assert.equal(again.changed, false);
  assert.equal(again.plan, plan);
});

test('planTracker: applyClosing marks done even when the PR is already in the column (issue #1004)', () => {
  // #13 is `in progress | #14, #15`. When #14 merges, the row must become `done` -- an existing PR
  // number in a non-done state is NOT done (Copilot review round 1).
  const { plan, changed } = applyClosing(SAMPLE, [{ issue: 13, pr: 14 }]);
  assert.equal(changed, true);
  const row = parsePlan(plan).rows.get(13)!;
  assert.equal(row.state, 'done');
  assert.deepEqual(row.prs, [14, 15], 'PR number is not duplicated');
});

test('planTracker: applyClosing keeps an escaped pipe in an updated title (issue #1004)', () => {
  const { plan } = applyClosing(SAMPLE, [{ issue: 12, pr: 99 }]);
  assert.match(plan, /escaped \\| pipe/, 'title retains its escaped pipe');
  assert.doesNotMatch(plan, /escaped \| pipe/, 'no bare pipe in the title');
});

test('planTracker: applyClosing skips an untracked row and an issue with no row', () => {
  const { plan, changed } = applyClosing(SAMPLE, [{ issue: 16, pr: 99 }, { issue: 4242, pr: 99 }]);
  assert.equal(changed, false, 'nothing tracked to mark done');
  assert.equal(plan, SAMPLE);
});

test('planTracker: the repository PLAN.md is well formed', () => {
  const { rows, errors } = parsePlan(readFileSync(new URL('../PLAN.md', import.meta.url), 'utf8'));
  assert.deepEqual(errors, []);
  assert.ok(rows.size > 0, 'PLAN.md has tracker rows');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkClosingIssues, parsePlan } from '../scripts/planTracker.ts';

const SAMPLE = [
  '# PLAN',
  '| Issue | Title | State | PR |',
  '| --- | --- | --- | --- |',
  '| #10 | first | done | #11 |',
  '| #12 | a title with an escaped \\| pipe | open | — |',
  '| #13 | in flight | in progress | #14, #15 |',
].join('\n');

test('planTracker: rows parse, escaped pipes in titles do not split columns', () => {
  const { rows, errors } = parsePlan(SAMPLE);
  assert.deepEqual(errors, []);
  assert.equal(rows.size, 3);
  assert.deepEqual(rows.get(12), { issue: 12, state: 'open', prs: [], line: 5 });
  assert.deepEqual(rows.get(13)!.prs, [14, 15]);
});

test('planTracker: a PR closing a tracked issue must mark it done with its own number', () => {
  const { rows } = parsePlan(SAMPLE);
  assert.deepEqual(checkClosingIssues(rows, 11, [10]), [], 'done with this PR: ok');
  const notDone = checkClosingIssues(rows, 16, [12]);
  assert.equal(notDone.length, 1);
  assert.match(notDone[0]!, /PLAN.md:5: this PR closes #12/);
  assert.match(notDone[0]!, /found state "open"/);
  // done, but by another PR: the closing PR must record itself.
  assert.equal(checkClosingIssues(rows, 99, [10]).length, 1);
});

test('planTracker: an issue without a row passes (not every issue belongs to a tracked set)', () => {
  const { rows } = parsePlan(SAMPLE);
  assert.deepEqual(checkClosingIssues(rows, 50, [4242]), []);
});

test('planTracker: unknown states and duplicate rows are errors on every PR', () => {
  const bad = SAMPLE + '\n| #10 | again | done | #11 |\n| #20 | x | finished | — |';
  const { errors } = parsePlan(bad);
  assert.equal(errors.length, 2);
  assert.match(errors.join('\n'), /#10 has a second row \(first at line 4\)/);
  assert.match(errors.join('\n'), /#20 has state "finished"/);
});

test('planTracker: the repository PLAN.md is well formed', () => {
  const { rows, errors } = parsePlan(readFileSync(new URL('../PLAN.md', import.meta.url), 'utf8'));
  assert.deepEqual(errors, []);
  assert.ok(rows.size > 0, 'PLAN.md has tracker rows');
});

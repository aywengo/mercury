/**
 * Goal input validation and objective resolution (docs/goals.md section 5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GoalValidationError, resolveGoalSpec } from '../src/domain/goalSpec.ts';
import { MAX_GOAL_OBJECTIVE_CHARS } from '../src/domain/types.ts';

test('an omitted objective resolves to the task text', () => {
  // The common case: `goal: {}` means "track whether the task was achieved".
  assert.equal(resolveGoalSpec({}, 'fix the off-by-one in calc.py').objective, 'fix the off-by-one in calc.py');
  assert.equal(resolveGoalSpec({ objective: '' }, 'the task').objective, 'the task');
  assert.equal(resolveGoalSpec({ objective: null }, 'the task').objective, 'the task');
});

test('an explicit objective wins over the task', () => {
  assert.equal(resolveGoalSpec({ objective: 'narrower' }, 'broad task').objective, 'narrower');
});

test('the cap applies to the RESOLVED value and is never truncated', () => {
  // A truncated objective is a different objective. Silently asking for less than the user
  // asked for is worse than refusing, so an over-long task with no explicit objective fails.
  const longTask = 'x'.repeat(MAX_GOAL_OBJECTIVE_CHARS + 1);
  assert.throws(() => resolveGoalSpec({}, longTask), (err: unknown) => {
    assert.ok(err instanceof GoalValidationError);
    assert.match(err.message, /not truncated/);
    return true;
  });
  // Exactly at the cap is fine.
  assert.equal(resolveGoalSpec({}, 'y'.repeat(MAX_GOAL_OBJECTIVE_CHARS)).objective.length, MAX_GOAL_OBJECTIVE_CHARS);
});

test('unknown goal fields are rejected rather than dropped', () => {
  // `objectiv: ...` would otherwise store a goal nobody asked for, silently defaulting the
  // objective to the task -- a goal that looks accepted and means something else.
  assert.throws(() => resolveGoalSpec({ objectiv: 'typo' }, 'task'), /unknown field\(s\): objectiv/);
  assert.throws(() => resolveGoalSpec({ contract: { outcme: 'typo' } }, 'task'), /contract has unknown field\(s\): outcme/);
});

test('a gate without a positive timeout is rejected', () => {
  // An unbounded gate is indistinguishable from a hung one.
  assert.throws(() => resolveGoalSpec({ gates: [{ command: 'npm test', maxRetries: 2 }] }, 'task'),
    /gates\[0\]\.timeoutMs must be a positive number/);
  assert.throws(() => resolveGoalSpec({ gates: [{ command: 'npm test', timeoutMs: 0, maxRetries: 2 }] }, 'task'),
    /timeoutMs/);
  assert.throws(() => resolveGoalSpec({ gates: [{ command: '  ', timeoutMs: 1, maxRetries: 0 }] }, 'task'),
    /command must be a non-empty string/);
  assert.throws(() => resolveGoalSpec({ gates: [{ command: 'x', timeoutMs: 1000 }] }, 'task'),
    /maxRetries/);
  const ok = resolveGoalSpec({ gates: [{ command: 'npm test', timeoutMs: 60000, maxRetries: 3 }] }, 'task');
  assert.deepEqual(ok.gates, [{ command: 'npm test', timeoutMs: 60000, maxRetries: 3 }]);
});

test('tokenBudget and maxTurns must be positive integers', () => {
  for (const bad of [0, -1, 1.5, '100']) {
    assert.throws(() => resolveGoalSpec({ tokenBudget: bad }, 'task'), /tokenBudget/, `accepted ${JSON.stringify(bad)}`);
    assert.throws(() => resolveGoalSpec({ maxTurns: bad }, 'task'), /maxTurns/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(resolveGoalSpec({ tokenBudget: 1000, maxTurns: 5 }, 'task').tokenBudget, 1000);
});

test('an all-empty contract normalises to no contract', () => {
  // Storage and comparison must agree; {} and absent have to mean the same thing.
  assert.equal(resolveGoalSpec({ contract: {} }, 'task').contract, undefined);
  assert.equal(resolveGoalSpec({ contract: { outcome: undefined } }, 'task').contract, undefined);
  assert.deepEqual(resolveGoalSpec({ contract: { outcome: 'tests pass' } }, 'task').contract, { outcome: 'tests pass' });
});

test('a non-object goal is rejected rather than treated as empty', () => {
  // `goal: true` or `goal: "text"` is a caller mistake; coercing it to "no fields set" would
  // silently mean "objective is the task", which is not what was asked.
  for (const bad of [true, 'text', 42, []]) {
    assert.throws(() => resolveGoalSpec(bad, 'task'), /goal must be an object/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the objective cap is never more permissive than the harness cap (docs/goals.md 2)', () => {
  // PrimeAgent validates the SAME 4000 limit but counts CODE POINTS (`[...objective].length`),
  // while Mercury counts UTF-16 code units (`objective.length`). For astral characters those
  // differ by 2x, so the two could disagree about who accepts a value.
  //
  // The direction is the whole point: Mercury must never accept something the harness will
  // then reject, because that turns a clean 400 at admission into a Run that dies at spawn.
  // Counting UTF-16 units makes Mercury strictly stricter, so the safe side always wins.
  const astral = '\u{1F3AF}'.repeat(MAX_GOAL_OBJECTIVE_CHARS); // 4000 code points, 8000 UTF-16 units
  assert.equal([...astral].length, MAX_GOAL_OBJECTIVE_CHARS);
  assert.ok(astral.length > MAX_GOAL_OBJECTIVE_CHARS, 'precondition: UTF-16 count exceeds the cap');
  assert.throws(
    () => resolveGoalSpec({ objective: astral }, 'task'),
    /over the .* limit/,
    'Mercury accepted an objective the harness would reject',
  );
});

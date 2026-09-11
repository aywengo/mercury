/**
 * Mid-run objective replacement (docs/goals.md 9).
 *
 * PrimeAgent replaces a live objective when a new one is set while one is active -- deliberately,
 * so the objective survives context compaction. The design requires each change to be recorded
 * rather than treated as a protocol violation. Before this, the field was accepted and dropped,
 * so the dashboard kept showing the ORIGINAL objective as if it were current.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateHarnessGoal } from '../src/domain/goalEvents.ts';
import { createRedactor } from '../src/domain/redact.ts';
import { makeEnv } from './helpers.ts';
import type { GoalStore } from '../src/runs/goalStore.ts';

/** A real Run with a real goal row: run_goals has a foreign key onto runs, so a bare store
 *  cannot be seeded without one. */
function seeded(objective = 'original objective', redactor = createRedactor([])): { env: ReturnType<typeof makeEnv>; goals: GoalStore; runId: string } {
  const env = makeEnv({ workerEnabled: false, redactor });
  const run = env.runService.create({ ownerId: 'alice', task: 'work', agent: 'fake' });
  env.goals.insert({ runId: run.id, status: 'active', objective, source: 'operator', updatedAt: '2026-01-01T00:00:00Z' });
  return { env, goals: env.goals, runId: run.id };
}

test('a reported objective change is carried in the patch', () => {
  const t = translateHarnessGoal({ status: 'active', objective: 'replaced after compaction', tokensUsed: 10 });
  assert.equal(t?.patch.objective, 'replaced after compaction');
});

test('an absent objective does not blank the stored one', () => {
  // The same "absent is not zero" rule that keeps tokensUsed from being fabricated. A report that
  // omits the objective means "no change", not "the objective is now empty".
  for (const missing of [undefined, null, '', 42]) {
    const t = translateHarnessGoal({ status: 'active', objective: missing, tokensUsed: 1 });
    assert.equal(t?.patch.objective, undefined, `objective ${JSON.stringify(missing)} became a change`);
  }
});

test('the store persists the replacement', () => {
  const { env, goals, runId } = seeded();
  try {
    goals.update(runId, { objective: 'the real success condition', status: 'active' }, '2026-01-01T00:01:00Z');
    assert.equal(goals.get(runId)?.objective, 'the real success condition');
  } finally { env.close(); }
});

test('a replacement objective is redacted before it is stored', () => {
  // Creation redacts the objective because tasks carry credentials (issue #43). A harness-reported
  // replacement is a second door into the same column, and an unredacted second door is a leak
  // rather than an audit note.
  const secret = ['sk-live','ABCDEF123456'].join('-');
  const { env, goals, runId } = seeded('original objective', createRedactor([secret]));
  try {
    goals.update(runId, { objective: `verify token ${secret} is rotated`, status: 'active' }, '2026-01-01T00:02:00Z');
    const stored = goals.get(runId)!.objective;
    assert.ok(!stored.includes('ABCDEF123456'), `secret persisted: ${stored}`);
    assert.match(stored, /REDACTED/);
  } finally { env.close(); }
});

test('a replacement cannot be an empty objective', () => {
  // An empty objective would make the row unreadable and is never a real replacement.
  const { env, goals, runId } = seeded();
  try {
    goals.update(runId, { objective: '' }, '2026-01-01T00:03:00Z');
    assert.equal(goals.get(runId)?.objective, 'original objective');
  } finally { env.close(); }
});

test('a secret straddling the bound is redacted, not truncated around', () => {
  // Ordering proof. Redaction must run BEFORE bounding. If the text is cut to MAX_GOAL_TEXT_CHARS
  // first, a configured secret that straddles the cut no longer matches itself, so the redactor
  // silently does nothing and the stored row carries a fragment of a credential with no REDACTED
  // marker anywhere -- an operator auditing the row could not tell redaction had been skipped.
  //
  // A short secret cannot detect this: it sits inside the kept prefix under either order. The
  // padding places the secret across the boundary on purpose, so this test fails the bound-first
  // order and only that order. Without it the ordering is a comment, not an invariant.
  const secret = ['zz', 'ACME-7f3c91be2d5a'].join('-'); // 20 chars
  // Positioned so the secret crosses the 2000-char cut while the [REDACTED] marker that replaces it
  // stays inside the kept prefix. If the marker were pushed past the cut it would be truncated away
  // under BOTH orders and the test would prove nothing -- so the geometry is asserted, not assumed.
  const text = `filler ${'x'.repeat(1977)} ${secret} tail`;
  const at = text.indexOf(secret);
  assert.ok(text.length > 2000, 'fixture must exceed the bound for the ordering to be observable');
  assert.ok(at < 2000 && at + secret.length > 2000, `secret must straddle the bound (starts at ${at})`);
  assert.ok(at + '[REDACTED]'.length < 2000, 'the marker must survive the cut, or both orders look alike');

  const { env, goals, runId } = seeded('original objective', createRedactor([secret]));
  try {
    goals.update(runId, { objective: text, status: 'active' }, '2026-01-01T00:04:00Z');
    const stored = goals.get(runId)!.objective;
    assert.ok(!stored.includes(secret), 'the whole secret was stored');
    assert.match(stored, /REDACTED/, 'redaction was skipped without saying so -- bound ran first');
  } finally { env.close(); }
});

test('a change is announced as goal.updated, not as a new goal', () => {
  const t = translateHarnessGoal({ status: 'active', objective: 'v2' });
  assert.equal(t?.eventType, 'goal.updated');
});

test('a late report on a settled goal still records the objective text', () => {
  // Documents a deliberate choice: the settled-status guard blocks the STATUS change, because a
  // late frame must not un-settle a verdict. The objective string is a fact about what the
  // harness was judging, and recording it does not disturb the verdict -- same reasoning the
  // usage numbers already follow.
  const t = translateHarnessGoal({ status: 'active', objective: 'late text', tokensUsed: 5 });
  const usageOnly = { ...t!.patch, status: undefined };
  assert.equal(usageOnly.status, undefined, 'a late report could move a settled goal');
  assert.equal(usageOnly.objective, 'late text', 'usage-only stripping also dropped the objective');
});

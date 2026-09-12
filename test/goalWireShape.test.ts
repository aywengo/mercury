import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { translateHarnessGoal, type HarnessGoalReport } from '../src/domain/goalEvents.ts';

/**
 * Issue #494. docs/goals.md section 2.1 used to present PrimeAgent's kernel-host-bridge
 * serialization (snake_case `SerializedGoal`) as "the goalState shape, read from a live
 * session". It is not: the RPC event stream carries camelCase `GoalState`. The implementation
 * was right and the document was wrong, which is the dangerous direction -- a maintainer
 * trusting the doc would rename the translator's fields to snake_case, every lookup would
 * return undefined, and goal usage would read as absent forever with the suite green, because
 * an unreported number stays unreported by design.
 *
 * These tests bind the translator to BOTH samples in the document, so neither can drift from
 * the code without a failure: the RPC sample must parse into real usage, and the kernel-bridge
 * sample must parse into nothing.
 */

const DOCS_FILE = join(import.meta.dirname, '..', 'docs', 'goals.md');
const FIXTURE_FILE = join(import.meta.dirname, 'fixtures', 'mock-prime-agent-rpc.mjs');
const DOCS = readFileSync(DOCS_FILE, 'utf8');
const FIXTURE = readFileSync(FIXTURE_FILE, 'utf8');

/** Pull one fenced json block that follows `marker`. */
function jsonBlockAfter(marker: string): unknown {
  const at = DOCS.indexOf(marker);
  assert.ok(at >= 0, `docs/goals.md no longer contains the marker: ${marker}`);
  const start = DOCS.indexOf('```json', at);
  assert.ok(start >= 0, `no json block after: ${marker}`);
  const open = DOCS.indexOf('\n', start) + 1;
  const end = DOCS.indexOf('```', open);
  assert.ok(end > open, `unterminated json block after: ${marker}`);
  return JSON.parse(DOCS.slice(open, end));
}

/** The goal object from the RPC `goal_update` sample the doc says Mercury parses. */
function docRpcGoal(): Record<string, unknown> {
  const block = jsonBlockAfter('The shape Mercury actually parses') as {
    type: string;
    goal: Record<string, unknown>;
  };
  assert.equal(block.type, 'goal_update', 'the RPC sample must be a goal_update frame');
  return block.goal;
}

/** The goal object from the kernel-bridge sample the doc says Mercury never sees. */
function docKernelBridgeGoal(): Record<string, unknown> {
  const block = jsonBlockAfter('Do not confuse this with the kernel-bridge shape') as {
    goal: Record<string, unknown>;
  };
  return block.goal;
}

test('the doc RPC sample parses into real usage through the translator', () => {
  const goal = docRpcGoal();
  const out = translateHarnessGoal(goal as HarnessGoalReport);
  assert.ok(out, 'the documented RPC shape must translate at all');
  assert.equal(out.patch.status, 'complete');
  assert.equal(out.patch.objective, 'resolve open issues …');
  assert.equal(out.patch.tokensUsed, 632007);
  assert.equal(out.patch.timeUsedSeconds, 4695);
  // continuationsUsed is the harness denominator; turnsUsed is Mercury's.
  assert.equal(out.patch.turnsUsed, 35);
  // tokenBudget is on the wire but deliberately NOT taken from a report: the budget is the
  // operator's admission-time spec, and Mercury passes it down at start only. A report that
  // could rewrite it would let the harness move the goalposts it is being judged against.
  assert.ok(!('tokenBudget' in out.patch), 'a report must not be able to move the budget it is judged against');
});

test('the doc kernel-bridge sample yields NO usage, proving it is the wrong shape to parse', () => {
  const bridge = docKernelBridgeGoal();
  // Guard the premise: the sample really is snake_case, or this test proves nothing.
  assert.ok('tokens_used' in bridge, 'the kernel-bridge sample is no longer snake_case');
  assert.ok(!('tokensUsed' in bridge), 'the kernel-bridge sample must not carry camelCase keys');

  const out = translateHarnessGoal(bridge as HarnessGoalReport);
  // No `active`/camelCase status path means no usage lands. If a future change starts
  // accepting snake_case as well, the silent-zero failure mode is back and this fails.
  if (out) {
    assert.equal(out.patch.tokensUsed, undefined, 'snake_case usage must not be accepted');
    assert.equal(out.patch.timeUsedSeconds, undefined, 'snake_case duration must not be accepted');
    assert.equal(out.patch.turnsUsed, undefined, 'snake_case continuations must not be accepted');
  }
});

test('the mock fixture speaks the same wire casing as the document', () => {
  // The fixture stands in for the real binary. If it and the translator ever disagree on
  // casing, that is exactly how #494 would ship: green tests and silently absent usage.
  const frames = FIXTURE.match(/type: 'goal_update', goal: (\{[^\n]*\})/g) ?? [];
  assert.ok(frames.length >= 4, `expected the fixture's goal_update frames, found ${frames.length}`);
  for (const [i, frame] of frames.entries()) {
    assert.match(frame, /tokensUsed:/, `fixture frame ${i} does not report camelCase tokensUsed`);
    assert.match(frame, /timeUsedSeconds:/, `fixture frame ${i} lacks camelCase timeUsedSeconds`);
    assert.match(frame, /continuationsUsed:/, `fixture frame ${i} lacks camelCase continuationsUsed`);
    // And never the kernel-bridge spelling, which would make the fixture agree with the old doc.
    assert.doesNotMatch(frame, /tokens_used|time_used_seconds|goal_id/, `fixture frame ${i} uses kernel-bridge snake_case`);
  }
});

test('the translator does not accept both casings for the same field', () => {
  const camel = { active: true, status: 'active', tokensUsed: 100, timeUsedSeconds: 9, continuationsUsed: 2 };
  const snake = { active: true, status: 'active', tokens_used: 100, time_used_seconds: 9, continuations_used: 2 };
  const a = translateHarnessGoal(camel as HarnessGoalReport)!;
  const b = translateHarnessGoal(snake as HarnessGoalReport)!;
  assert.equal(a.patch.tokensUsed, 100);
  assert.equal(b.patch.tokensUsed, undefined);
});

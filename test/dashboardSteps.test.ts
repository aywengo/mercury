import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error -- ui modules are plain browser JS without declarations; the test pins
// their behavior by importing them directly.
import { mapStepEvents } from '../ui/steps.js';
type StepRow = { id: string; status: string; preset: { id: string } | null; lastSequence: number | null };
declare const _t: undefined;

// Dashboard planned-steps mapping (issue #810 acceptance 3): the panel shows the advisory
// label (static in run.html/workflows.html), maps reported step events to planned steps by
// stage id, and shows unmatched planned steps as "not reported" -- never as "skipped" or
// "failed", because Mercury does not know.

const stages = [
  { index: 0, id: 'plan', task: 'Plan it', preset: { id: 'system-architect' } },
  { index: 1, id: 'implement', task: 'Build it', preset: null },
  { index: 2, id: 'review', task: 'Check it', preset: { id: 'reviewer' } },
];

test('unmatched planned steps are "not reported", never skipped or failed', () => {
  const rows: StepRow[] = mapStepEvents(stages, []);
  assert.deepEqual(rows.map((r) => r.status), ['not-reported', 'not-reported', 'not-reported']);
  assert.equal(rows[1]!.preset, null);
  assert.equal(rows[0]!.preset!.id, 'system-architect');
});

test('reported events map to planned steps by stage id, later events winning', () => {
  const rows: StepRow[] = mapStepEvents(stages, [
    { type: 'step.started', payload: { stage: 'plan' }, sequence: 3 },
    { type: 'step.completed', payload: { stage: 'plan' }, sequence: 7 },
    { type: 'step.started', payload: { stage: 'implement' }, sequence: 9 },
  ]);
  assert.deepEqual(rows.map((r) => r.status), ['completed', 'started', 'not-reported']);
  assert.equal(rows[0]!.lastSequence, 7);
});

test('aliases (stageId, step) and non-step events are handled', () => {
  const rows: StepRow[] = mapStepEvents(stages, [
    { type: 'step.completed', payload: { stageId: 'review' }, sequence: 2 },
    { type: 'step.started', payload: { step: 'plan' }, sequence: 3 },
    { type: 'run.started', payload: { stage: 'implement' }, sequence: 4 },
    { type: 'step.started', payload: {}, sequence: 5 },
  ]);
  assert.deepEqual(rows.map((r) => r.status), ['started', 'not-reported', 'completed']);
});

test('events naming an unknown stage do not invent rows or corrupt planned state', () => {
  const rows: StepRow[] = mapStepEvents(stages, [
    { type: 'step.failed', payload: { stage: 'typo-stage' }, sequence: 1 },
    { type: 'step.completed', payload: { stage: 'plan' }, sequence: 2 },
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.status), ['completed', 'not-reported', 'not-reported']);
});

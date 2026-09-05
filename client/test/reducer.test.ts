// Run presentation model (§11.3). Pure folding, plus one end-to-end check that the CLI actually uses it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BIN, createRunViaApi, forceStatus, runCliAsync, seedEvents, startMercuryServer, type LiveServer } from './helpers/server.ts';
import { reduceRun, summarizePresentation } from '../observe/reducer.ts';
import type { MercuryEvent } from '../api/protocol.ts';

const ev = (sequence: number, type: string, payload?: unknown): MercuryEvent => ({
  id: `evt_${sequence}`, runId: 'run_x', type, sequence,
  timestamp: '2026-01-01T00:00:00.000Z', payload: payload ?? {},
} as MercuryEvent);

const run = { id: 'run_x', status: 'RUNNING', agent: 'prime-agent', task: 'do the thing' };

test('folds step, tool, skill and message counts', () => {
  const p = reduceRun({
    run,
    events: [
      ev(1, 'run.started'),
      ev(2, 'skill.selected', { name: 'testing' }),
      ev(3, 'skill.selected', { name: 'testing' }),      // same skill twice
      ev(4, 'skill.selected', { name: 'frontend' }),
      ev(5, 'step.completed'),
      ev(6, 'step.failed'),
      ev(7, 'tool.completed'),
      ev(8, 'tool.completed'),
      ev(9, 'tool.failed'),
      ev(10, 'agent.message', { text: 'done' }),
    ],
  });
  assert.equal(p.stepsCompleted, 1);
  assert.equal(p.stepsFailed, 1);
  assert.equal(p.toolsCompleted, 2);
  assert.equal(p.toolsFailed, 1);
  assert.deepEqual(p.skills, ['testing', 'frontend'], 'skills were not deduplicated in order');
  assert.equal(p.messages, 1);
  assert.equal(p.lastSequence, 10);
  assert.equal(p.lastActivityType, 'agent.message');
  assert.equal(p.terminal, false);
});

test('an unanswered input.required is surfaced as pending', () => {
  const p = reduceRun({ run, events: [ev(1, 'input.required', { question: 'which branch?' })] });
  assert.deepEqual(p.pendingInput, { required: true, sequence: 1 });
  assert.match(summarizePresentation(p), /WAITING FOR INPUT/);
});

test('a later input.received clears the pending question', () => {
  const p = reduceRun({
    run,
    events: [ev(1, 'input.required'), ev(2, 'input.received', { text: 'main' })],
  });
  assert.equal(p.pendingInput, null);
});

test('an input.received that predates a newer question does not clear it', () => {
  // Events can arrive with the answer to an EARLIER prompt after a NEWER prompt was emitted. Clearing
  // unconditionally would hide an actionable prompt, which is the one thing this field exists for.
  const p = reduceRun({
    run,
    events: [ev(1, 'input.required'), ev(2, 'input.received'), ev(3, 'input.required')],
  });
  assert.deepEqual(p.pendingInput, { required: true, sequence: 3 });
});

test('a late answer to an EARLIER prompt does not clear a NEWER prompt', () => {
  // Events reach the reducer in arrival order, and an answer to an earlier prompt can arrive after a
  // newer prompt was emitted. Clearing unconditionally hides the prompt the operator still has to
  // answer -- the one thing this field exists to surface.
  const p = reduceRun({
    run,
    events: [ev(3, 'input.required', { question: 'rebase or merge?' }), ev(2, 'input.received', { text: 'merge' })],
  });
  assert.deepEqual(p.pendingInput, { required: true, sequence: 3 }, 'a stale answer dismissed a live prompt');
});

test('the first error wins, including one carried by a terminal event', () => {
  const p = reduceRun({
    run: { ...run, status: 'FAILED' },
    events: [ev(1, 'error', { error: 'first' }), ev(2, 'run.failed', { error: 'second' })],
  });
  assert.equal(p.error, 'first');
  assert.equal(p.terminalEvent, 'run.failed');
  assert.equal(p.terminal, true);
});

test('monotonic markers ignore out-of-order input rather than going backwards', () => {
  // The observer delivers in order; the guard means a caller that did not would still report a resume
  // point it had actually shown, instead of one behind it.
  const p = reduceRun({ run, events: [ev(5, 'agent.message'), ev(2, 'agent.message')] });
  assert.equal(p.lastSequence, 5);
  assert.equal(p.eventCount, 2);
});

test('terminal is taken from the Run status, not inferred from events', () => {
  const p = reduceRun({ run: { ...run, status: 'CANCELLED' }, events: [] });
  assert.equal(p.terminal, true);
  assert.equal(p.terminalEvent, null);
});

// ---------------------------------------------------------------------------
// The reducer must be on the live path, not a module nothing calls.
// ---------------------------------------------------------------------------

let server: LiveServer;
before(async () => { server = await startMercuryServer('mercuryctl-reducer-'); });
after(async () => { await server.stop(); });

test('runs watch reports projected counts, proving the reducer is wired in', async () => {
  const runId = await createRunViaApi(server, 'm3: reducer live');
  seedEvents(server, runId, [
    { type: 'run.started' },
    { type: 'skill.selected', payload: { name: 'testing' } },
    { type: 'step.completed' },
    { type: 'step.failed' },
    { type: 'tool.completed' },
    { type: 'agent.message', payload: { text: 'hi' } },
    { type: 'run.failed', payload: { error: 'the run blew up' } },
  ]);
  forceStatus(server, runId, 'FAILED');
  const r = await runCliAsync(server, ['runs', 'watch', runId, '--json', '--timeout', '20s']);
  assert.equal(r.code, 10, `failed Run must exit 10: ${r.stderr}`);
  const lines = r.stdout.trim().split('\n').map((l: string) => JSON.parse(l));
  const summary = lines[lines.length - 1];
  assert.equal(summary.type, 'client.watch.summary');
  assert.equal(summary.finalStatus, 'FAILED');
  assert.ok(summary.summary, 'the watch summary carried no projection -- the reducer is not wired in');
  assert.equal(summary.summary.stepsCompleted, 1);
  assert.equal(summary.summary.stepsFailed, 1);
  assert.equal(summary.summary.toolsCompleted, 1);
  assert.deepEqual(summary.summary.skills, ['testing']);
  assert.equal(summary.summary.error, 'the run blew up');
});

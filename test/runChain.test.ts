// chainState: the chain-level reading A2A needs (A0-2, issue #987, docs/a2a-design.md section 6.4).
//
// Pure over persisted Run rows, so these are plain unit tests: no database, no worker, no clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainState } from '../src/domain/runChain.ts';
import type { Run, RunStatus } from '../src/domain/types.ts';

function mkRun(over: Partial<Run> = {}): Run {
  return {
    id: 'run_root',
    ownerId: 'alice',
    task: 'x',
    repository: { url: 'https://example.test/r.git' },
    workspaceBranch: null,
    workspacePath: null,
    agent: 'fake',
    status: 'QUEUED',
    attempt: 1,
    retryOf: null,
    error: null,
    errorKind: null,
    constraints: { maxDurationMs: 1000, maxRetries: 2, budgetTokens: 0, budgetCost: 0 },
    createdAt: '2026-10-18T10:00:00.000Z',
    startedAt: null,
    completedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    cancellationRequestedAt: null,
    finalCommits: [],
    prUrl: null,
    ...over,
  };
}

/** A terminal attempt, optionally carrying a recorded retry intent. */
function attempt(n: number, status: RunStatus, retryDueAt: string | null = null, retryOf: string | null = null): Run {
  return mkRun({
    id: `run_attempt${n}`,
    attempt: n,
    retryOf,
    status,
    createdAt: `2026-10-18T10:0${n}:00.000Z`,
    retryDueAt,
  });
}

test('chainState: every non-terminal status is neither pending nor final', () => {
  for (const status of ['QUEUED', 'STARTING', 'RUNNING', 'NEEDS_INPUT'] as RunStatus[]) {
    const state = chainState([attempt(1, status)]);
    assert.equal(state.latest.status, status);
    assert.equal(state.retryPending, false, `${status} must not be retry-pending`);
    assert.equal(state.final, false, `${status} must not be final`);
  }
});

test('chainState: every terminal status without an intent is final', () => {
  for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as RunStatus[]) {
    const state = chainState([attempt(1, status)]);
    assert.equal(state.retryPending, false, `${status} without an intent must not be retry-pending`);
    assert.equal(state.final, true, `${status} without an intent must be final`);
  }
});

test('chainState: a terminal attempt with a recorded intent is pending, not final', () => {
  const state = chainState([attempt(1, 'FAILED', '2026-10-18T10:00:05.000Z')]);
  assert.equal(state.latest.attempt, 1);
  assert.equal(state.retryPending, true);
  assert.equal(state.final, false);
});

test('chainState: a terminal attempt with an intent AND a child is neither pending nor final', () => {
  // The intent is stale: the child exists, so the retry it described has already happened. The
  // child is the latest attempt and it is still running, which is why neither flag is set.
  const chain = [attempt(1, 'FAILED', '2026-10-18T10:00:05.000Z'), attempt(2, 'RUNNING', null, 'run_attempt1')];
  const state = chainState(chain);
  assert.equal(state.latest.attempt, 2);
  assert.equal(state.retryPending, false);
  assert.equal(state.final, false);
});

test('chainState: a terminal child makes the chain final even if the parent recorded an intent', () => {
  const chain = [attempt(1, 'FAILED', '2026-10-18T10:00:05.000Z'), attempt(2, 'FAILED', null, 'run_attempt1')];
  const state = chainState(chain);
  assert.equal(state.latest.attempt, 2);
  assert.equal(state.retryPending, false);
  assert.equal(state.final, true);
});

test('chainState: a terminal attempt with no intent is final (the "no retry was decided" case)', () => {
  const state = chainState([attempt(1, 'FAILED')]);
  assert.equal(state.retryPending, false);
  assert.equal(state.final, true);
});

test('chainState: a manual retry after a final state reopens the chain', () => {
  // Manual retry (POST /api/runs/:id/retry) after the chain was final: a new attempt exists, so
  // the chain is no longer final even though nothing recorded an automatic-retry intent.
  const chain = [attempt(1, 'FAILED'), attempt(2, 'QUEUED', null, 'run_attempt1')];
  const state = chainState(chain);
  assert.equal(state.latest.attempt, 2);
  assert.equal(state.retryPending, false);
  assert.equal(state.final, false);

  // ...and when that manual attempt finishes without deciding anything, the chain is final again.
  const done = chainState([attempt(1, 'FAILED'), attempt(2, 'COMPLETED', null, 'run_attempt1')]);
  assert.equal(done.latest.attempt, 2);
  assert.equal(done.final, true);
});

test('chainState: the latest attempt is the highest attempt, whatever order the chain arrives in', () => {
  const a = attempt(1, 'FAILED', '2026-10-18T10:00:05.000Z');
  const b = attempt(2, 'FAILED', null, 'run_attempt1');
  const c = attempt(3, 'RUNNING', null, 'run_attempt2');
  for (const order of [[a, b, c], [c, b, a], [b, c, a]]) {
    assert.equal(chainState(order).latest.attempt, 3);
  }
});

test('chainState: an attempt that already has a child in the chain is neither final nor pending', () => {
  // Reachable only when two attempts share a number: a chain written before #987, when the link
  // was a follow-up write and a worker could observe the child as a fresh attempt 1. `latest`
  // resolves to the parent here, and the childless conjunct is what stops "final" from being
  // asserted about an attempt whose retry already exists.
  const parent = mkRun({
    id: 'run_parent', attempt: 2, status: 'FAILED',
    retryDueAt: '2026-10-18T10:00:05.000Z', createdAt: '2026-10-18T10:00:02.000Z',
  });
  const child = mkRun({
    id: 'run_child', attempt: 2, status: 'FAILED',
    retryOf: 'run_parent', createdAt: '2026-10-18T10:00:01.000Z',
  });
  const state = chainState([parent, child]);
  assert.equal(state.latest.id, 'run_parent');
  assert.equal(state.retryPending, false);
  assert.equal(state.final, false);
});

test('chainState: a fork with a live sibling is not final, whichever attempt is newest', () => {
  // A forked chain -- data written before #987 allowed a second manual retry of one attempt. The
  // newest attempt is terminal and quiet, but its sibling is still RUNNING: "no further attempt
  // will be made" is false, so the chain must not read final.
  const parent = attempt(1, 'FAILED');
  const running = mkRun({ id: 'run_sibA', attempt: 2, retryOf: 'run_attempt1', status: 'RUNNING', createdAt: '2026-10-18T10:02:00.000Z' });
  const quiet = mkRun({ id: 'run_sibB', attempt: 2, retryOf: 'run_attempt1', status: 'FAILED', createdAt: '2026-10-18T10:03:00.000Z' });
  const state = chainState([parent, running, quiet]);
  assert.equal(state.latest.id, 'run_sibB');
  assert.equal(state.retryPending, false);
  assert.equal(state.final, false, 'a sibling is still running, so the work is not over');
});

test('chainState: a fork whose quiet sibling has a retry pending is not final either', () => {
  const parent = attempt(1, 'FAILED');
  const pendingSibling = mkRun({
    id: 'run_sibA', attempt: 2, retryOf: 'run_attempt1', status: 'FAILED',
    retryDueAt: '2026-10-18T10:00:05.000Z', createdAt: '2026-10-18T10:02:00.000Z',
  });
  const quiet = mkRun({ id: 'run_sibB', attempt: 2, retryOf: 'run_attempt1', status: 'FAILED', createdAt: '2026-10-18T10:03:00.000Z' });
  const state = chainState([parent, pendingSibling, quiet]);
  assert.equal(state.latest.id, 'run_sibB');
  assert.equal(state.final, false, 'a sibling still intends to retry, so the work is not over');

  // Control: the same fork with the intent gone is final, so the assertion above is about the
  // sibling's intent and not about forks in general.
  const withoutIntent = mkRun({ ...pendingSibling, retryDueAt: null });
  assert.equal(chainState([parent, withoutIntent, quiet]).final, true);
});

test('chainState: an empty chain is refused rather than answered', () => {
  assert.throws(() => chainState([]), /at least one attempt/);
});

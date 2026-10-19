// Run chain -> A2A task state (A0-4, issue #990, docs/a2a-design.md section 6.5).
//
// Pure over persisted Run rows, so these are plain unit tests: no database, no worker, no clock.
// The mapping is the ONLY thing standing between an A2A client and a terminal state it will treat as
// final, so every §6.5 row is pinned here, plus the two cases the table does not spell out: a
// shutdown-requeued attempt, and an attempt that has a retry pending.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TASK_STATE_NAMES, toTaskState, type TaskStateName } from '../src/a2a/taskState.ts';
import { RUN_STATUSES } from '../src/domain/stateMachine.ts';
import type { GoalStatus, Run, RunStatus } from '../src/domain/types.ts';

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
    statusChangedAt: '2026-10-18T10:00:01.000Z',
    finalCommits: [],
    prUrl: null,
    ...over,
  };
}

/** An attempt that has executed: both start stamps, as the store writes them. */
function started(over: Partial<Run> = {}): Partial<Run> {
  return { startedAt: '2026-10-18T10:00:02.000Z', firstStartedAt: '2026-10-18T10:00:02.000Z', ...over };
}

test('toTaskState: one row per section 6.5 entry', () => {
  const rows: { status: RunStatus; run: Partial<Run>; expected: TaskStateName }[] = [
    { status: 'QUEUED', run: {}, expected: 'TASK_STATE_SUBMITTED' },
    { status: 'STARTING', run: {}, expected: 'TASK_STATE_SUBMITTED' },
    { status: 'RUNNING', run: started(), expected: 'TASK_STATE_WORKING' },
    { status: 'NEEDS_INPUT', run: started(), expected: 'TASK_STATE_INPUT_REQUIRED' },
    { status: 'COMPLETED', run: started(), expected: 'TASK_STATE_COMPLETED' },
    { status: 'FAILED', run: started(), expected: 'TASK_STATE_FAILED' },
    { status: 'TIMED_OUT', run: started(), expected: 'TASK_STATE_FAILED' },
    { status: 'CANCELLED', run: started(), expected: 'TASK_STATE_CANCELED' },
  ];
  for (const row of rows) {
    const result = toTaskState({ chain: [mkRun({ status: row.status, ...row.run })] });
    assert.equal(result.state, row.expected, `${row.status} must map to ${row.expected}`);
  }
  // The table above is hand-written, so pin that it covers the machine: a ninth status added to
  // RunStatus would otherwise pass this test by not being listed.
  assert.deepEqual(
    rows.map((r) => r.status).sort(),
    [...RUN_STATUSES].sort(),
    'the row table must cover every RunStatus, or this test is not the exhaustive check it claims',
  );
});

test('toTaskState: a shutdown-requeued attempt stays WORKING, in QUEUED and again in STARTING', () => {
  // Issue #51 requeues an active Run to QUEUED and nulls `started_at`, so the metrics measure the
  // current execution. The attempt still ran, and the caller saw WORKING; reporting SUBMITTED again
  // would read as the work restarting from nothing on every deploy.
  for (const status of ['QUEUED', 'STARTING'] as RunStatus[]) {
    const requeued = mkRun({
      status,
      startedAt: null,
      firstStartedAt: '2026-10-18T10:00:02.000Z',
    });
    assert.equal(toTaskState({ chain: [requeued] }).state, 'TASK_STATE_WORKING', `${status} after a requeue`);
  }

  // And the pre-v21 fallback: a row written before the first-start column existed has only
  // `started_at`, so reading `firstStartedAt` alone would call every Run in an existing database
  // never-started.
  const preV21 = mkRun({ status: 'QUEUED', startedAt: '2026-10-18T10:00:02.000Z' });
  assert.equal(toTaskState({ chain: [preV21] }).state, 'TASK_STATE_WORKING', 'pre-v21 row, started_at only');

  // A QUEUED attempt that never ran is still SUBMITTED -- the requeue rule must not swallow it.
  assert.equal(toTaskState({ chain: [mkRun({ status: 'QUEUED' })] }).state, 'TASK_STATE_SUBMITTED');
});

test('toTaskState: a terminal attempt with a retry pending reports WORKING, not a terminal state', () => {
  const due = '2026-10-18T10:00:05.000Z';
  for (const status of ['FAILED', 'TIMED_OUT'] as RunStatus[]) {
    const pending = mkRun({ status, ...started(), retryDueAt: due });
    assert.equal(toTaskState({ chain: [pending] }).state, 'TASK_STATE_WORKING', `${status} with a retry pending`);
    // Control: the SAME status without an intent is terminal. Without this the assertion above would
    // pass for a mapping that simply never reports a terminal state.
    const decided = mkRun({ status, ...started(), retryDueAt: null });
    assert.equal(toTaskState({ chain: [decided] }).state, 'TASK_STATE_FAILED', `${status} without an intent`);
  }
});

test('toTaskState: TIMED_OUT says timed out, and a FAILED attempt carries its recorded error', () => {
  // A timed-out Run has NO `error` on the row -- the worker records the reason on the `run.timed_out`
  // event and transitions without setting one -- so a mapping that read `error` alone would report a
  // bare FAILED with no reason at all.
  const timedOut = toTaskState({ chain: [mkRun({ status: 'TIMED_OUT', ...started() })] });
  assert.equal(timedOut.state, 'TASK_STATE_FAILED');
  assert.equal(timedOut.message, 'timed out');

  // A `run.deadline_missed` refusal (notAfter passed before start, #731) sets the Run's error, and
  // that reason is what a caller needs to read.
  const missed = toTaskState({
    chain: [mkRun({ status: 'FAILED', ...started(), error: 'deadline passed before start', errorKind: 'infrastructure' })],
  });
  assert.equal(missed.state, 'TASK_STATE_FAILED');
  assert.equal(missed.message, 'deadline passed before start');

  // No error means no message key at all, not an empty string.
  const bare = toTaskState({ chain: [mkRun({ status: 'FAILED', ...started() })] });
  assert.equal(bare.state, 'TASK_STATE_FAILED');
  assert.equal('message' in bare, false, 'a missing reason must be omitted, never blanked');
});

test('toTaskState: goal status rides as metadata and never changes the task state', () => {
  // COMPLETED with goal `unmet` is the pair an operator most needs to see (docs/goals.md): the Run
  // finished and the objective did not. Mapping it to FAILED would destroy both halves of that.
  const completedUnmet = toTaskState({
    chain: [mkRun({ status: 'COMPLETED', ...started() })],
    goal: 'unmet',
  });
  assert.equal(completedUnmet.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(completedUnmet.metadata, { goalStatus: 'unmet' });

  const failedActive = toTaskState({
    chain: [mkRun({ status: 'FAILED', ...started() })],
    goal: 'active',
  });
  assert.equal(failedActive.state, 'TASK_STATE_FAILED', 'a goal status must not make a failure succeed either');
  assert.deepEqual(failedActive.metadata, { goalStatus: 'active' });

  // No goal, and the domain's word for "no goal row", both omit the key rather than reporting a goal.
  const noGoal = toTaskState({ chain: [mkRun({ status: 'COMPLETED', ...started() })] });
  assert.equal('metadata' in noGoal, false, 'a Run with no goal must not grow a metadata key');
  const absent = toTaskState({ chain: [mkRun({ status: 'COMPLETED', ...started() })], goal: 'absent' });
  assert.equal('metadata' in absent, false, '`absent` means no goal row, not a goal state');
});

test('toTaskState: the LATEST attempt decides, and the timestamp is its statusChangedAt', () => {
  const parent = mkRun({
    id: 'run_attempt1', status: 'FAILED', attempt: 1, ...started(),
    createdAt: '2026-10-18T10:00:00.000Z', statusChangedAt: '2026-10-18T10:00:30.000Z',
  });
  const child = mkRun({
    id: 'run_attempt2', status: 'RUNNING', attempt: 2, retryOf: parent.id, ...started(),
    createdAt: '2026-10-18T10:01:00.000Z', statusChangedAt: '2026-10-18T10:01:10.000Z',
  });
  const result = toTaskState({ chain: [parent, child] });
  assert.equal(result.state, 'TASK_STATE_WORKING');
  assert.equal(result.timestamp, '2026-10-18T10:01:10.000Z', "the latest attempt's stamp, not the parent's");

  // Absent, never fabricated: a row without the stamp omits the key rather than falling back to
  // createdAt, which measures when the Run was created rather than how long it has been in this state.
  const noStamp = toTaskState({ chain: [mkRun({ status: 'COMPLETED', ...started(), statusChangedAt: null })] });
  assert.equal('timestamp' in noStamp, false, 'a missing statusChangedAt must be omitted, not fabricated');
});

test('toTaskState: every RunStatus maps to a state Mercury is allowed to report', () => {
  // RUN_STATUSES is derived from the transition table, which is typed Record<RunStatus, ...>, so it
  // IS the union. Iterating it is what makes "every status has a mapping" a claim about the code
  // rather than about a hand-maintained list in this file.
  assert.equal(RUN_STATUSES.length, 8, 'the status list must not be empty or truncated');
  const produced = new Set<TaskStateName>();
  for (const status of RUN_STATUSES) {
    // No start stamps: this loop is about the STATUS axis. A started QUEUED attempt is the requeue
    // case, which has its own test above.
    const run = mkRun({ status });
    const result = toTaskState({ chain: [run] });
    assert.ok(
      TASK_STATE_NAMES.includes(result.state),
      `${status} produced ${result.state}, which is not a state Mercury may report`,
    );
    produced.add(result.state);
  }
  // Every reachable state is exercised by some status, so the closed set is not wider than reality.
  assert.deepEqual([...produced].sort(), [...TASK_STATE_NAMES].sort());

  // The three the design forbids outright (section 6.5): a request that cannot become a Run gets an
  // error and no task, so there is nothing to reject, nothing to leave unspecified, and no
  // auth-required task state in v1.
  for (const forbidden of ['TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED', 'TASK_STATE_UNSPECIFIED']) {
    assert.ok(!TASK_STATE_NAMES.includes(forbidden as TaskStateName), `${forbidden} must not be reportable`);
  }
});

test('toTaskState: an empty chain is refused rather than mapped to something plausible', () => {
  assert.throws(() => toTaskState({ chain: [] }), /at least one attempt/);
});

test('toTaskState: the module depends on nothing but src/domain and src/runs (acceptance 4)', () => {
  const src = readFileSync(new URL('../src/a2a/taskState.ts', import.meta.url), 'utf8');
  const specifiers = [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(specifiers.length >= 2, `expected imports to inspect, found ${specifiers.length}`);
  for (const specifier of specifiers) {
    assert.match(
      specifier,
      /^\.\.\/(domain|runs)\//,
      `${specifier} is outside src/domain and src/runs: the mapping must not depend on the SDK, on HTTP, or on a store`,
    );
  }
  // A bare specifier is a dependency: `@a2a-js/sdk` would appear here, and so would anything else
  // that turns this pure table into something that needs installing.
  const bare = specifiers.filter((s) => !s.startsWith('.'));
  assert.deepEqual(bare, [], 'the mapping must import no package at all');
});

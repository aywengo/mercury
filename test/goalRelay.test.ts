import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, tempDir, waitFor } from './helpers.ts';
import { translateHarnessGoal, MERCURY_ONLY_GOAL_STATUSES } from '../src/domain/goalEvents.ts';
import { EventTranslator } from '../src/adapters/eventTranslation.ts';
import { GoalStore } from '../src/runs/goalStore.ts';
import { createRedactor } from '../src/domain/redact.ts';

const base = { active: true, tokensUsed: 10, timeUsedSeconds: 5, continuationsUsed: 1 };

test('every harness status maps to the right Mercury event', () => {
  const cases: Array<[string, string]> = [
    ['active', 'goal.updated'],
    ['paused', 'goal.paused'],
    ['budget_limited', 'goal.budget_limited'],
    ['error', 'goal.error'],
    ['complete', 'goal.completed'],
  ];
  for (const [status, eventType] of cases) {
    const out = translateHarnessGoal({ ...base, status });
    assert.ok(out, `${status} produced no translation`);
    assert.equal(out!.eventType, eventType);
    assert.equal(out!.patch.status, status);
    assert.equal(out!.patch.source, 'harness', 'harness reports must be attributed to the harness');
  }
});

test('`idle` means no goal and records nothing', () => {
  assert.equal(translateHarnessGoal({ ...base, status: 'idle' }), null);
  assert.equal(translateHarnessGoal({ status: 'idle' }), null);
});

test('a report with no status records nothing rather than inventing a state', () => {
  assert.equal(translateHarnessGoal({ ...base }), null);
  assert.equal(translateHarnessGoal(null), null);
  assert.equal(translateHarnessGoal(undefined), null);
});

test('a harness cannot set a Mercury-only status', () => {
  // `unmet` is Mercury's inference and `cancelled` an operator action. If a harness could set
  // either, the distinction between "the harness said so" and "Mercury inferred this" -- the
  // one thing the whole design rests on -- would be gone.
  for (const status of MERCURY_ONLY_GOAL_STATUSES) {
    if (status === 'absent') continue;
    const out = translateHarnessGoal({ ...base, status });
    assert.ok(out, `${status} was silently dropped`);
    assert.equal(out!.eventType, 'goal.error');
    assert.equal(out!.patch.status, undefined, `${status} was applied to the row`);
    assert.match(out!.patch.lastError ?? '', /only Mercury may set/);
  }
});

test('an unrecognised status is surfaced, not discarded, and changes no status', () => {
  // Dropping it would be the accept-and-ignore failure at the translation layer. Inventing a
  // status for it would be worse: Mercury does not know what the goal is now.
  const out = translateHarnessGoal({ ...base, status: 'teleported' });
  assert.ok(out);
  assert.equal(out!.eventType, 'goal.error');
  assert.equal(out!.patch.status, undefined);
  assert.equal(out!.unrecognized, 'teleported');
  assert.match(out!.patch.lastError ?? '', /unrecognized harness goal status "teleported"/);
});

test('unreported usage stays undefined instead of becoming a fabricated zero', () => {
  // `null`/absent must not collapse to 0: that would overwrite recorded usage and make a goal
  // look like it had never consumed anything.
  const out = translateHarnessGoal({ active: true, status: 'active', tokensUsed: null, timeUsedSeconds: undefined });
  assert.ok(out);
  assert.equal(out!.patch.tokensUsed, undefined);
  assert.equal(out!.patch.timeUsedSeconds, undefined);
  assert.equal(out!.patch.turnsUsed, undefined);
});

test('continuations map to turnsUsed', () => {
  const out = translateHarnessGoal({ ...base, status: 'active', continuationsUsed: 7 });
  assert.equal(out!.patch.turnsUsed, 7);
});

test('paused keeps its reason in its own field', () => {
  // `paused` is the one status whose operator response is a human action, so the reason must
  // survive into a field the alert path can read, not only the event payload.
  const out = translateHarnessGoal({ ...base, status: 'paused', lastReason: 'needs a decision' });
  assert.equal(out!.patch.pausedReason, 'needs a decision');
});

test('the translator emits goal events instead of dropping goal_update', () => {
  // Before Phase 2 this fell through `default: return []`.
  const tr = new EventTranslator();
  const out = tr.translate({ type: 'goal_update', goal: { ...base, status: 'complete' } } as never);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'goal.completed');
  const dropped = tr.translate({ type: 'goal_update', goal: { ...base, status: 'idle' } } as never);
  assert.deepEqual(dropped, [], 'idle should record nothing');
});

function seedGoal(env: ReturnType<typeof makeEnv>, repo: string, objective = 'make tests pass') {
  const run = env.runService.create({ ownerId: 'a', task: 'the task', agent: 'fake', repository: { localPath: repo } });
  env.goals.insert({ runId: run.id, status: 'active', objective, source: 'operator', updatedAt: 'u' });
  return run;
}

test('the worker persists each goal report and keeps the row and timeline in step', async () => {
  const repo = tempDir('mercury-goal-relay-');
  const env = makeEnv({
    workerEnabled: false,
    fakeScript: [
      { event: { type: 'goal.updated', payload: { ...base, status: 'active', tokensUsed: 100 } } },
      { event: { type: 'goal.paused', payload: { ...base, status: 'paused', tokensUsed: 200, lastReason: 'waiting' } } },
      { event: { type: 'goal.completed', payload: { ...base, status: 'complete', tokensUsed: 300, continuationsUsed: 4 } } },
    ],
  });
  try {
    const run = seedGoal(env, repo);
    env.worker.start();
    await waitFor(() => env.goals.get(run.id)!.status === 'complete', 10_000);
    const g = env.goals.get(run.id)!;
    assert.equal(g.status, 'complete');
    assert.equal(g.tokensUsed, 300);
    assert.equal(g.turnsUsed, 4);
    assert.equal(g.source, 'harness');
    // The objective is Mercury's, not the harness echo.
    assert.equal(g.objective, 'make tests pass');
    // No `goal.created` here: these tests seed the row directly rather than going through
    // admission, and the relay must not fabricate a creation event it did not perform.
    const types = env.events.list(run.id).filter((e) => e.type.startsWith('goal.')).map((e) => e.type);
    assert.deepEqual(types, ['goal.updated', 'goal.paused', 'goal.completed']);
  } finally { env.close(); }
});

test('a goal report for a Run with no goal row is kept as evidence and invents no row', async () => {
    const repo = tempDir('mercury-goal-relay-');
const env = makeEnv({
    workerEnabled: false,
    fakeScript: [{ event: { type: 'goal.updated', payload: { ...base, status: 'complete' } } }],
  });
  try {
    const run = env.runService.create({ ownerId: 'a', task: 'plain', agent: 'fake', repository: { localPath: repo } });
    env.worker.start();
    await waitFor(() => env.events.list(run.id).some((e) => e.type === 'goal.updated'), 10_000);
    assert.equal(env.goals.get(run.id), null, 'a harness report created a goal nobody asked for');
    const ev = env.events.list(run.id).find((e) => e.type === 'goal.updated')!;
    assert.match(JSON.stringify(ev.payload), /no goal row/);
  } finally { env.close(); }
});

test('harness goal text is redacted before it reaches the row', async () => {
  // `lastReason` is agent-controlled. Goal text is written straight to run_goals and never
  // passes through the event path, so it needs its own redaction -- without it a credential in
  // harness text sits in a column the dashboard and CLI read.
  const redactor = createRedactor(['sk-HARNESSLEAK123']);
    const repo = tempDir('mercury-goal-relay-');
const env = makeEnv({
    redactor, workerEnabled: false,
    fakeScript: [{
      event: {
        type: 'goal.paused',
        payload: { ...base, status: 'paused', lastReason: 'blocked, token is sk-HARNESSLEAK123', lastError: 'sk-HARNESSLEAK123 failed' },
      },
    }],
  });
  try {
    const run = seedGoal(env, repo);
    env.worker.start();
    await waitFor(() => env.goals.get(run.id)!.status === 'paused', 10_000);
    const g = env.goals.get(run.id)!;
    assert.ok(!g.lastReason?.includes('sk-HARNESSLEAK123'), `leaked into lastReason: ${g.lastReason}`);
    assert.ok(!g.lastError?.includes('sk-HARNESSLEAK123'), `leaked into lastError: ${g.lastError}`);
    assert.ok(!g.pausedReason?.includes('sk-HARNESSLEAK123'), `leaked into pausedReason: ${g.pausedReason}`);
    assert.match(g.lastReason ?? '', /REDACTED/);
  } finally { env.close(); }
});

test('an unrecognised harness status is recorded without changing the stored status', async () => {
    const repo = tempDir('mercury-goal-relay-');
const env = makeEnv({
    workerEnabled: false,
    fakeScript: [{ event: { type: 'goal.error', payload: { ...base, status: 'teleported' } } }],
  });
  try {
    const run = seedGoal(env, repo);
    env.worker.start();
    await waitFor(() => env.events.list(run.id).some((e) => e.type === 'goal.error'), 10_000);
    // Wait for finalisation before reading the status. Asserting immediately races the worker's
    // terminal settlement, and a status that depends on whether the Run has finished yet is a
    // flaky test, not a meaningful one.
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    const status = env.goals.get(run.id)!.status;
    // The unknown value must never become the stored status. The Run then finishes, so Mercury
    // settles it to `unmet` on its own terminal path -- that is Phase 1 working, not the
    // harness's unparseable report landing.
    assert.notEqual(status, 'teleported', 'an unrecognised status was written to the row');
    assert.equal(status, 'unmet', 'the terminal settlement should still own the final status');
    const ev = env.events.list(run.id).find((e) => e.type === 'goal.error')!;
    assert.match(JSON.stringify(ev.payload), /unrecognized harness goal status/);
  } finally { env.close(); }
});

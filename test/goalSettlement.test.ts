import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.ts';
import { RunStore } from '../src/runs/runStore.ts';
import { GoalStore } from '../src/runs/goalStore.ts';
import { settleGoalOnTerminal } from '../src/runs/goalSettlement.ts';
import type { Run, RunStatus } from '../src/domain/types.ts';

function goalEvents(env: ReturnType<typeof makeEnv>, runId: string): string[] {
  return env.events.list(runId).filter((e) => e.type.startsWith('goal.')).map((e) => e.type);
}

function seed(env: ReturnType<typeof makeEnv>, objective = 'ship it'): Run {
  const run = env.runService.create({ ownerId: 'a', task: 'the task', agent: 'fake' });
  env.goals.insert({ runId: run.id, status: 'active', objective, source: 'operator', updatedAt: 'u' });
  return run;
}

function runTo(env: ReturnType<typeof makeEnv>, run: Run, to: RunStatus): void {
  // Walk the real state machine to a terminal status, starting the Run on the way so
  // startedAt is set the way a real execution sets it.
  env.runs.transition(run.id, 'STARTING');
  // startedAt is set by the worker's RUNNING transition; mirror that exactly, since the
  // settlement reads it to tell "never attempted" from "attempted and stopped short".
  env.runs.transition(run.id, 'RUNNING', { startedAt: new Date().toISOString() });
  env.runs.transition(run.id, to, { completedAt: new Date().toISOString() });
}

test('a Run that COMPLETED with the goal still active is reported unmet', () => {
  // The headline case of the whole feature: Run COMPLETED, objective never declared met.
  // Invisible before this, and the combination an operator most needs to see.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = seed(env, 'tests pass');
    runTo(env, run, 'COMPLETED');
    const g = env.goals.get(run.id)!;
    assert.equal(g.status, 'unmet');
    assert.deepEqual(goalEvents(env, run.id), ['goal.unmet']);
    const ev = env.events.list(run.id).find((e) => e.type === 'goal.unmet')!;
    const p = ev.payload as Record<string, unknown>;
    assert.equal(p.terminalStatus, 'COMPLETED');
    assert.equal(p.attempted, true);
    assert.equal(p.objective, 'tests pass');
    assert.match(String(p.reason), /completed without the harness ever reporting/i);
    // Orthogonality: the Run status is untouched by the goal verdict, and vice versa.
    assert.equal(env.runs.get(run.id)!.status, 'COMPLETED');
  } finally { env.close(); }
});

for (const to of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const) {
  test(`every exit route closes the goal: ${to}`, () => {
    // The reason this hangs off the transition choke point rather than the worker's happy
    // path: an exit route that forgets it leaves a goal `active` on a Run nobody is running.
    const env = makeEnv({ workerEnabled: false });
    try {
      const run = seed(env);
      runTo(env, run, to);
      assert.equal(env.goals.get(run.id)!.status, 'unmet', `${to} left the goal open`);
      assert.deepEqual(goalEvents(env, run.id), ['goal.unmet']);
    } finally { env.close(); }
  });
}

test('a goal the harness already closed is never overwritten', () => {
  // Mercury never judges completion. The harness's own word outranks Mercury's inference, so
  // a Run that COMPLETED after declaring the goal met must stay `complete`.
  for (const prior of ['complete', 'cancelled', 'budget_limited', 'error'] as const) {
    const env = makeEnv({ workerEnabled: false });
    try {
      const run = seed(env);
      env.goals.update(run.id, { status: prior }, 'now');
      runTo(env, run, 'COMPLETED');
      assert.equal(env.goals.get(run.id)!.status, prior, `${prior} was overwritten by unmet`);
      assert.deepEqual(goalEvents(env, run.id), [], `spurious goal.unmet over a ${prior} goal`);
    } finally { env.close(); }
  }
});

test('a Run with no goal settles nothing', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'a', task: 'plain', agent: 'fake' });
    runTo(env, run, 'COMPLETED');
    assert.deepEqual(goalEvents(env, run.id), []);
  } finally { env.close(); }
});

test('a Run cancelled before it started closes the goal and says it was never attempted', () => {
  // No "leave it open" escape: an open goal on a Run that will never run again is the dangling
  // state this removes. The distinction lives in `attempted`, not in a status that stays open.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = seed(env);
    env.runs.transition(run.id, 'CANCELLED', { completedAt: new Date().toISOString() });
    assert.equal(env.goals.get(run.id)!.status, 'unmet');
    const p = env.events.list(run.id).find((e) => e.type === 'goal.unmet')!.payload as Record<string, unknown>;
    assert.equal(p.attempted, false);
    assert.match(String(p.reason), /never attempted/i);
  } finally { env.close(); }
});

test('a non-terminal transition settles nothing', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = seed(env);
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING');
    assert.equal(env.goals.get(run.id)!.status, 'active');
    assert.deepEqual(goalEvents(env, run.id), []);
  } finally { env.close(); }
});

test('the API cancel path settles the goal too, not only the worker', () => {
  // Proves the guarantee is structural rather than a property of the worker's code path.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = seed(env);
    env.runService.cancel(run.id, 'a', false);
    assert.equal(env.goals.get(run.id)!.status, 'unmet');
    assert.deepEqual(goalEvents(env, run.id), ['goal.unmet']);
  } finally { env.close(); }
});

test('a goal settled to unmet rolls back if the event append fails', () => {
  // Atomicity, not optimism. If the status write committed and the event did not, the table
  // would say `unmet` while the timeline said nothing -- two sources of truth disagreeing.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = seed(env);
    // A second RunStore over the same database, with a hook whose event append explodes.
    const failing = new RunStore(env.db, {
      onTerminalTransition: (r, to) => {
        settleGoalOnTerminal(
          { goals: env.goals, events: { append: () => { throw new Error('append exploded'); } } },
          r, to,
        );
      },
    });
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING', { startedAt: new Date().toISOString() });
    assert.throws(
      () => failing.transition(run.id, 'COMPLETED', { completedAt: new Date().toISOString() }),
      /append exploded/,
    );
    assert.equal(env.runs.get(run.id)!.status, 'RUNNING', 'status committed despite the failed settle');
    assert.equal(env.goals.get(run.id)!.status, 'active', 'goal settled despite the rollback');
  } finally { env.close(); }
});

test('lease loss closes the goal too, even though that FAILED is written by raw SQL', () => {
  // The choke point is not quite single: lease-loss reaping marks a Run FAILED with raw SQL so
  // it can clear lease_owner in the same statement (issue #53). That bypasses transition(), so
  // without an explicit notify the goal on a reaped Run stays `active` forever -- the exact
  // state this feature exists to remove.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = seed(env, 'finish the migration');
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING', { startedAt: new Date().toISOString() });
    // A lease that expired an hour ago, owned by a worker that is gone.
    env.db
      .prepare('UPDATE runs SET lease_owner = ?, lease_expires_at = ? WHERE id = ?')
      .run('worker-dead', new Date(Date.now() - 3_600_000).toISOString(), run.id);

    const { failed } = env.queue.reapExpiredLeases(Date.now());
    assert.deepEqual(failed, [run.id], 'the reaper did not fail the run');
    assert.equal(env.runs.get(run.id)!.status, 'FAILED');

    const g = env.goals.get(run.id)!;
    assert.equal(g.status, 'unmet', 'lease loss left the goal open -- an exit route was missed');
    const ev = env.events.list(run.id).find((e) => e.type === 'goal.unmet');
    assert.ok(ev, 'no goal.unmet event after lease loss');
    const payload = ev!.payload as Record<string, unknown>;
    assert.equal(payload.terminalStatus, 'FAILED');
    assert.equal(payload.attempted, true);
  } finally { env.close(); }
});

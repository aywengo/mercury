/**
 * "Never attempted" must be separable from "attempted and stopped short" (issue #489).
 *
 * Phase 1 settled every terminal Run to `unmet` and recorded the distinction only in the event
 * payload. Every aggregate surface therefore counted a Run cancelled while QUEUED -- and the
 * routine FAILED(infrastructure) workspace-setup path -- in the same bucket as the pair the whole
 * feature exists to expose. docs/goals.md 14 predicted this: noise on the single signal would
 * discredit the feature before the counter could be trusted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { makeEnv, tempDir } from './helpers.ts';
import { MIGRATIONS, openDatabase } from '../src/db/database.ts';
import { collectMetrics } from '../src/metrics/collect.ts';

function goalRow(env: ReturnType<typeof makeEnv>, runId: string): { attempted: number | null } {
  return env.db.prepare('SELECT attempted FROM run_goals WHERE run_id = ?')
    .get(runId) as { attempted: number | null };
}

test('v8 adds attempted and invents no value for existing goals', () => {
  // The upgrade path is the one that matters. Goals written before this migration have no answer
  // to "was it attempted" -- the Run may have started or not and nothing recorded it. Defaulting
  // to 0 would retroactively relabel every live goal as never-started.
  const dir = tempDir('mercury-migrate-v8-');
  const dbPath = join(dir, 'test.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    const V8 = MIGRATIONS.findIndex((m) => m.includes('ADD COLUMN attempted'));
    assert.ok(V8 > 0, 'the v8 migration was not found');
    for (const sql of MIGRATIONS.slice(0, V8)) db.exec(sql);
    assert.deepEqual(
      db.prepare("SELECT name FROM pragma_table_info('run_goals') WHERE name = 'attempted'").all(),
      [], 'the column existed before v8');

    // A pre-existing goal row, as an upgraded database would have.
    // Built from the live schema rather than a hand-written column list: this test is about what
    // the migration does to an EXISTING row, and a literal list rots the moment a column is added
    // -- it would fail here for a reason unrelated to the change under review.
    const required = (db.prepare(
      `SELECT name FROM pragma_table_info('runs')`
      + ` WHERE "notnull" = 1 AND dflt_value IS NULL AND name <> 'id'`).all() as { name: string }[])
      .map((r) => r.name);
    // Guard the guard: if the introspection silently returns nothing the INSERT below would
    // omit every required column and fail on a constraint, pointing the reader at the wrong line.
    assert.ok(required.length > 0, 'schema introspection found no required columns');
    const values = required.map((c) => {
      if (c === 'owner_id') return 'o';
      if (c === 'status') return 'COMPLETED';
      if (c.endsWith('_json')) return '{}';
      if (c === 'attempt') return 0;
      return 'x';
    });
    // prepare().run(), not exec(): exec() does not bind parameters, so the placeholders stay
    // literal and the insert fails on a constraint far from the real cause.
    db.prepare(`INSERT INTO runs (id, ${required.join(', ')}) VALUES ('r1', ${required.map(() => '?').join(', ')})`)
      .run(...values);
    db.exec("INSERT INTO run_goals (run_id, objective, status, source, updated_at) VALUES ('r1','obj','unmet','operator','2026-01-02')");

    db.exec(MIGRATIONS[V8]);
    const row = db.prepare("SELECT attempted FROM run_goals WHERE run_id = 'r1'").get() as { attempted: number | null };
    assert.equal(row.attempted, null, 'the migration invented an answer for a goal it cannot know about');
  } finally { db.close(); }
});

test('settlement records whether the Run ever started', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const seed = () => {
      const run = env.runService.create({ ownerId: 'a', task: 'the task', agent: 'fake' });
      env.goals.insert({ runId: run.id, status: 'active', objective: 'obj', source: 'operator', updatedAt: 'u' });
      return run;
    };
    // The signal: it ran, and the harness never declared the objective met.
    const ran = seed();
    env.runs.transition(ran.id, 'STARTING');
    env.runs.transition(ran.id, 'RUNNING', { startedAt: new Date().toISOString() });
    env.runs.transition(ran.id, 'COMPLETED', { completedAt: new Date().toISOString() });
    // The noise: cancelled while QUEUED, the harness never received the goal.
    const queued = seed();
    env.runs.transition(queued.id, 'CANCELLED', { completedAt: new Date().toISOString() });

    assert.equal(env.goals.get(ran.id)?.attempted, true);
    assert.equal(env.goals.get(queued.id)?.attempted, false);
    assert.equal(goalRow(env, ran.id).attempted, 1);
    assert.equal(goalRow(env, queued.id).attempted, 0);
  } finally { env.close(); }
});

test('an unsettled goal reads as unknown, never as false', () => {
  // The distinction between "no answer" and "answer: no" is the whole content of the fix.
  // Collapsing it would classify the entire open population as never-started -- the same class of
  // error as coercing an unreported tokensUsed to zero.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'a', task: 't', agent: 'fake' });
    env.goals.insert({ runId: run.id, status: 'active', objective: 'obj', source: 'operator', updatedAt: 'u' });
    assert.equal(env.goals.get(run.id)?.attempted, undefined);
    assert.equal(goalRow(env, run.id).attempted, null);
  } finally { env.close(); }
});

test('a later patch does not erase a recorded attempted', () => {
  // The harness relay path patches usage onto a goal that may already be settled. A bare
  // `patch.attempted` in the update would turn a recorded 0 back into NULL and silently move the
  // goal from "noise" to "unknown" in the metric.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'a', task: 't', agent: 'fake' });
    env.goals.insert({ runId: run.id, status: 'active', objective: 'obj', source: 'operator', updatedAt: 'u' });
    env.goals.update(run.id, { status: 'unmet', attempted: false }, 'now');
    env.goals.update(run.id, { tokensUsed: 42 }, 'later');
    assert.equal(env.goals.get(run.id)?.attempted, false, 'a usage-only patch erased the answer');
    assert.equal(env.goals.get(run.id)?.tokensUsed, 42);
  } finally { env.close(); }
});

test('the metric separates the signal from the noise', () => {
  // The regression proof for the actual complaint: three unmet goals, only one of which is the
  // thing an operator needs to see. Before the label these were indistinguishable at the only
  // aggregate surface that exists.
  const env = makeEnv({ workerEnabled: false });
  try {
    const seed = () => {
      const run = env.runService.create({ ownerId: 'a', task: 't', agent: 'fake' });
      env.goals.insert({ runId: run.id, status: 'active', objective: 'obj', source: 'operator', updatedAt: 'u' });
      return run;
    };
    const a = seed();
    env.runs.transition(a.id, 'STARTING');
    env.runs.transition(a.id, 'RUNNING', { startedAt: 'x' });
    env.runs.transition(a.id, 'COMPLETED', { completedAt: 'y' });
    const b = seed();
    env.runs.transition(b.id, 'CANCELLED', { completedAt: 'y' });
    const c = seed();
    env.runs.transition(c.id, 'STARTING');
    env.runs.transition(c.id, 'FAILED', { completedAt: 'y' });   // workspace setup blew up

    const snap = collectMetrics(env.db);
    assert.equal(snap.goalsByStatus.unmet, 3, 'the marginal should still count all three');
    assert.deepEqual(snap.goalsByStatusAndAttempted.unmet, { true: 1, false: 2, unknown: 0 },
      'the gauge cannot tell the signal from the noise');
  } finally { env.close(); }
});

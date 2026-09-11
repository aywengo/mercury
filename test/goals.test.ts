/**
 * Goal admission and persistence (docs/goals.md sections 5, 6, 13).
 *
 * The property under test throughout: a goal is either accepted AND trackable, or refused
 * with a reason. The middle state -- accepted, stored, never updated -- is issue #459 and
 * every test here is aimed at making it unreachable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEnv } from './helpers.ts';
import { GoalStore } from '../src/runs/goalStore.ts';
import { openDatabase } from '../src/db/database.ts';
import { tempDir } from './helpers.ts';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import type { AgentAdapter, AgentCapabilities, AgentVersionInfo, RunContext } from '../src/domain/types.ts';

/** An adapter that can carry goals, given a version to report. */
function capableAdapter(version: string | null): AgentAdapter {
  const capabilities: AgentCapabilities = { goals: { set: '0.3.3', track: '0.3.3' } };
  return {
    capabilities,
    detectVersion: async (): Promise<AgentVersionInfo> =>
      version === null ? { version: null, raw: null, error: 'unparsable' } : { version, raw: version },
    start: async () => { throw new Error('not started'); },
    sendInput: async () => {},
    cancel: async () => {},
  } as AgentAdapter;
}

function goalEvents(env: ReturnType<typeof makeEnv>, runId: string): string[] {
  return env.events.list(runId).filter((e) => e.type.startsWith('goal.')).map((e) => e.type);
}

test('a Run with no goal emits no goal events and stores no row', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'plain', agent: 'fake' });
    assert.deepEqual(goalEvents(env, run.id), []);
    assert.equal(env.goals.get(run.id), null);
  } finally { env.close(); }
});

test('a goal on an agent that cannot carry one is refused, and nothing is written', async () => {
  // The core fail-closed case. `fake` declares no goal support, so a goal must be rejected
  // outright -- not accepted, persisted, and then never reported on.
  const env = makeEnv({ workerEnabled: false });
  try {
    let message = '';
    try {
      env.runService.create({ ownerId: 'alice', task: 'do it', agent: 'fake', goal: { objective: 'done' } });
      assert.fail('expected the create to be rejected');
    } catch (err) {
      message = (err as Error).message;
    }
    assert.match(message, /fake does not support goals/i, message);
    // Nothing may linger: a rejected create must not leave a Run or a goal row.
    assert.equal(env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 50 }).runs.length, 0, 'a rejected create left a Run behind');
  } finally { env.close(); }
});

test('a goal is accepted on a capable agent, stored, and announced', async () => {
  const env = makeEnv({
    workerEnabled: false,
    adapters: { capable: capableAdapter('0.9.4') },
    probeCapabilities: true,
  });
  try {
    await env.agentCapabilities.settle();
    const run = env.runService.create({
      ownerId: 'alice', task: 'fix the bug', agent: 'capable',
      goal: { objective: 'calc tests pass', tokenBudget: 5000 },
    });
    const stored = env.goals.get(run.id);
    assert.ok(stored, 'goal row missing');
    assert.equal(stored!.objective, 'calc tests pass');
    assert.equal(stored!.status, 'active');
    assert.equal(stored!.tokenBudget, 5000);
    assert.equal(stored!.source, 'operator');
    assert.deepEqual(goalEvents(env, run.id), ['goal.created']);
  } finally { env.close(); }
});

test('an omitted objective is stored as the task text', async () => {
  const env = makeEnv({
    workerEnabled: false, adapters: { capable: capableAdapter('0.9.4') }, probeCapabilities: true,
  });
  try {
    await env.agentCapabilities.settle();
    const run = env.runService.create({ ownerId: 'a', task: 'ship the release', agent: 'capable', goal: {} });
    assert.equal(env.goals.get(run.id)!.objective, 'ship the release');
  } finally { env.close(); }
});

test('a capable agent whose version cannot be detected is refused, not guessed', async () => {
  // Fail closed. "unknown" must not become "supported" (that is #459) and must not become
  // "unsupported" either -- the message has to say the version could not be determined, so
  // the operator fixes the probe instead of switching agent.
  const env = makeEnv({
    workerEnabled: false, adapters: { capable: capableAdapter(null) }, probeCapabilities: true,
  });
  try {
    await env.agentCapabilities.settle();
    try {
      env.runService.create({ ownerId: 'a', task: 't', agent: 'capable', goal: {} });
      assert.fail('expected rejection');
    } catch (err) {
      assert.match((err as Error).message, /could not be determined/, (err as Error).message);
    }
  } finally { env.close(); }
});

test('a goal on an agent that is too old names the threshold and the detected version', async () => {
  const env = makeEnv({
    workerEnabled: false, adapters: { capable: capableAdapter('0.2.7') }, probeCapabilities: true,
  });
  try {
    await env.agentCapabilities.settle();
    try {
      env.runService.create({ ownerId: 'a', task: 't', agent: 'capable', goal: {} });
      assert.fail('expected rejection');
    } catch (err) {
      const m = (err as Error).message;
      assert.match(m, /0\.3\.3/, m);
      assert.match(m, /0\.2\.7/, m);
    }
  } finally { env.close(); }
});

test('an invalid goal is rejected before any Run is written', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    try {
      env.runService.create({ ownerId: 'a', task: 't', agent: 'fake', goal: { gates: [{ command: 'x' }] } });
      assert.fail('expected rejection');
    } catch (err) {
      assert.match((err as Error).message, /timeoutMs/);
    }
    assert.equal(env.runService.list({ ownerId: 'a', isAdmin: true, limit: 50 }).runs.length, 0);
  } finally { env.close(); }
});

// --- store behaviour ----------------------------------------------------------

test('migration v6 creates run_goals on a fresh database', () => {
  const dir = tempDir('goal-migrate');
  try {
    const db = openDatabase(join(dir, 'g.db'));
    const cols = (db.prepare('PRAGMA table_info(run_goals)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes('objective'), `run_goals missing columns: ${cols.join(',')}`);
    assert.ok(cols.includes('time_used_seconds'), 'column must be seconds, matching what harnesses report');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('update returns null for a Run with no goal rather than throwing', () => {
  // The finalisation path calls this for every Run that ends and most have no goal.
  const dir = tempDir('goal-store');
  try {
    const db = openDatabase(join(dir, 'g.db'));
    const store = new GoalStore(db);
    assert.equal(store.update('missing-run', { status: 'unmet' }, 'now'), null);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('harness text is bounded before it is stored', () => {
  // lastReason is agent-controlled. Unbounded harness text in a row is how it later reaches
  // an SSE frame (issue #50).
  const dir = tempDir('goal-bound');
  try {
    const db = openDatabase(join(dir, 'g.db'));
    const store = new GoalStore(db);
    db.prepare(`INSERT INTO runs (id, owner_id, task, repository_json, agent, status, attempt,
                constraints_json, created_at)
                VALUES ('r1','o','t','{}','fake','QUEUED',1,'{}','2026-01-01T00:00:00Z')`).run();
    store.insert({ runId: 'r1', status: 'active', objective: 'o', source: 'operator', updatedAt: 'u' });
    const updated = store.update('r1', { lastReason: 'x'.repeat(50_000) }, 'now')!;
    assert.ok(updated.lastReason && updated.lastReason.length <= 2001, `stored ${updated.lastReason?.length} chars`);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isOpen is true only while the goal is active', () => {
  const dir = tempDir('goal-open');
  try {
    const db = openDatabase(join(dir, 'g.db'));
    const store = new GoalStore(db);
    db.prepare(`INSERT INTO runs (id, owner_id, task, repository_json, agent, status, attempt,
                constraints_json, created_at)
                VALUES ('r1','o','t','{}','fake','QUEUED',1,'{}','2026-01-01T00:00:00Z')`).run();
    store.insert({ runId: 'r1', status: 'active', objective: 'o', source: 'operator', updatedAt: 'u' });
    assert.equal(store.isOpen('r1'), true);
    store.update('r1', { status: 'complete' }, 'now');
    assert.equal(store.isOpen('r1'), false, 'a completed goal must not be reported as open');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

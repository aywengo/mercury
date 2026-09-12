/**
 * The section 6 event table is a contract, and it had drifted (issue #495).
 *
 * It listed `goal.budgetLimited` where the registry has `goal.budget_limited`, described
 * `goal.unmet` as `{ runStatus, lastVerdict?, turnsUsed? }` when the settlement appends nine
 * different keys under different names, and described the harness-relayed rows in Mercury's
 * normalized vocabulary when what is stored is the raw harness payload plus `status`. A
 * consumer written from that table would have read `undefined` off the single most important
 * event in the feature.
 *
 * These tests bind the table to the code that writes it, in both directions: a type cannot be
 * registered without a row, a row cannot name an unregistered type, and the documented field
 * lists must match the payloads actually appended.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, tempDir, waitFor } from './helpers.ts';
import { isEventType } from '../src/domain/types.ts';
import { EVENT_TYPES } from '../src/domain/types.ts';
import type { AgentAdapter, AgentCapabilities, AgentVersionInfo, Run } from '../src/domain/types.ts';

/** An adapter that declares full goal support, so admission lets a goal through. */
function capableAdapter(): AgentAdapter {
  const capabilities: AgentCapabilities = {
    goals: { set: '0.3.3', track: '0.3.3', tokenBudget: '0.3.3', contract: '0.3.3', gates: '0.3.3' },
  };
  return {
    capabilities,
    detectVersion: async (): Promise<AgentVersionInfo> => ({ version: '0.9.4', raw: '0.9.4' }),
    start: async () => { throw new Error('not started'); },
    sendInput: async () => {},
    cancel: async () => {},
  } as unknown as AgentAdapter;
}

const DOCS_FILE = join(import.meta.dirname, '..', 'docs', 'goals.md');
const DOCS = readFileSync(DOCS_FILE, 'utf8');

/** Rows of the section 6 payload table: type -> documented payload text. */
function sectionSixRows(): Map<string, string> {
  const at = DOCS.indexOf('| Type | Payload actually appended | Emitted when |');
  assert.ok(at >= 0, 'docs/goals.md no longer has the section 6 payload table');
  const end = DOCS.indexOf('\n\n', at);
  const rows = new Map<string, string>();
  for (const line of DOCS.slice(at, end).split('\n')) {
    const m = line.match(/^\| `(goal\.[a-z_]+)` \| (.*?) \| (.*?) \|$/);
    if (m) rows.set(m[1], m[2]);
  }
  return rows;
}

function registeredGoalTypes(): string[] {
  return [...EVENT_TYPES].filter((t) => t.startsWith('goal.')).sort();
}

function seed(env: ReturnType<typeof makeEnv>, objective = 'ship it', repo?: string): Run {
  const run = env.runService.create({
    ownerId: 'a',
    task: 'the task',
    agent: 'fake',
    ...(repo ? { repository: { localPath: repo } } : {}),
  });
  env.goals.insert({ runId: run.id, status: 'active', objective, source: 'operator', updatedAt: 'u' });
  return run;
}

function payload(env: ReturnType<typeof makeEnv>, runId: string, type: string): Record<string, unknown> {
  const ev = env.events.list(runId).find((e) => e.type === type);
  assert.ok(ev, `no ${type} event was appended`);
  return ev.payload as Record<string, unknown>;
}

test('every goal row in the section 6 table names a registered event type', () => {
  const rows = sectionSixRows();
  assert.ok(rows.size >= 8, `expected at least the 8 registered goal types, table has ${rows.size}`);
  const bogus = [...rows.keys()].filter((t) => !isEventType(t));
  assert.deepEqual(bogus, [], `documented but not in EVENT_TYPES: ${bogus.join(', ')}`);
});

test('every registered goal type has a section 6 row', () => {
  const rows = sectionSixRows();
  const missing = registeredGoalTypes().filter((t) => !rows.has(t));
  assert.deepEqual(missing, [], `registered but undocumented: ${missing.join(', ')}`);
});

test('gate outcome types stay unregistered until an emitter exists', () => {
  // Registering a type with no emitter makes the vocabulary a claim with no evidence behind
  // it, and lets a consumer subscribe to an event that can never fire.
  for (const t of ['goal.gate.failed', 'goal.gate.passed']) {
    assert.equal(isEventType(t), false, `${t} must stay out of EVENT_TYPES until Phase 4b`);
    assert.ok(!sectionSixRows().has(t), `${t} must not appear in the payload table`);
  }
});

test('goal.created appends the documented fields, and omits what was never set', async () => {
  const env = makeEnv({ workerEnabled: false, adapters: { capable: capableAdapter() }, probeCapabilities: true });
  // The version probe is boot-detached and never awaited, so admission cannot be reached
  // until it settles. That is deliberate: an unreachable binary must not block boot.
  await env.agentCapabilities.settle();
  try {
    const run = env.runService.create({ ownerId: 'a', task: 'the task', agent: 'capable', goal: { objective: 'ship it' } });
    const p = payload(env, run.id, 'goal.created');
    assert.equal(p.objective, 'ship it');
    // Absent, not empty: a goal with no contract must not gain an empty one on the way to the
    // timeline, or a consumer cannot tell "no contract" from "contract of nothing".
    for (const k of ['contract', 'gates', 'tokenBudget']) assert.ok(!(k in p), `${k} was never set but appears in goal.created`);
  } finally { env.close(); }
});

test('goal.unmet appends the fields the table documents, under those names', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = seed(env, 'tests pass');
    // Usage recorded, so the optional usage fields are present and can be checked by name.
    env.goals.update(run.id, { tokensUsed: 632007, timeUsedSeconds: 4695, turnsUsed: 35 }, new Date().toISOString());
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING', { startedAt: new Date().toISOString() });
    env.runs.transition(run.id, 'COMPLETED', { completedAt: new Date().toISOString() });

    const p = payload(env, run.id, 'goal.unmet');
    // The table used to promise `runStatus` and `lastVerdict`. Neither exists: the real name is
    // `terminalStatus`, and `lastVerdict` is Hermes-only and never reaches this payload.
    assert.ok(!('runStatus' in p), 'runStatus is not a real field and must not be documented');
    assert.ok(!('lastVerdict' in p), 'lastVerdict is never appended to goal.unmet');

    const cell = sectionSixRows().get('goal.unmet')!;
    const documented = [...cell.matchAll(/\b([a-zA-Z]+)\??\b/g)].map((m) => m[1]).filter((k) => !['goal', 'unmet'].includes(k));
    const actual = Object.keys(p);
    for (const key of documented) {
      assert.ok(actual.includes(key), `table documents goal.unmet.${key} but nothing appends it`);
    }
    assert.equal(p.terminalStatus, 'COMPLETED');
    assert.equal(p.attempted, true);
    assert.equal(p.tokensUsed, 632007);
  } finally { env.close(); }
});

test('goal.unmet omits unreported usage instead of inventing a zero', () => {
  // The standing rule: an absent number stays absent, because a fabricated zero would read as
  // measured usage. The table marks these optional and this is what that means.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = seed(env, 'no usage');
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING', { startedAt: new Date().toISOString() });
    env.runs.transition(run.id, 'COMPLETED', { completedAt: new Date().toISOString() });
    const p = payload(env, run.id, 'goal.unmet');
    for (const k of ['tokensUsed', 'timeUsedSeconds', 'turnsUsed']) {
      assert.ok(!(k in p), `${k} must be absent when unreported, not zero`);
    }
    assert.equal(p.attempted, true, 'attempted is still answered even with no usage');
  } finally { env.close(); }
});

test('goal.cancelled appends source and runStatus', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = seed(env);
    env.runService.cancelGoal(run.id, 'a', true);
    const p = payload(env, run.id, 'goal.cancelled');
    assert.deepEqual(Object.keys(p).sort(), ['runStatus', 'source']);
  } finally { env.close(); }
});

test('a relayed event carries the harness field names, not Mercury normalized ones', async () => {
  // The table says "raw harness report + status". If recordGoalReport ever appends the
  // normalized patch instead, the row and the timeline would say the same thing twice and
  // the harness evidence would be gone -- so the claim is checked, not asserted in prose.
  const repo = tempDir('mercury-goal-evt-');
  const env = makeEnv({
    workerEnabled: false,
    fakeScript: [
      { event: { type: 'goal.updated', payload: { active: true, status: 'active', tokensUsed: 100, timeUsedSeconds: 7, continuationsUsed: 3 } } },
    ],
  });
  try {
    const run = seed(env, 'make tests pass', repo);
    env.worker.start();
    await waitFor(() => env.events.list(run.id).some((e) => e.type === 'goal.updated'), 10_000);
    const p = payload(env, run.id, 'goal.updated');
    assert.equal(p.continuationsUsed, 3, 'the harness name must survive into the event');
    assert.ok(!('turnsUsed' in p), 'Mercury normalizes continuationsUsed to turnsUsed only in the row');
    assert.equal(p.status, 'active', 'Mercury adds its own resolved status');
    assert.equal(env.goals.get(run.id)!.turnsUsed, 3, 'while the row carries the normalized name');
  } finally { env.close(); }
});

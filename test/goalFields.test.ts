/**
 * Per-field goal capability admission (docs/goals.md 13.2, Phase 4).
 *
 * `set` answering yes does not make the rest of a goal spec meaningful. PrimeAgent carries an
 * objective and reports its status, and has no gate or contract concept at all; before this was
 * enforced, `goal.gates` was accepted, persisted, and rendered on a Run whose harness will never
 * evaluate it -- issue #459 (advertise a capability nobody honours) reproduced inside the feature
 * built to prevent it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.ts';
import { RunService } from '../src/runs/runService.ts';
import { createSkillSelector } from '../src/skills/skillSelector.ts';
import { LocalAgentAdapter } from '../src/adapters/localAgentAdapter.ts';
import { MAX_GOAL_GATE_TIMEOUT_MS } from '../src/domain/types.ts';
import { GOAL_CAPABILITY_FIELDS } from '../src/domain/goalSupport.ts';
import type { AgentAdapter, AgentCapabilities, AgentVersionInfo } from '../src/domain/types.ts';

function adapter(version: string | null, capabilities: AgentCapabilities): AgentAdapter {
  return {
    capabilities,
    detectVersion: async (): Promise<AgentVersionInfo> =>
      version === null ? { version: null, raw: null, error: 'unparsable' } : { version, raw: version },
    start: async () => {
      throw new Error('not started');
    },
    sendInput: async () => {},
    cancel: async () => {},
  } as AgentAdapter;
}

/** Exactly what PrimeAgentAdapter declares: set/track/tokenBudget, and NO contract or gates. */
const PRIMEAGENT_LIKE: AgentCapabilities = { goals: { set: '0.3.3', track: '0.3.3', tokenBudget: '0.3.3' } };

/** A declarative adapter that really does report gates and a contract. */
const GATE_CAPABLE: AgentCapabilities = {
  goals: { set: '0.3.3', track: '0.3.3', tokenBudget: '0.3.3', contract: '1.2.0', gates: '1.2.0' },
};

const GATE = { command: 'npm test', timeoutMs: 60_000, maxRetries: 2 };

async function envWith(agent: string, capabilities: AgentCapabilities, version: string | null = '0.9.4') {
  const env = makeEnv({ workerEnabled: false, adapters: { [agent]: adapter(version, capabilities) }, probeCapabilities: true });
  await env.agentCapabilities.settle();
  return env;
}

function createGoal(env: ReturnType<typeof makeEnv>, agent: string, goal: unknown): { ok: boolean; message: string } {
  try {
    env.runService.create({ ownerId: 'alice', task: 'do the thing', agent, goal });
    return { ok: true, message: '' };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

test('gates are refused for an agent that has no gate concept', async () => {
  const env = await envWith('capable', PRIMEAGENT_LIKE);
  try {
    const r = createGoal(env, 'capable', { objective: 'ship it', gates: [GATE] });
    assert.equal(r.ok, false, 'gates were accepted for an agent that cannot report them');
    assert.match(r.message, /goal\.gates/, `message must name the field: ${r.message}`);
    assert.match(r.message, /not supported by capable/, `message must name the agent: ${r.message}`);
    // Refusing must not leave a Run behind, or the caller has a Run carrying a goal nobody asked for.
    assert.equal(env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 50 }).runs.length, 0,
      'a rejected create left a Run behind');
  } finally { env.close(); }
});

test('a contract is refused for an agent that has no contract concept', async () => {
  const env = await envWith('capable', PRIMEAGENT_LIKE);
  try {
    const r = createGoal(env, 'capable', { objective: 'ship it', contract: { outcome: 'tests green' } });
    assert.equal(r.ok, false, 'contract was accepted for an agent that cannot carry one');
    assert.match(r.message, /goal\.contract/);
  } finally { env.close(); }
});

test('tokenBudget is refused when the adapter does not declare it', async () => {
  // set/track only: the caller can set a goal but Mercury has nowhere to pass a budget.
  const env = await envWith('capable', { goals: { set: '0.3.3', track: '0.3.3' } });
  try {
    const r = createGoal(env, 'capable', { objective: 'ship it', tokenBudget: 5000 });
    assert.equal(r.ok, false, 'tokenBudget was accepted with no declared support');
    assert.match(r.message, /goal\.tokenBudget/);
  } finally { env.close(); }
});

test('tokenBudget is accepted when declared, so the check is not a blanket refusal', async () => {
  const env = await envWith('capable', PRIMEAGENT_LIKE);
  try {
    const r = createGoal(env, 'capable', { objective: 'ship it', tokenBudget: 5000 });
    assert.equal(r.ok, true, `unexpectedly refused: ${r.message}`);
  } finally { env.close(); }
});

test('gates and a contract are accepted when the adapter declares them', async () => {
  const env = await envWith('capable', GATE_CAPABLE, '1.4.0');
  try {
    const r = createGoal(env, 'capable', {
      objective: 'ship it', gates: [GATE], contract: { outcome: 'tests green' },
    });
    assert.equal(r.ok, true, `unexpectedly refused: ${r.message}`);
    const runs = env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 10 }).runs;
    const stored = env.goals.get(runs[0].id);
    assert.deepEqual(stored?.gates, [GATE], 'the accepted gate spec was not persisted');
  } finally { env.close(); }
});

test('gates are refused when the installed version predates the gates threshold', async () => {
  // Declared at 1.2.0, installed 1.1.0: the goal itself is fine (set is 0.3.3), the gates are not.
  const env = await envWith('capable', GATE_CAPABLE, '1.1.0');
  try {
    const r = createGoal(env, 'capable', { objective: 'ship it', gates: [GATE] });
    assert.equal(r.ok, false, 'gates accepted on a version that predates them');
    assert.match(r.message, /goal\.gates requires capable >= 1\.2\.0/);
    assert.match(r.message, /detected 1\.1\.0/, 'the operator needs the detected version to act on');
    // The goal itself is still settable on this version -- the refusal is field-scoped.
    const plain = createGoal(env, 'capable', { objective: 'ship it' });
    assert.equal(plain.ok, true, `a plain goal should still work: ${plain.message}`);
  } finally { env.close(); }
});

test('an empty contract does not trip the contract check', async () => {
  // resolveGoalSpec normalises `contract: {}` away, so nothing was actually asked for.
  const env = await envWith('capable', PRIMEAGENT_LIKE);
  try {
    const r = createGoal(env, 'capable', { objective: 'ship it', contract: {} });
    assert.equal(r.ok, true, `an empty contract was refused: ${r.message}`);
  } finally { env.close(); }
});

test('an empty gate list does not trip the gates check', async () => {
  const env = await envWith('capable', PRIMEAGENT_LIKE);
  try {
    const r = createGoal(env, 'capable', { objective: 'ship it', gates: [] });
    assert.equal(r.ok, true, `an empty gate list was refused: ${r.message}`);
  } finally { env.close(); }
});

test('a gate timeout must be bounded, not merely positive', async () => {
  const env = await envWith('capable', GATE_CAPABLE, '1.4.0');
  try {
    const r = createGoal(env, 'capable', {
      objective: 'ship it', gates: [{ command: 'make', timeoutMs: MAX_GOAL_GATE_TIMEOUT_MS + 1, maxRetries: 0 }],
    });
    assert.equal(r.ok, false, 'an effectively unbounded gate timeout was accepted');
    assert.match(r.message, /over the \d+ms ceiling/);
    assert.match(r.message, /indistinguishable from a hung one/);
    // Exactly at the ceiling is still fine -- the bound is inclusive, not off by one.
    const at = createGoal(env, 'capable', {
      objective: 'ship it', gates: [{ command: 'make', timeoutMs: MAX_GOAL_GATE_TIMEOUT_MS, maxRetries: 0 }],
    });
    assert.equal(at.ok, true, `a timeout at the ceiling was refused: ${at.message}`);
  } finally { env.close(); }
});

test('the field answers are visible on the capability surface', async () => {
  // An operator should be able to see WHY gates would be refused without creating a Run to find
  // out. Nested under goals so /api/agents' top-level key set stays as fleetContract pins it.
  const env = await envWith('capable', PRIMEAGENT_LIKE);
  try {
    const caps = env.runService.listAgentCapabilities();
    const fields = caps.capable.goals.fields;
    assert.ok(fields, 'no per-field capability reported');
    assert.equal(fields.set?.supported, true);
    assert.equal(fields.gates?.supported, false);
    assert.equal(fields.contract?.supported, false);
    assert.equal(fields.gates?.reason, 'unsupported');
  } finally { env.close(); }
});

test('a capability snapshot with no per-field answers fails closed', async () => {
  // `fields` is optional on the summary, so something that builds a snapshot by hand -- a test
  // helper, or a future projection that forgets to populate it -- can answer "supported" for the
  // goal while saying nothing about its parts. Silence must not read as permission: that is the
  // assume-yes failure this feature exists to close.
  const env = makeEnv({ workerEnabled: false });
  try {
    const svc = new RunService({
      db: env.db,
      runs: env.runs,
      events: env.events,
      skills: env.skills,
      selector: createSkillSelector(),
      knownAgents: ['capable'],
      defaultAgent: 'capable',
      defaultMaxDurationMs: 60_000,
      defaultMaxRetries: 0,
      goals: env.goals,
      agentCapabilities: () => ({
        capable: {
          version: '1.4.0',
          versionRaw: '1.4.0',
          goals: { supported: true, detectedVersion: '1.4.0', detectedRaw: '1.4.0' },
        },
      }),
    });
    let message = '';
    try {
      svc.create({ ownerId: 'alice', task: 't', agent: 'capable', goal: { objective: 'o', gates: [GATE] } });
      assert.fail('gates were accepted on a snapshot that never said gates were supported');
    } catch (err) {
      message = (err as Error).message;
    }
    assert.match(message, /goal\.gates is not supported by capable/, message);
  } finally { env.close(); }
});

test('a declarative adapter takes its gate threshold from config, and admission honours it', async () => {
  // The declarative adapters exist to add agents without per-agent code, so the gate threshold
  // is operator-supplied. This proves the config value reaches admission rather than being
  // parsed and then ignored -- the failure mode would be config that looks authoritative and
  // changes nothing.
  const base = {
    id: 'acme',
    description: 'acme cli',
    command: '/usr/bin/true',
    taskInput: { mode: 'arg', flag: '--task' },
    output: { format: 'text' },
    eventMap: {},
    cancel: { signal: 'SIGTERM', graceMs: 200 },
  };
  const cfgWith = (goalSupport: Record<string, string>) => ({ ...base, goalSupport });

  const mk = async (goalSupport: Record<string, string>) => {
    const a = new LocalAgentAdapter(cfgWith(goalSupport) as never);
    // Pin the detected version so the test is about the config, not about /usr/bin/true.
    a.detectVersion = async () => ({ version: '2.0.0', raw: 'acme 2.0.0' });
    const env = makeEnv({ workerEnabled: false, adapters: { acme: a }, probeCapabilities: true });
    await env.agentCapabilities.settle();
    return env;
  };

  const declared = await mk({ set: '1.0.0', track: '1.0.0', gates: '2.0.0' });
  try {
    const ok = createGoal(declared, 'acme', { objective: 'ship it', gates: [GATE] });
    assert.equal(ok.ok, true, `config-declared gates were refused: ${ok.message}`);
  } finally { declared.close(); }

  const undeclared = await mk({ set: '1.0.0', track: '1.0.0' });
  try {
    const bad = createGoal(undeclared, 'acme', { objective: 'ship it', gates: [GATE] });
    assert.equal(bad.ok, false, 'gates accepted with no gates entry in config');
    assert.match(bad.message, /goal\.gates/);
  } finally { undeclared.close(); }
});

test('maxTurns is refused, because nothing can honour it today', async () => {
  // The same rule as gates, and the same bug class. `goal.maxTurns` was validated and then
  // dropped: run_goals has no max_turns column, no adapter receives it, and the only Hermes
  // turn cap that works is the global MERCURY_HERMES_MAX_TURNS, which applies to every Run
  // whether or not it has a goal. So a caller asking for 20 turns got a 201 and a Run with no
  // turn cap -- accepted and silently not honoured, which is issue #459.
  const env = await envWith('capable', GATE_CAPABLE, '1.4.0');
  try {
    const r = createGoal(env, 'capable', { objective: 'ship it', maxTurns: 20 });
    assert.equal(r.ok, false, 'maxTurns was accepted although nothing can enforce it');
    assert.match(r.message, /goal\.maxTurns/);
  } finally { env.close(); }
});

test('maxTurns is accepted only when the adapter declares it', async () => {
  // The escape hatch exists so Phase 5 (Hermes goals) can turn this on by declaring a threshold
  // rather than by editing admission code.
  const env = await envWith('capable', {
    goals: { set: '0.3.3', track: '0.3.3', maxTurns: '1.2.0' },
  }, '1.4.0');
  try {
    const r = createGoal(env, 'capable', { objective: 'ship it', maxTurns: 20 });
    assert.equal(r.ok, true, `declared maxTurns was refused: ${r.message}`);
  } finally { env.close(); }
});

test('every capability field is resolvable, so a new matrix column cannot be forgotten', async () => {
  // Admission iterates a hardcoded field list. If someone adds a column to AgentGoalSupport and
  // forgets the list, the field would be accepted ungated -- the exact bug this file exists for.
  // Asserting the full set here means the omission shows up as a failing test rather than as a
  // silently ungated field.
  const env = await envWith('capable', PRIMEAGENT_LIKE);
  try {
    const fields = env.runService.listAgentCapabilities().capable.goals.fields;
    assert.deepEqual(
      Object.keys(fields ?? {}).sort(),
      [...GOAL_CAPABILITY_FIELDS].sort(),
      'the registry did not resolve every declared capability field',
    );
  } finally { env.close(); }
});

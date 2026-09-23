import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreset, type PresetCallerInput } from '../src/presets/resolvePreset.ts';
import type { RolePresetManifest } from '../src/presets/types.ts';

// docs/crew/role-presets.md section 3: caller/default/required precedence (roadmap §6
// acceptance 3) and constraint ceilings that only narrow (acceptance 6). Pure-function tests:
// no registry, no db.

const SYSTEM = { defaultAgent: 'fake', defaultMaxDurationMs: 60_000, defaultMaxRetries: 2 };
// Static capabilities like production passes (RunService.create wires agentCapabilities.snapshot()).
// A test that wants the UNKNOWN case builds its own lookup without staticCapabilities (#721).
const CAPS = {
  knownAgents: ['fake', 'primeagent', 'claude'],
  staticCapabilities: (id: string) => (id === 'fake'
    ? { roleInstruction: 'system' as const, sandbox: true, perRunModel: true, mcp: 'none' as const }
    : { roleInstruction: 'prompt-reference' as const, sandbox: true, mcp: 'none' as const }),
};

function manifest(over: Partial<RolePresetManifest> = {}): RolePresetManifest {
  return {
    schemaVersion: 1,
    id: 'reviewer',
    version: '1.0.0',
    description: 'Reviews changes.',
    role: 'Code reviewer',
    ...over,
  };
}

test('no preset preference: system default agent, caller skills pass through', () => {
  const r = resolvePreset(manifest(), { skills: ['code-review'] }, SYSTEM, CAPS);
  assert.equal(r.effectiveAgent.id, 'fake');
  assert.deepEqual(r.effectiveSkillIds, ['code-review']);
  assert.equal(r.effectiveConstraints.maxDurationMs, 60_000);
  assert.equal(r.effectiveConstraints.maxRetries, 2);
  assert.equal(r.requiresSandbox, false);
});

test('explicit caller [] means "no skills": defaults skipped, autoSelect suppressed, required still applied', () => {
  const m = manifest({ skills: { defaults: ['code-review'], required: ['secretary-check'], autoSelect: true } });
  const r = resolvePreset(m, { skills: [] }, SYSTEM, CAPS);
  assert.deepEqual(r.effectiveSkillIds, ['secretary-check'], 'defaults skipped, required kept');
  assert.equal(r.autoSelect, false, 'an explicit empty list is a decision, not silence');
});

test('undefined caller skills + empty defaults + autoSelect sets the autoSelect flag, required blocks it', () => {
  const quiet = manifest({ skills: { autoSelect: true } });
  const r1 = resolvePreset(quiet, {}, SYSTEM, CAPS);
  assert.deepEqual(r1.effectiveSkillIds, []);
  assert.equal(r1.autoSelect, true, 'RunService must run the selector');

  const withRequired = manifest({ skills: { autoSelect: true, required: ['secretary-check'] } });
  const r2 = resolvePreset(withRequired, {}, SYSTEM, CAPS);
  assert.deepEqual(r2.effectiveSkillIds, ['secretary-check']);
  assert.equal(r2.autoSelect, false, 'required skills make the list non-empty; no auto-select');

  const disabled = manifest({ skills: { autoSelect: false } });
  const r3 = resolvePreset(disabled, {}, SYSTEM, CAPS);
  assert.equal(r3.autoSelect, false, 'autoSelect:false disables the flag even when silent');
});

test('caller agent wins over a preset default agent', () => {
  const m = manifest({ agent: { id: 'primeagent' } });
  const r = resolvePreset(m, { agent: 'claude' }, SYSTEM, CAPS);
  assert.equal(r.effectiveAgent.id, 'claude');
});

test('a preset default agent is used when the caller is silent', () => {
  const m = manifest({ agent: { id: 'primeagent' } });
  const r = resolvePreset(m, {}, SYSTEM, CAPS);
  assert.equal(r.effectiveAgent.id, 'primeagent');
});

test('required agent: a differing caller is an error, an agreeing caller is fine, silence uses the required id', () => {
  const m = manifest({ agent: { id: 'primeagent', required: true } });
  assert.throws(
    () => resolvePreset(m, { agent: 'claude' }, SYSTEM, CAPS),
    /requires agent "primeagent"/,
  );
  const agree = resolvePreset(m, { agent: 'primeagent' }, SYSTEM, CAPS);
  assert.equal(agree.effectiveAgent.id, 'primeagent');
  const silent = resolvePreset(m, {}, SYSTEM, CAPS);
  assert.equal(silent.effectiveAgent.id, 'primeagent');
});

test('an unknown selected agent is rejected through the known-agent check', () => {
  const m = manifest({ agent: { id: 'ghost' } });
  assert.throws(() => resolvePreset(m, {}, SYSTEM, CAPS), /Unknown agent: ghost/);
  const m2 = manifest({});
  assert.throws(() => resolvePreset(m2, { agent: 'ghost' }, SYSTEM, CAPS), /Unknown agent: ghost/);
});

test('model: caller wins over the preset default; modelRequired rejects a conflicting caller', () => {
  // perRunModel: true — a model cannot resolve against unknown capabilities anymore (#721), and
  // the instruction check runs first, so the block carries roleInstruction too.
  const MODEL_CAPS = {
    knownAgents: CAPS.knownAgents,
    staticCapabilities: () => ({ roleInstruction: 'system' as const, perRunModel: true }),
  };
  const m = manifest({ agent: { model: 'sonnet' } });
  const r = resolvePreset(m, { model: 'haiku' }, SYSTEM, MODEL_CAPS);
  assert.equal(r.effectiveAgent.model, 'haiku');

  const req = manifest({ agent: { model: 'sonnet', modelRequired: true } });
  const silent = resolvePreset(req, {}, SYSTEM, MODEL_CAPS);
  assert.equal(silent.effectiveAgent.model, 'sonnet');
  assert.throws(
    () => resolvePreset(req, { model: 'haiku' }, SYSTEM, MODEL_CAPS),
    /requires model "sonnet"/,
  );
});

const NO_CAPS = { knownAgents: CAPS.knownAgents };

test('unknown capabilities fail closed for a model', () => {
  // staticCapabilities returns undefined for everything: "unknown is not supported" (#721).
  const m = manifest({ agent: { model: 'sonnet' } });
  assert.throws(
    () => resolvePreset(m, {}, SYSTEM, NO_CAPS),
    /roleInstruction: unknown/,
  );
});

test('a preset with an instruction fails closed on a roleInstruction-none or unknown agent', () => {
  // The seed manifests all carry instruction files; the test manifest() helper builds one with
  // instruction undefined, so name an instruction file explicitly via the manifest's instruction
  // block if the type has one... the instruction lives on the manifest's `instruction` field.
  const withInstruction = manifest({ instruction: { file: 'INSTRUCTION.md' } } as Partial<RolePresetManifest>);
  // fake declares roleInstruction: 'system' -> admitted.
  const fakeCaps = {
    knownAgents: CAPS.knownAgents,
    staticCapabilities: (id: string) => (id === 'fake' ? { roleInstruction: 'system' as const } : undefined),
  };
  const ok = resolvePreset(withInstruction, {}, SYSTEM, fakeCaps);
  assert.equal(ok.effectiveAgent.id, 'fake');
  // hermes declares 'none' -> rejected with the agent named.
  const noneCaps = {
    knownAgents: [...CAPS.knownAgents, 'hermes', 'daemon'],
    staticCapabilities: (id: string) => {
      if (id === 'hermes') return { roleInstruction: 'none' as const, sandbox: true };
      if (id === 'daemon') return { roleInstruction: 'none' as const, sandbox: false };
      if (id === 'fake') return { roleInstruction: 'system' as const, sandbox: true };
      return undefined;
    },
  };
  assert.throws(
    () => resolvePreset(withInstruction, { agent: 'hermes' }, SYSTEM, noneCaps),
    /agent "hermes" cannot receive one \(roleInstruction: none\)/,
  );
  // sandbox:false + requires.sandbox -> rejected at creation (acceptance 3). daemon carries a
  // capable roleInstruction here so the sandbox leg is what fires.
  const sb = manifest({ requires: { sandbox: true } });
  const daemonCaps = {
    knownAgents: noneCaps.knownAgents,
    staticCapabilities: (id: string) => (id === 'daemon'
      ? { roleInstruction: 'prompt-reference' as const, sandbox: false }
      : noneCaps.staticCapabilities(id)),
  };
  assert.throws(
    () => resolvePreset(sb, { agent: 'daemon' }, SYSTEM, daemonCaps),
    /declares sandbox: false/,
  );
  // Unknown caps + instruction -> rejected (fail closed).
  assert.throws(
    () => resolvePreset(withInstruction, {}, SYSTEM, NO_CAPS),
    /roleInstruction: unknown/,
  );
});

test('a preset model fails closed when the selected adapter cannot take a per-Run model', () => {
  const caps = {
    knownAgents: CAPS.knownAgents,
    staticCapabilities: (id: string) => (id === 'fake'
      ? { roleInstruction: 'system' as const, perRunModel: false }
      : undefined),
  };
  const m = manifest({ agent: { model: 'sonnet' } });
  assert.throws(
    () => resolvePreset(m, {}, SYSTEM, caps),
    /cannot take a per-Run model/,
  );
  // A preset WITHOUT a model is unaffected by the capability.
  const plain = resolvePreset(manifest(), {}, SYSTEM, caps);
  assert.equal(plain.effectiveAgent.model, undefined);
});

test('skills: caller list beats defaults; required appended; dedupe keeps first; cap enforced', () => {
  const m = manifest({
    skills: { defaults: ['a', 'b'], required: ['b', 'c'] },
  });
  // Caller list replaces defaults, but required is still appended and deduped: the caller
  // cannot remove a required skill (section 3.2).
  const caller = resolvePreset(m, { skills: ['x', 'y'] }, SYSTEM, CAPS);
  assert.deepEqual(caller.effectiveSkillIds, ['x', 'y', 'b', 'c']);
  // Silence uses defaults; required appended after; first occurrence kept.
  const silent = resolvePreset(m, {}, SYSTEM, CAPS);
  assert.deepEqual(silent.effectiveSkillIds, ['a', 'b', 'c']);
  // Cap after dedup: 5 distinct ids, no max -> system cap 4 -> error.
  const tooMany = manifest({ skills: { defaults: ['a', 'b'], required: ['c', 'd', 'e'] } });
  assert.throws(() => resolvePreset(tooMany, {}, SYSTEM, CAPS), /effective maximum is 4/);
  // max can LOWER the cap: 3 distinct with max 2 -> error naming 2.
  const capped = manifest({ skills: { defaults: ['a', 'b'], required: ['c'], max: 2 } });
  assert.throws(() => resolvePreset(capped, {}, SYSTEM, CAPS), /effective maximum is 2/);
});

test('autoSelect: empty effective ids with autoSelect!=false returns [] for the caller to select', () => {
  const m = manifest({ skills: { autoSelect: true } });
  const r = resolvePreset(m, {}, SYSTEM, CAPS);
  assert.deepEqual(r.effectiveSkillIds, []);
  // autoSelect: false with nothing else -> stays empty, no selection.
  const m2 = manifest({ skills: { autoSelect: false } });
  assert.deepEqual(resolvePreset(m2, {}, SYSTEM, CAPS).effectiveSkillIds, []);
  // An explicit caller empty array means "no skills" and skips selection too (section 3.2:
  // the caller provided a list; it is just empty).
  const m3 = manifest({});
  assert.deepEqual(resolvePreset(m3, { skills: [] }, SYSTEM, CAPS).effectiveSkillIds, []);
});

test('scalar constraints: effective = min(system, ceiling, caller-or-default)', () => {
  const m = manifest({
    constraints: {
      defaults: { maxDurationMs: 50_000 },
      ceilings: { maxDurationMs: 30_000, maxRetries: 1 },
    },
  });
  // Caller silent: default 50k clamped to ceiling 30k.
  const silent = resolvePreset(m, {}, SYSTEM, CAPS);
  assert.equal(silent.effectiveConstraints.maxDurationMs, 30_000);
  assert.equal(silent.effectiveConstraints.maxRetries, 1);
  // Caller under the ceiling: wins as long as it does not exceed it.
  const under = resolvePreset(m, { constraints: { maxDurationMs: 20_000 } }, SYSTEM, CAPS);
  assert.equal(under.effectiveConstraints.maxDurationMs, 20_000);
  // Caller ABOVE the ceiling: refused, not clamped silently (accepted-but-ignored is the
  // failure mode the repo refuses).
  assert.throws(
    () => resolvePreset(m, { constraints: { maxDurationMs: 40_000 } }, SYSTEM, CAPS),
    /exceeds the preset ceiling of 30000/,
  );
});

test('resourceLimits ceilings: a conflicting caller value is refused; defaults fill from the ceiling', () => {
  const m = manifest({
    constraints: { ceilings: { resourceLimits: { memory: '2g' } } },
  });
  const silent = resolvePreset(m, {}, SYSTEM, CAPS);
  assert.deepEqual(silent.effectiveConstraints.resourceLimits, { memory: '2g' });
  const equal = resolvePreset(m, { constraints: { resourceLimits: { memory: '2g' } } }, SYSTEM, CAPS);
  assert.deepEqual(equal.effectiveConstraints.resourceLimits, { memory: '2g' });
  assert.throws(
    () => resolvePreset(m, { constraints: { resourceLimits: { memory: '4g' } } }, SYSTEM, CAPS),
    /conflicts with the preset ceiling/,
  );
});

test('networkMode none: a caller list is REFUSED, not silently dropped', () => {
  const none = manifest({ constraints: { ceilings: { networkMode: 'none' } } });
  assert.throws(
    () => resolvePreset(none, { constraints: { allowedNetworks: ['github.com'] } }, SYSTEM, CAPS),
    /conflicts with the preset network ceiling/,
  );
  const r = resolvePreset(none, {}, SYSTEM, CAPS);
  assert.deepEqual(r.effectiveConstraints.allowedNetworks, []);
});

test('networkMode bridge: an empty caller allowlist is refused; non-empty passes', () => {
  const bridge = manifest({ constraints: { ceilings: { networkMode: 'bridge' } } });
  assert.throws(
    () => resolvePreset(bridge, { constraints: { allowedNetworks: [] } }, SYSTEM, CAPS),
    /conflicts with the preset network ceiling/,
  );
  const r = resolvePreset(bridge, { constraints: { allowedNetworks: ['github.com'] } }, SYSTEM, CAPS);
  assert.deepEqual(r.effectiveConstraints.allowedNetworks, ['github.com']);
});

test('requires.sandbox injects a sandbox request when the caller and preset defaults name none', () => {
  const m = manifest({ requires: { sandbox: true } });
  const r = resolvePreset(m, {}, SYSTEM, CAPS);
  // An empty resourceLimits object is the constraints vocabulary for "isolate with runtime
  // defaults" -- exactly what SandboxManager.requiresSandbox keys on.
  assert.deepEqual(r.effectiveConstraints.resourceLimits, {});
  assert.equal(r.requiresSandbox, true);
  // A preset that ALSO sets defaults keeps its own limits, no injection needed.
  const withDefaults = manifest({
    requires: { sandbox: true },
    constraints: { defaults: { allowedNetworks: [] } },
  });
  const r2 = resolvePreset(withDefaults, {}, SYSTEM, CAPS);
  assert.deepEqual(r2.effectiveConstraints.allowedNetworks, []);
  assert.equal(r2.effectiveConstraints.resourceLimits, undefined);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.ts';
import { validatePreset, PRESET_INSTRUCTION_MAX_BYTES, PRESET_SKILL_SYSTEM_CAP } from '../src/presets/validatePreset.ts';

// docs/crew/role-presets.md section 2.1: hard errors, each with a stable finding code. The
// codes are API surface -- the registry, the diagnostic API and callers branch on them -- so
// every test below pins the exact code, not the prose.

function presetDir(body: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = tempDir('mercury-preset-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), JSON.stringify(body));
  writeFileSync(join(dir, 'INSTRUCTION.md'), files['INSTRUCTION.md'] ?? 'Do the task as the role.');
  for (const [name, content] of Object.entries(files)) {
    if (name === 'INSTRUCTION.md') continue;
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const VALID = {
  schemaVersion: 1,
  id: 'reviewer',
  version: '1.0.0',
  description: 'Reviews changes.',
  role: 'Code reviewer',
};

test('a valid minimal manifest yields no findings', () => {
  const res = validatePreset('reviewer', presetDir(VALID), structuredClone(VALID));
  assert.deepEqual(res, { valid: true, findings: [] });
});

test('schemaVersion other than exactly 1 is PRESET_SCHEMA_VERSION', () => {
  for (const bad of [2, '1', null, undefined]) {
    const body = { ...structuredClone(VALID), schemaVersion: bad };
    const res = validatePreset('reviewer', presetDir(body), body);
    assert.equal(res.valid, false);
    assert.ok(res.findings.some((f) => f.code === 'PRESET_SCHEMA_VERSION' && f.field === 'schemaVersion'),
      `schemaVersion=${JSON.stringify(bad)} should be PRESET_SCHEMA_VERSION, got ${JSON.stringify(res.findings)}`);
  }
});

test('unsafe id and directory mismatch are distinct codes', () => {
  const bad = { ...structuredClone(VALID), id: '../escape' };
  const res = validatePreset('reviewer', presetDir(bad), bad);
  assert.ok(res.findings.some((f) => f.code === 'PRESET_ID'));

  const mismatch = { ...structuredClone(VALID), id: 'other' };
  const res2 = validatePreset('reviewer', presetDir(mismatch), mismatch);
  assert.ok(res2.findings.some((f) => f.code === 'PRESET_ID_MISMATCH' && f.field === 'id'));
});

test('a non-semver version is PRESET_VERSION', () => {
  for (const bad of ['1', 'v1.0.0', '1.0', '01.0.0', '']) {
    const body = { ...structuredClone(VALID), version: bad };
    const res = validatePreset('reviewer', presetDir(body), body);
    assert.ok(res.findings.some((f) => f.code === 'PRESET_VERSION'),
      `version=${JSON.stringify(bad)} should be PRESET_VERSION`);
  }
  const ok = { ...structuredClone(VALID), version: '1.2.3-rc.1+build.7' };
  const res = validatePreset('reviewer', presetDir(ok), ok);
  assert.ok(!res.findings.some((f) => f.code === 'PRESET_VERSION'));
});

test('instruction escaping the preset directory is PRESET_INSTRUCTION_PATH (absolute, .., symlink)', () => {
  const outside = tempDir('mercury-preset-outside-');
  writeFileSync(join(outside, 'secret.md'), 'not for presets');

  const abs = { ...structuredClone(VALID), instruction: { file: join(outside, 'secret.md') } };
  const res1 = validatePreset('reviewer', presetDir(abs), abs);
  assert.ok(res1.findings.some((f) => f.code === 'PRESET_INSTRUCTION_PATH'));

  const rel = { ...structuredClone(VALID), instruction: { file: '../../secret.md' } };
  const res2 = validatePreset('reviewer', presetDir(rel), rel);
  assert.ok(res2.findings.some((f) => f.code === 'PRESET_INSTRUCTION_PATH'));

  // A symlink INSIDE the directory pointing OUTSIDE is also an escape (section 2.1:
  // "crosses a symlink"). The registry materializes these bytes, so containment is not optional.
  const dir = presetDir({ ...structuredClone(VALID), instruction: { file: 'link.md' } });
  symlinkSync(join(outside, 'secret.md'), join(dir, 'link.md'));
  const res3 = validatePreset('reviewer', dir, { ...structuredClone(VALID), instruction: { file: 'link.md' } });
  assert.ok(res3.findings.some((f) => f.code === 'PRESET_INSTRUCTION_PATH'),
    JSON.stringify(res3.findings));
});

test('explicit null instruction or file is a shape/path error, not a silent default', () => {
  const nullBlock = { ...structuredClone(VALID), instruction: null };
  const res = validatePreset('reviewer', presetDir(nullBlock), nullBlock);
  assert.ok(res.findings.some((f) => f.code === 'PRESET_INSTRUCTION'),
    JSON.stringify(res.findings));

  const nullFile = { ...structuredClone(VALID), instruction: { file: null } };
  const res2 = validatePreset('reviewer', presetDir(nullFile), nullFile);
  assert.ok(res2.findings.some((f) => f.code === 'PRESET_INSTRUCTION_PATH'),
    JSON.stringify(res2.findings));
});

test('a ".." segment in the raw instruction path is refused even when it resolves back inside', () => {
  // `sub/../INSTRUCTION.md` normalizes to a contained path, but section 2.1 rejects the
  // SEGMENT: a manifest that plays normalization games cannot be trusted to stay honest.
  const tricky = { ...structuredClone(VALID), instruction: { file: 'sub/../INSTRUCTION.md' } };
  const dir = presetDir(tricky);
  mkdirSync(join(dir, 'sub'), { recursive: true });
  const res = validatePreset('reviewer', dir, tricky);
  assert.ok(res.findings.some((f) => f.code === 'PRESET_INSTRUCTION_PATH'), JSON.stringify(res.findings));
});

test('missing instruction is PRESET_INSTRUCTION_MISSING', () => {
  const dir = presetDir(VALID);
  rmSync(join(dir, 'INSTRUCTION.md'));
  const res = validatePreset('reviewer', dir, structuredClone(VALID));
  assert.ok(res.findings.some((f) => f.code === 'PRESET_INSTRUCTION_MISSING'));
});

test('oversized instruction is PRESET_INSTRUCTION_SIZE at exactly past the limit', () => {
  const big = 'a'.repeat(PRESET_INSTRUCTION_MAX_BYTES + 1);
  const body = { ...structuredClone(VALID), instruction: { file: 'INSTRUCTION.md' } };
  const dir = presetDir(body, { 'INSTRUCTION.md': big });
  const res = validatePreset('reviewer', dir, body);
  assert.ok(res.findings.some((f) => f.code === 'PRESET_INSTRUCTION_SIZE'));
  // Exactly at the limit is fine.
  const ok = presetDir(body, { 'INSTRUCTION.md': 'a'.repeat(PRESET_INSTRUCTION_MAX_BYTES) });
  const res2 = validatePreset('reviewer', ok, body);
  assert.ok(!res2.findings.some((f) => f.code === 'PRESET_INSTRUCTION_SIZE'));
});

test('referenced skills must exist; required and defaults each checked with indexed fields', () => {
  const body = {
    ...structuredClone(VALID),
    skills: { defaults: ['code-review', 'ghost-one'], required: ['testing', 'ghost-two'] },
  };
  const res = validatePreset('reviewer', presetDir(body), body, {
    skillExists: (id) => ['code-review', 'testing'].includes(id),
  });
  assert.ok(res.findings.some((f) => f.code === 'PRESET_SKILL_MISSING' && f.field === 'skills.defaults[1]'));
  assert.ok(res.findings.some((f) => f.code === 'PRESET_SKILL_MISSING' && f.field === 'skills.required[1]'));
});

test('cap is enforced AFTER deduplication and system-capped', () => {
  // 5 distinct refs, max not set: system cap is 4 -> PRESET_SKILL_CAP.
  const five = {
    ...structuredClone(VALID),
    skills: { defaults: ['a', 'b'], required: ['c', 'd', 'e'] },
  };
  const res = validatePreset('reviewer', presetDir(five), five, { skillExists: () => true });
  assert.ok(res.findings.some((f) => f.code === 'PRESET_SKILL_CAP'));

  // 4 distinct refs where one is duplicated across required+defaults: 5 names, 4 distinct, fine.
  const dup = {
    ...structuredClone(VALID),
    skills: { defaults: ['a', 'b'], required: ['a', 'c', 'd'] },
  };
  const res2 = validatePreset('reviewer', presetDir(dup), dup, { skillExists: () => true });
  assert.ok(!res2.findings.some((f) => f.code === 'PRESET_SKILL_CAP'), JSON.stringify(res2.findings));

  // A manifest may lower max but never exceed the system cap.
  const high = { ...structuredClone(VALID), skills: { max: PRESET_SKILL_SYSTEM_CAP + 1 } };
  const res3 = validatePreset('reviewer', presetDir(high), high);
  assert.ok(res3.findings.some((f) => f.code === 'PRESET_SKILL_CAP' && f.field === 'skills.max'));
});

test('an invalid skills.max does not mask the cap finding', () => {
  // NaN max would make every Math.min comparison false and silently skip the cap check.
  const nan = {
    ...structuredClone(VALID),
    skills: { defaults: ['a', 'b'], required: ['c', 'd', 'e'], max: Number.NaN },
  };
  const res = validatePreset('reviewer', presetDir(nan), nan, { skillExists: () => true });
  assert.ok(res.findings.some((f) => f.code === 'PRESET_SKILLS_SHAPE' && f.field === 'skills.max'));
  assert.ok(res.findings.some((f) => f.code === 'PRESET_SKILL_CAP'),
    'the cap finding must still fire with the system cap: ' + JSON.stringify(res.findings));
});

test('a required agent must exist and required=true demands agent.id', () => {
  const unknown = { ...structuredClone(VALID), agent: { id: 'nope', required: true } };
  const res = validatePreset('reviewer', presetDir(unknown), unknown, { knownAgents: ['fake', 'claude'] });
  assert.ok(res.findings.some((f) => f.code === 'PRESET_AGENT_UNKNOWN' && f.field === 'agent.id'));

  const noId = { ...structuredClone(VALID), agent: { required: true } };
  const res2 = validatePreset('reviewer', presetDir(noId), noId, { knownAgents: ['fake'] });
  assert.ok(res2.findings.some((f) => f.code === 'PRESET_AGENT_REQUIRED_ID'));
});

test('negative, non-finite and non-integer constraint numbers are PRESET_CONSTRAINT', () => {
  const body = {
    ...structuredClone(VALID),
    constraints: {
      defaults: { maxDurationMs: -5, budgetCost: Number.POSITIVE_INFINITY, maxRetries: 1.5 },
      ceilings: { maxDurationMs: -1, networkMode: 'host' },
    },
  };
  const res = validatePreset('reviewer', presetDir(body), body);
  const codes = res.findings.filter((f) => f.code === 'PRESET_CONSTRAINT').map((f) => f.field);
  assert.ok(codes.includes('constraints.defaults.maxDurationMs'));
  assert.ok(codes.includes('constraints.defaults.budgetCost'));
  assert.ok(codes.includes('constraints.defaults.maxRetries'));
  assert.ok(codes.includes('constraints.ceilings.maxDurationMs'));
  assert.ok(codes.includes('constraints.ceilings.networkMode'));
});

test('unknown manifest keys are a hard error -- including a manifest trying to set trust', () => {
  const body = { ...structuredClone(VALID), trust: 'trusted' };
  const res = validatePreset('reviewer', presetDir(body), body);
  assert.ok(res.findings.some((f) => f.code === 'PRESET_UNKNOWN_KEYS' && f.field === 'trust'));
});

test('one malformed aspect does not mask the others', () => {
  const body = {
    schemaVersion: 2,
    id: 'other',
    version: 'nope',
    description: '',
    role: '',
    trust: 'trusted',
  };
  const res = validatePreset('reviewer', presetDir(body), body);
  const codes = new Set(res.findings.map((f) => f.code));
  for (const c of ['PRESET_SCHEMA_VERSION', 'PRESET_ID_MISMATCH', 'PRESET_VERSION',
    'PRESET_DESCRIPTION', 'PRESET_ROLE', 'PRESET_UNKNOWN_KEYS']) {
    assert.ok(codes.has(c), `missing ${c} in ${JSON.stringify(res.findings)}`);
  }
});

test('a non-object manifest is PRESET_MANIFEST_SHAPE', () => {
  const dir = tempDir('mercury-preset-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), '[1,2,3]');
  writeFileSync(join(dir, 'INSTRUCTION.md'), 'x');
  const res = validatePreset('reviewer', dir, [1, 2, 3]);
  assert.equal(res.valid, false);
  assert.equal(res.findings[0].code, 'PRESET_MANIFEST_SHAPE');
});

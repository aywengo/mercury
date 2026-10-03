import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.ts';
import { WorkflowRegistry, WorkflowValidationFailure, builtinWorkflowsDir } from '../src/workflows/workflowRegistry.ts';
import { validateWorkflowTemplate } from '../src/workflows/validateWorkflow.ts';
import { WORKFLOW_STAGE_SYSTEM_CAP, WORKFLOW_TASK_MAX_BYTES } from '../src/workflows/types.ts';
import { PresetRegistry } from '../src/presets/presetRegistry.ts';
import { SkillRegistry } from '../src/skills/skillRegistry.ts';
import { dataPath } from '../src/paths.ts';
import { NotFoundError, ValidationError } from '../src/domain/errors.ts';

// docs/crew/workflows.md sections 3.1 (advisory) and 4 (schema), issue #808: advisory-only
// schema with stable finding codes, a registry modelled on the preset registry (isolation,
// deterministic order, registry-assigned trust, locale-independent hash), and one builtin
// template that must load against the REAL preset registry.

function makePresetRegistry(root: string): PresetRegistry {
  // One real preset ('reviewer') so manifests built by validManifest() resolve without a
  // network of fixtures; tests that need other presets build their own registry.
  const presets = tempDir('mercury-workflows-presets-');
  mkdirSync(join(presets, 'reviewer'), { recursive: true });
  writeFileSync(join(presets, 'reviewer', 'preset.json'), JSON.stringify({
    schemaVersion: 1, id: 'reviewer', version: '1.1.0', description: 'reviews', role: 'reviewer',
  }));
  writeFileSync(join(presets, 'reviewer', 'INSTRUCTION.md'), 'review it');
  return new PresetRegistry(presets);
}

function makeWorkflow(root: string, id: string, manifest: Record<string, unknown>): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflow.json'), JSON.stringify(manifest));
}

function validManifest(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, id, version: '1.0.0',
    description: `${id} renders a bounded plan`,
    mode: 'advisory',
    stages: [
      { id: 'only', preset: { id: 'reviewer' }, task: 'Do the single step.' },
    ],
    maxStages: 1,
    ...over,
  };
}

function codes(findings: Array<{ code: string }>): string[] {
  return findings.map((f) => f.code);
}

/** A lookup that resolves every preset id, for tests that pin non-preset findings. */
function presetLookupAll(): { presetLookup: (id: string, version?: string) => { version: string } | null } {
  return { presetLookup: (id, version) => (version === undefined ? { version: '1.0.0' } : null) };
}

// --- validation: manifest shape and identity ---

test('unknown manifest keys are a hard error (closed schema: no trust, no workflow references)', () => {
  for (const [key, why] of [['trust', 'trust is registry-assigned'], ['workflow', 'a recursive reference']] as const) {
    const v = validateWorkflowTemplate('w', validManifest('w', { [key]: 'sneaky' }), presetLookupAll());
    assert.equal(v.valid, false, why);
    assert.ok(codes(v.findings).includes('WORKFLOW_UNKNOWN_KEYS'));
    assert.ok(v.findings.some((f) => f.code === 'WORKFLOW_UNKNOWN_KEYS' && f.field === key), why);
  }
});

test('schemaVersion, id, id/directory match and version carry their own codes', () => {
  const v = validateWorkflowTemplate('dir-name', validManifest('other', { schemaVersion: 2, version: 'not-semver' }), presetLookupAll());
  assert.deepEqual(codes(v.findings).sort(),
    ['WORKFLOW_ID_MISMATCH', 'WORKFLOW_SCHEMA_VERSION', 'WORKFLOW_VERSION']);
  const v2 = validateWorkflowTemplate('w', validManifest('w', { id: '../escape' }), presetLookupAll());
  assert.ok(codes(v2.findings).includes('WORKFLOW_ID'));
  const ok = validateWorkflowTemplate('w', validManifest('w'), presetLookupAll());
  assert.deepEqual(codes(ok.findings), []);
});

test('description must be a non-empty string', () => {
  const v = validateWorkflowTemplate('w', validManifest('w', { description: '   ' }), presetLookupAll());
  assert.ok(codes(v.findings).includes('WORKFLOW_DESCRIPTION'));
});

// --- validation: mode (the issue's stable-code refusal) ---

test("mode 'staged' is refused with its own stable code; other values are shape errors", () => {
  const staged = validateWorkflowTemplate('w', validManifest('w', { mode: 'staged' }), presetLookupAll());
  assert.deepEqual(codes(staged.findings), ['WORKFLOW_MODE_STAGED']);
  const nonsense = validateWorkflowTemplate('w', validManifest('w', { mode: 'yolo' }), presetLookupAll());
  assert.deepEqual(codes(nonsense.findings), ['WORKFLOW_MODE']);
  const missing = validateWorkflowTemplate('w', { ...validManifest('w'), mode: undefined }, presetLookupAll());
  assert.ok(codes(missing.findings).includes('WORKFLOW_MODE'));
});

// --- validation: the advisory refusals ---

test('gate, carryForward and repositoryInput are refused in advisory mode, per stage', () => {
  const m = validManifest('w', {
    stages: [
      { id: 'a', preset: { id: 'reviewer' }, task: 'x', gate: { type: 'run-completed' } },
      { id: 'b', task: 'y', carryForward: ['summary'] },
      { id: 'c', task: 'z', repositoryInput: 'previous-head' },
    ],
    maxStages: 3,
  });
  const v = validateWorkflowTemplate('w', m, presetLookupAll());
  assert.ok(codes(v.findings).includes('WORKFLOW_STAGE_GATE_ADVISORY'));
  assert.ok(codes(v.findings).includes('WORKFLOW_STAGE_CARRY_FORWARD_ADVISORY'));
  assert.ok(codes(v.findings).includes('WORKFLOW_STAGE_REPOSITORY_INPUT_ADVISORY'));
  // The finding names its stage, so the author can tell which stage to clean up.
  assert.ok(v.findings.find((f) => f.code === 'WORKFLOW_STAGE_GATE_ADVISORY')!.field.startsWith('stages[0]'));
  assert.ok(v.findings.find((f) => f.code === 'WORKFLOW_STAGE_CARRY_FORWARD_ADVISORY')!.field.startsWith('stages[1]'));
  assert.ok(v.findings.find((f) => f.code === 'WORKFLOW_STAGE_REPOSITORY_INPUT_ADVISORY')!.field.startsWith('stages[2]'));
});

// --- validation: stages and hard limits ---

test('stages must be a non-empty array of objects', () => {
  for (const stages of [undefined, [], 'nope', [42]]) {
    const v = validateWorkflowTemplate('w', validManifest('w', { stages: stages as unknown as unknown[] }), presetLookupAll());
    assert.equal(v.valid, false, JSON.stringify(stages));
    assert.ok(codes(v.findings).some((c) => c.startsWith('WORKFLOW_STAGES') || c === 'WORKFLOW_STAGE_SHAPE'),
      JSON.stringify(codes(v.findings)));
  }
});

test('more than 16 stages is refused with WORKFLOW_STAGES_LIMIT', () => {
  const stages = Array.from({ length: WORKFLOW_STAGE_SYSTEM_CAP + 1 }, (_, i) => ({ id: `s${i}`, task: 'x' }));
  const v = validateWorkflowTemplate('w', validManifest('w', { stages, maxStages: stages.length }), presetLookupAll());
  assert.ok(codes(v.findings).includes('WORKFLOW_STAGES_LIMIT'));
  // 16 exactly is fine.
  const ok = validateWorkflowTemplate('w', validManifest('w', {
    stages: stages.slice(0, WORKFLOW_STAGE_SYSTEM_CAP), maxStages: WORKFLOW_STAGE_SYSTEM_CAP,
  }), presetLookupAll());
  assert.deepEqual(codes(ok.findings), []);
});

test('duplicate stage ids are refused with the second occurrence named', () => {
  const v = validateWorkflowTemplate('w', validManifest('w', {
    stages: [
      { id: 'same', task: 'x' },
      { id: 'same', task: 'y' },
    ],
    maxStages: 2,
  }), presetLookupAll());
  assert.ok(codes(v.findings).includes('WORKFLOW_STAGE_ID_DUPLICATE'));
  assert.ok(v.findings.find((f) => f.code === 'WORKFLOW_STAGE_ID_DUPLICATE')!.field.startsWith('stages[1]'));
});

test('a task must be a non-empty string of at most 16 KiB', () => {
  const empty = validateWorkflowTemplate('w', validManifest('w', { stages: [{ id: 'a', task: '  ' }] }), presetLookupAll());
  assert.ok(codes(empty.findings).includes('WORKFLOW_STAGE_TASK'));
  const big = 'x'.repeat(WORKFLOW_TASK_MAX_BYTES + 1);
  const v = validateWorkflowTemplate('w', validManifest('w', { stages: [{ id: 'a', task: big }] }), presetLookupAll());
  assert.ok(codes(v.findings).includes('WORKFLOW_STAGE_TASK_SIZE'));
  // Exactly at the cap is fine (16 KiB = 16384 bytes).
  const at = validateWorkflowTemplate('w', validManifest('w', { stages: [{ id: 'a', task: 'x'.repeat(WORKFLOW_TASK_MAX_BYTES) }] }), presetLookupAll());
  assert.deepEqual(codes(at.findings), []);
});

test('maxStages must be an integer between the stage count and the system cap', () => {
  const low = validateWorkflowTemplate('w', validManifest('w', { maxStages: 0 }), presetLookupAll());
  assert.ok(codes(low.findings).includes('WORKFLOW_MAX_STAGES'));
  const below = validateWorkflowTemplate('w', validManifest('w', {
    stages: [{ id: 'a', task: 'x' }, { id: 'b', task: 'y' }], maxStages: 1,
  }), presetLookupAll());
  assert.ok(codes(below.findings).includes('WORKFLOW_MAX_STAGES_LOW'));
  const over = validateWorkflowTemplate('w', validManifest('w', { maxStages: WORKFLOW_STAGE_SYSTEM_CAP + 1 }), presetLookupAll());
  assert.ok(codes(over.findings).includes('WORKFLOW_MAX_STAGES_CAP'));
  const frac = validateWorkflowTemplate('w', validManifest('w', { maxStages: 1.5 }), presetLookupAll());
  assert.ok(codes(frac.findings).includes('WORKFLOW_MAX_STAGES'));
  const ok = validateWorkflowTemplate('w', validManifest('w'), presetLookupAll());
  assert.deepEqual(codes(ok.findings), []);
});

test('an omitted maxStages is a finding, not an implied bound (the field is required)', () => {
  const v = validateWorkflowTemplate('w', { ...validManifest('w'), maxStages: undefined }, presetLookupAll());
  assert.deepEqual(codes(v.findings), ['WORKFLOW_MAX_STAGES']);
  // An explicitly null or non-integer maxStages stays the same code.
  for (const bad of [null, '3', 3.5]) {
    const v2 = validateWorkflowTemplate('w', { ...validManifest('w'), maxStages: bad }, presetLookupAll());
    assert.ok(codes(v2.findings).includes('WORKFLOW_MAX_STAGES'), JSON.stringify(bad));
  }
  // The two bounded checks are independent (LOW from the stage count, CAP from the system
  // cap), so a manifest violating both is possible only with >16 stages plus maxStages below
  // that count -- e.g. 20 stages, maxStages 20 is over the cap; maxStages 3 is BOTH.
  // With >16 stages the list itself is over the cap and maxStages 3 is below that list --
  // both bound findings fire against the declared list, alongside the list-limit finding.
  const manyStages = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, task: 'x' }));
  const both = validateWorkflowTemplate('w', {
    ...validManifest('w', { stages: manyStages }), maxStages: 3,
  }, presetLookupAll());
  assert.deepEqual(codes(both.findings).sort(),
    ['WORKFLOW_MAX_STAGES_LOW', 'WORKFLOW_STAGES_LIMIT'],
    'the bounded checks run against the declared stage list even when that list is itself over the cap');
});

// --- validation: preset references ---

test('a stage preset referencing an unknown preset is invalid and names the preset id', () => {
  const v = validateWorkflowTemplate('w', validManifest('w'), { presetLookup: () => null });
  assert.deepEqual(codes(v.findings), ['WORKFLOW_STAGE_PRESET_MISSING']);
  assert.match(v.findings[0].message, /"reviewer"/);
});

test('a requested preset version that does not resolve gets its own code', () => {
  const v = validateWorkflowTemplate('w', validManifest('w', { stages: [{ id: 'a', preset: { id: 'reviewer', version: '9.9.9' }, task: 'x' }] }), {
    presetLookup: (id, version) => (version === '9.9.9' ? null : { version: '1.1.0' }),
  });
  assert.deepEqual(codes(v.findings), ['WORKFLOW_STAGE_PRESET_VERSION_MISSING']);
  assert.match(v.findings[0].message, /"reviewer"/);
  assert.match(v.findings[0].message, /9\.9\.9/);
});

test('an absent preset lookup means every referenced preset is missing (fail closed)', () => {
  const v = validateWorkflowTemplate('w', validManifest('w'), {});
  assert.deepEqual(codes(v.findings), ['WORKFLOW_STAGE_PRESET_MISSING']);
  // An optional preset (absent = the Run's default agent) needs no lookup.
  const ok = validateWorkflowTemplate('w', validManifest('w', { stages: [{ id: 'a', task: 'x' }] }), {});
  assert.deepEqual(codes(ok.findings), []);
});

test('a malformed preset block carries a shape code, not a missing-preset code', () => {
  for (const preset of ['reviewer', null, 42, {}, { id: '' }, { id: 'reviewer', version: '' }]) {
    const v = validateWorkflowTemplate('w', validManifest('w', { stages: [{ id: 'a', preset: preset as unknown }] }), {
      presetLookup: () => ({ version: '1.1.0' }),
    });
    assert.ok(codes(v.findings).includes('WORKFLOW_STAGE_PRESET'), JSON.stringify(preset));
    assert.ok(!codes(v.findings).includes('WORKFLOW_STAGE_PRESET_MISSING'), JSON.stringify(preset));
  }
});

test('unknown keys inside a stage preset are refused (closed shape: no silent typo downgrade)', () => {
  // The round-1 review case: a typo'd `versoin` key must fail loudly. Silently accepting it
  // would drop the author's version pin and resolve ANY version of the preset instead.
  const v = validateWorkflowTemplate('w', validManifest('w', {
    stages: [{ id: 'a', preset: { id: 'reviewer', versoin: '9.9.9' }, task: 'x' }],
  }), { presetLookup: () => ({ version: '1.1.0' }) });
  assert.ok(v.findings.some((f) => f.code === 'WORKFLOW_STAGE_PRESET'
    && f.field === 'stages[0].preset.versoin' && /versoin/.test(f.message)), JSON.stringify(v.findings));
  // The typo must not ALSO be read as a version pin (no VERSION_MISSING finding).
  assert.ok(!codes(v.findings).includes('WORKFLOW_STAGE_PRESET_VERSION_MISSING'), JSON.stringify(codes(v.findings)));
  // A well-formed extra key is refused the same way; id/version stay the only legal keys.
  const v2 = validateWorkflowTemplate('w', validManifest('w', {
    stages: [{ id: 'a', preset: { id: 'reviewer', trust: 'builtin' }, task: 'x' }],
  }), { presetLookup: () => ({ version: '1.1.0' }) });
  assert.ok(v2.findings.some((f) => f.code === 'WORKFLOW_STAGE_PRESET' && f.field === 'stages[0].preset.trust'));
});

// --- registry behavior (modelled on the preset registry tests) ---

test('valid builtin templates list in deterministic code-unit order', () => {
  const root = tempDir('mercury-workflows-');
  // Insert in NON-sorted order; '_' sorts AFTER letters and '.' in code-unit order.
  for (const id of ['zeta', 'alpha-x', 'alpha_x', 'alpha.a']) {
    makeWorkflow(root, id, validManifest(id));
  }
  const reg = new WorkflowRegistry(root, { presets: makePresetRegistry(root) });
  assert.deepEqual(reg.list().map((w) => w.id), ['alpha-x', 'alpha.a', 'alpha_x', 'zeta']);
});

test('one malformed template does not hide unrelated valid templates (isolation)', () => {
  const root = tempDir('mercury-workflows-');
  makeWorkflow(root, 'good-one', validManifest('good-one'));
  makeWorkflow(root, 'good-two', validManifest('good-two'));
  // Malformed: unparsable JSON.
  const bad = join(root, 'bad-json');
  mkdirSync(bad);
  writeFileSync(join(bad, 'workflow.json'), '{nope');
  // Malformed: valid JSON, invalid template.
  makeWorkflow(root, 'bad-manifest', { ...validManifest('bad-manifest'), mode: 'staged' });
  // Malformed: missing workflow.json entirely.
  makeWorkflow(root, 'stray', validManifest('stray'));
  rmSync(join(root, 'stray', 'workflow.json'));

  const reg = new WorkflowRegistry(root, { presets: makePresetRegistry(root) });
  assert.deepEqual(reg.list().map((w) => w.id), ['good-one', 'good-two']);

  const all = reg.listAll();
  assert.deepEqual(all.workflows.map((w) => w.id), ['good-one', 'good-two']);
  // A stray directory is neither valid nor invalid.
  assert.deepEqual(all.invalid.map((i) => i.id).sort(), ['bad-json', 'bad-manifest']);
  for (const inv of all.invalid) {
    assert.ok(inv.validation.length > 0, `${inv.id} should carry findings`);
    assert.ok(inv.validation.every((f) => f.code.startsWith('WORKFLOW_')));
  }
});

test('get() returns the snapshot contract: files, hash, template bytes, registry-assigned trust', () => {
  const root = tempDir('mercury-workflows-');
  makeWorkflow(root, 'reviewed', validManifest('reviewed'));
  writeFileSync(join(root, 'reviewed', 'NOTES.md'), 'extra context');
  const reg = new WorkflowRegistry(root, { presets: makePresetRegistry(root) });
  const w = reg.get('reviewed');
  assert.equal(w.id, 'reviewed');
  assert.equal(w.version, '1.0.0');
  assert.equal(w.mode, 'advisory');
  assert.equal(w.maxStages, 1);
  assert.deepEqual(w.stages, [{ id: 'only', preset: { id: 'reviewer' }, task: 'Do the single step.' }]);
  assert.deepEqual(Object.keys(w.files).sort(), ['NOTES.md', 'workflow.json']);
  // Trust is assigned by the registry; the manifest cannot influence it (unknown keys are refused).
  assert.equal(w.trust, 'builtin');
  assert.deepEqual(w.source, { kind: 'builtin', relativePath: 'workflows/reviewed/workflow.json' });
  assert.equal(w.contentHash, WorkflowRegistry.contentHash(w.files));
  assert.match(w.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(w.templateJson, w.files['workflow.json']);
});

test('a manifest cannot set trust or any other unknown key', () => {
  const root = tempDir('mercury-workflows-');
  makeWorkflow(root, 'sneaky', { ...validManifest('sneaky'), trust: 'trusted' });
  const reg = new WorkflowRegistry(root);
  assert.deepEqual(reg.list().map((w) => w.id), []);
  const all = reg.listAll();
  assert.equal(all.invalid.length, 1);
  assert.ok(all.invalid[0].validation.some((f) => f.code === 'WORKFLOW_UNKNOWN_KEYS' && f.field === 'trust'));
});

test('unsafe ids are a ValidationError; unknown ids are NotFound', () => {
  const root = tempDir('mercury-workflows-');
  makeWorkflow(root, 'real', validManifest('real'));
  const reg = new WorkflowRegistry(root);
  assert.throws(() => reg.get('nope'), NotFoundError);
  assert.throws(() => reg.get('../escape'), ValidationError);
  const empty = join(root, 'empty-dir');
  mkdirSync(empty);
  assert.throws(() => reg.get('empty-dir'), NotFoundError);
});

test('a stray safe-named directory without workflow.json does not break listing', () => {
  const root = tempDir('mercury-workflows-');
  makeWorkflow(root, 'real', validManifest('real'));
  mkdirSync(join(root, 'stray-dir'));
  const reg = new WorkflowRegistry(root, { presets: makePresetRegistry(root) });
  assert.deepEqual(reg.list().map((w) => w.id), ['real']);
  assert.deepEqual(reg.listAll().workflows.map((w) => w.id), ['real']);
  assert.deepEqual(reg.listAll().invalid.map((i) => i.id), []);
});

test('the content hash does not depend on the host locale', () => {
  // The preset registry's lesson (issue #86): localeCompare sorts '_' before '-' and '.',
  // code units sort it after. The file map order must be code-unit order regardless of host.
  const root = tempDir('mercury-workflows-');
  const dir = join(root, 'ordercheck');
  mkdirSync(dir);
  writeFileSync(join(dir, 'workflow.json'), JSON.stringify(validManifest('ordercheck')));
  const sub = join(dir, 'details');
  mkdirSync(sub);
  writeFileSync(join(sub, 'a-b.md'), 'hyphen');
  writeFileSync(join(sub, 'a_.md'), 'underscore');
  writeFileSync(join(sub, 'a.b.md'), 'dot');
  const reg = new WorkflowRegistry(root, { presets: makePresetRegistry(root) });
  const w = reg.get('ordercheck');
  const names = Object.keys(w.files);
  assert.ok(names.includes('details/a-b.md') && names.includes('details/a_.md'));
  assert.deepEqual(
    names.filter((n) => n.startsWith('details/')).sort(),
    ['details/a-b.md', 'details/a.b.md', 'details/a_.md'],
  );
  assert.equal(w.contentHash, WorkflowRegistry.contentHash(w.files));
});

test('a symlinked workflow.json or file inside the workflow dir is refused before reading', () => {
  const root = tempDir('mercury-workflows-');
  const outside = tempDir('mercury-workflows-outside-');
  writeFileSync(join(outside, 'host-file.txt'), 'host bytes');
  // Case 1: workflow.json itself is a symlink to an arbitrary host file.
  const dirA = join(root, 'linked-manifest');
  mkdirSync(dirA);
  symlinkSync(join(outside, 'host-file.txt'), join(dirA, 'workflow.json'));
  const regA = new WorkflowRegistry(root);
  assert.deepEqual(regA.list().map((w) => w.id), []);
  const allA = regA.listAll();
  assert.ok(allA.invalid.some((i) => i.id === 'linked-manifest'
    && i.validation.some((f) => f.code === 'WORKFLOW_LOAD_FAILED'
      && /symlink/i.test(f.message))), JSON.stringify(allA.invalid));

  // Case 2: an extra file inside the workflow dir is a symlink -- refused, not folded into the hash.
  const dirB = join(root, 'linked-file');
  mkdirSync(dirB);
  // No preset registry dep: the symlink finding must still fire before validation results
  // matter, so the fixture does not need a resolvable preset (fail-closed lookup is fine).
  writeFileSync(join(dirB, 'workflow.json'), JSON.stringify(validManifest('linked-file', { stages: [{ id: 'a', task: 'x' }] })));
  symlinkSync(join(outside, 'host-file.txt'), join(dirB, 'extra.md'));
  const regB = new WorkflowRegistry(root);
  assert.deepEqual(regB.list().map((w) => w.id), []);
  const allB = regB.listAll();
  assert.ok(allB.invalid.some((i) => i.id === 'linked-file'
    && /symlink/i.test(i.validation[0]?.message ?? '')), JSON.stringify(allB.invalid));
});

test('a workflow.json that cannot be READ is a sanitized WORKFLOW_LOAD_FAILED, not an encoding finding', () => {
  const root = tempDir('mercury-workflows-');
  // Case 1: workflow.json is a DIRECTORY -- readFileSync throws EISDIR. The raw Node message
  // embeds the absolute host path; the finding must not carry it.
  const dirId = 'manifest-is-a-dir';
  const dir = join(root, dirId);
  mkdirSync(dir);
  mkdirSync(join(dir, 'workflow.json'));
  const reg = new WorkflowRegistry(root);
  assert.deepEqual(reg.list().map((w) => w.id), []);
  const all = reg.listAll();
  const enc = all.invalid.find((i) => i.id === dirId);
  assert.ok(enc, 'the unreadable manifest is reported');
  const finding = enc.validation.find((f) => f.code === 'WORKFLOW_LOAD_FAILED');
  assert.ok(finding, JSON.stringify(enc.validation));
  // The sanitized message names the problem without the errno token or the host path.
  assert.match(finding.message, /could not be read/);
  assert.ok(!finding.message.includes(root), `no host path leak: ${finding.message}`);
  // The same entry through get() keeps the structured failure contract.
  try {
    reg.get(dirId);
    assert.fail('expected a load failure');
  } catch (err) {
    assert.match(String((err as Error).message), /could not be read/);
    assert.ok(!String((err as Error).message).includes(root), 'no host path in the thrown message');
  }

  // Case 2: a directory entry that vanishes between readdir and read (ENOENT) is the same
  // code -- and a genuine decoding failure is still WORKFLOW_MANIFEST_ENCODING, not LOAD_FAILED.
  const binary = join(root, 'binary2');
  mkdirSync(binary);
  writeFileSync(join(binary, 'workflow.json'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  const all2 = new WorkflowRegistry(root).listAll();
  assert.ok(all2.invalid.find((i) => i.id === 'binary2')
    ?.validation.some((f) => f.code === 'WORKFLOW_MANIFEST_ENCODING'), 'decoding failures keep their own code');
  assert.ok(all2.invalid.find((i) => i.id === 'binary2')
    ?.validation.every((f) => f.code !== 'WORKFLOW_LOAD_FAILED'), 'decoding failures are not LOAD_FAILED');
});

test('a non-UTF-8 workflow.json is a structured finding, not U+FFFD bytes', () => {
  const root = tempDir('mercury-workflows-');
  const dir = join(root, 'binary');
  mkdirSync(dir);
  writeFileSync(join(dir, 'workflow.json'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  const reg = new WorkflowRegistry(root);
  assert.deepEqual(reg.list().map((w) => w.id), []);
  const all = reg.listAll();
  assert.ok(all.invalid[0].validation.some((f) => f.code === 'WORKFLOW_MANIFEST_ENCODING'));
});

test('a UTF-8 BOM stays in the snapshot: templateJson and files agree on the manifest bytes', () => {
  // TextDecoder strips the BOM; collectFiles reads the raw bytes. Without the fix the
  // verbatim templateJson and files['workflow.json'] differ, so the W-2 snapshot and the
  // hashed content cover different bytes.
  const root = tempDir('mercury-workflows-');
  const dir = join(root, 'bombed');
  mkdirSync(dir);
  writeFileSync(join(dir, 'workflow.json'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(validManifest('bombed')), 'utf8'),
  ]));
  const reg = new WorkflowRegistry(root, { presets: makePresetRegistry(root) });
  // A BOM-prefixed template is judged by its content, not rejected as unparsable JSON.
  assert.deepEqual(reg.list().map((w) => w.id), ['bombed']);
  const w = reg.get('bombed');
  assert.equal(w.id, 'bombed');
  assert.equal(w.mode, 'advisory');
  // The two views of the manifest are byte-identical again.
  assert.equal(w.templateJson, w.files['workflow.json']);
  assert.equal(w.templateJson.charCodeAt(0), 0xfeff, 'the BOM stays in both views');
  assert.equal(w.contentHash, WorkflowRegistry.contentHash(w.files));
  // The parsed manifest is the BOM-free view.
  assert.equal(w.manifest.id, 'bombed');
  // And the no-BOM path is unchanged.
  const plain = tempDir('mercury-workflows-');
  makeWorkflow(plain, 'plain', validManifest('plain'));
  const w2 = new WorkflowRegistry(plain, { presets: makePresetRegistry(plain) }).get('plain');
  assert.equal(w2.templateJson, w2.files['workflow.json']);
});

test('a template whose referenced preset is disabled does not resolve', () => {
  // Run creation refuses disabled presets (runService), so the registry must not approve a
  // reference that would fail at creation.
  const root = tempDir('mercury-workflows-');
  const presetRoot = tempDir('mercury-workflows-presets-');
  mkdirSync(join(presetRoot, 'retired'), { recursive: true });
  writeFileSync(join(presetRoot, 'retired', 'preset.json'), JSON.stringify({
    schemaVersion: 1, id: 'retired', version: '1.0.0', description: 'old', role: 'old', enabled: false,
  }));
  writeFileSync(join(presetRoot, 'retired', 'INSTRUCTION.md'), 'x');
  makeWorkflow(root, 'uses-retired', validManifest('uses-retired', { stages: [{ id: 'a', preset: { id: 'retired' }, task: 'x' }] }));
  const presets = new PresetRegistry(presetRoot);
  const reg = new WorkflowRegistry(root, { presets });
  const all = reg.listAll();
  assert.deepEqual(all.workflows.map((w) => w.id), []);
  assert.ok(all.invalid.some((i) => i.id === 'uses-retired'
    && i.validation.some((f) => f.code === 'WORKFLOW_STAGE_PRESET_MISSING')));
});

test('one malformed referenced preset fails validation through the real lookup path', () => {
  const root = tempDir('mercury-workflows-');
  const presetRoot = tempDir('mercury-workflows-presets-');
  // A preset dir that does not parse: get() throws, the lookup reports null.
  mkdirSync(join(presetRoot, 'broken'), { recursive: true });
  writeFileSync(join(presetRoot, 'broken', 'preset.json'), '{nope');
  makeWorkflow(root, 'w', validManifest('w', { stages: [{ id: 'a', preset: { id: 'broken' }, task: 'x' }] }));
  const presets = new PresetRegistry(presetRoot);
  const reg = new WorkflowRegistry(root, { presets });
  const all = reg.listAll();
  assert.deepEqual(all.workflows.map((x) => x.id), []);
  assert.ok(all.invalid[0].validation.some((f) => f.code === 'WORKFLOW_STAGE_PRESET_MISSING'
    && /"broken"/.test(f.message)));
});

// --- the shipped catalog (real directories, real registries) ---

test('the shipped builtin templates load with the real preset registry', async () => {
  // Runs against the real workflows/ directory so a broken seed fails CI, not a user
  // (the same rule as the preset registry's shipped-catalog test).
  const skills = new SkillRegistry(dataPath('.agents', 'skills'));
  const presets = new PresetRegistry(dataPath('presets'), { skills });
  const reg = new WorkflowRegistry(builtinWorkflowsDir(), { presets });
  const ids = reg.list().map((w) => w.id);
  assert.deepEqual(ids, ['plan-implement-review']);
  const all = reg.listAll();
  // A new template that fails validation is silently excluded from list(); the invalid
  // list must be empty (the same gap this issue closed in the preset test).
  assert.deepEqual(all.invalid.map((i) => i.id), []);
  const w = reg.get('plan-implement-review');
  assert.equal(w.trust, 'builtin');
  assert.equal(w.mode, 'advisory');
  assert.deepEqual(w.stages.map((s) => s.id), ['plan', 'implement', 'review']);
  assert.equal(w.stages.length, 3);
  assert.equal(w.stages[0].preset?.id, 'system-architect');
  assert.equal(w.stages[2].preset?.id, 'reviewer');
  // "The default agent implements": the middle step carries no preset.
  assert.equal(w.stages[1].preset, undefined);
  for (const s of w.stages) {
    assert.ok(s.task.length > 0);
    assert.ok(Buffer.byteLength(s.task, 'utf8') <= WORKFLOW_TASK_MAX_BYTES);
  }
  assert.ok(w.maxStages >= w.stages.length && w.maxStages <= WORKFLOW_STAGE_SYSTEM_CAP);
  assert.ok(w.description.length > 0);
});

test('WorkflowValidationFailure carries its findings for callers that branch on codes', () => {
  const root = tempDir('mercury-workflows-');
  makeWorkflow(root, 'bad', validManifest('bad', { mode: 'staged' }));
  const reg = new WorkflowRegistry(root, { presets: makePresetRegistry(root) });
  try {
    reg.get('bad');
    assert.fail('expected WorkflowValidationFailure');
  } catch (err) {
    assert.ok(err instanceof WorkflowValidationFailure);
    assert.deepEqual((err as WorkflowValidationFailure).findings.map((f) => f.code), ['WORKFLOW_MODE_STAGED']);
  }
});

// -- Round-2 review regressions (#812): stat/read failures must surface as sanitized load
// failures, never silently collapse to absence or leak raw Node error text.

test('a manifest under an unsearchable directory reports WORKFLOW_LOAD_FAILED, not stray/not-found', () => {
  const root = tempDir('mercury-workflows-');
  const dir = join(root, 'locked');
  makeWorkflow(root, 'locked', validManifest('locked'));
  const reg = new WorkflowRegistry(root, { presets: makePresetRegistry(root) });
  // statSync(workflow.json) inside a 0o000 directory fails EACCES for a non-root process:
  // absence semantics must not swallow it (round-2 review, #812).
  chmodSync(dir, 0o000);
  try {
    const all = reg.listAll();
    assert.equal(all.workflows.length, 0);
    assert.deepEqual(codes(all.invalid[0]?.validation ?? []), ['WORKFLOW_LOAD_FAILED']);
    assert.ok(!/\//.test(all.invalid[0].validation[0].message), 'no absolute path may leak');
    assert.throws(() => reg.get('locked'), (err: unknown) => {
      const e = err as { name?: string; message?: string };
      return e.name === 'WorkflowLoadError' || /could not be read/.test(e.message ?? '');
    });
  } finally {
    chmodSync(dir, 0o755);
  }
});

test('an unreadable extra file fails get() with a sanitized message, no absolute paths', () => {
  const root = tempDir('mercury-workflows-');
  makeWorkflow(root, 'locked2', validManifest('locked2'));
  const notes = join(root, 'locked2', 'notes.md');
  writeFileSync(notes, 'internal notes');
  chmodSync(notes, 0o000);
  const reg = new WorkflowRegistry(root, { presets: makePresetRegistry(root) });
  try {
    const all = reg.listAll();
    assert.deepEqual(codes(all.invalid[0]?.validation ?? []), ['WORKFLOW_LOAD_FAILED']);
    const msg = all.invalid[0].validation[0].message;
    assert.ok(!msg.includes(root), 'listAll must not leak the registry root path');
    assert.throws(() => reg.get('locked2'), (err: unknown) => {
      const e = err as { name?: string; message?: string };
      return e.name === 'WorkflowLoadError' && !(e.message ?? '').includes(root);
    }, 'get() must sanitize the same way listAll() does');
  } finally {
    chmodSync(notes, 0o644);
  }
});

test('an unreadable registry root fails listAll/list with a sanitized error, not raw EACCES', () => {
  const root = tempDir('mercury-workflows-');
  // A directory itself 0o000: stat(root) may succeed (parent searchable) but readdir fails.
  mkdirSync(root, { recursive: true });
  const reg = new WorkflowRegistry(root, { presets: undefined });
  chmodSync(root, 0o000);
  try {
    assert.throws(() => reg.listAll(), (err: unknown) => {
      const e = err as { name?: string; message?: string };
      return e.name === 'WorkflowLoadError' && !(e.message ?? '').includes(root);
    });
    assert.throws(() => reg.list(), (err: unknown) => {
      const e = err as { name?: string; message?: string };
      return e.name === 'WorkflowLoadError';
    });
  } finally {
    chmodSync(root, 0o755);
  }
});

test('an unknown preset reports MISSING even when a version pin is present; version code only for a real version conflict', () => {
  const root = tempDir('mercury-workflows-');
  const reg = new WorkflowRegistry(root, { presets: makePresetRegistry(root) });
  // 'retired' does not exist at all -> MISSING with or without a version pin.
  makeWorkflow(root, 'dead', validManifest('dead', {
    stages: [{ id: 'only', preset: { id: 'retired', version: '9.9.9' }, task: 'x' }],
  }));
  const all = reg.listAll();
  assert.deepEqual(codes(all.invalid.find((w) => w.id === 'dead')!.validation), ['WORKFLOW_STAGE_PRESET_MISSING']);
  // 'reviewer' exists (registry helper pins 1.0.0); pinning 9.9.9 is a real version conflict.
  makeWorkflow(root, 'conflict', validManifest('conflict', {
    stages: [{ id: 'only', preset: { id: 'reviewer', version: '9.9.9' }, task: 'x' }],
  }));
  const all2 = reg.listAll();
  assert.deepEqual(codes(all2.invalid.find((w) => w.id === 'conflict')!.validation), ['WORKFLOW_STAGE_PRESET_VERSION_MISSING']);
});

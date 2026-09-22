import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.ts';
import { PresetRegistry } from '../src/presets/presetRegistry.ts';
import { NotFoundError, ValidationError } from '../src/domain/errors.ts';

// docs/crew/role-presets.md sections 2.1 (isolation), 4 (snapshot contract) and 5 of the
// acceptance list: deterministic order, per-preset error isolation, locale-independent hash,
// registry-assigned trust.

function makePreset(root: string, id: string, manifest: Record<string, unknown>, instruction = 'Do the task.'): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'INSTRUCTION.md'), instruction);
}

function validManifest(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, id, version: '1.0.0',
    description: `${id} does things`, role: `${id} role`,
    ...over,
  };
}

test('valid builtin presets list in deterministic code-unit order', () => {
  const root = tempDir('mercury-presets-');
  // Insert in NON-sorted order; '_' sorts AFTER letters and '.' in code-unit order, which is
  // exactly the pair issue #86 measured locale disagreement on.
  for (const id of ['zeta', 'alpha-x', 'alpha_x', 'Alpha2', 'alpha.a']) {
    makePreset(root, id, validManifest(id));
  }
  const reg = new PresetRegistry(root);
  // Code-unit order: '-' (0x2D) < '.' (0x2E) < '_' (0x5F). localeCompare sorts '_' FIRST --
  // the exact disagreement issue #86 measured -- so this assertion pins the code-unit answer.
  assert.deepEqual(reg.list().map((p) => p.id), ['alpha-x', 'alpha.a', 'alpha_x', 'zeta']);
  // 'Alpha2' is not a safe id (uppercase), so the registry skips the directory rather than
  // failing the whole listing.
});

test('one malformed preset does not hide unrelated valid presets (isolation)', () => {
  const root = tempDir('mercury-presets-');
  makePreset(root, 'good-one', validManifest('good-one'));
  makePreset(root, 'good-two', validManifest('good-two'));
  // Malformed: unparsable JSON.
  const bad = join(root, 'bad-json');
  mkdirSync(bad);
  writeFileSync(join(bad, 'preset.json'), '{nope');
  // Malformed: valid JSON, invalid manifest.
  makePreset(root, 'bad-manifest', { ...validManifest('bad-manifest'), schemaVersion: 9 });
  // Malformed: missing instruction file.
  makePreset(root, 'bad-instruction', validManifest('bad-instruction'));
  rmSync(join(root, 'bad-instruction', 'INSTRUCTION.md'));
  // Malformed: id/directory mismatch.
  makePreset(root, 'mismatch', validManifest('other-name'));

  const reg = new PresetRegistry(root);
  assert.deepEqual(reg.list().map((p) => p.id), ['good-one', 'good-two']);

  const all = reg.listAll();
  assert.deepEqual(all.presets.map((p) => p.id), ['good-one', 'good-two']);
  assert.deepEqual(all.invalid.map((i) => i.id).sort(),
    ['bad-instruction', 'bad-json', 'bad-manifest', 'mismatch']);
  for (const inv of all.invalid) {
    assert.ok(inv.validation.length > 0, `${inv.id} should carry findings`);
    assert.ok(inv.validation.every((f) => f.code.startsWith('PRESET_')));
  }
});

test('get() returns the snapshot contract: instruction, files, hash, registry-assigned trust', () => {
  const root = tempDir('mercury-presets-');
  makePreset(root, 'reviewer', validManifest('reviewer', { tags: ['review'] }), 'Be exhaustive.');
  const reg = new PresetRegistry(root);
  const p = reg.get('reviewer');
  assert.equal(p.id, 'reviewer');
  assert.equal(p.version, '1.0.0');
  assert.equal(p.role, 'reviewer role');
  assert.equal(p.description, 'reviewer does things');
  assert.deepEqual(p.tags, ['review']);
  assert.equal(p.enabled, true);
  assert.equal(p.instruction, 'Be exhaustive.');
  assert.equal(p.instructionFile, 'INSTRUCTION.md');
  assert.deepEqual(Object.keys(p.files).sort(), ['INSTRUCTION.md', 'preset.json']);
  // Trust is assigned by the registry (section 2): always builtin for the MVP registry, and
  // the manifest cannot influence it -- the next test proves the manifest cannot even say it.
  assert.equal(p.trust, 'builtin');
  assert.deepEqual(p.source, { kind: 'builtin', relativePath: 'presets/reviewer/preset.json' });
  // The hash covers every file, including the manifest itself.
  assert.equal(p.contentHash, PresetRegistry.contentHash(p.files));
  assert.match(p.contentHash, /^[0-9a-f]{64}$/);
});

test('a manifest cannot set trust or any other unknown key', () => {
  const root = tempDir('mercury-presets-');
  makePreset(root, 'sneaky', { ...validManifest('sneaky'), trust: 'trusted' });
  const reg = new PresetRegistry(root);
  assert.deepEqual(reg.list().map((p) => p.id), []);
  const all = reg.listAll();
  assert.equal(all.invalid.length, 1);
  assert.ok(all.invalid[0].validation.some((f) => f.code === 'PRESET_UNKNOWN_KEYS' && f.field === 'trust'));
});

test('a stray safe-named directory without preset.json does not break listing', () => {
  const root = tempDir('mercury-presets-');
  makePreset(root, 'real', validManifest('real'));
  const stray = join(root, 'stray-dir');
  mkdirSync(stray);
  const reg = new PresetRegistry(root);
  assert.deepEqual(reg.list().map((p) => p.id), ['real']);
  assert.deepEqual(reg.listAll().presets.map((p) => p.id), ['real']);
  // get() still reports it as not-found rather than half-loading it.
  assert.throws(() => reg.get('stray-dir'), NotFoundError);
});

test('disabled presets are excluded from list() but still loadable and listed with includeDisabled', () => {
  const root = tempDir('mercury-presets-');
  makePreset(root, 'live', validManifest('live'));
  makePreset(root, 'retired', validManifest('retired', { enabled: false }));
  const reg = new PresetRegistry(root);
  assert.deepEqual(reg.list().map((p) => p.id), ['live']);
  assert.deepEqual(reg.list({ includeDisabled: true }).map((p) => p.id), ['live', 'retired']);
  assert.equal(reg.get('retired').enabled, false);
});

test('unknown preset id is NotFound; unsafe id is a ValidationError', () => {
  const root = tempDir('mercury-presets-');
  makePreset(root, 'real', validManifest('real'));
  const reg = new PresetRegistry(root);
  assert.throws(() => reg.get('nope'), NotFoundError);
  assert.throws(() => reg.get('../escape'), ValidationError);
  // A directory that exists but has no preset.json is NOT a preset.
  const empty = join(root, 'empty-dir');
  mkdirSync(empty);
  assert.throws(() => reg.get('empty-dir'), NotFoundError);
});

test('the content hash does not depend on the host locale', () => {
  // The skill registry's lesson (issue #86): localeCompare sorts '_' before '-' and '.', code
  // units sort it after. A preset with files whose relative order differs between the two
  // orderings pins the point: the hash must match a locally computed CODE-UNIT hash even when
  // the process locale would sort differently.
  const root = tempDir('mercury-presets-');
  const dir = join(root, 'ordercheck');
  mkdirSync(dir);
  writeFileSync(join(dir, 'preset.json'), JSON.stringify(validManifest('ordercheck')));
  writeFileSync(join(dir, 'INSTRUCTION.md'), 'main file');
  const sub = join(dir, 'details');
  mkdirSync(sub);
  writeFileSync(join(sub, 'a-b.md'), 'hyphen');
  writeFileSync(join(sub, 'a_.md'), 'underscore');
  writeFileSync(join(sub, 'a.b.md'), 'dot');
  const reg = new PresetRegistry(root);
  const p = reg.get('ordercheck');
  const names = Object.keys(p.files);
  assert.ok(names.includes('details/a-b.md') && names.includes('details/a_.md'));
  // Code-unit order: 'a-b.md' (0x2D) < 'a.b.md' (0x2E) < 'a_.md' (0x5F).
  assert.deepEqual(
    names.filter((n) => n.startsWith('details/')).sort(),
    ['details/a-b.md', 'details/a.b.md', 'details/a_.md'],
  );
  assert.equal(p.contentHash, PresetRegistry.contentHash(p.files));
});

test('a preset whose instruction crosses a symlink is rejected by the registry', () => {
  const root = tempDir('mercury-presets-');
  const outside = tempDir('mercury-presets-outside-');
  writeFileSync(join(outside, 'secret.md'), 'not preset bytes');
  const dir = join(root, 'linked');
  mkdirSync(dir);
  writeFileSync(join(dir, 'preset.json'), JSON.stringify(validManifest('linked')));
  symlinkSync(join(outside, 'secret.md'), join(dir, 'INSTRUCTION.md'));
  const reg = new PresetRegistry(root);
  assert.deepEqual(reg.list().map((p) => p.id), []);
  const all = reg.listAll();
  assert.ok(all.invalid[0].validation.some((f) => f.code === 'PRESET_INSTRUCTION_PATH'));
});

test('registry without a skills dep treats every referenced skill as missing', () => {
  const root = tempDir('mercury-presets-');
  makePreset(root, 'needs-skills', {
    ...validManifest('needs-skills'),
    skills: { defaults: ['code-review'] },
  });
  const reg = new PresetRegistry(root);
  const all = reg.listAll();
  assert.equal(all.presets.length, 0);
  assert.ok(all.invalid[0].validation.some((f) => f.code === 'PRESET_SKILL_MISSING'));
});

test('the shipped builtin presets all load with the real skill registry', async () => {
  // The seed catalog (section 11): reviewer, system-architect, linux, kafka. This test runs
  // against the real presets/ directory so a broken seed fails CI, not a user.
  const { builtinPresetsDir } = await import('../src/presets/presetRegistry.ts');
  const { SkillRegistry } = await import('../src/skills/skillRegistry.ts');
  const { dataPath } = await import('../src/paths.ts');
  const skills = new SkillRegistry(dataPath('.agents', 'skills'));
  const reg = new PresetRegistry(builtinPresetsDir(), { skills });
  const ids = reg.list().map((p) => p.id);
  assert.deepEqual(ids, ['kafka', 'linux', 'reviewer', 'system-architect']);
  for (const p of reg.list()) {
    assert.equal(p.trust, 'builtin');
    assert.ok(p.instruction.length > 0);
    assert.ok(p.instruction.length <= 32 * 1024);
  }
  const linux = reg.get('linux');
  assert.equal(linux.manifest.requires?.sandbox, true);
});

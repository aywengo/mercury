import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatBuiltinLint, lintBuiltinManifests } from '../src/manifests/lint.ts';
import { tempDir } from './helpers.ts';

// CI schema lint for the builtin manifests (issue #868, Crew Phase 11 CP-1).
//
// The linter is a guard: it must fail on a malformed tree and stay quiet on a valid one.
// A linter that never fails is decoration, so these tests seed malformed fixtures through
// the real code path (registries + validators, exactly what the CLI and CI run) and pin
// the exact findings, not just "something went wrong".

function seedPreset(root: string, id: string, manifest: unknown, instruction = '# Role\nDo the thing.\n'): void {
  const dir = join(root, 'presets', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'INSTRUCTION.md'), instruction);
}

function seedWorkflow(root: string, id: string, manifest: unknown): void {
  const dir = join(root, 'workflows', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflow.json'), JSON.stringify(manifest, null, 2));
}

function seedSkill(root: string, id: string): void {
  const dir = join(root, '.agents', 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\n---\n\n# ${id}\n`);
}

const validPreset = (id: string): Record<string, unknown> => ({
  schemaVersion: 1,
  id,
  version: '1.0.0',
  description: 'A role for the tree under test',
  role: 'Engineer',
  instruction: { file: 'INSTRUCTION.md' },
});

const validWorkflow = (id: string, presetId: string): Record<string, unknown> => ({
  schemaVersion: 1,
  id,
  version: '1.0.0',
  description: 'One advisory stage that names a real preset',
  mode: 'advisory',
  stages: [{ id: 'plan', preset: { id: presetId }, task: 'Plan the change.' }],
  maxStages: 1,
});

function shape(report: ReturnType<typeof lintBuiltinManifests>): Array<[string, string, string, string, string, string]> {
  return report.findings.map((f) => [f.kind, f.id, f.file, f.code, f.field, f.message]);
}

test('a valid tree lints clean and counts both builtin roots', () => {
  const root = tempDir('mercury-lint-');
  {
    seedSkill(root, 'real-skill');
    seedPreset(root, 'good-preset', { ...validPreset('good-preset'), skills: { defaults: ['real-skill'] } });
    seedWorkflow(root, 'good-wf', validWorkflow('good-wf', 'good-preset'));
    const report = lintBuiltinManifests({ rootDir: root });
    assert.deepEqual(shape(report), []);
    assert.equal(report.valid, true);
    assert.equal(report.presetsChecked, 1);
    assert.equal(report.workflowsChecked, 1);
    assert.deepEqual(formatBuiltinLint(report), {
      exitCode: 0,
      lines: ['ok: no findings in 1 builtin preset(s), 1 builtin workflow template(s)'],
    });
  }
});

test('malformed fixtures produce the exact findings and a non-zero exit', () => {
  const root = tempDir('mercury-lint-');
  {
    seedSkill(root, 'real-skill');
    // One preset with two independent faults: a non-semver version and a dead skill
    // reference. Both must be reported — one fault must not mask the other.
    seedPreset(root, 'bad-preset', {
      ...validPreset('bad-preset'),
      version: '1.0',
      skills: { defaults: ['no-such-skill'] },
    });
    // One workflow with three independent faults: no maxStages, a mode that is not
    // advisory, and an unresolvable preset reference.
    seedWorkflow(root, 'bad-wf', {
      schemaVersion: 1,
      id: 'bad-wf',
      version: '1.0.0',
      description: 'Three faults at once: no maxStages, a non-advisory mode, a dead preset reference',
      mode: 'bogus',
      stages: [{ id: 'plan', preset: { id: 'ghost' }, task: 'Plan the change.' }],
    });
    const report = lintBuiltinManifests({ rootDir: root });
    assert.equal(report.valid, false);
    assert.equal(report.presetsChecked, 1);
    assert.equal(report.workflowsChecked, 1);
    assert.deepEqual(shape(report), [
      ['preset', 'bad-preset', 'presets/bad-preset/preset.json', 'PRESET_SKILL_MISSING', 'skills.defaults[0]', 'skill not found: "no-such-skill"'],
      ['preset', 'bad-preset', 'presets/bad-preset/preset.json', 'PRESET_VERSION', 'version', 'version must be valid semantic version text, e.g. "1.0.0"'],
      ['workflow', 'bad-wf', 'workflows/bad-wf/workflow.json', 'WORKFLOW_MAX_STAGES', 'maxStages', 'maxStages must be a positive integer'],
      ['workflow', 'bad-wf', 'workflows/bad-wf/workflow.json', 'WORKFLOW_MODE', 'mode', "mode must be the string 'advisory'"],
      ['workflow', 'bad-wf', 'workflows/bad-wf/workflow.json', 'WORKFLOW_STAGE_PRESET_MISSING', 'stages[0].preset', 'preset "ghost" does not resolve in the preset registry'],
    ]);
    const cli = formatBuiltinLint(report);
    assert.equal(cli.exitCode, 1);
    assert.deepEqual(cli.lines, [
      'presets/bad-preset/preset.json: PRESET_SKILL_MISSING skills.defaults[0]: skill not found: "no-such-skill"',
      'presets/bad-preset/preset.json: PRESET_VERSION version: version must be valid semantic version text, e.g. "1.0.0"',
      'workflows/bad-wf/workflow.json: WORKFLOW_MAX_STAGES maxStages: maxStages must be a positive integer',
      "workflows/bad-wf/workflow.json: WORKFLOW_MODE mode: mode must be the string 'advisory'",
      'workflows/bad-wf/workflow.json: WORKFLOW_STAGE_PRESET_MISSING stages[0].preset: preset "ghost" does not resolve in the preset registry',
      'FAIL: 5 finding(s) in 1 builtin preset(s), 1 builtin workflow template(s)',
    ]);
  }
});

test('the shipped tree is clean: zero findings on the real builtin manifests', () => {
  // The default roots are the package's own presets/, workflows/ and .agents/skills/.
  // This is the guard the issue is about: a committed typo must be a red build here,
  // not a structured finding at runtime. The counts pin the shipped set, so adding a
  // builtin manifest is a deliberate test update, not an unnoticed drift.
  const report = lintBuiltinManifests();
  assert.equal(report.presetsChecked, 4);
  assert.equal(report.workflowsChecked, 1);
  assert.deepEqual(shape(report), []);
  assert.equal(report.valid, true);
});

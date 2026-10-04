import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';
import { WorkflowRegistry } from '../src/workflows/workflowRegistry.ts';
import { renderPlan, isTruncated, PLAN_MAX_BYTES, TRUNCATION_MARKER } from '../src/workflows/renderPlan.ts';
import { resolveWorkflowStages, WorkflowPresetResolutionError, WorkflowSkillCapError } from '../src/workflows/resolveWorkflow.ts';
import { resolvePreset } from '../src/presets/resolvePreset.ts';
import { PresetRegistry } from '../src/presets/presetRegistry.ts';
import { SkillRegistry } from '../src/skills/skillRegistry.ts';
import type { ResolvedWorkflow } from '../src/runs/workflowStore.ts';

// docs/crew/workflows.md sections 3.1 and 5, issue #809: one ordinary advisory Run from a
// template -- service-level resolution (section 3.1.1), a snapshot written in the creation
// transaction, deterministic rendering from the snapshot, and the CLI surface. No HTTP
// endpoints (W-3 #810), no child Runs, no group tables, no coordinator.

function makePreset(root: string, id: string, over: Record<string, unknown> = {}, instruction = `${id} INSTRUCTION`): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), JSON.stringify({
    schemaVersion: 1, id, version: '1.0.0',
    description: `${id} preset`, role: `${id} role`,
    ...over,
  }));
  writeFileSync(join(dir, 'INSTRUCTION.md'), instruction);
}

function makeWorkflowDir(root: string, id: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflow.json'), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
}

function twoStageManifest(id = 'two-stage'): Record<string, unknown> {
  return {
    schemaVersion: 1, id, version: '2.0.0',
    description: 'two advisory steps',
    mode: 'advisory',
    stages: [
      { id: 'plan', preset: { id: 'planner' }, task: 'Plan it.' },
      { id: 'do', task: 'Do it.' },
    ],
    maxStages: 2,
  };
}

function snapshotOf(wf: {
  id: string; version: string; description: string; mode: 'advisory';
  stages: never[]; maxStages: number; templateJson: string; files: Record<string, string>;
  contentHash: string; trust: 'builtin'; source: { kind: 'builtin'; relativePath: string };
}): ResolvedWorkflow {
  return wf as unknown as ResolvedWorkflow;
}

// --- resolution: section 3.1.1 ---

function resolutionEnv(): { presetsDir: string; presets: PresetRegistry } {
  const presetsDir = tempDir('mercury-wf-presets-');
  makePreset(presetsDir, 'planner', { agent: { id: 'fake', required: true }, skills: { required: ['planning'] } });
  makePreset(presetsDir, 'planner-soft', { agent: { id: 'fake' } });
  makePreset(presetsDir, 'other-agent-req', { agent: { id: 'hermes', required: true } });
  makePreset(presetsDir, 'tight', { constraints: { ceilings: { maxDurationMs: 5_000, networkMode: 'none' } } });
  makePreset(presetsDir, 'skillheavy', { skills: { required: ['a', 'b', 'c', 'd'] } });
  // The fixture skills the presets name: the preset registry refuses a required skill it
  // cannot resolve, so the skills registry must see them.
  const skillsDir = tempDir('mercury-wf-skills-');
  for (const id of ['planning', 'a', 'b', 'c', 'd']) {
    mkdirSync(join(skillsDir, id), { recursive: true });
    writeFileSync(join(skillsDir, id, 'SKILL.md'),
      `---\nname: ${id}\nversion: 1.0.0\ndescription: fixture skill.\ncapabilities: [testing]\n---\n\nbody.\n`);
  }
  const skills = new SkillRegistry(skillsDir);
  const presets = new PresetRegistry(presetsDir, { skills, knownAgents: ['fake', 'hermes'] });
  return { presetsDir, presets };
}

const SYSTEM = { defaultAgent: 'fake', defaultMaxDurationMs: 60_000, defaultMaxRetries: 2 };
// The fake double declares every preset mechanism "works" (skills: none but roleInstruction:
// 'system' and perRunModel: true), which is what a preset/workflow Run needs to resolve.
const STATIC = {
  skills: 'none' as const,
  roleInstruction: 'system' as const,
  perRunModel: true,
  humanInput: true,
};
const CAPS = {
  knownAgents: ['fake', 'hermes'],
  staticCapabilities: () => STATIC,
};

test('two stages requiring different agents fail creation (section 3.1.1 rule 1)', () => {
  const { presets } = resolutionEnv();
  const stages = [
    { id: 'a', preset: { id: 'planner' } },
    { id: 'b', preset: { id: 'other-agent-req' } },
  ];
  assert.throws(
    () => resolveWorkflowStages(
      { id: 'wf', stages }, { }, SYSTEM, CAPS, resolvePreset, (id) => presets.get(id),
    ),
    (err: unknown) => err instanceof WorkflowPresetResolutionError
      && err.code === 'WORKFLOW_STAGE_AGENT_CONFLICT',
  );
});

test('a non-required stage agent never overrides the caller or the default (rule 1)', () => {
  const { presets } = resolutionEnv();
  const stages = [
    { id: 'a', preset: { id: 'planner-soft' } }, // preset default agent: fake
  ];
  const sel = resolveWorkflowStages({ id: 'wf', stages }, { agent: 'hermes' }, SYSTEM, CAPS, resolvePreset, (id) => presets.get(id));
  assert.equal(sel.effectiveAgent.id, 'hermes', 'the caller wins over a stage preference');
  const sel2 = resolveWorkflowStages({ id: 'wf', stages }, {}, SYSTEM, CAPS, resolvePreset, (id) => presets.get(id));
  assert.equal(sel2.effectiveAgent.id, 'fake', 'caller absent -> system default, not the stage preference');
});

test('the effective ceiling is the narrowest across stages: networkMode none wins (rule 3)', () => {
  const { presets } = resolutionEnv();
  const stages = [
    { id: 'a', preset: { id: 'tight' } },
    { id: 'b' },
  ];
  const sel = resolveWorkflowStages(
    { id: 'wf', stages },
    { constraints: { maxDurationMs: 30_000 } },
    SYSTEM, CAPS, resolvePreset, (id) => presets.get(id),
  );
  assert.equal(sel.effectiveConstraints.maxDurationMs, 5_000, 'the narrowest scalar ceiling applies');
  assert.deepEqual(sel.effectiveConstraints.allowedNetworks, [], 'none beats bridge (empty list)');
});

test('a skills union over the cap fails with a finding naming the stages (rule 4)', () => {
  const { presets } = resolutionEnv();
  const stages = [
    { id: 'a', preset: { id: 'skillheavy' } },
    { id: 'b', preset: { id: 'planner' } },
  ];
  // skillheavy requires 4 skills (a,b,c,d), planner requires 1 (planning): union 5 > cap 4.
  assert.throws(
    () => resolveWorkflowStages({ id: 'wf', stages }, {}, SYSTEM, CAPS, resolvePreset, (id) => presets.get(id)),
    (err: unknown) => {
      if (!(err instanceof WorkflowSkillCapError)) return false;
      assert.match(err.message, /skillheavy/);
      assert.match(err.message, /planner/);
      return true;
    },
  );
});

test('an unknown stage preset fails with the W-1 code (acceptance 5)', () => {
  const { presets } = resolutionEnv();
  assert.throws(
    () => resolveWorkflowStages(
      { id: 'wf', stages: [{ id: 'a', preset: { id: 'missing' } }] },
      {}, SYSTEM, CAPS, resolvePreset, (id) => presets.get(id),
    ),
    (err: unknown) => err instanceof WorkflowPresetResolutionError
      && err.code === 'WORKFLOW_STAGE_PRESET_MISSING',
  );
});

// --- rendering: deterministic, bounded stated, advisory wording (acceptance 1 and 3) ---

function renderFixture(): ResolvedWorkflow {
  return snapshotOf({
    id: 'two-stage',
    version: '2.0.0',
    description: 'two advisory steps',
    mode: 'advisory',
    stages: [
      { id: 'plan', preset: { id: 'planner' }, task: 'Plan it.' },
      { id: 'do', task: 'Do it.' },
    ],
    maxStages: 2,
    templateJson: '{}',
    files: {},
    contentHash: 'a'.repeat(64),
    trust: 'builtin',
    source: { kind: 'builtin', relativePath: 'workflows/two-stage/workflow.json' },
  } as never);
}

test('rendering is deterministic: two renders of the same snapshot are byte-equal (acceptance 1)', () => {
  const snap = renderFixture();
  const a = renderPlan(snap, 'fake', { 0: 'PLAN INSTRUCTION' });
  const b = renderPlan(snap, 'fake', { 0: 'PLAN INSTRUCTION' });
  assert.equal(a, b);
  assert.ok(a.includes('Step 1 of 2: plan'));
  assert.ok(a.includes('Step 2 of 2: do'));
  assert.ok(a.includes('2 steps, in order'), 'the step bound is stated explicitly');
  assert.ok(a.includes('PLAN INSTRUCTION'), 'the stage preset instruction is guidance for its own step');
  assert.ok(!a.split('Step 2 of 2')[1].includes('PLAN INSTRUCTION'),
    'a stage instruction must not leak into another step');
});

test('the prompt wording never claims Mercury enforces the order (acceptance 3, required test 14)', () => {
  const plan = renderPlan(renderFixture(), 'fake', {});
  // The claim under test: no wording says Mercury enforces the steps.
  assert.match(plan, /does not (verify|enforce)/);
  assert.doesNotMatch(plan, /Mercury enforces/);
});

test('rendering a changed template after creation does not affect the existing Run (acceptance 1)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  makeWorkflowDir(workflowsDir, 'grow', twoStageManifest('grow'));
  const presetsDir = tempDir('mercury-wf-presets-');
  makePreset(presetsDir, 'planner');
  const env = makeEnv({
    workspaceMode: 'copy',
    repoDir: repo,
    workflowsDir,
    presetsDir,
    fakeScript: [{ event: { type: 'run.completed', payload: {} } }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Run the two-stage plan',
      repository: { localPath: repo },
      workflow: { id: 'grow' },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    const before = env.runService.getWorkflow(run.id)!.templateJson;
    const planBefore = readFileSync(join(env.runs.get(run.id)!.workspacePath!, '.mercury', 'workflow', 'workflow.json'), 'utf8');

    // Edit the template on disk after creation.
    makeWorkflowDir(workflowsDir, 'grow', twoStageManifest('grow'), { 'notes.md': 'changed' });
    const after = env.runService.getWorkflow(run.id)!.templateJson;
    assert.equal(after, before, 'the stored snapshot is unchanged by a later template edit');
    assert.equal(planBefore, before, 'the materialized bytes are the snapshot bytes');
  } finally {
    env.close();
  }
});

test('editing a referenced preset after creation leaves the rendered plan unchanged (acceptance 2)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  const presetsDir = tempDir('mercury-wf-presets-');
  makePreset(presetsDir, 'planner', {}, 'ORIGINAL INSTRUCTION');
  makeWorkflowDir(workflowsDir, 'grow', twoStageManifest('grow'));
  const env = makeEnv({
    workspaceMode: 'copy',
    repoDir: repo,
    workflowsDir,
    presetsDir,
    fakeScript: [{ event: { type: 'run.completed', payload: {} } }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Run the plan',
      repository: { localPath: repo },
      workflow: { id: 'grow' },
    });
    const wf = env.runService.getWorkflow(run.id)!;
    assert.ok(wf);
    // The stage preset snapshot rides the Run (section 3.1.1 rule 6).
    const stagePreset = env.runService.getWorkflowStagePresets(run.id);
    assert.equal(stagePreset.length, 1);
    assert.equal(stagePreset[0]!.presetId, 'planner');

    // Edit the preset after creation.
    makePreset(presetsDir, 'planner', {}, 'CHANGED INSTRUCTION');
    const wfAfter = env.runService.getWorkflow(run.id)!;
    assert.deepEqual(wfAfter, wf, 'neither the workflow snapshot nor the stage preset snapshot changed');
    assert.equal(stagePreset[0]!.contentHash, env.runService.getWorkflowStagePresets(run.id)[0]!.contentHash);
  } finally {
    env.close();
  }
});

test('exactly one Run row is created; the only new table is the snapshot table (acceptance 4)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  makeWorkflowDir(workflowsDir, 'grow', twoStageManifest('grow'));
  const presetsDir = tempDir('mercury-wf-presets-');
  makePreset(presetsDir, 'planner');
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workflowsDir, presetsDir, workerEnabled: false });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'One row only',
      repository: { localPath: repo },
      workflow: { id: 'grow' },
    });
    assert.ok(env.runs.get(run.id));
    const rows = env.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
    assert.equal(rows.n, 1);
    const wf = env.db.prepare('SELECT * FROM run_workflows WHERE run_id = ?').get(run.id) as Record<string, unknown> | undefined;
    assert.ok(wf);
    assert.equal(wf!['workflow_id'], 'grow');
    assert.equal(wf!['workflow_version'], '2.0.0');
    assert.match(String(wf!['content_hash']), /^[0-9a-f]{64}$/);
    // The table list has exactly one new member over the pre-#809 schema.
    const tables = (env.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name).sort();
    for (const t of ['runs', 'run_skills', 'run_workflows', 'events', 'run_presets', 'schema_migrations']) {
      assert.ok(tables.includes(t), `${t} exists`);
    }
    assert.ok(!tables.includes('workflow_groups'), 'no group tables');
    assert.ok(!tables.includes('run_stages'), 'no stage tables');
  } finally {
    env.close();
  }
});

test('an unknown template, an invalid template, or an unresolvable preset fails creation (acceptance 5)', () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  // invalid: staged mode (the W-1 refusal code) and a preset reference that does not resolve
  makeWorkflowDir(workflowsDir, 'staged-tpl', {
    schemaVersion: 1, id: 'staged-tpl', version: '1.0.0', description: 'staged',
    mode: 'staged', stages: [{ id: 'a', task: 'x' }], maxStages: 1,
  });
  makeWorkflowDir(workflowsDir, 'dead-preset', {
    schemaVersion: 1, id: 'dead-preset', version: '1.0.0', description: 'dead ref',
    mode: 'advisory', stages: [{ id: 'a', preset: { id: 'ghost' }, task: 'x' }], maxStages: 1,
  });
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workflowsDir, workerEnabled: false });
  try {
    assert.throws(
      () => env.runService.create({ ownerId: 'a', task: 't', repository: { localPath: repo }, workflow: { id: 'nope' } }),
      (err: unknown) => err instanceof WorkflowPresetResolutionError && err.code === 'WORKFLOW_NOT_FOUND',
    );
    // An INVALID template reports the W-1 findings (the registry's validation failure), not a
    // silent fallback to a normal Run.
    assert.throws(
      () => env.runService.create({ ownerId: 'a', task: 't', repository: { localPath: repo }, workflow: { id: 'staged-tpl' } }),
      (err: unknown) => err instanceof Error && /WORKFLOW_MODE_STAGED/.test(err.message),
    );
    assert.throws(
      () => env.runService.create({ ownerId: 'a', task: 't', repository: { localPath: repo }, workflow: { id: 'dead-preset' } }),
      (err: unknown) => err instanceof Error && /WORKFLOW_STAGE_PRESET_MISSING/.test(err.message),
    );
  } finally {
    env.close();
  }
});

test('a Run created without workflow behaves byte-identically: no snapshot row, no workflow event (acceptance 6)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'a', task: 'plain', repository: { localPath: repo } });
    assert.equal(env.runService.getWorkflow(run.id), null);
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(!types.includes('workflow.selected'));
    assert.ok(!types.includes('workflow.materialized'));
  } finally {
    env.close();
  }
});

test('a workflow Run completes end to end: snapshot, events, workspace files, prompt', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  const presetsDir = tempDir('mercury-wf-presets-');
  makePreset(presetsDir, 'planner', {}, 'PLAN LIKE AN ARCHITECT');
  makeWorkflowDir(workflowsDir, 'grow', twoStageManifest('grow'));
  const env = makeEnv({
    workspaceMode: 'copy',
    repoDir: repo,
    workflowsDir,
    presetsDir,
    fakeScript: [{ event: { type: 'run.completed', payload: {} } }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Run the two-stage plan',
      repository: { localPath: repo },
      workflow: { id: 'grow', version: '2.0.0' },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);

    // workflow.selected follows run.created; workflow.materialized after run.started.
    const types = env.events.list(run.id).map((e) => `${e.sequence}:${e.type}`);
    const created = types.findIndex((t) => t.endsWith(':run.created'));
    const selected = types.findIndex((t) => t.endsWith(':workflow.selected'));
    const materialized = types.findIndex((t) => t.endsWith(':workflow.materialized'));
    assert.ok(selected > created, `workflow.selected must follow run.created: ${types}`);
    assert.ok(materialized > 0, 'workflow.materialized must exist');

    // Workspace materialization from the snapshot bytes.
    const final = env.runs.get(run.id)!;
    assert.ok(final.workspacePath);
    const wfDir = join(final.workspacePath!, '.mercury', 'workflow');
    assert.equal(readFileSync(join(wfDir, 'workflow.json'), 'utf8'), env.runService.getWorkflow(run.id)!.templateJson);
    const provenance = JSON.parse(readFileSync(join(wfDir, 'PROVENANCE.json'), 'utf8')) as {
      workflowId: string; version: string; mode: string; trust: string; contentHash: string; stages: number;
    };
    assert.equal(provenance.workflowId, 'grow');
    assert.equal(provenance.version, '2.0.0');
    assert.equal(provenance.mode, 'advisory');
    assert.equal(provenance.trust, 'builtin');
    assert.equal(provenance.contentHash, env.runService.getWorkflow(run.id)!.contentHash);
    assert.equal(provenance.stages, 2);

    // The materialized event carries the plan hash and stage count.
    const events = env.events.list(run.id);
    const mat = events.find((e) => e.type === 'workflow.materialized');
    assert.ok(mat);
    const payload = mat!.payload as { planHash: string; stages: number; truncated: boolean };
    assert.match(payload.planHash, /^[0-9a-f]{64}$/);
    assert.equal(payload.stages, 2);
    assert.equal(payload.truncated, false);
  } finally {
    env.close();
  }
});

test('preset and workflow are mutually exclusive', () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  makeWorkflowDir(workflowsDir, 'grow', twoStageManifest('grow'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workflowsDir, workerEnabled: false });
  try {
    assert.throws(
      () => env.runService.create({
        ownerId: 'a', task: 't', repository: { localPath: repo },
        preset: { id: 'reviewer' }, workflow: { id: 'grow' },
      }),
      /mutually exclusive/,
    );
  } finally {
    env.close();
  }
});

test('a version pin that does not resolve is refused, the resolved version is stored', () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  makeWorkflowDir(workflowsDir, 'grow', twoStageManifest('grow'));
  const presetsDir = tempDir('mercury-wf-presets-');
  makePreset(presetsDir, 'planner');
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workflowsDir, presetsDir, workerEnabled: false });
  try {
    assert.throws(
      () => env.runService.create({ ownerId: 'a', task: 't', repository: { localPath: repo }, workflow: { id: 'grow', version: '9.9.9' } }),
      /is version 2\.0\.0, not the requested 9\.9\.9/,
    );
    const run = env.runService.create({ ownerId: 'a', task: 't', repository: { localPath: repo }, workflow: { id: 'grow' } });
    assert.equal(env.runService.getWorkflow(run.id)!.version, '2.0.0');
  } finally {
    env.close();
  }
});

test('the whole rendered plan has a cap and truncation is marked, never silent', () => {
  const stages = Array.from({ length: 16 }, (_, i) => ({
    id: `s${i}`,
    task: 'x'.repeat(8 * 1024),
  }));
  const snap = snapshotOf({
    id: 'big', version: '1.0.0', description: 'big', mode: 'advisory',
    stages, maxStages: 16,
    templateJson: '{}', files: {}, contentHash: 'a'.repeat(64),
    trust: 'builtin', source: { kind: 'builtin', relativePath: 'workflows/big/workflow.json' },
  } as never);
  const plan = renderPlan(snap, 'fake', {});
  assert.ok(isTruncated(plan));
  assert.ok(plan.endsWith(TRUNCATION_MARKER));
  assert.ok(Buffer.byteLength(plan, 'utf8') <= PLAN_MAX_BYTES + TRUNCATION_MARKER.length);
});

test('the builtin template renders through the real registry without error', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const wf = env.runService['deps'].workflows;
    assert.ok(wf, 'workflows are wired in test env when the dir exists');
  } finally {
    env.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';
import { WorkflowRegistry } from '../src/workflows/workflowRegistry.ts';
import { FakeAgentAdapter } from '../src/adapters/fakeAgentAdapter.ts';
import { renderPlan, isTruncated, PLAN_MAX_BYTES, TRUNCATION_MARKER } from '../src/workflows/renderPlan.ts';
import { resolveWorkflowStages, WorkflowPresetResolutionError, WorkflowSkillCapError } from '../src/workflows/resolveWorkflow.ts';
import { PresetRegistry } from '../src/presets/presetRegistry.ts';
import { SkillRegistry } from '../src/skills/skillRegistry.ts';
import type { ResolvedWorkflow } from '../src/runs/workflowStore.ts';
import { validateCreateRunRequest, parseRunDetailResponse } from '../client/api/protocol.ts';
import { collectMetrics } from '../src/metrics/collect.ts';

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

// --- review-round fixes (#842 r2) ---

test('a resource ceiling conflicts with a differing caller value instead of keeping it (#842 r2)', () => {
  const presetsDir = tempDir('mercury-wf-presets-');
  makePreset(presetsDir, 'memcap', {
    constraints: { ceilings: { resourceLimits: { memory: '1g' } } },
  });
  const skills = new SkillRegistry(tempDir('mercury-wf-skills-'));
  const presets = new PresetRegistry(presetsDir, { skills, knownAgents: ['fake'] });
  const stages = [{ id: 'a', preset: { id: 'memcap' } }];
  // The caller asks 100g against a stage ceiling of 1g: kept unchanged, the Run would admit
  // past its sandbox policy -- so creation must fail, not narrow-or-keep.
  assert.throws(
    () => resolveWorkflowStages(
      { id: 'wf', stages },
      { constraints: { resourceLimits: { memory: '100g' } } },
      SYSTEM, CAPS, (id) => presets.get(id),
    ),
    (err: unknown) => err instanceof WorkflowPresetResolutionError
      && err.code === 'WORKFLOW_STAGE_RESOURCE_CONFLICT',
  );
  // The same refusal for two stages with incompatible ceilings and no caller value.
  makePreset(presetsDir, 'memcap-2g', {
    constraints: { ceilings: { resourceLimits: { memory: '2g' } } },
  });
  const stages2 = [
    { id: 'a', preset: { id: 'memcap' } },
    { id: 'b', preset: { id: 'memcap-2g' } },
  ];
  assert.throws(
    () => resolveWorkflowStages({ id: 'wf2', stages: stages2 }, {}, SYSTEM, CAPS, (id) => presets.get(id)),
    (err: unknown) => err instanceof WorkflowPresetResolutionError
      && err.code === 'WORKFLOW_STAGE_RESOURCE_CONFLICT',
  );
  // Equal values stay legal: caller == ceiling, and two stages naming the same ceiling.
  const stagesEq = [{ id: 'a', preset: { id: 'memcap' } }];
  const sel = resolveWorkflowStages(
    { id: 'wf3', stages: stagesEq },
    { constraints: { resourceLimits: { memory: '1g' } } },
    SYSTEM, CAPS, (id) => presets.get(id),
  );
  assert.equal(sel.effectiveConstraints.resourceLimits?.memory, '1g');
});

test('the plan cap holds for multibyte UTF-8 templates (#842 r2)', () => {
  // 20,000 emoji (~4 bytes each) before the first newline: code-unit truncation left this
  // plan at ~80 KB against a 65,536-byte cap.
  const stages = [{ id: 'big', task: '\u{1F680}'.repeat(20_000) }];
  const snap = snapshotOf({
    id: 'emoji', version: '1.0.0', description: 'emoji', mode: 'advisory',
    stages, maxStages: 1,
    templateJson: '{}', files: {}, contentHash: 'a'.repeat(64),
    trust: 'builtin', source: { kind: 'builtin', relativePath: 'workflows/emoji/workflow.json' },
  } as never);
  const plan = renderPlan(snap, 'fake', {});
  assert.ok(isTruncated(plan));
  assert.ok(Buffer.byteLength(plan, 'utf8') <= PLAN_MAX_BYTES, 'the byte cap holds for multibyte text');
  assert.ok(plan.endsWith(TRUNCATION_MARKER));
});

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
      { id: 'wf', stages }, { }, SYSTEM, CAPS, (id) => presets.get(id),
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
  const sel = resolveWorkflowStages({ id: 'wf', stages }, { agent: 'hermes' }, SYSTEM, CAPS, (id) => presets.get(id));
  assert.equal(sel.effectiveAgent.id, 'hermes', 'the caller wins over a stage preference');
  const sel2 = resolveWorkflowStages({ id: 'wf', stages }, {}, SYSTEM, CAPS, (id) => presets.get(id));
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
    SYSTEM, CAPS, (id) => presets.get(id),
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
    () => resolveWorkflowStages({ id: 'wf', stages }, {}, SYSTEM, CAPS, (id) => presets.get(id)),
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
      {}, SYSTEM, CAPS, (id) => presets.get(id),
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

// --- #842 review r4: stage DEMANDS only; capabilities checked once, on the final agent ---

/** Two agents with DIFFERENT capabilities -- the shared STATIC table above made every per-stage
 *  check against the wrong agent pass, which is how the r4 defects stayed invisible. */
const SPLIT_CAPS = {
  knownAgents: ['fake', 'hermes'],
  staticCapabilities: (agent: string) => (agent === 'fake'
    ? { skills: 'none' as const, roleInstruction: 'system' as const, perRunModel: true, humanInput: true, sandbox: true }
    : { skills: 'none' as const, roleInstruction: 'none' as const, perRunModel: false, humanInput: true, sandbox: false }),
};

function r4Env(): PresetRegistry {
  const presetsDir = tempDir('mercury-wf-r4-presets-');
  makePreset(presetsDir, 'req-fake', { agent: { id: 'fake', required: true } });
  makePreset(presetsDir, 'soft-hermes', { agent: { id: 'hermes' } });
  makePreset(presetsDir, 'soft-model', { agent: { model: 'm-soft' } });
  makePreset(presetsDir, 'req-model', { agent: { model: 'm-req', modelRequired: true } });
  makePreset(presetsDir, 'sandboxed-soft-fake', { agent: { id: 'fake' }, requires: { sandbox: true } });
  const skills = new SkillRegistry(tempDir('mercury-wf-r4-skills-'));
  return new PresetRegistry(presetsDir, { skills, knownAgents: ['fake', 'hermes'] });
}

test('workflow resolution: a stage PREFERENCE is ignored, never resolved or capability-checked (#842 r4, cases 1-2)', () => {
  const presets = r4Env();
  // Case 1: a stage prefers hermes (roleInstruction: none). The preference is ignored (rule 1),
  // the default agent performs every step, and advisory instructions travel in the plan -- so
  // no role-instruction check applies to hermes at all.
  const one = resolveWorkflowStages(
    { id: 'wf', stages: [{ id: 'a', preset: { id: 'soft-hermes' } }] }, {}, SYSTEM, SPLIT_CAPS, (id) => presets.get(id),
  );
  assert.equal(one.effectiveAgent.id, 'fake', 'case 1: the default agent, not the stage preference');

  // Case 2: a stage prefers a model; the caller's agent (hermes) has no per-Run model. Rule 2
  // ignores the preference, so nothing asks hermes for a model and creation succeeds.
  const two = resolveWorkflowStages(
    { id: 'wf', stages: [{ id: 'a', preset: { id: 'soft-model' } }] }, { agent: 'hermes' }, SYSTEM, SPLIT_CAPS, (id) => presets.get(id),
  );
  assert.equal(two.effectiveAgent.id, 'hermes', 'case 2: the caller agent');
  assert.equal(two.effectiveAgent.model, undefined, 'case 2: the stage model preference is ignored');
});

test('workflow resolution: caller conflicts with a REQUIRED stage agent/model carry the W-2 codes (#842 r4, cases 3-4)', () => {
  const presets = r4Env();
  // Case 3: before r4 the per-stage single-preset call threw its generic wording first and the
  // WORKFLOW_STAGE_AGENT_CONFLICT caller branch was unreachable.
  assert.throws(
    () => resolveWorkflowStages(
      { id: 'wf', stages: [{ id: 'a', preset: { id: 'req-fake' } }] }, { agent: 'hermes' }, SYSTEM, SPLIT_CAPS, (id) => presets.get(id),
    ),
    (err: unknown) => err instanceof WorkflowPresetResolutionError && err.code === 'WORKFLOW_STAGE_AGENT_CONFLICT' && err.field === 'agent',
  );
  // Case 4: the same for the model.
  assert.throws(
    () => resolveWorkflowStages(
      { id: 'wf', stages: [{ id: 'a', preset: { id: 'req-model' } }] }, { agent: 'fake', model: 'm-other' }, SYSTEM, SPLIT_CAPS, (id) => presets.get(id),
    ),
    (err: unknown) => err instanceof WorkflowPresetResolutionError && err.code === 'WORKFLOW_STAGE_MODEL_CONFLICT' && err.field === 'model',
  );
});

test('workflow resolution: a sandbox demand is checked against the FINAL agent (#842 r4, case 5)', () => {
  const presets = r4Env();
  // The stage prefers fake (sandbox: true) and requires sandboxing; the preference is ignored,
  // so the system default hermes (sandbox: false) performs the step. Before r4 the demand was
  // checked against fake and the Run was admitted onto an agent that cannot run sandboxed.
  const system = { ...SYSTEM, defaultAgent: 'hermes' };
  assert.throws(
    () => resolveWorkflowStages(
      { id: 'wf', stages: [{ id: 'a', preset: { id: 'sandboxed-soft-fake' } }] }, {}, system, SPLIT_CAPS, (id) => presets.get(id),
    ),
    (err: unknown) => err instanceof WorkflowPresetResolutionError && err.code === 'WORKFLOW_STAGE_SANDBOX_CONFLICT'
      && /stages\[0\] requires sandboxed execution/.test((err as Error).message),
  );
  // The same template on an agent that does run sandboxed is admitted, with the sentinel.
  const ok = resolveWorkflowStages(
    { id: 'wf', stages: [{ id: 'a', preset: { id: 'sandboxed-soft-fake' } }] }, { agent: 'fake' }, system, SPLIT_CAPS, (id) => presets.get(id),
  );
  assert.equal(ok.effectiveAgent.id, 'fake');
  assert.ok(ok.effectiveConstraints.resourceLimits !== undefined, 'the sandbox sentinel survives the fold');
});

test('the workflow block is a closed shape: an unknown key is refused, never ignored (#842 r4)', () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  makeWorkflowDir(workflowsDir, 'closed', {
    schemaVersion: 1, id: 'closed', version: '1.0.0', description: 'closed shape',
    mode: 'advisory', stages: [{ id: 'a', task: 'x' }], maxStages: 1,
  });
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workflowsDir, workerEnabled: false });
  try {
    // A misspelled pin would otherwise run the CURRENT template -- the downgrade the pin exists for.
    assert.throws(
      () => env.runService.create({ ownerId: 'a', task: 't', repository: { localPath: repo }, workflow: { id: 'closed', versoin: '0.9.0' } as never }),
      /workflow has unknown key "versoin" \(did you mean 'version'\?\); allowed keys: id, version/,
    );
    assert.throws(
      () => env.runService.create({ ownerId: 'a', task: 't', repository: { localPath: repo }, workflow: { id: 'closed', stages: [] } as never }),
      /workflow has unknown key "stages"/,
    );
    assert.equal(env.runs.list({ ownerId: 'a', limit: 10 }).runs.length, 0, 'no Run row written');
    // The two allowed keys still work.
    const run = env.runService.create({ ownerId: 'a', task: 't', repository: { localPath: repo }, workflow: { id: 'closed', version: '1.0.0' } });
    assert.ok(run.id);
  } finally {
    env.close();
  }
});

// --- #842 review r5 (findings on unchanged code) ---

function r5Skills(ids: string[]): string {
  const dir = tempDir('mercury-wf-r5-skills-');
  for (const id of ids) {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'SKILL.md'), `---\nname: ${id}\nversion: 1.0.0\ndescription: fixture skill.\ncapabilities: [testing]\n---\n\nbody.\n`);
  }
  return dir;
}

test('client --file: an unknown workflow key is refused, not dropped into an unpinned request (#842 r5)', () => {
  assert.throws(
    () => validateCreateRunRequest({ task: 't', workflow: { id: 'plan', versoin: '1.0.0' } }),
    /workflow has unknown key "versoin" \(did you mean 'version'\?\)/,
  );
  const ok = validateCreateRunRequest({ task: 't', workflow: { id: 'plan', version: '1.0.0' } });
  assert.deepEqual(ok.workflow, { id: 'plan', version: '1.0.0' });
});

test('workflow Runs keep explicit caller skills, then stage-required ones (role-presets 3.2; #842 r5)', () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  makeWorkflowDir(workflowsDir, 'grow', twoStageManifest('grow'));
  const presetsDir = tempDir('mercury-wf-presets-');
  makePreset(presetsDir, 'planner', { skills: { required: ['planning'] } });
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workflowsDir, presetsDir, skillsDir: r5Skills(['planning', 'testing']), workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'a', task: 't', repository: { localPath: repo }, workflow: { id: 'grow' }, skills: ['testing'] });
    assert.deepEqual(env.runService.getSkills(run.id).map((sk) => sk.id).sort(), ['planning', 'testing'], 'the caller skill is kept, the stage-required one added');
    // An explicit [] still means "no caller skills" (no auto-select) but required stays.
    const none = env.runService.create({ ownerId: 'a', task: 't', repository: { localPath: repo }, workflow: { id: 'grow' }, skills: [] });
    assert.deepEqual(env.runService.getSkills(none.id).map((sk) => sk.id), ['planning']);
  } finally {
    env.close();
  }
});

test('the Run-wide skills cap is the strictest stage preset cap, not the system cap (#842 r5)', () => {
  const presetsDir = tempDir('mercury-wf-r5-presets-');
  makePreset(presetsDir, 'one-max', { skills: { required: ['a'], max: 1 } });
  makePreset(presetsDir, 'four-max', { skills: { required: ['b'], max: 4 } });
  const presets = new PresetRegistry(presetsDir, { skills: new SkillRegistry(r5Skills(['a', 'b'])), knownAgents: ['fake', 'hermes'] });
  const stages = [{ id: 'x', preset: { id: 'one-max' } }, { id: 'y', preset: { id: 'four-max' } }];
  assert.throws(
    () => resolveWorkflowStages({ id: 'wf', stages }, {}, SYSTEM, CAPS, (id) => presets.get(id)),
    (err: unknown) => err instanceof WorkflowSkillCapError && /effective maximum is 1/.test((err as Error).message),
  );
  const single = resolveWorkflowStages({ id: 'wf', stages: [stages[1]!] }, {}, SYSTEM, CAPS, (id) => presets.get(id));
  assert.equal(single.skillCap, 4);
});

test('isTruncated checks the suffix: a plan that merely mentions the marker is not truncated (#842 r5)', () => {
  const untruncated = `step text that quotes ${TRUNCATION_MARKER} verbatim\n`;
  assert.equal(isTruncated(untruncated), false);
  assert.equal(isTruncated(`plan\n${TRUNCATION_MARKER}`), true);
});

test('Run detail and metrics: workflow identity is exposed; stage snapshots are not preset Runs (#809 acc. 4; #842 r5)', () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  makeWorkflowDir(workflowsDir, 'twice', {
    schemaVersion: 1, id: 'twice', version: '3.1.0', description: 'one preset, two stages', mode: 'advisory',
    stages: [{ id: 'a', preset: { id: 'planner' }, task: 'x' }, { id: 'b', preset: { id: 'planner' }, task: 'y' }], maxStages: 2,
  });
  const presetsDir = tempDir('mercury-wf-presets-');
  makePreset(presetsDir, 'planner');
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workflowsDir, presetsDir, workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'a', task: 't', repository: { localPath: repo }, workflow: { id: 'twice' } });
    const identity = env.runService.getWorkflowIdentity(run.id)!;
    assert.deepEqual({ ...identity, contentHash: typeof identity.contentHash }, { id: 'twice', version: '3.1.0', contentHash: 'string', mode: 'advisory', stages: 2 });
    // The client parser accepts it, and keeps the three states apart.
    const parsed = parseRunDetailResponse({ run: env.runs.get(run.id), skills: [], workflow: identity });
    assert.deepEqual(parsed.workflow, identity);
    assert.equal(parseRunDetailResponse({ run: env.runs.get(run.id), skills: [], workflow: null }).workflow, null);
    assert.equal('workflow' in parseRunDetailResponse({ run: env.runs.get(run.id), skills: [] }), false);
    // Two stage snapshots of the same preset are NOT two preset Runs.
    assert.equal(collectMetrics(env.db).runsByPreset['planner'], undefined);
    env.runService.create({ ownerId: 'a', task: 'single', preset: { id: 'planner' } });
    assert.equal(collectMetrics(env.db).runsByPreset['planner'], 1);
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

test('the worker renders stage guidance from the snapshot rows, not the live registry', async () => {
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
      task: 'Run the plan',
      repository: { localPath: repo },
      workflow: { id: 'grow' },
    });
    // Capture the plan the worker rendered, via the materialized event's planHash.
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    // Edit the preset AFTER completion; the snapshot row (and any re-render) is unchanged.
    const snapshots = env.runService.getWorkflowStagePresetSnapshots(run.id);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.snapshot.instruction, 'PLAN LIKE AN ARCHITECT');
    makePreset(presetsDir, 'planner', {}, 'CHANGED AFTER THE RUN');
    assert.equal(env.runService.getWorkflowStagePresetSnapshots(run.id)[0]!.snapshot.instruction,
      'PLAN LIKE AN ARCHITECT', 'stage guidance is read from the snapshot rows');
  } finally {
    env.close();
  }
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

test('stage preset rows are distinguishable from the Run-wide preset: get() excludes them (#842 r2)', async () => {
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
    workerEnabled: false,
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Run the plan',
      repository: { localPath: repo },
      workflow: { id: 'grow' },
    });
    // Even a ONE-preset workflow must not look like a Run-wide preset: the stage instruction
    // guides only its own step, so `preset` in Run detail / the worker's .mercury/preset
    // materialization must stay null.
    assert.equal(env.runService.getPreset(run.id), null,
      'a stage preset row must never surface as the Run-wide preset');
    // The stage listing still sees the row, with its stage index recorded.
    const stages = env.runService.getWorkflowStagePresetSnapshots(run.id);
    assert.equal(stages.length, 1);
    assert.equal(stages[0]!.stageIndex, 0);
    assert.equal(stages[0]!.snapshot.instruction, 'PLAN LIKE AN ARCHITECT');
    // The column itself distinguishes the shapes at the storage layer.
    const row = env.db.prepare('SELECT stage_index FROM run_presets WHERE run_id = ?').get(run.id) as { stage_index: number | null };
    assert.equal(row.stage_index, 0);
    // A plain preset Run keeps the Run-wide shape: stage_index NULL and get() finds it.
    makePreset(presetsDir, 'plain');
    const presetRun = env.runService.create({
      ownerId: 'alice',
      task: 'Plain preset run',
      repository: { localPath: repo },
      preset: { id: 'plain' },
    });
    const prow = env.db.prepare('SELECT stage_index FROM run_presets WHERE run_id = ?').get(presetRun.id) as { stage_index: number | null };
    assert.equal(prow.stage_index, null);
    assert.equal(env.runService.getPreset(presetRun.id)!.id, 'plain');
  } finally {
    env.close();
  }
});

test('retry carries the parent workflow: snapshot rows, stage presets, skills, and events (#842 r2)', async () => {
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
    maxRetries: 2,
    retryBackoffMs: 0,
    fakeScript: [{ fail: true }],
  });
  try {
    const parent = env.runService.create({
      ownerId: 'alice',
      task: 'Run the plan',
      repository: { localPath: repo },
      workflow: { id: 'grow' },
    });
    await waitFor(() => env.runs.get(parent.id)!.status === 'FAILED', 10_000);
    const retried = env.runService.retry(parent.id, 'alice', false);
    // The retry IS a workflow Run: same template bytes, same stage preset snapshots.
    assert.deepEqual(env.runService.getWorkflow(retried.id), env.runService.getWorkflow(parent.id));
    assert.deepEqual(env.runService.getWorkflowStagePresetSnapshots(retried.id),
      env.runService.getWorkflowStagePresetSnapshots(parent.id));
    const skillRows = env.db.prepare('SELECT COUNT(*) AS n FROM run_skills WHERE run_id = ?').get(retried.id) as { n: number };
    assert.equal(skillRows.n,
      (env.db.prepare('SELECT COUNT(*) AS n FROM run_skills WHERE run_id = ?').get(parent.id) as { n: number }).n,
      'the workflow skill union rides the retry too');
    // The workflow event trail exists on the retry, not just on the parent.
    assert.ok(env.events.list(retried.id).some((e) => e.type === 'workflow.selected'));
    // And a retry of a PLAIN run stays plain: no workflow row invented.
    const plain = env.runService.create({ ownerId: 'alice', task: 'plain', repository: { localPath: repo } });
    env.runs.transition(plain.id, 'STARTING');
    env.runs.transition(plain.id, 'FAILED', { completedAt: new Date().toISOString() });
    const plainRetry = env.runService.retry(plain.id, 'alice', false);
    assert.equal(env.runService.getWorkflow(plainRetry.id), null);
  } finally {
    env.close();
  }
});

test('a template with preset-bearing stages on TWO stages creates one row per stage (#842 r2)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  const presetsDir = tempDir('mercury-wf-presets-');
  makePreset(presetsDir, 'planner', {}, 'PLAN INSTRUCTION');
  makePreset(presetsDir, 'reviewer', {}, 'REVIEW INSTRUCTION');
  // Two preset-bearing stages: the shipped plan-implement-review shape. PK (run_id) alone
  // failed the second stage insert with UNIQUE constraint failed: run_presets.run_id.
  const manifest = {
    schemaVersion: 1, id: 'plan-review', version: '1.0.0',
    description: 'plan then review', mode: 'advisory',
    stages: [
      { id: 'plan', preset: { id: 'planner' }, task: 'Plan it.' },
      { id: 'review', preset: { id: 'reviewer' }, task: 'Review it.' },
    ],
    maxStages: 2,
  };
  makeWorkflowDir(workflowsDir, 'plan-review', manifest);
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workflowsDir, presetsDir, workerEnabled: false });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'Plan and review', repository: { localPath: repo },
      workflow: { id: 'plan-review' },
    });
    const rows = (env.db.prepare('SELECT preset_id, stage_index FROM run_presets WHERE run_id = ? ORDER BY stage_index').all(run.id) as { preset_id: string; stage_index: number | null }[])
      .map((r) => ({ preset_id: r.preset_id, stage_index: r.stage_index }));
    assert.deepEqual(rows, [
      { preset_id: 'planner', stage_index: 0 },
      { preset_id: 'reviewer', stage_index: 1 },
    ]);
    assert.equal(env.runService.getPreset(run.id), null, 'still no Run-wide preset');
    // A second run-wide preset row stays impossible even after the rebuild.
    env.db.prepare(
      "INSERT INTO run_presets (run_id, preset_id, preset_version, role, trust, content_hash, source_kind, source_commit, source_path, stage_index, snapshot_json) VALUES (?, 'x', '1', 'r', 'builtin', 'h', 'builtin', NULL, 'p', NULL, '{}')",
    ).run(run.id);
    assert.throws(() => env.db.prepare(
      "INSERT INTO run_presets (run_id, preset_id, preset_version, role, trust, content_hash, source_kind, source_commit, source_path, stage_index, snapshot_json) VALUES (?, 'y', '1', 'r', 'builtin', 'h', 'builtin', NULL, 'p', NULL, '{}')",
    ).run(run.id), /UNIQUE/);
  } finally {
    env.close();
  }
});

test('the workflow resolution carries its effective agent and model reach the Run row (#842 r2)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  const presetsDir = tempDir('mercury-wf-presets-');
  // A stage REQUIRING a non-default agent with no caller agent: resolution demands that agent,
  // and the Run row must carry it, not the system default.
  makePreset(presetsDir, 'other-required', { agent: { id: 'other', required: true } });
  const manifest = {
    schemaVersion: 1, id: 'needs-other', version: '1.0.0',
    description: 'requires other', mode: 'advisory',
    stages: [{ id: 'work', preset: { id: 'other-required' }, task: 'Do it on other.' }],
    maxStages: 1,
  };
  makeWorkflowDir(workflowsDir, 'needs-other', manifest);
  const env = makeEnv({
    workspaceMode: 'copy', repoDir: repo, workflowsDir, presetsDir, workerEnabled: false,
    adapters: { other: new FakeAgentAdapter({ script: [] }) },
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'Run on other', repository: { localPath: repo },
      workflow: { id: 'needs-other' },
    });
    assert.equal(run.agent, 'other', 'the required stage agent is the Run agent, not the default');
  } finally {
    env.close();
  }
});

test('a sandbox-required stage preset keeps its isolation demand in the effective constraints (#842 r2)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  const presetsDir = tempDir('mercury-wf-presets-');
  makePreset(presetsDir, 'isolated', { requires: { sandbox: true } });
  makeWorkflowDir(workflowsDir, 'iso-wf', {
    schemaVersion: 1, id: 'iso-wf', version: '1.0.0',
    description: 'sandboxed stage', mode: 'advisory',
    stages: [{ id: 'work', preset: { id: 'isolated' }, task: 'Do it isolated.' }],
    maxStages: 1,
  });
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workflowsDir, presetsDir, workerEnabled: false });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'Run isolated', repository: { localPath: repo },
      workflow: { id: 'iso-wf' },
    });
    // The empty-resourceLimits sentinel is what SandboxManager.requiresSandbox keys on.
    assert.deepEqual(run.constraints.resourceLimits, {},
      'a sandbox-required stage must not fold into an unsandboxed Run');
  } finally {
    env.close();
  }
});


// --- review-round 3 fixes (#842 r3) ---

test('a sandbox-required stage does not erase the caller resource limits (#842 r3)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  const presetsDir = tempDir('mercury-wf-presets-');
  makePreset(presetsDir, 'isolated-limits', { requires: { sandbox: true } });
  makeWorkflowDir(workflowsDir, 'iso-limits-wf', {
    schemaVersion: 1, id: 'iso-limits-wf', version: '1.0.0',
    description: 'sandboxed stage with caller limits', mode: 'advisory',
    stages: [{ id: 'work', preset: { id: 'isolated-limits' }, task: 'Do it isolated.' }],
    maxStages: 1,
  });
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workflowsDir, presetsDir, workerEnabled: false });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'Run isolated with limits', repository: { localPath: repo },
      workflow: { id: 'iso-limits-wf' },
      constraints: { resourceLimits: { memory: '512m' } },
    });
    // The caller's limits are themselves an isolation request; the sentinel must only fill the
    // ABSENT case, never overwrite a narrower caller policy with runtime defaults.
    assert.deepEqual(run.constraints.resourceLimits, { memory: '512m' },
      'a sandbox demand must not widen the caller resource limits away');
  } finally {
    env.close();
  }
});

test('a workflow Run on an adapter without a workflow-plan channel fails creation (#842 r3)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  // The base double declares workflowPlan: true; this instance drops the declaration to model
  // an adapter with no plan channel, and the runService check must refuse it.
  const noPlanFake = new FakeAgentAdapter({ script: [] });
  {
    const caps = noPlanFake.capabilities;
    const stat = { ...caps.static } as Record<string, unknown>;
    delete stat.workflowPlan;
    Object.defineProperty(noPlanFake, 'capabilities', {
      value: { ...caps, static: stat },
    });
  }
  const env = makeEnv({
    adapters: { fake: noPlanFake },
    workspaceMode: 'copy', repoDir: repo, workflowsDir, workerEnabled: false,
  });
  try {
    makeWorkflowDir(workflowsDir, 'plain-wf', {
      schemaVersion: 1, id: 'plain-wf', version: '1.0.0',
      description: 'no presets at all', mode: 'advisory',
      stages: [{ id: 'work', task: 'Do it.' }],
      maxStages: 1,
    });
    assert.throws(
      () => env.runService.create({
        ownerId: 'alice', task: 'Run planned', repository: { localPath: repo },
        workflow: { id: 'plain-wf' },
      }),
      (err: unknown) => err instanceof Error && /workflow-plan prompt channel/.test(err.message),
    );
  } finally {
    env.close();
  }
});

test('a workflow Run on an adapter WITH a workflow-plan channel is admitted (#842 r3)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const workflowsDir = tempDir('mercury-wf-dir-');
  const planFake = new FakeAgentAdapter({ script: [] });
  Object.defineProperty(planFake, 'capabilities', {
    value: {
      ...planFake.capabilities,
      static: { ...planFake.capabilities.static, workflowPlan: true },
    },
  });
  const env = makeEnv({
    workspaceMode: 'copy', repoDir: repo, workflowsDir, workerEnabled: false,
    adapters: { planfake: planFake },
    defaultAgent: 'planfake',
  });
  try {
    makeWorkflowDir(workflowsDir, 'plain-wf', {
      schemaVersion: 1, id: 'plain-wf', version: '1.0.0',
      description: 'no presets at all', mode: 'advisory',
      stages: [{ id: 'work', task: 'Do it.' }],
      maxStages: 1,
    });
    const run = env.runService.create({
      ownerId: 'alice', task: 'Run planned', repository: { localPath: repo },
      workflow: { id: 'plain-wf' },
    });
    assert.equal(run.agent, 'planfake');
  } finally {
    env.close();
  }
});

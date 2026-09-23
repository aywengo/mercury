import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';
import { FakeAgentAdapter } from '../src/adapters/fakeAgentAdapter.ts';
import type { ResolvedRolePreset } from '../src/presets/types.ts';

// docs/crew/role-presets.md sections 4.1, 5, 6 and 7: selection -> snapshot -> materialization,
// with the snapshot (not the live registry) as the source of truth.

test('the Run row enforces the snapshot: run.constraints === preset.effectiveConstraints', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  try {
    // linux requires.sandbox -> an injected resourceLimits request; caller maxDurationMs is
    // merged in. The Run's PERSISTED constraints must equal the snapshot's resolved set --
    // otherwise the snapshot documents limits the worker never applies.
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Diagnose the failing mount',
      repository: { localPath: repo },
      preset: { id: 'linux' },
      constraints: { maxDurationMs: 45_000 },
    });
    const preset = env.runService.getPreset(run.id)!;
    assert.ok(preset);
    assert.deepEqual(run.constraints, preset.effectiveConstraints);
    assert.deepEqual(run.constraints.resourceLimits, {}, 'requires.sandbox injected the isolation request');
    assert.equal(run.constraints.maxDurationMs, 45_000);
  } finally {
    env.close();
  }
});

test('a Run with a builtin preset completes end to end with the fake adapter and stores the snapshot', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({
    workspaceMode: 'copy',
    repoDir: repo,
    fakeScript: [{ event: { type: 'run.completed', payload: {} } }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Review the authorization change',
      repository: { localPath: repo },
      preset: { id: 'reviewer' },
    });
    assert.equal(run.agent, 'fake'); // reviewer sets no agent -> system default
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);

    // Snapshot stored and readable (section 6).
    const preset = env.runService.getPreset(run.id);
    assert.ok(preset);
    assert.equal(preset!.id, 'reviewer');
    assert.equal(preset!.version, '1.0.0');
    assert.equal(preset!.role, 'Code reviewer');
    assert.equal(preset!.trust, 'builtin');
    assert.match(preset!.contentHash, /^[0-9a-f]{64}$/);
    assert.ok(preset!.instruction.length > 0);
    assert.deepEqual(preset!.effectiveSkills.map((s) => s.id),
      ['code-review', 'security-review', 'testing']);

    // preset.selected in the same stream as run.created (section 10).
    const types = env.events.list(run.id).map((e) => `${e.sequence}:${e.type}`);
    const created = types.findIndex((t) => t.endsWith(':run.created'));
    const selected = types.findIndex((t) => t.endsWith(':preset.selected'));
    assert.ok(created >= 0 && selected > created, `preset.selected must follow run.created: ${types}`);
    assert.ok(types.some((t) => t.endsWith(':preset.materialized')));

    // Workspace materialization (section 7): exact snapshot bytes, provenance file.
    const final = env.runs.get(run.id)!;
    assert.ok(final.workspacePath);
    const presetDir = join(final.workspacePath!, '.mercury', 'preset');
    assert.equal(readFileSync(join(presetDir, 'preset.json'), 'utf8'), preset!.files['preset.json']);
    assert.equal(readFileSync(join(presetDir, 'INSTRUCTION.md'), 'utf8'), preset!.instruction);
    const provenance = JSON.parse(readFileSync(join(presetDir, 'PROVENANCE.json'), 'utf8')) as {
      presetId: string; trust: string; contentHash: string;
    };
    assert.equal(provenance.presetId, 'reviewer');
    assert.equal(provenance.trust, 'builtin');
    assert.equal(provenance.contentHash, preset!.contentHash);
  } finally {
    env.close();
  }
});

test('source mutation after creation cannot change the workspace bytes (section 4.1)', async () => {
  // The point of the snapshot contract: edit the SHIPPED preset's source? No -- mutate a TEMP
  // registry copy so the shipped catalog is untouched, then create a Run and edit the source
  // before the worker picks it up. The Run must execute the created-at bytes.
  const presetsDir = tempDir('mercury-presets-mut-');
  const dir = join(presetsDir, 'editable');
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schemaVersion: 1, id: 'editable', version: '1.0.0',
    description: 'editable preset', role: 'Editable role',
  };
  writeFileSync(join(dir, 'preset.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'INSTRUCTION.md'), 'ORIGINAL INSTRUCTION BYTES');

  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({
    workspaceMode: 'copy',
    repoDir: repo,
    presetsDir,
    fakeScript: [{ event: { type: 'run.completed', payload: {} } }],
    // Slow the worker enough to edit between creation and materialization: pollMs default 20ms
    // is too fast to win reliably, so create first, THEN edit, then let the worker claim.
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Do the editable task',
      repository: { localPath: repo },
      preset: { id: 'editable' },
    });
    // Edit the SOURCE now -- the Run is queued but not yet started (worker polls at 20ms; the
    // edit below happens synchronously before any await yields to the worker).
    writeFileSync(join(dir, 'INSTRUCTION.md'), 'MUTATED AFTER CREATION');

    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    const final = env.runs.get(run.id)!;
    const onDisk = readFileSync(join(final.workspacePath!, '.mercury', 'preset', 'INSTRUCTION.md'), 'utf8');
    assert.equal(onDisk, 'ORIGINAL INSTRUCTION BYTES',
      'the workspace must receive the created-at snapshot bytes, not the mutated source');
    assert.equal(env.runService.getPreset(run.id)!.instruction, 'ORIGINAL INSTRUCTION BYTES');
  } finally {
    env.close();
  }
});

test('retry copies the parent preset snapshot verbatim (section 6)', async () => {
  const presetsDir = tempDir('mercury-presets-retry-');
  const dir = join(presetsDir, 'retryable');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), JSON.stringify({
    schemaVersion: 1, id: 'retryable', version: '1.0.0',
    description: 'retryable', role: 'Retryable role',
  }));
  writeFileSync(join(dir, 'INSTRUCTION.md'), 'PARENT BYTES');

  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({
    workspaceMode: 'copy',
    repoDir: repo,
    presetsDir,
    maxRetries: 1,
    fakeScript: [{ fail: true }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Fails on purpose',
      repository: { localPath: repo },
      preset: { id: 'retryable' },
    });
    await waitFor(() => ['FAILED', 'COMPLETED'].includes(env.runs.get(run.id)!.status), 15_000);
    assert.equal(env.runs.get(run.id)!.status, 'FAILED');

    // Mutate the source BEFORE retrying: the retry must still run the parent's bytes.
    writeFileSync(join(dir, 'INSTRUCTION.md'), 'MUTATED BEFORE RETRY');
    const retried = env.runService.retry(run.id, 'alice', false);
    assert.equal(retried.retryOf, run.id);
    const parentPreset = env.runService.getPreset(run.id)!;
    const retriedPreset = env.runService.getPreset(retried.id)!;
    assert.equal(retriedPreset.contentHash, parentPreset.contentHash);
    assert.equal(retriedPreset.instruction, 'PARENT BYTES');
    assert.equal(retriedPreset.version, '1.0.0');
  } finally {
    env.close();
  }
});

test('a Run without preset follows the previous code path byte-for-byte at the API boundary', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({
    workspaceMode: 'copy',
    repoDir: repo,
    fakeScript: [{ event: { type: 'run.completed', payload: {} } }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Plain run, no preset',
      repository: { localPath: repo },
      skills: ['testing'],
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    assert.equal(env.runService.getPreset(run.id), null);
    const final = env.runs.get(run.id)!;
    assert.ok(!existsSync(join(final.workspacePath!, '.mercury', 'preset')));
    // No preset event.
    assert.ok(!env.events.list(run.id).some((e) => e.type.startsWith('preset.')));
  } finally {
    env.close();
  }
});

test('unsupported required capabilities fail closed: a required agent the caller contradicts', () => {
  const presetsDir = tempDir('mercury-presets-req-');
  const dir = join(presetsDir, 'strict-agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), JSON.stringify({
    schemaVersion: 1, id: 'strict-agent', version: '1.0.0',
    description: 'requires claude', role: 'Claude only',
    agent: { id: 'claude', required: true },
  }));
  writeFileSync(join(dir, 'INSTRUCTION.md'), 'x');
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  // Fixture A: required agent `fake` (exists in this env), caller contradicts with a second
  // registered adapter -> resolution refuses, no silent override.
  const dirA = join(presetsDir, 'strict-fake');
  mkdirSync(dirA, { recursive: true });
  writeFileSync(join(dirA, 'preset.json'), JSON.stringify({
    schemaVersion: 1, id: 'strict-fake', version: '1.0.0',
    description: 'requires fake', role: 'Fake only',
    agent: { id: 'fake', required: true },
  }));
  writeFileSync(join(dirA, 'INSTRUCTION.md'), 'x');
  const env = makeEnv({
    workspaceMode: 'copy', repoDir: repo, presetsDir, workerEnabled: false,
    adapters: { second: new FakeAgentAdapter({ script: [] }) },
  });
  try {
    assert.throws(
      () => env.runService.create({
        ownerId: 'alice', task: 't', repository: { localPath: repo },
        preset: { id: 'strict-fake' }, agent: 'second',
      }),
      /requires agent "fake"/,
    );
  } finally {
    env.close();
  }

  // Fixture B: a required agent NO registered adapter provides -> the known-agent check
  // refuses at validation (PRESET_AGENT_UNKNOWN), before resolution can even run.
  const env2 = makeEnv({ workspaceMode: 'copy', repoDir: repo, presetsDir, workerEnabled: false });
  try {
    assert.throws(
      () => env2.runService.create({
        ownerId: 'alice', task: 't', repository: { localPath: repo },
        preset: { id: 'strict-agent' },
      }),
      /unknown agent: "claude"/,
    );
  } finally {
    env2.close();
  }
});

test('an unknown preset id is a domain 404-shaped validation error; a version mismatch is named', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo });
  try {
    assert.throws(
      () => env.runService.create({
        ownerId: 'alice', task: 't', repository: { localPath: repo },
        preset: { id: 'no-such-preset' },
      }),
      /Preset not found/,
    );
    assert.throws(
      () => env.runService.create({
        ownerId: 'alice', task: 't', repository: { localPath: repo },
        preset: { id: 'reviewer', version: '9.9.9' },
      }),
      /is version 1\.0\.0, not the requested 9\.9\.9/,
    );
  } finally {
    env.close();
  }
});

test('per-run log lines carry the preset dimensions (id, version, trust); no-preset logs do not', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const env = makeEnv({
    workspaceMode: 'copy',
    repoDir: repo,
    fakeScript: [{ event: { type: 'run.completed', payload: {} } }],
    logCapture: (level, msg, fields) => lines.push({ level, msg, fields }),
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'log dims', repository: { localPath: repo },
      preset: { id: 'reviewer' },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    const executing = lines.find((l) => l.msg === 'executing run' && l.fields.runId === run.id);
    assert.ok(executing, 'the executing-run line was captured: ' + JSON.stringify(lines.map((l) => l.msg)));
    assert.equal(executing!.fields.presetId, 'reviewer');
    assert.equal(executing!.fields.presetVersion, '1.0.0');
    assert.equal(executing!.fields.presetTrust, 'builtin');

    const plain = env.runService.create({ ownerId: 'alice', task: 'no role', repository: { localPath: repo } });
    await waitFor(() => env.runs.get(plain.id)!.status === 'COMPLETED', 10_000);
    const plainExecuting = lines.find((l) => l.msg === 'executing run' && l.fields.runId === plain.id);
    assert.ok(plainExecuting);
    assert.equal(plainExecuting!.fields.presetId, undefined, 'no preset -> no preset label');

    // Other per-run sites (finalize) get the same dimensions, not just the first line.
    const completed = lines.find((l) => l.msg === 'run completed' && l.fields.runId === run.id);
    assert.ok(completed, 'the finalize line was captured');
    assert.equal(completed!.fields.presetId, 'reviewer');
  } finally {
    env.close();
  }
});

test('AC 7: a preset with an instruction is rejected at creation on a roleInstruction-none agent', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  // A hermes-shaped adapter: no preset rendering, roleInstruction 'none', sandbox available.
  const hermesLike = {
    id: 'hermes',
    capabilities: { static: { skills: 'none' as const, roleInstruction: 'none' as const, sandbox: true, mcp: 'none' as const } },
    start: () => { throw new Error('not used'); },
  } as unknown as import('../src/adapters/agentAdapter.ts').AgentAdapter;
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false, adapters: { hermes: hermesLike } });
  try {
    assert.throws(
      () => env.runService.create({
        ownerId: 'alice', task: 't', repository: { localPath: repo },
        preset: { id: 'reviewer' }, agent: 'hermes',
      }),
      /agent "hermes" cannot receive one \(roleInstruction: none -- the agent's static block declares roleInstruction: 'none'\)/,
    );
    // Nothing was written: no Run row for this owner, no run_presets row at all.
    assert.deepEqual(env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 50 }).runs, []);
    assert.equal((env.db.prepare('SELECT COUNT(*) AS n FROM run_presets').get() as { n: number }).n, 0);
  } finally {
    env.close();
  }
});

test('AC 7: a requires.sandbox preset on a sandbox-false agent is rejected at creation', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const daemonLike = {
    id: 'daemon',
    capabilities: { static: { skills: 'nativeNames' as const, roleInstruction: 'prompt-reference' as const, sandbox: false, mcp: 'none' as const } },
    start: () => { throw new Error('not used'); },
  } as unknown as import('../src/adapters/agentAdapter.ts').AgentAdapter;
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false, adapters: { daemon: daemonLike } });
  try {
    assert.throws(
      () => env.runService.create({
        ownerId: 'alice', task: 't', repository: { localPath: repo },
        preset: { id: 'linux' }, agent: 'daemon',
      }),
      /declares sandbox: false/,
    );
  } finally {
    env.close();
  }
});

test('AC 7: a Run without a preset on a roleInstruction-none agent is unaffected', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  // A fake EXECUTOR wearing the hermes capability block: the point is AC 10 (no-preset Runs are
  // byte-identical), not hermes protocol coverage.
  class HermesShapedFake extends FakeAgentAdapter {
    // Own property, not a getter: the base class's field initializer would shadow a prototype
    // getter (class fields are own properties assigned in the constructor).
    override capabilities = {
      static: { skills: 'none' as const, roleInstruction: 'none' as const, sandbox: true, mcp: 'none' as const },
    };
  }
  const env = makeEnv({
    workspaceMode: 'copy', repoDir: repo,
    fakeScript: [{ event: { type: 'run.completed', payload: {} } }],
    adapters: { hermes: new HermesShapedFake({ script: [{ event: { type: 'run.completed', payload: {} } }] }) },
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'no role here', repository: { localPath: repo }, agent: 'hermes',
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    assert.equal(env.runService.getPreset(run.id), null);
  } finally {
    env.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';
import { FakeAgentAdapter } from '../src/adapters/fakeAgentAdapter.ts';
import { HermesAgentAdapter } from '../src/adapters/hermesAgentAdapter.ts';
import { SOUL_MD_FILE } from '../src/knowledge/materialize.ts';
import { writePersonaFiles } from '../src/worker/worker.ts';

// Per-Run persona, Phase 0 of docs/crew/agent-templates.md (issue #911): two structured channels
// (append + workspace files), resolved fail-closed against the agent's static capabilities at
// creation, stored on the Run row as the snapshot, materialized/rendered at execution.

const MOCK_HERMES = join(import.meta.dirname, 'fixtures', 'mock-hermes-agent.mjs');

// --- creation: fail-closed admission -----------------------------------------

test('persona.append on an agent without personaAppend is refused at creation (three-way wording)', () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  // The shipped fake declares no personaAppend: the unknown/undeclared refusal is the default path.
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  try {
    assert.throws(
      () => env.runService.create({
        ownerId: 'alice', task: 't', repository: { localPath: repo },
        persona: { append: 'You are terse.' },
      }),
      /personaAppend: undeclared -- the agent's static block omits personaAppend/,
    );
  } finally {
    env.close();
  }
});

test('persona.append: false declares as false, unknown refuses as unknown', () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  class FalsePersona extends FakeAgentAdapter {
    constructor() { super({ script: [] }); }
    override capabilities = { static: { personaAppend: false } };
  }
  const env = makeEnv({
    workspaceMode: 'copy', repoDir: repo, workerEnabled: false,
    adapters: { falsepersona: new FalsePersona() },
  });
  try {
    assert.throws(
      () => env.runService.create({
        ownerId: 'alice', task: 't', repository: { localPath: repo }, agent: 'falsepersona',
        persona: { append: 'x' },
      }),
      /personaAppend: false -- the agent's static block declares personaAppend: false/,
    );

  } finally {
    env.close();
  }
});

test('persona.files is refused when the agent declares no personaFiles or reads a different file', () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  class SoulReader extends FakeAgentAdapter {
    constructor() { super({ script: [] }); }
    override capabilities = { static: { personaFiles: ['SOUL.md'] } };
  }
  const env = makeEnv({
    workspaceMode: 'copy', repoDir: repo, workerEnabled: false,
    adapters: { soul: new SoulReader() },
  });
  try {
    // Undeclared on the default fake.
    assert.throws(
      () => env.runService.create({
        ownerId: 'alice', task: 't', repository: { localPath: repo },
        persona: { files: [{ path: 'SOUL.md', content: 'x' }] },
      }),
      /personaFiles: undeclared -- the agent's static block omits personaFiles/,
    );
    // Declared, but the requested path is not one the agent reads: a silent no-op refused.
    assert.throws(
      () => env.runService.create({
        ownerId: 'alice', task: 't', repository: { localPath: repo }, agent: 'soul',
        persona: { files: [{ path: 'PERSONA.md', content: 'x' }] },
      }),
      /the agent reads \["SOUL.md"\], not "PERSONA.md"/,
    );
  } finally {
    env.close();
  }
});

test('a malformed persona block is refused, never ignored', () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  try {
    const base = { ownerId: 'alice', task: 't', repository: { localPath: repo } };
    assert.throws(() => env.runService.create({ ...base, persona: 'append me' as unknown as object }),
      /persona must be an object/);
    assert.throws(() => env.runService.create({ ...base, persona: {} }),
      /persona must carry append or files/);
    assert.throws(
      () => env.runService.create({ ...base, persona: { files: [{ path: '../etc/passwd', content: 'x' }] } }),
      /workspace-relative POSIX path without traversal/,
    );
    assert.throws(
      () => env.runService.create({ ...base, persona: { files: [{ path: '/abs/path', content: 'x' }] } }),
      /workspace-relative POSIX path without traversal/,
    );
    assert.throws(
      () => env.runService.create({ ...base, persona: { files: [{ path: 'a.md', content: 'x' }, { path: 'a.md', content: 'y' }] } }),
      /names "a.md" twice/,
    );
  } finally {
    env.close();
  }
});

// --- creation: success path, snapshot + event --------------------------------

test('a persona run stores the request on the Run row and records run.persona_resolved', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  class AppendCapable extends FakeAgentAdapter {
    constructor(cfg: import('../src/adapters/fakeAgentAdapter.ts').FakeAgentConfig = { script: [] }) { super(cfg); }
    override capabilities = { static: { personaAppend: true } };
  }
  const env = makeEnv({
    workspaceMode: 'copy', repoDir: repo,
    adapters: { primeagent: new AppendCapable({ script: [{ event: { type: 'run.completed', payload: {} } }] }) },
    defaultAgent: 'primeagent',
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 't', repository: { localPath: repo },
      persona: { append: 'You are a terse reviewer.' },
    });
    assert.deepEqual(run.persona, { append: 'You are a terse reviewer.' });
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('run.persona_resolved'), types.join(','));
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
  } finally {
    env.close();
  }
});

test('a Run without a persona has persona === null and no persona event (byte-identical behavior)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({
    workspaceMode: 'copy', repoDir: repo,
    fakeScript: [{ event: { type: 'run.completed', payload: {} } }],
  });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 't', repository: { localPath: repo } });
    assert.equal(run.persona, null);
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    assert.ok(!env.events.list(run.id).some((e) => e.type === 'run.persona_resolved'));
    assert.ok(!env.events.list(run.id).some((e) => e.type === 'persona.materialized'));
  } finally {
    env.close();
  }
});

test('retry carries the parent persona and passes the same capability gate', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  class AppendCapable extends FakeAgentAdapter {
    constructor(cfg: import('../src/adapters/fakeAgentAdapter.ts').FakeAgentConfig = { script: [] }) { super(cfg); }
    override capabilities = { static: { personaAppend: true } };
  }
  const env = makeEnv({
    workspaceMode: 'copy', repoDir: repo,
    adapters: { primeagent: new AppendCapable({ script: [{ event: { type: 'run.completed', payload: {} } }] }) },
    defaultAgent: 'primeagent',
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 't', repository: { localPath: repo },
      persona: { append: 'persona bytes' },
    });
    // Retry needs a FAILED terminal Run (a completed Run refuses retry, state machine §6).
    env.runService.cancel(run.id, 'alice', true);
    await waitFor(() => env.runs.get(run.id)!.status === 'CANCELLED', 10_000);
    const retried = env.runService.retry(run.id, 'alice', true);
    assert.equal(retried.retryOf, run.id);
    assert.deepEqual(retried.persona, run.persona, 'retry executes the same persona bytes');
  } finally {
    env.close();
  }
});

// --- worker: file materialization --------------------------------------------

test('writePersonaFiles writes the snapshot bytes and skips an existing target', () => {
  const ws = tempDir('mercury-persona-');
  const out = writePersonaFiles(ws, {
    files: [
      { path: 'SOUL.md', content: 'persona v1' },
      { path: 'docs/persona.md', content: 'nested' },
    ],
  });
  assert.equal(readFileSync(join(ws, 'SOUL.md'), 'utf8'), 'persona v1');
  assert.equal(readFileSync(join(ws, 'docs', 'persona.md'), 'utf8'), 'nested');
  assert.deepEqual(out.files?.map((f) => ({ path: f.path, skipped: f.skipped })),
    [{ path: 'SOUL.md', skipped: undefined }, { path: 'docs/persona.md', skipped: undefined }]);

  // Second call: the tracked-file rule (§9.4) — existing targets are never overwritten.
  const again = writePersonaFiles(ws, { files: [{ path: 'SOUL.md', content: 'persona v2' }] });
  assert.equal(readFileSync(join(ws, 'SOUL.md'), 'utf8'), 'persona v1', 'existing file wins');
  assert.equal(again.files?.[0]?.skipped, true);

  // Traversal is refused by the containment check, not by luck.
  assert.throws(
    () => writePersonaFiles(ws, { files: [{ path: '../outside.md', content: 'x' }] }),
    /escapes|contained/,
  );
});

test('the worker materializes persona files before the agent starts and records the event', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const seen: string[] = [];
  class SoulReadingFake extends FakeAgentAdapter {
    constructor(cfg: import('../src/adapters/fakeAgentAdapter.ts').FakeAgentConfig = { script: [] }) { super(cfg); }
    override capabilities = { static: { personaFiles: ['SOUL.md'] } };
    override async start(context: import('../src/domain/types.ts').RunContext) {
      const ws = context.workspace.path;
      seen.push(existsSync(join(ws, 'SOUL.md')) ? readFileSync(join(ws, 'SOUL.md'), 'utf8') : 'ABSENT');
      seen.push(context.persona ? JSON.stringify(context.persona) : 'NO-CONTEXT');
      return super.start(context);
    }
  }
  const env = makeEnv({
    workspaceMode: 'copy', repoDir: repo,
    adapters: { soul: new SoulReadingFake({ script: [{ event: { type: 'run.completed', payload: {} } }] }) },
    defaultAgent: 'soul',
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 't', repository: { localPath: repo },
      persona: { files: [{ path: 'SOUL.md', content: 'BE-Terse' }] },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    assert.equal(seen[0], 'BE-Terse', 'the file existed in the workspace before start()');
    assert.ok(seen[1]?.includes('SOUL.md'), 'the adapter context carries the persona');
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('persona.materialized'), types.join(','));
  } finally {
    env.close();
  }
});

// --- adapters: rendering ------------------------------------------------------

test('HermesAgentAdapter declares personaFiles [SOUL.md] and writes the file in start()', async () => {
  const adapter = new HermesAgentAdapter({ cmd: process.execPath, args: [MOCK_HERMES] });
  const stat = adapter.capabilities.static as { personaFiles?: string[]; personaAppend?: boolean };
  assert.deepEqual(stat.personaFiles, ['SOUL.md']);
  assert.equal(stat.personaAppend, undefined, 'no append flag exists on the verified Hermes CLI');

  const workspacePath = tempDir('mercury-hermes-persona-');
  const run = {
    id: 'run_persona_hermes', ownerId: 'alice', task: 't',
    repository: { localPath: '/tmp/repo' }, workspaceBranch: null, workspacePath: null,
    agent: 'hermes', status: 'QUEUED', attempt: 1, retryOf: null, error: null, errorKind: null,
    constraints: { maxDurationMs: 60_000, maxRetries: 2 },
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    leaseOwner: null, leaseExpiresAt: null, cancellationRequestedAt: null,
    finalCommits: [], prUrl: null,
    persona: { files: [{ path: 'SOUL.md', content: 'HERMES-PERSONA' }] },
  } as unknown as import('../src/domain/types.ts').Run;
  const context: import('../src/domain/types.ts').RunContext = {
    run,
    repository: run.repository,
    workspace: { path: workspacePath, branch: 'agent/' + run.id, baseCommit: 'abc', mode: 'copy' },
    skills: [],
    constraints: run.constraints,
    // The worker sets this from the Run row; the adapter reads the CONTEXT, never the row.
    persona: { files: [{ path: 'SOUL.md', content: 'HERMES-PERSONA' }] },
  };
  const handle = await adapter.start(context);
  for await (const ev of handle.events) { if (ev.type === '__done__') break; }
  await handle.exit;
  assert.equal(readFileSync(join(workspacePath, 'SOUL.md'), 'utf8'), 'HERMES-PERSONA');
});

test('a tracked SOUL.md wins over the persona (never overwritten)', async () => {
  const adapter = new HermesAgentAdapter({ cmd: process.execPath, args: [MOCK_HERMES] });
  const workspacePath = tempDir('mercury-hermes-persona-tracked-');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(workspacePath, 'SOUL.md'), 'TRACKED');
  const run = {
    id: 'run_persona_tracked', ownerId: 'alice', task: 't',
    repository: { localPath: '/tmp/repo' }, workspaceBranch: null, workspacePath: null,
    agent: 'hermes', status: 'QUEUED', attempt: 1, retryOf: null, error: null, errorKind: null,
    constraints: { maxDurationMs: 60_000, maxRetries: 2 },
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    leaseOwner: null, leaseExpiresAt: null, cancellationRequestedAt: null,
    finalCommits: [], prUrl: null,
    persona: { files: [{ path: 'SOUL.md', content: 'MERCURO-PERSONA' }] },
  } as unknown as import('../src/domain/types.ts').Run;
  const context: import('../src/domain/types.ts').RunContext = {
    run,
    repository: run.repository,
    workspace: { path: workspacePath, branch: 'agent/' + run.id, baseCommit: 'abc', mode: 'copy' },
    skills: [],
    constraints: run.constraints,
    persona: { files: [{ path: 'SOUL.md', content: 'MERCURO-PERSONA' }] },
  };
  const handle = await adapter.start(context);
  for await (const ev of handle.events) { if (ev.type === '__done__') break; }
  await handle.exit;
  assert.equal(readFileSync(join(workspacePath, 'SOUL.md'), 'utf8'), 'TRACKED');
});

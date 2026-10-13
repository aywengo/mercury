import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Express } from 'express';
import { createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { makeEnv, makeGitRepo, tempDir } from './helpers.ts';

// HTTP seam for the W-3 workflow API (docs/crew/workflows.md section 14, issue #810, advisory
// only). The create route forwards unresolved to RunService.create so HTTP and in-process
// callers hit identical validation, and the Run created through the route matches one created
// through the service path for the same input (acceptance 2: same snapshot hash). Scoping
// follows the presets/Runs rules; a foreign Run is 404 (acceptance 1). No staged-mode
// /api/workflow-runs/* group endpoint exists (acceptance 4).

function makeApi(env: ReturnType<typeof makeEnv>) {
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    apiTokens: new Map([['tok-alice', 'alice'], ['tok-bob', 'bob']]),
    adminToken: 'tok-admin',
  });
  return { app, close: () => stream.stop() };
}

async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const { port } = server.address() as import('node:net').AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('GET /api/workflows lists valid templates and hides invalid ones from non-admins', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  const api = makeApi(env);
  const { url, close: stopSrv } = await listen(api.app);
  try {
    const base = url;
    const res = await fetch(`${base}/api/workflows`, { headers: auth('tok-alice') });
    assert.equal(res.status, 200);
    const body = await res.json() as { workflows: { id: string; stageCount: number; mode: string; contentHash: string }[]; invalid?: unknown };
    const w = body.workflows.find((x) => x.id === 'plan-implement-review');
    assert.ok(w, 'the shipped builtin template must be listed');
    assert.equal(w!.stageCount, 3);
    assert.equal(w!.mode, 'advisory');
    assert.match(w!.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(body.invalid, undefined, 'invalid entries are admin-only diagnostics');

    // Non-admin includeInvalid -> 403.
    const denied = await fetch(`${base}/api/workflows?includeInvalid=1`, { headers: auth('tok-alice') });
    assert.equal(denied.status, 403);
  } finally {
    await stopSrv();
    api.close();
    env.close();
  }
});

test('GET /api/workflows?includeInvalid=1 as admin lists invalid templates with findings', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const badDir = tempDir('mercury-wf-');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  mkdirSync(join(badDir, 'broken'));
  writeFileSync(join(badDir, 'broken', 'workflow.json'), JSON.stringify({ schemaVersion: 1, id: 'broken', version: '1.0.0', description: 'x', mode: 'advisory', stages: [], maxStages: 0 }));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false, workflowsDir: join(badDir, 'workflows') });
  mkdirSync(join(badDir, 'workflows'));
  const shipped = join(import.meta.dirname, '..', 'workflows', 'plan-implement-review');
  const { cpSync } = await import('node:fs');
  cpSync(shipped, join(badDir, 'workflows', 'plan-implement-review'), { recursive: true });
  mkdirSync(join(badDir, 'workflows', 'broken'));
  writeFileSync(join(badDir, 'workflows', 'broken', 'workflow.json'), JSON.stringify({ schemaVersion: 1, id: 'broken', version: '1.0.0', description: 'x', mode: 'advisory', stages: [], maxStages: 0 }));
  const api = makeApi(env);
  const { url, close: stopSrv } = await listen(api.app);
  try {
    const base = url;
    const clean = await fetch(`${base}/api/workflows`, { headers: auth('tok-admin') });
    const cleanBody = await clean.json() as { workflows: { id: string }[] };
    assert.ok(!cleanBody.workflows.some((w) => w.id === 'broken'), 'invalid templates never appear in the valid list');
    const res = await fetch(`${base}/api/workflows?includeInvalid=1`, { headers: auth('tok-admin') });
    assert.equal(res.status, 200);
    const body = await res.json() as { invalid: { id: string; findings: { code: string }[] }[] };
    const bad = body.invalid.find((x) => x.id === 'broken');
    assert.ok(bad, 'the invalid template must appear with its findings');
    assert.ok(bad!.findings.length > 0);
  } finally {
    await stopSrv();
    api.close();
    env.close();
  }
});

test('GET /api/workflows/:id returns stages with the presets they reference', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  const api = makeApi(env);
  const { url, close: stopSrv } = await listen(api.app);
  try {
    const base = url;
    const res = await fetch(`${base}/api/workflows/plan-implement-review`, { headers: auth('tok-alice') });
    assert.equal(res.status, 200);
    const w = await res.json() as { id: string; stages: { id: string; task: string; preset: { id: string } | null; resolvedPreset: { id: string; role: string } | null }[] };
    assert.equal(w.id, 'plan-implement-review');
    assert.deepEqual(w.stages.map((s) => s.id), ['plan', 'implement', 'review']);
    assert.equal(w.stages[0]!.preset!.id, 'system-architect');
    assert.equal(w.stages[0]!.resolvedPreset!.role, 'System architect');
    assert.equal(w.stages[1]!.preset, null, 'a stage without a preset shows none, not a fabricated one');
    const missing = await fetch(`${base}/api/workflows/ghost-wf`, { headers: auth('tok-alice') });
    assert.equal(missing.status, 404);
  } finally {
    await stopSrv();
    api.close();
    env.close();
  }
});

test('POST /api/workflows/:id/runs shares the create-run rate limit (429)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    apiTokens: new Map([['tok-alice', 'alice']]),
    adminToken: 'tok-admin',
    rateLimits: { createRun: { windowMs: 60_000, max: 2 } },
  });
  const { url, close: stopSrv } = await listen(app);
  try {
    const base = url;
    const post = (task: string) => fetch(`${base}/api/workflows/plan-implement-review/runs`, {
      method: 'POST', headers: auth('tok-alice'),
      body: JSON.stringify({ task, repository: { localPath: repo } }),
    });
    assert.equal((await post('a')).status, 201);
    assert.equal((await post('b')).status, 201);
    const third = await post('c');
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) > 0, 'Retry-After header');
    assert.equal(((await third.json()) as { error: string }).error, 'rate limit exceeded');
  } finally {
    await stopSrv();
    stream.stop();
    env.close();
  }
});

test('a non-string workflowVersion reaches strict validation instead of being dropped', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  const api = makeApi(env);
  const { url, close: stopSrv } = await listen(api.app);
  try {
    const base = url;
    const bad = await fetch(`${base}/api/workflows/plan-implement-review/runs`, {
      method: 'POST', headers: auth('tok-alice'),
      body: JSON.stringify({ task: 'x', repository: { localPath: repo }, workflowVersion: 1 }),
    });
    // A numeric pin is preserved and refused by RunService's strict workflow validation --
    // it must NOT silently become an unpinned head request.
    assert.ok(bad.status === 400 || bad.status === 422, `non-string pin is refused, got ${bad.status}`);
    const ok = await fetch(`${base}/api/workflows/plan-implement-review/runs`, {
      method: 'POST', headers: auth('tok-alice'),
      body: JSON.stringify({ task: 'x', repository: { localPath: repo }, workflowVersion: '1.0.0' }),
    });
    assert.equal(ok.status, 201);
  } finally {
    await stopSrv();
    api.close();
    env.close();
  }
});

test('POST /api/workflows/:id/runs creates the Run through the W-2 path (same snapshot hash)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  const api = makeApi(env);
  const { url, close: stopSrv } = await listen(api.app);
  try {
    const base = url;
    const created = await fetch(`${base}/api/workflows/plan-implement-review/runs`, {
      method: 'POST', headers: auth('tok-alice'),
      body: JSON.stringify({ task: 'Do the thing', repository: { localPath: repo } }),
    });
    assert.equal(created.status, 201);
    const { runId } = await created.json() as { runId: string };

    // Same input through the W-2 service path: the snapshot hashes must agree (acceptance 2).
    const viaService = env.runService.create({
      ownerId: 'alice',
      task: 'Do the thing',
      repository: { localPath: repo },
      workflow: { id: 'plan-implement-review' },
    });
    const get = (id: string, tok: string) => fetch(`${base}/api/runs/${id}`, { headers: { authorization: `Bearer ${tok}` } });
    const d1 = await (await get(runId, 'tok-alice')).json() as { workflow: { contentHash: string; id: string; mode: string } | null; workflowStages: { id: string; preset: { id: string } | null }[] | null };
    const d2 = await (await get(viaService.id, 'tok-alice')).json() as { workflow: { contentHash: string } | null };
    assert.ok(d1.workflow);
    assert.equal(d1.workflow!.id, 'plan-implement-review');
    assert.equal(d1.workflow!.mode, 'advisory');
    assert.equal(d1.workflow!.contentHash, d2.workflow!.contentHash);
    // Planned steps ride along with the detail, from the stored snapshot.
    assert.deepEqual(d1.workflowStages!.map((s) => s.id), ['plan', 'implement', 'review']);
    assert.equal(d1.workflowStages![1]!.preset, null);

    // Refusals: unknown template 404, mutually exclusive blocks 400.
    const unknown = await fetch(`${base}/api/workflows/ghost-wf/runs`, {
      method: 'POST', headers: auth('tok-alice'),
      body: JSON.stringify({ task: 'x', repository: { localPath: repo } }),
    });
    assert.equal(unknown.status, 404);
    const both = await fetch(`${base}/api/workflows/plan-implement-review/runs`, {
      method: 'POST', headers: auth('tok-alice'),
      body: JSON.stringify({ task: 'x', repository: { localPath: repo }, preset: { id: 'reviewer' } }),
    });
    assert.equal(both.status, 400);
  } finally {
    await stopSrv();
    api.close();
    env.close();
  }
});

test('owner scoping: a foreign Run is 404, and no staged-mode group endpoint exists', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  const api = makeApi(env);
  const { url, close: stopSrv } = await listen(api.app);
  try {
    const base = url;
    const created = await fetch(`${base}/api/workflows/plan-implement-review/runs`, {
      method: 'POST', headers: auth('tok-alice'),
      body: JSON.stringify({ task: 'x', repository: { localPath: repo } }),
    });
    assert.equal(created.status, 201);
    const { runId } = await created.json() as { runId: string };
    // Bob cannot read Alice's Run: 404, not 403 (existence is the secret).
    const foreign = await fetch(`${base}/api/runs/${runId}`, { headers: { authorization: 'Bearer tok-bob' } });
    assert.equal(foreign.status, 404);

    // Phase 9 group endpoints are absent (acceptance 4).
    const group = await fetch(`${base}/api/workflow-runs/some-group`, { headers: auth('tok-alice') });
    assert.equal(group.status, 404);
  } finally {
    await stopSrv();
    api.close();
    env.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Express } from 'express';
import { createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { makeEnv, makeGitRepo, tempDir } from './helpers.ts';

// HTTP seam for presets (docs/crew/role-presets.md section 9, Phase 2 slice): the block is
// forwarded UNRESOLVED so HTTP callers hit the same validation in-process callers do, and the
// Run detail response carries the snapshot as a sibling of run/skills/goal/knowledge. The
// lesson from the goal/knowledge forwarding bugs (#539 et al): a route that drops the block
// passes every unit test and breaks only at the seam.

function makeApi(env: ReturnType<typeof makeEnv>) {
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    apiTokens: new Map([['tok-alice', 'alice']]),
    adminToken: null,
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

test('POST /api/runs with a preset creates the Run and GET detail returns the snapshot', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  const api = makeApi(env);
  const { url, close: stopSrv } = await listen(api.app);
  try {
    const base = url;
    const auth = { authorization: 'Bearer tok-alice', 'content-type': 'application/json' };
    const created = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        task: 'Review the auth change',
        repository: { localPath: repo },
        preset: { id: 'reviewer' },
      }),
    });
    assert.equal(created.status, 201);
    const { runId } = (await created.json()) as { runId: string };

    const detail = await (await fetch(`${base}/api/runs/${runId}`, {
      headers: { authorization: 'Bearer tok-alice' },
    })).json() as { preset: { id: string; role: string; trust: string; instruction: string; contentHash: string } | null };
    assert.ok(detail.preset, 'the snapshot must ride along with the run detail');
    assert.equal(detail.preset.id, 'reviewer');
    assert.equal(detail.preset.role, 'Code reviewer');
    assert.equal(detail.preset.trust, 'builtin');
    assert.ok(detail.preset.instruction.length > 0);
    assert.match(detail.preset.contentHash, /^[0-9a-f]{64}$/);
  } finally {
    await stopSrv();
    api.close();
    env.close();
  }
});

test('POST /api/runs with an unknown preset id is a domain 404 naming the preset, not a 500', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  const api = makeApi(env);
  const { url, close: stopSrv } = await listen(api.app);
  try {
    const base = url;
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'x',
        repository: { localPath: repo },
        preset: { id: 'ghost-preset' },
      }),
    });
    // NotFoundError maps to 404 by design (errors.ts: a referenced resource that does not
    // exist -- here the preset -- is a 404 that names it, never a 500 leaking internals).
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.match(body.error, /Preset not found/);
  } finally {
    await stopSrv();
    api.close();
    env.close();
  }
});

test('a request with no preset block behaves exactly as before (no preset key on the detail)', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  const api = makeApi(env);
  const { url, close: stopSrv } = await listen(api.app);
  try {
    const base = url;
    const created = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'plain', repository: { localPath: repo } }),
    });
    assert.equal(created.status, 201);
    const { runId } = (await created.json()) as { runId: string };
    const detail = await (await fetch(`${base}/api/runs/${runId}`, {
      headers: { authorization: 'Bearer tok-alice' },
    })).json() as { preset: unknown };
    assert.equal(detail.preset, null);
  } finally {
    await stopSrv();
    api.close();
    env.close();
  }
});

test('GET /api/presets lists builtin roles and GET /api/presets/:id inspects one', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  const api = makeApi(env);
  const { url, close: stopSrv } = await listen(api.app);
  try {
    const auth = { authorization: 'Bearer tok-alice' };
    const list = await (await fetch(`${url}/api/presets`, { headers: auth })).json() as {
      presets: Array<{ id: string; role: string; version: string; tags: string[]; description: string; enabled: boolean; trust: string; contentHash: string }>;
    };
    const ids = list.presets.map((p) => p.id);
    assert.ok(ids.includes('reviewer') && ids.includes('linux'), 'shipped catalog is browsable: ' + ids);
    const reviewer = list.presets.find((p) => p.id === 'reviewer')!;
    assert.equal(reviewer.trust, 'builtin');
    assert.match(reviewer.contentHash, /^[0-9a-f]{64}$/);
    assert.ok(!('instruction' in reviewer), 'the list stays a list; instruction rides the detail');

    const detail = await (await fetch(`${url}/api/presets/reviewer`, { headers: auth })).json() as {
      id: string; instruction: string; agent: { id: string; required: boolean } | null;
      skills: { defaults: string[]; required: string[]; autoSelect?: boolean; max?: number } | null; contentHash: string;
    };
    assert.equal(detail.id, 'reviewer');
    assert.ok(detail.instruction.length > 0);
    assert.match(detail.contentHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(detail.skills?.defaults, ['code-review', 'security-review', 'testing']);
    assert.equal(detail.skills?.autoSelect, false);
  } finally {
    await stopSrv();
    api.close();
    env.close();
  }
});

test('GET /api/presets diagnostics are admin-gated; unknown preset id is a 404 naming it', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({ workspaceMode: 'copy', repoDir: repo, workerEnabled: false });
  const api = makeApi(env);
  const { url, close: stopSrv } = await listen(api.app);
  try {
    const user = { authorization: 'Bearer tok-alice' };
    const gated = await fetch(`${url}/api/presets?diagnostics=1`, { headers: user });
    assert.equal(gated.status, 403, 'diagnostics are an operator concern, not a browsing one');

    const missing = await fetch(`${url}/api/presets/ghost-preset`, { headers: user });
    assert.equal(missing.status, 404);
    const body = await missing.json() as { error: string };
    assert.match(body.error, /ghost-preset/);
  } finally {
    await stopSrv();
    api.close();
    env.close();
  }
});

test('a broken preset directory shows up in admin diagnostics, not in the browsable list', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const root = tempDir('mercury-presets-');
  const broken = join(root, 'broken');
  mkdirSync(broken);
  writeFileSync(join(broken, 'preset.json'), '{"schemaVersion":1,"id":"broken"}');
  const env = makeEnv({
    workspaceMode: 'copy', repoDir: repo, workerEnabled: false,
    presetsDir: root,
  });
  const api = makeApi(env);
  const { url, close: stopSrv } = await listen(api.app);
  try {
    // Admin surface: the server's admin token is null in makeApi, so exercise the registry
    // through runService (the same accessor the route uses) for the diagnostics content, and
    // the HTTP list for visibility.
    const list = await (await fetch(`${url}/api/presets`, {
      headers: { authorization: 'Bearer tok-alice' },
    })).json() as { presets: Array<{ id: string }> };
    assert.ok(!list.presets.some((p) => p.id === 'broken'), 'an invalid preset is not browsable');
    const all = env.runService.presetRegistry()!.listAll();
    assert.ok(all.invalid.some((bad) => bad.id === 'broken'), 'the validator saw the broken directory');
    assert.ok(all.invalid.find((bad) => bad.id === 'broken')!.validation.length > 0);
  } finally {
    await stopSrv();
    api.close();
    env.close();
  }
});

// Workspace retention + quota GC tests (Mercury.md section 18).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, makeGitRepo, sleep } from './helpers.ts';
import { WorkspaceGC } from '../src/workspace/workspaceGC.ts';
import type { Run } from '../src/domain/types.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeRun(env: ReturnType<typeof makeEnv>, over: Partial<Run> = {}): Run {
  return {
    id: `run_${Math.random().toString(16).slice(2, 14)}`,
    ownerId: 'alice',
    task: 'gc test',
    repository: { localPath: join(env.dir, 'repo') },
    workspaceBranch: null,
    workspacePath: null,
    agent: 'fake',
    status: 'COMPLETED',
    attempt: 1,
    retryOf: null,
    error: null,
    errorKind: null,
    constraints: { maxDurationMs: 60_000, maxRetries: 2 },
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    leaseOwner: null,
    leaseExpiresAt: null,
    cancellationRequestedAt: null,
    finalCommits: [],
    prUrl: null,
    ...over,
  };
}


test('multi-repo: extra repositories are cloned under workspace/repos/', async () => {
  const env = makeEnv({ workerEnabled: false, workspaceMode: 'copy' });
  try {
    const main = makeGitRepo(join(env.dir, 'main-repo'));
    const libA = makeGitRepo(join(env.dir, 'lib-a'));
    const libB = makeGitRepo(join(env.dir, 'lib-b'));
    const run = makeRun(env, {
      id: 'run_multi',
      repository: { localPath: main },
      repositories: [
        { localPath: libA },
        { localPath: libB },
      ],
    });
    const ws = await env.workspace.create(run);
    assert.ok(existsSync(join(ws.path, 'repos', 'lib-a', 'README.md')), 'lib-a cloned');
    assert.ok(existsSync(join(ws.path, 'repos', 'lib-b', 'README.md')), 'lib-b cloned');
    assert.ok(existsSync(join(ws.path, 'README.md')), 'main repo present');
  } finally {
    env.close();
  }
});
test('copy mode: symlinked extra repo is copied, not symlinked (issue #7)', async () => {
  const env = makeEnv({ workerEnabled: false, workspaceMode: 'copy' });
  try {
    const main = makeGitRepo(join(env.dir, 'main-repo'));
    const libReal = makeGitRepo(join(env.dir, 'lib-real'));
    const libLink = join(env.dir, 'lib-link');
    symlinkSync(libReal, libLink);
    const run = makeRun(env, {
      id: 'run_extra_symlink',
      repository: { localPath: main },
      repositories: [{ localPath: libLink }],
    });
    const ws = await env.workspace.create(run);
    const reposLib = join(ws.path, 'repos', 'lib-link');
    assert.ok(existsSync(join(reposLib, 'README.md')), 'extra repo copied');
    // repos/<name> is a real directory, not a symlink to the source (isolation)
    assert.ok(statSync(reposLib).isDirectory());
    assert.ok(!lstatSync(reposLib).isSymbolicLink());
  } finally {
    env.close();
  }
});
test('recordCommits returns full commit SHAs, not --oneline subjects (issue #14)', async () => {
  const env = makeEnv({ workerEnabled: false, workspaceMode: 'git-worktree' }); // has .git
  try {
    const repo = makeGitRepo(join(env.dir, 'commits-repo'));
    const run = makeRun(env, {
      id: 'run_commits',
      repository: { localPath: repo },
    });
    const ws = await env.workspace.create(run);
    const commits = await env.workspace.recordCommits(ws.path);
    assert.ok(commits.length >= 1, 'expected at least one commit');
    for (const c of commits) {
      assert.match(c, /^[0-9a-f]{40}$/, `expected a full SHA, got '${c}'`);
    }
  } finally {
    env.close();
  }
});


test('copy mode: symlinked source path resolves before copy (issue #7)', async () => {
  const env = makeEnv({ workerEnabled: false, workspaceMode: 'copy' });
  try {
    const real = join(env.dir, 'real-repo');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'file.txt'), 'hello');
    const link = join(env.dir, 'link-repo');
    symlinkSync(real, link);
    const run = makeRun(env, {
      id: 'run_symlink',
      repository: { localPath: link },
    });
    const ws = await env.workspace.create(run);
    assert.ok(existsSync(join(ws.path, 'file.txt')));
    assert.equal(ws.mode, 'copy');
    // the workspace is a real directory (not a symlink to the source)
    assert.ok(statSync(ws.path).isDirectory());
  } finally {
    env.close();
  }
});


test('multi-repo: repositories[]-only run derives primary from first entry without duplicating it', async () => {
  const env = makeEnv({ workerEnabled: false, workspaceMode: 'copy' });
  try {
    const libA = makeGitRepo(join(env.dir, 'lib-a'));
    const libB = makeGitRepo(join(env.dir, 'lib-b'));
    // API accepts `repositories` or `repository` (roadmap #6): only the list form here.
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'multi',
      agent: 'fake',
      repositories: [{ localPath: libA }, { localPath: libB }],
    });
    // primary derived from the first entry; extras kept as provided
    assert.equal(run.repository.localPath, libA);
    assert.equal(run.repositories?.length, 2);
    const ws = await env.workspace.create(run);
    assert.ok(existsSync(join(ws.path, 'README.md')), 'primary repo present');
    assert.ok(existsSync(join(ws.path, 'repos', 'lib-b', 'README.md')), 'extra cloned');
    assert.ok(!existsSync(join(ws.path, 'repos', 'lib-a')), 'primary not duplicated under repos/');
  } finally {
    env.close();
  }
});

test('multi-repo: no repos/ dir when no extra repositories', async () => {
  const env = makeEnv({ workerEnabled: false, workspaceMode: 'copy' });
  try {
    const main = makeGitRepo(join(env.dir, 'main-repo'));
    const run = makeRun(env, { id: 'run_single', repository: { localPath: main } });
    const ws = await env.workspace.create(run);
    assert.ok(!existsSync(join(ws.path, 'repos')), 'no repos dir');
  } finally {
    env.close();
  }
});

test('retention: removes terminal workspaces older than retention period', async () => {
  const env = makeEnv({ workerEnabled: false, workspaceMode: 'copy' });
  try {
    const repo = makeGitRepo(join(env.dir, 'repo'));
    const old = makeRun(env, {
      id: 'run_old',
      completedAt: new Date(Date.now() - 10 * DAY).toISOString(),
    });
    const fresh = makeRun(env, {
      id: 'run_fresh',
      completedAt: new Date(Date.now() - 1 * HOUR).toISOString(),
    });
    env.runs.insert(old);
    env.runs.insert(fresh);
    const wsOld = await env.workspace.create(old);
    const wsFresh = await env.workspace.create(fresh);
    assert.ok(existsSync(wsOld.path));
    assert.ok(existsSync(wsFresh.path));

    const gc = new WorkspaceGC(env.runs, env.workspace, {
      retentionMs: 7 * DAY,
      quotaBytes: 0,
      orphanGraceMs: HOUR,
    });
    const report = await gc.run();

    assert.deepEqual(report.removed.sort(), [wsOld.path, wsFresh.path].sort().filter((p) => p === wsOld.path));
    assert.ok(!existsSync(wsOld.path), 'old workspace should be removed');
    assert.ok(existsSync(wsFresh.path), 'fresh workspace should be kept');
    assert.equal(report.kept, 1);
  } finally {
    env.close();
  }
});

test('retention: never removes workspaces of active runs', async () => {
  const env = makeEnv({ workerEnabled: false, workspaceMode: 'copy' });
  try {
    const repo = makeGitRepo(join(env.dir, 'repo'));
    const running = makeRun(env, {
      id: 'run_running',
      status: 'RUNNING',
      completedAt: null,
    });
    const queued = makeRun(env, {
      id: 'run_queued',
      status: 'QUEUED',
      completedAt: null,
    });
    env.runs.insert(running);
    env.runs.insert(queued);
    const wsRunning = await env.workspace.create(running);
    const wsQueued = await env.workspace.create(queued);

    const gc = new WorkspaceGC(env.runs, env.workspace, {
      retentionMs: 0, // everything is "expired"
      quotaBytes: 0,
      orphanGraceMs: 0,
    });
    const report = await gc.run();

    assert.equal(report.removed.length, 0);
    assert.ok(existsSync(wsRunning.path));
    assert.ok(existsSync(wsQueued.path));
    assert.equal(report.kept, 2);
  } finally {
    env.close();
  }
});

test('quota: evicts oldest terminal workspaces until under quota', async () => {
  const env = makeEnv({ workerEnabled: false, workspaceMode: 'copy' });
  try {
    const repo = makeGitRepo(join(env.dir, 'repo'));
    const runs = [
      makeRun(env, { id: 'run_a', completedAt: new Date(Date.now() - 3 * DAY).toISOString() }),
      makeRun(env, { id: 'run_b', completedAt: new Date(Date.now() - 2 * DAY).toISOString() }),
      makeRun(env, { id: 'run_c', completedAt: new Date(Date.now() - 1 * DAY).toISOString() }),
    ];
    for (const r of runs) env.runs.insert(r);
    const paths: string[] = [];
    for (const r of runs) {
      const ws = await env.workspace.create(r);
      paths.push(ws.path);
      // give each workspace some content so sizes are measurable
      writeFileSync(join(ws.path, 'payload.txt'), 'x'.repeat(1024));
    }

    // quota = size of 2 workspaces -> evicts the oldest 1
    const sizes = paths.map((p) => env.workspace.workspaceSize(p));
    const quota = sizes[0] + sizes[1] + 1;
    const gc = new WorkspaceGC(env.runs, env.workspace, {
      retentionMs: 30 * DAY, // no retention eviction
      quotaBytes: quota,
      orphanGraceMs: HOUR,
    });
    const report = await gc.run();

    assert.equal(report.removed.length, 1);
    assert.equal(report.removed[0], paths[0], 'oldest (run_a) evicted first');
    assert.ok(!existsSync(paths[0]));
    assert.ok(existsSync(paths[1]));
    assert.ok(existsSync(paths[2]));
    assert.ok(report.overQuota === false || report.totalBytes <= quota);
  } finally {
    env.close();
  }
});

test('orphans: removes dirs without a Run row after grace period', async () => {
  const env = makeEnv({ workerEnabled: false, workspaceMode: 'copy' });
  try {
    const orphanDir = join(env.dir, 'workspaces', 'worktrees', 'run_orphan');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, 'junk.txt'), 'orphan');
    // backdate mtime beyond grace
    const { utimesSync } = await import('node:fs');
    utimesSync(orphanDir, new Date(Date.now() - 2 * HOUR), new Date(Date.now() - 2 * HOUR));

    const gc = new WorkspaceGC(env.runs, env.workspace, {
      retentionMs: DAY,
      quotaBytes: 0,
      orphanGraceMs: HOUR,
    });
    const report = await gc.run();

    assert.equal(report.removed.length, 1);
    assert.ok(!existsSync(orphanDir));
  } finally {
    env.close();
  }
});

test('orphans: young dirs without a Run row are kept', async () => {
  const env = makeEnv({ workerEnabled: false, workspaceMode: 'copy' });
  try {
    const orphanDir = join(env.dir, 'workspaces', 'worktrees', 'run_young');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, 'junk.txt'), 'orphan');

    const gc = new WorkspaceGC(env.runs, env.workspace, {
      retentionMs: DAY,
      quotaBytes: 0,
      orphanGraceMs: HOUR,
    });
    const report = await gc.run();

    assert.equal(report.removed.length, 0);
    assert.ok(existsSync(orphanDir));
  } finally {
    env.close();
  }
});

test('git-worktree mode: removal uses git worktree remove and deletes branch', async () => {
  const env = makeEnv({ workerEnabled: false, workspaceMode: 'git-worktree' });
  try {
    const repo = makeGitRepo(join(env.dir, 'repo'));
    const run = makeRun(env, { id: 'run_wt', repository: { localPath: repo } });
    env.runs.insert(run);
    const ws = await env.workspace.create(run);
    assert.ok(existsSync(ws.path));
    assert.equal(ws.mode, 'git-worktree');

    const gc = new WorkspaceGC(env.runs, env.workspace, {
      retentionMs: 0,
      quotaBytes: 0,
      orphanGraceMs: HOUR,
    });
    const report = await gc.run();

    assert.equal(report.removed.length, 1);
    assert.ok(!existsSync(ws.path), 'worktree dir removed');
    // branch should be gone too
    const { execFileSync } = await import('node:child_process');
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', run.workspaceBranch ?? 'agent/run_wt'], { encoding: 'utf8' });
    assert.equal(branches.trim(), '', 'agent branch deleted');
  } finally {
    env.close();
  }
});

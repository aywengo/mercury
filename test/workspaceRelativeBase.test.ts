import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { makeGitRepo, tempDir } from './helpers.ts';
import type { Run } from '../src/domain/types.ts';

// Issue #703: a relative MERCURY_WORKSPACE_BASE (the shipped default) handed git a relative
// `worktree add` target. git resolves that target against the clone directory (--C repoDir),
// while the worker, adapters, GC and the recorded run.workspacePath resolve the same string
// against the process cwd. The worktree landed INSIDE the clone; the agent ran in an empty
// directory. Nothing caught it because every test env builds absolute temp paths -- so this
// test reproduces the shipped shape exactly: relative base, process cwd elsewhere.

test('a relative workspace base puts the worktree at the cwd-resolved path, with repository content', async () => {
  const cwd = tempDir('mercury-wsbase-cwd-');
  // The fixture clone lives OUTSIDE the process cwd, so cwd-relative and clone-relative
  // resolutions diverge -- the exact condition the failure needs.
  const repo = makeGitRepo(tempDir('mercury-wsbase-repo-'));
  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    const { WorkspaceManager } = await import('../src/workspace/workspaceManager.ts');
    // Deliberately relative: this is the shipped default's shape (config resolves it for
    // production, but the manager itself must not depend on that having happened).
    const mgr = new WorkspaceManager({ baseDir: './workspaces', mode: 'git-worktree' });
    const run = {
      id: 'run_relbase',
      agent: 'fake',
      task: 'x',
      repository: { url: repo, baseBranch: 'main' },
      repositories: [],
    } as unknown as Run;
    const ws = await mgr.create(run);

    // 1. The directory the worker/agent will use (the returned path, as recorded) holds the
    //    repository's files -- it is a real worktree, not an empty cwd-relative shell.
    assert.equal(existsSync(join(ws.path, 'README.md')), true,
      `the workspace at ${ws.path} has no repository content -- the worktree resolved somewhere else`);
    assert.equal(existsSync(join(ws.path, '.git')), true, 'the workspace is a git worktree');

    // 2. It lives under the cwd-resolved base, not inside the clone.
    const abs = resolve(ws.path);
    assert.ok(isAbsolute(ws.path), 'the manager hands out absolute workspace paths');
    // macOS tmpdir is under a symlinked prefix (/var -> /private/var), so compare real paths.
    assert.ok(abs.startsWith(realpathSync(resolve(cwd, 'workspaces')) + '/'),
      `the worktree must resolve against the process cwd, got ${abs}`);
    assert.ok(!abs.startsWith(realpathSync(repo)),
      'the worktree must not live inside the clone directory');
  } finally {
    process.chdir(prevCwd);
  }
});

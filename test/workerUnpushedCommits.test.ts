// Issue #1024 acceptance 1 and 6: a Run that commits and never pushes records
// `run.unpushed_commits` (naming the commits and the branch), and a Run that pushed everything
// emits nothing new. The fixture is a real bare remote plus a worktree workspace, because the
// whole signal is "is this commit reachable from a remote ref" -- a mock would assert the mock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';
import type { AgentAdapter, AgentEvent, AgentExit, AgentHandle, RunContext } from '../src/domain/types.ts';

/**
 * An agent double that does real git work in the workspace: one commit, then optionally a push of
 * the workspace branch to the remote. Everything else about it is the trivial adapter shape.
 */
function gitAgent(opts: { push: boolean }): AgentAdapter {
  return {
    id: 'git-fake',
    capabilities: { static: { skills: 'none', humanInput: false, resume: false, toolEvents: 'none', roleInstruction: 'none', perRunModel: false, sandbox: false, mcp: 'none', workflowPlan: false } },
    async start(context: RunContext): Promise<AgentHandle> {
      const dir = context.workspace.path;
      writeFileSync(join(dir, 'change.txt'), 'work\n');
      execFileSync('git', ['-C', dir, 'add', 'change.txt'], { timeout: 30_000 });
      execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'the work'], { timeout: 30_000 });
      if (opts.push) {
        execFileSync('git', ['-C', dir, 'push', '-q', 'origin', `HEAD:refs/heads/${context.workspace.branch}`], { timeout: 60_000 });
      }
      const exit: AgentExit = { code: 0, signal: null, reason: 'completed' };
      const events: AgentEvent[] = [];
      return {
        runId: context.run.id,
        events: (async function* () { yield* events; })(),
        exit: Promise.resolve(exit),
        terminate: async () => {},
      };
    },
  } as unknown as AgentAdapter;
}

/** A bare origin plus a seed checkout that tracks it, so the workspace worktree has refs/remotes. */
function repoWithRemote(): { seed: string; origin: string } {
  const dir = tempDir('mercury-1024-');
  const origin = join(dir, 'origin.git');
  execFileSync('git', ['init', '--bare', '-q', origin], { timeout: 30_000 });
  const seed = makeGitRepo(join(dir, 'seed'));
  execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', origin], { timeout: 30_000 });
  execFileSync('git', ['-C', seed, 'push', '-q', '-u', 'origin', 'main'], { timeout: 60_000 });
  return { seed, origin };
}

test('#1024: a Run that commits and does not push records run.unpushed_commits', async () => {
  const { seed, origin } = repoWithRemote();
  const env = makeEnv({ workspaceMode: 'git-worktree', repoDir: seed, adapters: { 'git-fake': gitAgent({ push: false }) } });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'commit without pushing',
      agent: 'git-fake',
      repository: { url: origin, localPath: seed, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 30_000);

    const events = env.events.list(run.id, 0, 200);
    const unpushed = events.filter((e) => e.type === 'run.unpushed_commits');
    assert.equal(unpushed.length, 1, 'exactly one record for the one Run');
    const payload = unpushed[0]!.payload as { branch: string; commits: string[] };
    assert.equal(payload.branch, `agent/${run.id}`, 'the branch names where the work sits');
    assert.equal(payload.commits.length, 1, 'only the Run\'s own commit is unpushed, not the base commit');

    // The named commit is the real one in the worktree, and it is genuinely absent from the remote.
    const ws = env.runs.get(run.id)!.workspacePath!;
    const head = execFileSync('git', ['-C', ws, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 }).trim();
    assert.deepEqual(payload.commits, [head]);
    const remoteHas = (() => {
      try {
        execFileSync('git', ['-C', origin, 'cat-file', '-e', head], { timeout: 30_000 });
        return true;
      } catch {
        return false;
      }
    })();
    assert.equal(remoteHas, false, 'the commit really never reached the remote');

    // The event precedes the terminal event, so a reader that stops at run.completed still saw it.
    const types = events.map((e) => e.type);
    assert.ok(types.indexOf('run.unpushed_commits') < types.indexOf('run.completed'));
  } finally {
    env.close();
  }
});

test('#1024: a Run that pushed everything emits nothing new (byte-identical good Runs)', async () => {
  const { seed, origin } = repoWithRemote();
  const env = makeEnv({ workspaceMode: 'git-worktree', repoDir: seed, adapters: { 'git-fake': gitAgent({ push: true }) } });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'commit and push',
      agent: 'git-fake',
      repository: { url: origin, localPath: seed, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 30_000);
    const events = env.events.list(run.id, 0, 200);
    assert.deepEqual(events.filter((e) => e.type === 'run.unpushed_commits'), []);
    // The Run still records its commits: the new signal is additive, not a replacement.
    const done = events.find((e) => e.type === 'run.completed')!;
    assert.ok((done.payload as { commits: string[] }).commits.length > 0);
  } finally {
    env.close();
  }
});

test('#1024: a repository with no remote never reports unpushed commits', async () => {
  // The guard that keeps every local-fixture Run quiet: there is no branch the commits were meant
  // for, so "unpushed" is not a fact about this Run.
  const repo = makeGitRepo(tempDir('mercury-1024-noremote-'));
  const env = makeEnv({ workspaceMode: 'git-worktree', repoDir: repo, adapters: { 'git-fake': gitAgent({ push: false }) } });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'no remote', agent: 'git-fake', repository: { localPath: repo } });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 30_000);
    assert.deepEqual(env.events.list(run.id, 0, 200).filter((e) => e.type === 'run.unpushed_commits'), []);
  } finally {
    env.close();
  }
});

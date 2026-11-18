// Issue #1111 acceptance 2: a nightly-next Run that committed work but cannot finish before its
// deadline (notAfter) must not strand it in the worktree. The worker pushes the branch with the
// Run's own credentials at TIMED_OUT finalize, records the commits on the Run, and falls back to
// the existing `run.unpushed_commits` record when the push cannot land. The fixture is a real
// bare remote plus a worktree workspace: the whole point is "the branch exists on the remote
// after the stop", which a mock cannot show.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';
import type { AgentAdapter, AgentExit, AgentHandle, RunContext } from '../src/domain/types.ts';

const GIT = { timeout: 30_000 };

/** The agent shape every fixture shares: a handle whose exit never resolves, so only the
 * Run's own deadline can stop it -- the shape of a Run that dies at its notAfter instant. The
 * worker's deadline stop calls terminate(), which ends the event loop so the test process can
 * exit: a forever-holding generator would keep node alive long after the assertions ran. */
function hangingHandle(runId: string): AgentHandle {
  let terminated = false;
  return {
    runId,
    events: (async function* () {
      // "Working": never yields, never finishes on its own.
      while (!terminated) {
        await new Promise((r) => setTimeout(r, 50));
      }
    })(),
    // Never settles: the drive loop's deadline is what ends the Run.
    exit: new Promise<AgentExit>(() => {}),
    terminate: async () => { terminated = true; },
  };
}

function adapter(id: string, onWorkspace: (dir: string) => void): AgentAdapter {
  return {
    id,
    capabilities: { static: { skills: 'none', humanInput: false, resume: false, toolEvents: 'none', roleInstruction: 'none', perRunModel: false, sandbox: false, mcp: 'none', workflowPlan: false } },
    async start(context: RunContext): Promise<AgentHandle> {
      onWorkspace(context.workspace.path);
      return hangingHandle(context.run.id);
    },
  } as unknown as AgentAdapter;
}

/** Commits one file in the workspace, exactly what a Run does before its deadline arrives. */
const commitWork = (dir: string): void => {
  writeFileSync(join(dir, 'stranded.txt'), 'committed before the deadline\n');
  execFileSync('git', ['-C', dir, 'add', 'stranded.txt'], GIT);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work committed before the deadline'], GIT);
};

/** A bare origin plus a seed checkout that tracks it (the worktree then has refs/remotes). */
function repoWithRemote(): { seed: string; origin: string } {
  const dir = tempDir('mercury-1111-');
  const origin = join(dir, 'origin.git');
  execFileSync('git', ['init', '--bare', '-q', origin], GIT);
  const seed = makeGitRepo(join(dir, 'seed'));
  execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', origin], GIT);
  execFileSync('git', ['-C', seed, 'push', '-q', '-u', 'origin', 'main'], { timeout: 60_000 });
  return { seed, origin };
}

const NOT_AFTER = (): { maxDurationMs: number; notAfter: string } => ({
  maxDurationMs: 60_000,
  notAfter: new Date(Date.now() + 2_500).toISOString(),
});

test('#1111: a deadline-stopped Run with committed work pushes its branch', async () => {
  const { seed, origin } = repoWithRemote();
  const env = makeEnv({
    workspaceMode: 'git-worktree',
    repoDir: seed,
    adapters: { 'git-fake': adapter('git-fake', commitWork) },
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'commits, then the deadline',
      agent: 'git-fake',
      repository: { url: origin, localPath: seed, baseBranch: 'main' },
      constraints: NOT_AFTER(),
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'TIMED_OUT', 20_000);

    const timedOut = env.events.list(run.id).find((e) => e.type === 'run.timed_out');
    assert.equal((timedOut!.payload as { reason: string }).reason, 'not-after');

    // The branch the work is on now exists on the remote -- the next Run resumes from there.
    const ws = env.runs.get(run.id)!.workspacePath!;
    const head = execFileSync('git', ['-C', ws, 'rev-parse', 'HEAD'], { encoding: 'utf8', ...GIT }).trim();
    const remoteHead = execFileSync('git', ['-C', origin, 'rev-parse', `refs/heads/agent/${run.id}`], { encoding: 'utf8', ...GIT }).trim();
    assert.equal(remoteHead, head, 'the stop pushed the committed branch to origin');

    // The Run records the commits it made: TIMED_OUT runs used to carry null, which read as
    // "nothing happened".
    assert.deepEqual(env.runs.get(run.id)!.finalCommits, [head]);

    // The push landed, so nothing is stranded: no run.unpushed_commits record (a false alarm in
    // the morning digest would be worse than silence here).
    assert.deepEqual(env.events.list(run.id).filter((e) => e.type === 'run.unpushed_commits'), []);
  } finally {
    env.close();
  }
});

test('#1111: when the push cannot land, the branch is recorded as unpushed for the report', async () => {
  // Same stop, but the remote refuses writes (read-only): the branch must still be NAMED, with
  // its commits, for the morning report's recovery section.
  const { seed, origin } = repoWithRemote();
  // Recursively: a mode change on the top dir alone would not stop ref creation, which only
  // needs write on refs/heads.
  execFileSync('chmod', ['-R', 'a-w', origin], GIT);
  const env = makeEnv({
    workspaceMode: 'git-worktree',
    repoDir: seed,
    adapters: { 'git-fake': adapter('git-fake', commitWork) },
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'commits, then the deadline, remote read-only',
      agent: 'git-fake',
      repository: { url: origin, localPath: seed, baseBranch: 'main' },
      constraints: NOT_AFTER(),
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'TIMED_OUT', 20_000);

    const ws = env.runs.get(run.id)!.workspacePath!;
    const head = execFileSync('git', ['-C', ws, 'rev-parse', 'HEAD'], { encoding: 'utf8', ...GIT }).trim();

    const unpushed = env.events.list(run.id).filter((e) => e.type === 'run.unpushed_commits');
    assert.equal(unpushed.length, 1, 'the refused push is recorded, not swallowed');
    const payload = unpushed[0]!.payload as { branch: string; commits: string[] };
    assert.equal(payload.branch, `agent/${run.id}`);
    assert.deepEqual(payload.commits, [head]);
    assert.deepEqual(env.runs.get(run.id)!.finalCommits, [head]);

    // The commit really never reached the remote: the record is a fact, not a guess.
    let remoteHas = true;
    try {
      execFileSync('git', ['-C', origin, 'cat-file', '-e', head], GIT);
    } catch {
      remoteHas = false;
    }
    assert.equal(remoteHas, false);
  } finally {
    execFileSync('chmod', ['-R', 'u+w', origin], GIT);
    env.close();
  }
});

test('#1111: a deadline-stopped Run with no commits stays quiet (the five-run shape)', async () => {
  // The observed failure mode (2026-11-04/06): the Run died with uncommitted edits and zero
  // commits. The new code must add nothing to that terminal shape -- no record to fake, no push
  // to try -- so these Runs remain byte-identical to before.
  const { seed, origin } = repoWithRemote();
  const env = makeEnv({
    workspaceMode: 'git-worktree',
    repoDir: seed,
    adapters: { 'git-fake': adapter('git-fake', () => {}) },
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'no commits before the deadline',
      agent: 'git-fake',
      repository: { url: origin, localPath: seed, baseBranch: 'main' },
      constraints: NOT_AFTER(),
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'TIMED_OUT', 20_000);
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('run.timed_out'));
    assert.ok(!types.includes('run.unpushed_commits'), 'no commits, no record');
    assert.deepEqual(env.runs.get(run.id)!.finalCommits, []);
    // And nothing new on the remote either.
    const branches = execFileSync('git', ['-C', origin, 'branch', '--list'], { encoding: 'utf8', ...GIT });
    assert.ok(!branches.includes(`agent/${run.id}`));
  } finally {
    env.close();
  }
});

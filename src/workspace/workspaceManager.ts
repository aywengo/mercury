// Workspace isolation (Mercury.md section 18).
// git-worktree mode: real git worktrees off a base repo clone.
// copy mode: recursive copy of a local template (for tests / non-git sources).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, Workspace } from '../domain/types.ts';

const execFileP = promisify(execFile);

/**
 * Every git invocation in this file goes through runGit(). There was no choke point, so there was
 * no default: eleven execFile calls, none with a timeout, and a worker that hangs is indistinguishable
 * from a worker that is slow except in hindsight.
 *
 * Two failure modes, and the second is the one that bites in production:
 *
 *   1. A remote is slow or a clone is huge. Bounded by the timeout.
 *   2. git decides to ASK A QUESTION. The worker is a detached daemon with no controlling terminal,
 *      so the prompt goes nowhere and the call blocks forever. `git clone` of a private URL with no
 *      cached credential does this by default, as does anything that opens an editor.
 *
 * The env block answers the questions instead of refusing to answer them: GIT_TERMINAL_PROMPT=0 makes
 * git fail with an error rather than prompt, and GIT_ASKPASS points at a program that prints nothing,
 * so an auth attempt fails immediately with bad credentials. Failing fast is correct here because the
 * alternative is not "works" -- it is "hangs".
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  // Defence in depth, and NOT independently covered by a test: GIT_TERMINAL_PROMPT=0 already blocks
  // the terminal fallback that the credential test observes. GIT_ASKPASS covers the paths that ask
  // an askpass helper rather than the terminal (ssh passphrase, core.askPass), where git would
  // otherwise wait on a helper that never answers. Stated plainly because a comment that implies
  // coverage the suite does not provide is its own kind of defect.
  GIT_ASKPASS: '/bin/true',
  GIT_EDITOR: 'true',
  GIT_PAGER: 'cat',
  GIT_MERGE_AUTOEDIT: 'no',
};

/** Plumbing: rev-parse, worktree add/remove, branch -D. All local, all sub-second. */
const GIT_DEFAULT_TIMEOUT_MS = 30_000;
/** Network: clone and fetch. A large repository legitimately takes minutes. */
const GIT_NETWORK_TIMEOUT_MS = 600_000;

export interface GitRunOptions {
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Run git with a deadline and no ability to ask for input.
 *
 * The error names the subcommand and the deadline that expired, because "workspace creation failed"
 * from a worker that has been stuck for an hour tells an operator nothing actionable.
 */
export async function runGit(args: string[], opts: GitRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const timeout = opts.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS;
  try {
    return await execFileP('git', args, {
      cwd: opts.cwd,
      env: GIT_ENV,
      timeout,
      // SIGKILL so the deadline cannot be negotiated. git handles SIGTERM, and a child that is
      // willing to shut down cleanly may still take time to do it; the worker's own shutdown has a
      // deadline and cannot absorb an unbounded child on top of it. Not independently covered --
      // every git process in these tests dies on either signal, so no test distinguishes them.
      killSignal: 'SIGKILL',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as Error & { killed?: boolean; code?: number | string; signal?: string };
    if (e.killed || e.signal === 'SIGKILL') {
      throw new Error(
        `git ${args.join(' ')} exceeded its ${timeout} ms deadline and was killed `
        + `(cwd: ${opts.cwd ?? 'worker cwd'}). Raise MERCURY_GIT_TIMEOUT_MS if this repository `
        + 'legitimately needs longer.',
      );
    }
    throw err;
  }
}

/** Recursive directory size in bytes (symlinks not followed). */
function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(full);
      } else if (entry.isFile()) {
        total += statSync(full).size;
      }
    }
  } catch {
    // unreadable entries are skipped
  }
  return total;
}

export interface WorkspaceManagerConfig {
  baseDir: string;
  mode: 'git-worktree' | 'copy';
  /** Deadline for local git plumbing. Default 30s. */
  gitTimeoutMs?: number;
  /** Deadline for clone/fetch. Default 600s. */
  gitNetworkTimeoutMs?: number;
}

export class WorkspaceManager {
  private cfg: WorkspaceManagerConfig;

  constructor(cfg: WorkspaceManagerConfig) {
    this.cfg = cfg;
  }

  /** Applies this manager's configured deadlines. `network: true` for clone/fetch. */
  private git(args: string[], opts: { cwd?: string; network?: boolean } = {}): Promise<{ stdout: string; stderr: string }> {
    return runGit(args, {
      cwd: opts.cwd,
      timeoutMs: opts.network
        ? this.cfg.gitNetworkTimeoutMs ?? GIT_NETWORK_TIMEOUT_MS
        : this.cfg.gitTimeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
    });
  }

  async create(run: Run): Promise<Workspace> {
    mkdirSync(this.cfg.baseDir, { recursive: true });
    const workspace = this.cfg.mode === 'copy' ? await this.createCopy(run) : await this.createWorktree(run);
    await this.attachExtraRepos(run, workspace.path);
    return workspace;
  }

  /** Clone/copy additional repositories (roadmap #6) under <workspace>/repos/<name>. */
  private async attachExtraRepos(run: Run, workspacePath: string): Promise<void> {
    const extras = run.repositories ?? [];
    if (extras.length === 0) return;
    const primarySource = run.repository.url ?? run.repository.localPath;
    const toAttach = extras.filter((repo) => {
      const source = repo.url ?? repo.localPath;
      return source !== undefined && source !== primarySource;
    });
    if (toAttach.length === 0) return;
    const reposDir = join(workspacePath, 'repos');
    mkdirSync(reposDir, { recursive: true });
    for (let i = 0; i < extras.length; i++) {
      const repo = extras[i];
      const source = repo.url ?? repo.localPath;
      if (!source) throw new Error(`repositories[${i}] requires url or localPath`);
      // The primary is already the workspace itself; never clone it again.
      if (source === primarySource) continue;
      const name = repo.url
        ? repo.url.replace(/^.*\//, '').replace(/\.git$/, '')
        : (repo.localPath?.split(/[\/]/).filter(Boolean).pop() ?? `repo-${i}`);
      const dest = join(reposDir, name);
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      if (repo.localPath && !repo.url) {
        if (!existsSync(repo.localPath)) throw new Error(`localPath not found: ${repo.localPath}`);
        // Same symlink handling as createCopy: without realpathSync, cpSync would
        // create repos/<name> as a symlink to the source (isolation leak).
        cpSync(realpathSync(repo.localPath), dest, {
          recursive: true,
          filter: (src) => !src.split(/[\/]/).includes('.git'),
        });
      } else {
        await this.git(['clone', '--quiet', source, dest], { network: true });
      }
    }
  }

  private async createWorktree(run: Run): Promise<Workspace> {
    const repoDir = await this.ensureRepo(run);
    const branch = `agent/${run.id}`;
    const worktreePath = join(this.cfg.baseDir, 'worktrees', run.id);
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });

    const baseCommit = run.repository.baseCommit ?? (await this.resolveBaseCommit(repoDir, run.repository.baseBranch ?? 'main'));
    await this.git(['-C', repoDir, 'worktree', 'add', '-b', branch, worktreePath, baseCommit]);
    return { path: worktreePath, branch, baseCommit, mode: 'git-worktree' };
  }

  private async ensureRepo(run: Run): Promise<string> {
    const source = run.repository.url ?? run.repository.localPath;
    if (!source) throw new Error('Workspace requires repository.url or repository.localPath');
    if (run.repository.localPath && !run.repository.url) {
      if (!existsSync(run.repository.localPath)) throw new Error(`localPath not found: ${run.repository.localPath}`);
      return run.repository.localPath;
    }
    const key = createHash('sha1').update(source).digest('hex').slice(0, 12);
    const repoDir = join(this.cfg.baseDir, 'repos', key);
    if (!existsSync(join(repoDir, '.git'))) {
      mkdirSync(repoDir, { recursive: true });
      await this.git(['clone', '--quiet', source, repoDir], { network: true });
    } else {
      await this.git(['-C', repoDir, 'fetch', '--quiet', 'origin'], { network: true });
    }
    return repoDir;
  }

  private async resolveBaseCommit(repoDir: string, baseBranch: string): Promise<string> {
    try {
      const { stdout } = await this.git(['-C', repoDir, 'rev-parse', `origin/${baseBranch}`]);
      return stdout.trim();
    } catch {
      const { stdout } = await this.git(['-C', repoDir, 'rev-parse', 'HEAD']);
      return stdout.trim();
    }
  }

  private async createCopy(run: Run): Promise<Workspace> {
    const source = run.repository.localPath ?? run.repository.url;
    if (!source) throw new Error('Workspace requires repository.localPath (copy mode)');
    if (!existsSync(source)) throw new Error(`localPath not found: ${source}`);
    // Resolve symlinks (e.g. /tmp -> /private/tmp on macOS): cpSync copies a
    // symlinked source as a symlink by default, which collides with the
    // pre-created destination directory (EEXIST).
    const resolved = realpathSync(source);
    const branch = `agent/${run.id}`;
    const dest = join(this.cfg.baseDir, 'worktrees', run.id);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(resolved, dest, {
      recursive: true,
      filter: (src) => !src.split(/[\\/]/).includes('.git'),
    });
    return { path: dest, branch, baseCommit: 'copy', mode: 'copy' };
  }

  /** Enumerate workspace directories currently on disk (worktrees/<runId>). */
  listWorkspaces(): string[] {
    const dir = join(this.cfg.baseDir, 'worktrees');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name));
  }

  /** Size of a workspace directory in bytes (recursive). */
  workspaceSize(workspacePath: string): number {
    return dirSize(workspacePath);
  }

  /** Total size of the workspace base in bytes. */
  totalSize(): number {
    return dirSize(this.cfg.baseDir);
  }

  /**
   * Remove a workspace safely. git-worktree mode uses `git worktree remove`
   * (also deletes the worktree metadata + branch); copy mode is a plain rm.
   * `path` overrides run.workspacePath (the run row may not have the path
   * persisted yet, e.g. during GC of a run whose workspace was created but
   * the transition never recorded it). Never throws: cleanup is best-effort.
   */
  async removeWorkspace(run: Run, path?: string): Promise<void> {
    const target = path ?? run.workspacePath;
    if (!target || !existsSync(target)) return;
    if (this.cfg.mode === 'copy') {
      rmSync(target, { recursive: true, force: true });
      return;
    }
    try {
      const repoDir = await this.ensureRepo(run);
      await this.git(['-C', repoDir, 'worktree', 'remove', '--force', target]);
      const branch = run.workspaceBranch ?? `agent/${run.id}`;
      await this.git(['-C', repoDir, 'branch', '-D', branch]).catch(() => {});
    } catch {
      // fall back to plain removal if git worktree remove fails
      rmSync(target, { recursive: true, force: true });
    }
  }

  async recordCommits(workspacePath: string): Promise<string[]> {
    try {
      // Full SHAs, not --oneline display strings: finalCommits is documented as
      // commit identifiers (run.finalCommits, shown in the UI); consumers need
      // extractable SHAs rather than display strings.
      const { stdout } = await this.git(['-C', workspacePath, 'log', '--format=%H', '-n', '20']);
      return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  async cleanup(run: Run): Promise<void> {
    if (!run.workspacePath || this.cfg.mode === 'copy') {
      if (run.workspacePath && existsSync(run.workspacePath)) rmSync(run.workspacePath, { recursive: true, force: true });
      return;
    }
    try {
      const repoDir = await this.ensureRepo(run);
      await this.git(['-C', repoDir, 'worktree', 'remove', '--force', run.workspacePath]);
      if (run.workspaceBranch) {
        await this.git(['-C', repoDir, 'branch', '-D', run.workspaceBranch]).catch(() => {});
      }
    } catch {
      // best effort
    }
  }
}

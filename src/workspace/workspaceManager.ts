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
}

export class WorkspaceManager {
  private cfg: WorkspaceManagerConfig;

  constructor(cfg: WorkspaceManagerConfig) {
    this.cfg = cfg;
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
        await execFileP('git', ['clone', '--quiet', source, dest]);
      }
    }
  }

  private async createWorktree(run: Run): Promise<Workspace> {
    const repoDir = await this.ensureRepo(run);
    const branch = `agent/${run.id}`;
    const worktreePath = join(this.cfg.baseDir, 'worktrees', run.id);
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });

    const baseCommit = run.repository.baseCommit ?? (await this.resolveBaseCommit(repoDir, run.repository.baseBranch ?? 'main'));
    await execFileP('git', ['-C', repoDir, 'worktree', 'add', '-b', branch, worktreePath, baseCommit]);
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
      await execFileP('git', ['clone', '--quiet', source, repoDir]);
    } else {
      await execFileP('git', ['-C', repoDir, 'fetch', '--quiet', 'origin']);
    }
    return repoDir;
  }

  private async resolveBaseCommit(repoDir: string, baseBranch: string): Promise<string> {
    try {
      const { stdout } = await execFileP('git', ['-C', repoDir, 'rev-parse', `origin/${baseBranch}`]);
      return stdout.trim();
    } catch {
      const { stdout } = await execFileP('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
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
      await execFileP('git', ['-C', repoDir, 'worktree', 'remove', '--force', target]);
      const branch = run.workspaceBranch ?? `agent/${run.id}`;
      await execFileP('git', ['-C', repoDir, 'branch', '-D', branch]).catch(() => {});
    } catch {
      // fall back to plain removal if git worktree remove fails
      rmSync(target, { recursive: true, force: true });
    }
  }

  async recordCommits(workspacePath: string): Promise<string[]> {
    try {
      const { stdout } = await execFileP('git', ['-C', workspacePath, 'log', '--oneline', '-n', '20']);
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
      await execFileP('git', ['-C', repoDir, 'worktree', 'remove', '--force', run.workspacePath]);
      if (run.workspaceBranch) {
        await execFileP('git', ['-C', repoDir, 'branch', '-D', run.workspaceBranch]).catch(() => {});
      }
    } catch {
      // best effort
    }
  }
}

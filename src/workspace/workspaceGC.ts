// Workspace retention + disk quota GC (Mercury.md section 18).
//
// One GC pass:
//   1. Enumerate workspace dirs on disk (worktrees/<runId>).
//   2. For each dir, look up its Run. If the Run is terminal and its
//      completedAt is older than the retention period -> remove.
//   3. If the total workspace base size exceeds the quota, evict the oldest
//      terminal workspaces until under quota.
//   4. Orphan dirs (no matching Run row) older than a grace period -> remove.
//   5. Never touch workspaces of non-terminal Runs (QUEUED/STARTING/RUNNING/
//      NEEDS_INPUT) — they are actively in use or about to be.
//
// Removal is best-effort: a failed removal is reported, not fatal.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../domain/types.ts';
import type { RunStore } from '../runs/runStore.ts';
import type { WorkspaceManager } from './workspaceManager.ts';

export interface WorkspaceGCConfig {
  /** Keep terminal workspaces at least this long (ms). Default 7 days. */
  retentionMs: number;
  /** Max total workspace base size in bytes. 0 = no quota. Default 10 GiB. */
  quotaBytes: number;
  /** Orphan dirs younger than this are left alone (ms). Default 1 hour. */
  orphanGraceMs: number;
}

export interface WorkspaceGCReport {
  removed: string[];
  failed: string[];
  freedBytes: number;
  totalBytes: number;
  kept: number;
  quotaBytes: number;
  overQuota: boolean;
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

export class WorkspaceGC {
  private runs: RunStore;
  private workspace: WorkspaceManager;
  private cfg: WorkspaceGCConfig;

  constructor(runs: RunStore, workspace: WorkspaceManager, cfg: WorkspaceGCConfig) {
    this.runs = runs;
    this.workspace = workspace;
    this.cfg = cfg;
  }

  async run(now: number = Date.now()): Promise<WorkspaceGCReport> {
    const report: WorkspaceGCReport = {
      removed: [],
      failed: [],
      freedBytes: 0,
      totalBytes: 0,
      kept: 0,
      quotaBytes: this.cfg.quotaBytes,
      overQuota: false,
    };

    const dirs = this.workspace.listWorkspaces();
    // runId -> Run (only terminal runs are candidates for retention eviction)
    const runById = new Map<string, Run>();
    for (const dir of dirs) {
      const runId = join(dir).split(/[\\/]/).pop() ?? '';
      const run = this.runs.get(runId);
      if (run) runById.set(runId, run);
    }

    // Phase 1: retention expiry + orphan cleanup
    const candidates: { dir: string; run: Run | null; completedAt: number | null }[] = [];
    for (const dir of dirs) {
      const runId = join(dir).split(/[\\/]/).pop() ?? '';
      const run = runById.get(runId) ?? null;
      if (run) {
        if (!TERMINAL.has(run.status)) {
          report.kept += 1; // active run — never touch
          continue;
        }
        const completedAt = run.completedAt ? new Date(run.completedAt).getTime() : null;
        candidates.push({ dir, run, completedAt });
      } else {
        // orphan: no Run row. Remove if older than grace period.
        try {
          const mtime = statSync(dir).mtimeMs;
          if (now - mtime > this.cfg.orphanGraceMs) {
            await this.remove(dir, run, report);
          } else {
            report.kept += 1;
          }
        } catch {
          report.kept += 1;
        }
      }
    }

    // Phase 2: retention expiry
    for (const c of candidates) {
      if (c.completedAt === null) continue; // terminal but no completedAt — keep
      if (now - c.completedAt > this.cfg.retentionMs) {
        await this.remove(c.dir, c.run, report);
      } else {
        report.kept += 1;
      }
    }

    // Phase 3: disk quota — evict oldest terminal workspaces first
    report.totalBytes = this.workspace.totalSize();
    if (this.cfg.quotaBytes > 0 && report.totalBytes > this.cfg.quotaBytes) {
      report.overQuota = true;
      const remaining = candidates
        .filter((c) => c.completedAt !== null && !report.removed.includes(c.dir))
        .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
      for (const c of remaining) {
        if (report.totalBytes <= this.cfg.quotaBytes) break;
        const size = this.workspace.workspaceSize(c.dir);
        await this.remove(c.dir, c.run, report);
        report.totalBytes -= size;
        report.freedBytes += size;
      }
    }

    return report;
  }

  private async remove(dir: string, run: Run | null, report: WorkspaceGCReport): Promise<void> {
    const size = this.workspace.workspaceSize(dir);
    try {
      if (run) {
        await this.workspace.removeWorkspace(run, dir);
      } else {
        // orphan: no Run to consult — plain removal
        const { rmSync } = await import('node:fs');
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      }
      report.removed.push(dir);
      report.freedBytes += size;
    } catch {
      report.failed.push(dir);
    }
  }
}

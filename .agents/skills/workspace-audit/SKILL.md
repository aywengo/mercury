---
name: workspace-audit
version: 1.0.0
description: Audit Mercury workspace disk usage against the retention window and quota before a GC pass. Report what WOULD be removed and what would be freed — change nothing.
capabilities: [audit, workspace, disk, gc, retention, report]
---

# Workspace Audit

You are auditing the Mercury host's workspace directory. This is a READ-ONLY
audit: you report what a GC pass would do and never delete anything yourself.
The operator (or the nightly GC run that follows you) decides.

## What to do

1. Read the GC configuration that applies to this host:
   - `MERCURY_WORKSPACE_RETENTION_MS` (default 7 days) and
     `MERCURY_WORKSPACE_QUOTA_BYTES` (default 10 GiB, `0` = no quota) from
     `mercury.env` or the process environment.
   - `MERCURY_WORKSPACE_BASE` if set; otherwise the default `./workspaces`
     under the data directory.
2. Enumerate the workspace directories (one per Run id). For each:
   - Does a Run row exist? An orphan directory (no Run row) is a finding.
   - Is the Run terminal? Non-terminal workspaces are in use — list them as
     "in use", never as reclaimable.
   - For terminal Runs: compute `age = now - completedAt` and compare with the
     retention window. Older than retention => "would be removed".
3. Compute total size. If a quota is configured and total exceeds it, list the
   oldest terminal workspaces that GC would evict until under quota
   ("would be evicted for quota").
4. Summarize in a table: path, run id, status, age, size, verdict
   (`keep` / `in use` / `would remove` / `orphan` / `would evict`), plus totals
   (count, bytes) per verdict and the overall free-after-GC estimate.

## What to report

- The config you read (retention window, quota) and where you read it from.
- The verdict table and totals.
- Anything surprising: workspaces whose Run row is missing, sizes that jumped,
  permission errors, symlinks (worktrees share the repo base — do not count
  the base twice), and disk headroom on the volume.

## Never do this

- Delete, move, or rename anything. `node src/cli.ts gc` is the only GC.
- Count a linked worktree's repository base as workspace bytes.
- Touch workspaces of non-terminal Runs.
- Report absolute secret values from `mercury.env` — name the variable, not
  the value.

/**
 * Tier-3 harvest, half one: decision records under `docs/decisions/` (§6.3; issue #684).
 *
 * Called from the same pre-transaction read as `harvestNotes()` in the worker's finalize path, and
 * its result is merged with the tier-1 result so one transaction carries both. The gap this closes
 * is the sharpest form of §6.3: a Run that writes and commits a record publishes it to git and to
 * nothing else — the one Run that certainly touched the record is exactly the one not asked about it.
 *
 * Everything git-shaped here goes through `runGit`, never a bare spawn: P0-4 decided the harvester
 * adds no git invocation of its own, so the host's timeout and non-interactive environment apply
 * unchanged. A git hang ends as a timed-out harvest, not a hung Run (K4).
 *
 * Only committed state is read: the diff is `baseCommit..HEAD` and content comes from
 * `git show HEAD:<path>`. An uncommitted edit is not a decision. Deleted records (`D`) are ignored —
 * a deletion is a supersession someone forgot to write, and guessing which record superseded which
 * is not the harvester's job. Copy mode has no git and no `baseCommit`; that is a skip, not an error.
 */

import { runGit } from '../workspace/workspaceManager.ts';
import { parseDecisionRecord } from './decisionRecord.ts';
import type { KnowledgeBounds } from './validation.ts';
import type { NoteContribution } from './types.ts';

export interface HarvestRecordsInput {
  workspacePath: string;
  /** The base commit the workspace branched from. Undefined in copy mode: no git, no delta, and
   *  that is a skip rather than an error (§9.4). `setWorkspace` pins it only in git-worktree mode,
   *  so its absence is the mode signal. */
  baseCommit: string | undefined;
  bounds: KnowledgeBounds;
  /** How many notes tier 1 already accepted; records share the same per-Run cap. */
  notesAccepted: number;
  repoIdentity: string;
  hostId: string;
  runId: string;
  agent?: string;
  recordedAt: string;
  now?: () => number;
}

export interface RejectedRecord {
  /** The repository-relative record path; `''` when the failure is about the whole step. */
  path: string;
  reason: string;
  detail?: string;
}

export interface HarvestRecordsResult {
  accepted: NoteContribution[];
  rejected: RejectedRecord[];
  /** Copy mode, or no base commit: no delta was attempted, which is the normal case for copy. */
  skipped: boolean;
  /** The git deadline expired (P0-4 hanging fixture); the Run still completes. */
  timedOut: boolean;
  recordsSeen: number;
}

const DECISIONS_DIR = 'docs/decisions/';

export async function harvestRecords(input: HarvestRecordsInput): Promise<HarvestRecordsResult> {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const result: HarvestRecordsResult = { accepted: [], rejected: [], skipped: false, timedOut: false, recordsSeen: 0 };

  if (!input.baseCommit) {
    // Copy mode has no git and no base commit (§9.4): skip without an error event.
    result.skipped = true;
    return result;
  }

  let nameStatus: string;
  let headSha: string;
  try {
    const diff = await runGit(
      ['diff', '--name-status', `${input.baseCommit}..HEAD`, '--', DECISIONS_DIR],
      { cwd: input.workspacePath, timeoutMs: input.bounds.harvestTimeoutMs },
    );
    nameStatus = diff.stdout;
    // Resolve HEAD once: the worker owns the workspace at finalize, so HEAD cannot move under us.
    // The self-referencing evidence entry (§6.2) needs the real sha; `HEAD` as a literal would be
    // a pointer that names nothing.
    headSha = (await runGit(['rev-parse', 'HEAD'], { cwd: input.workspacePath, timeoutMs: input.bounds.harvestTimeoutMs })).stdout.trim();
  } catch (err) {
    // runGit turns a hang into a throw naming the deadline; either way the Run completes (K4) and
    // the harvest failure is visible in the returned result and the log line.
    result.timedOut = true;
    result.rejected.push({
      path: '',
      reason: 'harvest-timeout',
      detail: `git over ${DECISIONS_DIR} failed: ${(err as Error).message.slice(0, 200)}`,
    });
    return result;
  }

  for (const line of nameStatus.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Status letters can carry a score on renames (R100); A and M are exact.
    const m = trimmed.match(/^([AM])\s+(.+)$/);
    if (!m) continue; // D and everything else is ignored by design
    const path = m[2]!.trim();
    result.recordsSeen += 1;

    if (now() - startedAt > input.bounds.harvestTimeoutMs) {
      result.timedOut = true;
      result.rejected.push({ path, reason: 'harvest-timeout' });
      continue;
    }

    const budget = input.bounds.maxNotesPerRun - input.notesAccepted - result.accepted.length;
    if (budget <= 0) {
      result.rejected.push({ path, reason: 'over-limit', detail: `per-Run cap ${input.bounds.maxNotesPerRun} reached` });
      continue;
    }

    let text: string;
    try {
      const shown = await runGit(['show', `HEAD:${path}`], { cwd: input.workspacePath, timeoutMs: input.bounds.harvestTimeoutMs });
      text = shown.stdout;
    } catch (err) {
      result.rejected.push({ path, reason: 'harvest-timeout', detail: `git show failed: ${(err as Error).message.slice(0, 160)}` });
      continue;
    }

    const parsed = parseDecisionRecord(text, {
      path,
      repoIdentity: input.repoIdentity,
      headSha,
      bounds: input.bounds,
    });
    if (!parsed.ok) {
      result.rejected.push({
        path,
        reason: parsed.reason,
        ...(parsed.detail ? { detail: parsed.detail } : {}),
      });
      continue;
    }

    result.accepted.push({
      projectId: '', // filled by the caller, which knows the configured project
      kind: parsed.draft.kind,
      scope: parsed.draft.scope,
      claim: parsed.draft.claim,
      ...(parsed.draft.detail !== undefined ? { detail: parsed.draft.detail } : {}),
      evidence: parsed.draft.evidence ?? [],
      ...(parsed.draft.contradicts ? { contradicts: parsed.draft.contradicts } : {}),
      provenance: {
        source: 'repo-record',
        hostId: input.hostId,
        runId: input.runId,
        ...(input.agent ? { agent: input.agent } : {}),
        recordedAt: input.recordedAt,
      },
    });
  }
  return result;
}


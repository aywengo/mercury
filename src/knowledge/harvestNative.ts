/**
 * Tier-3 harvest, half two: harness-native memory files (§7.3; issue #686).
 *
 * Agents edit `AGENTS.md`, `CLAUDE.md`, `SOUL.md`, `.cursor/rules/*.mdc` and `.agents/skills/` as a
 * side effect of working. Those edits are knowledge the Run produced, and until now they reached
 * nothing: the tier-1 read is `.mercury/notes.jsonl` and half one of tier 3 is `docs/decisions/`.
 * This module diffs the same committed range as half one (`baseCommit..HEAD`), limited to the §7.3
 * path list, and imports only ADDED paragraphs — never whole files, because a repository's existing
 * `AGENTS.md` is knowledge the agent already reads from the checkout and copying it into Atlas would
 * be the second copy K1 exists to prevent.
 *
 * What "added" means here: each file is split into blank-line-separated blocks at HEAD and at the
 * base commit, and a block is imported when its exact text exists at HEAD and not at base. A modified
 * paragraph has new text, so it imports — the delta is what the Run contributed. Unchanged and
 * deleted paragraphs import nothing (acceptance 2).
 *
 * Every output is `kind: 'convention'`, `source: 'distilled'` (§7.3 names no source; `distilled` is
 * the closest existing vocabulary value — recorded in §7.3), scope `repo:<hash>` or
 * `repo:<hash>#<dir>`, and a `repo-file` evidence entry at HEAD. Items land `candidate` at Atlas: an
 * edited memory file has no review step the way a merged decision record does.
 *
 * Two guards the §7.3 text demands even though earlier layers should make them unreachable:
 *
 * - Generated files never come back as knowledge. The generated `CLAUDE.md`, `AGENTS.md` and
 *   `.agents/skills/mercury-knowledge/` are in `info/exclude` (§9.4), so they cannot appear in a
 *   committed diff. The path filter below rejects them anyway: a pack that feeds itself back into
 *   Atlas would corroborate its own notes — the K3 failure in a loop.
 * - K2 applies. Harness-native files are harness-specific by nature, so heavy rejection is the
 *   expected shape, not a bug; each rejection is reported through `knowledge.rejected` like any
 *   other, and the volume is the signal for whether this tier earns its keep (§16 on tier 2).
 *
 * Everything git-shaped goes through `runGit` (P0-4), the same remaining-budget pattern as half one:
 * each call gets the time LEFT, and a git failure or deadline becomes one step-level rejection while
 * the Run still completes (K4).
 */

import { runGit } from '../workspace/workspaceManager.ts';
import { validateDraft, type KnowledgeBounds } from './validation.ts';
import { repoIdentity } from './identity.ts';
import { AGENTS_MD_FILE, CLAUDE_MD_FILE, CONTEXT_FILE, SKILL_DIR } from './materialize.ts';
import type { NoteContribution } from './types.ts';

export interface HarvestNativeInput {
  workspacePath: string;
  /** Same contract as half one: `undefined` or the `'copy'` sentinel means no git and a skip. */
  baseCommit: string | undefined;
  bounds: KnowledgeBounds;
  /** How many notes earlier halves already accepted; the per-Run cap is shared across all of them. */
  notesAccepted: number;
  repoIdentity: string;
  hostId: string;
  runId: string;
  agent?: string;
  recordedAt: string;
  now?: () => number;
}

export interface RejectedNative {
  /** The repository-relative path; `''` when the failure is about the whole step. */
  path: string;
  reason: string;
  detail?: string;
  source: 'distilled';
}

export interface HarvestNativeResult {
  accepted: NoteContribution[];
  rejected: RejectedNative[];
  skipped: boolean;
  failed: boolean;
  filesSeen: number;
}

/** The §7.3 path list, as git pathspecs. The two directories are prefixes: everything under them
 *  diffs, and the per-path filter decides file by file. */
const NATIVE_PATHS = ['AGENTS.md', 'CLAUDE.md', 'SOUL.md', '.cursor/rules/', '.agents/skills/'];

/** Paths Mercury generates and no agent should ever commit. `info/exclude` (§9.4) keeps them out
 *  of a commit; this filter is the second door. `.agents/skills/` as a whole IS a target —
 *  agent-written skills are the point — so the exclusion is the generated skill directory only,
 *  not the parent. `.mercury*` and the generated skill directory are Mercury's, always, whatever a
 *  diff says. */
const GENERATED_ALWAYS = new Set<string>([CONTEXT_FILE]);
const GENERATED_PREFIXES = ['.mercury/', `${SKILL_DIR}/`];

function isGeneratedPath(path: string): boolean {
  if (GENERATED_ALWAYS.has(path)) return true;
  return GENERATED_PREFIXES.some((p) => path.startsWith(p));
}

/** `AGENTS.md` and `CLAUDE.md` are the §9.3 injection channels: Mercury writes one per Run when the
 *  harness reads it, and `info/exclude` is what keeps that write out of a commit. But a project may
 *  legitimately TRACK an AGENTS.md of its own — exclusion is a no-op for tracked files — and edits
 *  to that file are exactly what this half exists to import (acceptance 1). The two cases differ in
 *  one observable: a project's file exists at the base commit; Mercury's is created fresh in the
 *  workspace and can only enter a diff as Added. So: Modified imports, Added is skipped as a
 *  possible generated channel. The cost is a missed import when an agent genuinely authors a brand
 *  new tracked AGENTS.md — cheap next to the failure of a pack corroborating its own notes (K3 in a
 *  loop), which is the exact case this guard exists to break. */
function isChannelFile(path: string): boolean {
  return path === AGENTS_MD_FILE || path === CLAUDE_MD_FILE;
}

/** Split a markdown file into blank-line-separated blocks, trimmed. A block that is only a markdown
 *  heading is structure, not knowledge, and imports nothing. A frontmatter block (`---` fences) is
 *  metadata for the file's own tooling — `.mdc` rules carry one — and imports nothing. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => {
      if (b.length === 0) return false;
      if (b.split('\n').every((l) => /^#{1,6}\s/.test(l.trim()))) return false;
      const first = b.split('\n')[0]!.trim();
      return first !== '---' && !first.startsWith('--- ');
    });
}

export async function harvestNative(input: HarvestNativeInput): Promise<HarvestNativeResult> {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const result: HarvestNativeResult = { accepted: [], rejected: [], skipped: false, failed: false, filesSeen: 0 };
  const remaining = () => Math.max(1, input.bounds.harvestTimeoutMs - (now() - startedAt));

  if (!input.baseCommit || input.baseCommit === 'copy') {
    // Copy mode has no git — the same skip half one takes (§9.4).
    result.skipped = true;
    return result;
  }

  const identity = repoIdentity(input.repoIdentity);
  if (!identity) {
    result.rejected.push({ path: '', reason: 'invalid-scope', source: 'distilled', detail: `repository identity does not parse: ${input.repoIdentity.slice(0, 80)}` });
    return result;
  }

  let nameStatus: string;
  let headSha: string;
  try {
    const diff = await runGit(
      ['diff', '--name-status', `${input.baseCommit}..HEAD`, '--', ...NATIVE_PATHS],
      { cwd: input.workspacePath, timeoutMs: remaining() },
    );
    nameStatus = diff.stdout;
    headSha = (await runGit(['rev-parse', 'HEAD'], { cwd: input.workspacePath, timeoutMs: remaining() })).stdout.trim();
  } catch (err) {
    result.failed = true;
    result.rejected.push({
      path: '',
      reason: 'harvest-timeout',
      source: 'distilled',
      detail: `git over harness-native paths failed: ${(err as Error).message.slice(0, 200)}`,
    });
    return result;
  }

  for (const line of nameStatus.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A/M only, like half one: D is a deletion (imports nothing), renames carry scores.
    const m = trimmed.match(/^([AM])\s+(.+)$/);
    if (!m) continue;
    const path = m[2]!.trim();
    result.filesSeen += 1;

    // The generated-file guard. Unreachable when §9.4 holds (info/exclude), which is exactly why it
    // must be asserted: if a future change breaks the exclusion, the pack starts corroborating its
    // own notes here, quietly. A skip, not a rejection — nothing is wrong with the repository.
    if (isGeneratedPath(path)) continue;
    if (m[1] === 'A' && isChannelFile(path)) continue;

    if (now() - startedAt > input.bounds.harvestTimeoutMs) {
      result.failed = true;
      result.rejected.push({ path: '', reason: 'harvest-timeout', source: 'distilled',
        detail: `deadline reached with ${result.filesSeen} file(s) scanned` });
      break;
    }

    const budget = input.bounds.maxNotesPerRun - input.notesAccepted - result.accepted.length;
    if (budget <= 0) {
      result.rejected.push({ path: '', reason: 'over-limit', source: 'distilled',
        detail: `per-Run cap ${input.bounds.maxNotesPerRun} reached; remaining files dropped` });
      break;
    }

    let headText: string;
    let baseText: string;
    try {
      headText = (await runGit(['show', `HEAD:${path}`], { cwd: input.workspacePath, timeoutMs: remaining() })).stdout;
    } catch (err) {
      // HEAD:path cannot legitimately fail here — the diff just named the path at HEAD and the
      // worker owns HEAD at finalize. A failure is a git problem or a deadline: mark the step
      // failed (K4 keeps the Run completing) and move on.
      result.failed = true;
      result.rejected.push({ path, reason: 'harvest-timeout', source: 'distilled',
        detail: `git show HEAD failed: ${(err as Error).message.slice(0, 160)}` });
      continue;
    }
    try {
      // The base side of the delta: without it a pre-existing paragraph would re-import on every
      // touching Run. A path that did not exist at base is a new file: every block is added, so a
      // missing base path reads as empty base text.
      baseText = (await runGit(['show', `${input.baseCommit}:${path}`], { cwd: input.workspacePath, timeoutMs: remaining() })).stdout;
    } catch (err) {
      const msg = (err as Error).message;
      if (/exceeded its .* deadline/.test(msg)) {
        result.failed = true;
        result.rejected.push({ path, reason: 'harvest-timeout', source: 'distilled',
          detail: msg.slice(0, 160) });
        continue;
      }
      // git names this exact case: `fatal: path 'X' does not exist in '<rev>'` (also "exists on
      // disk, but not in" for add/rm races). That is the new-file shape: empty base, import all.
      // ANY other git error is not interpretable as "new file" — treating it as one would import
      // the whole HEAD file on, say, a corrupt base sha. Mark the step failed and skip the path.
      if (!/does not exist in|exists on disk, but not in/.test(msg)) {
        result.failed = true;
        result.rejected.push({ path, reason: 'harvest-timeout', source: 'distilled',
          detail: `git show base failed: ${msg.slice(0, 160)}` });
        continue;
      }
      baseText = '';
    }

    const baseBlocks = new Set(paragraphs(baseText));
    const added = paragraphs(headText).filter((b) => !baseBlocks.has(b));

    // §7.3: `repo:<hash>`, or `repo:<hash>#<path>` when the file sits in a subdirectory. The path in
    // the scope is the file's DIRECTORY (a scope is a place, not a file that can be renamed).
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const scope = dir ? `repo:${identity.hash}#${dir}` : `repo:${identity.hash}`;

    for (const block of added) {
      if (now() - startedAt > input.bounds.harvestTimeoutMs) {
        result.failed = true;
        result.rejected.push({ path: '', reason: 'harvest-timeout', source: 'distilled',
          detail: `deadline reached while importing ${path}` });
        break;
      }
      const liveBudget = input.bounds.maxNotesPerRun - input.notesAccepted - result.accepted.length;
      if (liveBudget <= 0) {
        result.rejected.push({ path, reason: 'over-limit', source: 'distilled',
          detail: `per-Run cap ${input.bounds.maxNotesPerRun} reached; remaining paragraphs dropped` });
        break;
      }

      // validateDraft is the same gate tier 1 goes through: bounds, evidence shape and K2 last.
      // Harness-native text is harness-specific by nature — expect `k2-violation` here often (§16).
      const validated = validateDraft({
        kind: 'convention',
        scope,
        claim: block,
        evidence: [{ type: 'repo-file', repo: identity.identity, path, sha: headSha }],
      }, input.bounds);
      if (!validated.ok) {
        result.rejected.push({ path, reason: validated.reason, source: 'distilled',
          ...(validated.detail ? { detail: validated.detail } : {}) });
        continue;
      }

      result.accepted.push({
        projectId: '', // filled by the caller, which knows the configured project
        kind: validated.draft.kind,
        scope: validated.draft.scope,
        claim: validated.draft.claim,
        ...(validated.draft.detail !== undefined ? { detail: validated.draft.detail } : {}),
        evidence: validated.draft.evidence ?? [],
        ...(validated.draft.contradicts ? { contradicts: validated.draft.contradicts } : {}),
        provenance: {
          source: 'distilled',
          hostId: input.hostId,
          runId: input.runId,
          ...(input.agent ? { agent: input.agent } : {}),
          recordedAt: input.recordedAt,
        },
      });
    }
  }
  return result;
}

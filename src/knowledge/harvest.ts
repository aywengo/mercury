/**
 * Tier-1 harvest: read what the agent wrote, before the workspace is gone (docs/knowledge-base.md 7.1, 7.5).
 *
 * This is the only place knowledge enters the system from an agent, so its dominant concern is that a
 * hostile or merely confused agent cannot put something into a store that is replicated to every host and
 * retained far longer than the workspace it came from. Everything the agent wrote is treated as untrusted
 * input: validated against the closed vocabularies, bounded, K2-checked, and refused outright if it
 * carries a secret.
 *
 * Refused, not truncated and not redacted-with-stars. A truncated claim is a different claim, and a
 * stored secret with the middle removed is still a stored secret.
 */

import { readFileSync } from 'node:fs';
import type { Redactor } from '../domain/redact.ts';
import { NOTES_JSONL } from './materialize.ts';
import { validateDraft, type RejectReason } from './validation.ts';
import type { KnowledgeBounds } from './validation.ts';
import type { NoteContribution, NoteProvenance } from './types.ts';

export interface HarvestInput {
  workspacePath: string;
  bounds: KnowledgeBounds;
  redactor: Redactor;
  provenance: Omit<NoteProvenance, 'source' | 'recordedAt'>;
  recordedAt: string;
  now?: () => number;
}

export interface RejectedLine {
  /** 1-based line number in the file, so an operator can point at it. */
  line: number;
  reason: RejectReason;
  detail?: string;
}

export interface HarvestResult {
  accepted: NoteContribution[];
  rejected: RejectedLine[];
  /** True when the file was absent, which is the common case and not a failure. */
  absent: boolean;
  /** Lines dropped purely because the per-Run cap was reached. */
  overLimit: number;
  /** True when the wall-clock bound expired and the remainder was dropped. */
  timedOut: boolean;
  linesSeen: number;
}

/**
 * Read and validate `.mercury/notes.jsonl`.
 *
 * Never throws. A harvest runs inside the transaction that finalizes a Run, so an exception here would
 * turn "the agent wrote a file we cannot parse" into "the Run failed", which is the wrong blast radius by
 * a wide margin. Every problem is a rejected line with a reason instead.
 */
export function harvestNotes(input: HarvestInput): HarvestResult {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const result: HarvestResult = { accepted: [], rejected: [], absent: false, overLimit: 0, timedOut: false, linesSeen: 0 };

  let raw: string;
  try {
    raw = readFileSync(`${input.workspacePath}/${NOTES_JSONL}`, 'utf8');
  } catch {
    // Absent is normal: most Runs learn nothing durable, and a Run that wrote nothing must not look
    // like a Run that broke something.
    result.absent = true;
    return result;
  }

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]!.trim();
    if (!text) continue;
    result.linesSeen += 1;
    const lineNo = i + 1;

    if (result.linesSeen > input.bounds.maxNotesPerRun) {
      // One rejection for the whole remainder rather than one per line: the cap is a single event, and
      // 500 identical events would bury the 50 real ones.
      result.overLimit += 1;
      continue;
    }
    if (now() - startedAt > input.bounds.harvestTimeoutMs) {
      // Keep what was already parsed. Dropping good notes because later ones arrived too slowly would
      // punish the Run for an agent that kept writing.
      result.timedOut = true;
      result.overLimit += 1;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      result.rejected.push({ line: lineNo, reason: 'malformed-json' });
      continue;
    }

    const validated = validateDraft(parsed, input.bounds);
    if (!validated.ok) {
      result.rejected.push({ line: lineNo, reason: validated.reason, ...(validated.detail ? { detail: validated.detail } : {}) });
      continue;
    }

    // Redaction is a GATE here, not a scrub. If redacting changed anything, a declared secret was in
    // the note, and the note is refused rather than stored with stars where the token used to be.
    const redactedClaim = input.redactor.redact(validated.draft.claim);
    const redactedDetail = validated.draft.detail !== undefined ? input.redactor.redact(validated.draft.detail) : undefined;
    if (redactedClaim !== validated.draft.claim || (redactedDetail !== undefined && redactedDetail !== validated.draft.detail)) {
      result.rejected.push({ line: lineNo, reason: 'secret-detected' });
      continue;
    }

    result.accepted.push({
      projectId: '', // filled by the caller, which knows the configured project
      kind: validated.draft.kind,
      scope: validated.draft.scope,
      claim: redactedClaim,
      ...(redactedDetail !== undefined ? { detail: redactedDetail } : {}),
      evidence: validated.draft.evidence ?? [],
      ...(validated.draft.contradicts ? { contradicts: validated.draft.contradicts } : {}),
      provenance: {
        source: 'agent-reported',
        hostId: input.provenance.hostId,
        runId: input.provenance.runId,
        agent: input.provenance.agent,
        ...(input.provenance.harnessVersion !== undefined ? { harnessVersion: input.provenance.harnessVersion } : {}),
        recordedAt: input.recordedAt,
      },
    });
  }

  if (result.overLimit > 0) {
    result.rejected.push({ line: 0, reason: result.timedOut ? 'harvest-timeout' : 'over-limit', detail: String(result.overLimit) });
  }
  return result;
}

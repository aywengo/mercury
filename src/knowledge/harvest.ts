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

import { readFileSync, statSync } from 'node:fs';
import type { Redactor } from '../domain/redact.ts';
import { NOTES_JSONL } from './materialize.ts';
import { validateDraft, type RejectReason } from './validation.ts';
import type { KnowledgeBounds } from './validation.ts';
import type { NoteContribution, NoteProvenance } from './types.ts';

/**
 * The largest file that could possibly contain a valid set of notes.
 *
 * Derived from the bounds rather than chosen, because the bounds already say what a legal note is:
 * at most `maxNotesPerRun` of them, each carrying at most `maxClaimBytes` of claim, `maxDetailBytes`
 * of detail and `maxEvidence` evidence refs. Anything bigger than the sum of those cannot contain a
 * single note that would survive validation, so reading it would be work performed purely to produce
 * rejections.
 *
 * The reason to enforce it before reading is that the harvest runs on the worker, and the worker is
 * one loop serving every Run on the host. `readFileSync` of a large file is synchronous and holds the
 * event loop for the whole read, and the wall-clock bound below cannot fire during it because the
 * bound is checked between lines. A workspace quota limits the disk; it does not limit how long the
 * worker is blocked, and those are different failures.
 */
export function maxHarvestBytes(bounds: KnowledgeBounds): number {
  const perNote = bounds.maxClaimBytes + bounds.maxDetailBytes
    + bounds.maxEvidence * MAX_EVIDENCE_BYTES + NOTE_JSON_OVERHEAD_BYTES;
  return bounds.maxNotesPerRun * perNote;
}

/** Generous per-ref and per-note JSON allowance: keys, quoting, and the evidence array. */
const MAX_EVIDENCE_BYTES = 512;
const NOTE_JSON_OVERHEAD_BYTES = 1024;

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
 * Never throws. An exception here would turn "the agent wrote a file we cannot parse" into "the Run
 * failed", which is the wrong blast radius by a wide margin. Every problem is a rejected line with a reason
 * instead.
 *
 * The caller reads this BEFORE the finalize transaction and commits the RESULT inside it
 * (`src/worker/worker.ts`). That ordering is not incidental and this comment used to describe the opposite,
 * claiming the harvest ran inside the transaction. It must not: the read does file I/O under a wall-clock
 * bound, and doing that while holding `BEGIN IMMEDIATE` would pin the host's single write lock for up to
 * `harvestTimeoutMs`. Section 8.1 asks that a Run never be complete with its notes still in memory, and the
 * insert of the result inside the transaction is what satisfies that -- not the read.
 */
export function harvestNotes(input: HarvestInput): HarvestResult {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const result: HarvestResult = { accepted: [], rejected: [], absent: false, overLimit: 0, timedOut: false, linesSeen: 0 };

  let raw: string;
  try {
    const path = `${input.workspacePath}/${NOTES_JSONL}`;
    const ceiling = maxHarvestBytes(input.bounds);
    const size = statSync(path).size;
    if (size > ceiling) {
      // Refuse the whole file without reading it. Every line in it is unvalidatable by construction,
      // and the alternative is allocating the file in memory on the worker's event loop to discover
      // that fact one rejection at a time.
      result.rejected.push({
        line: 0,
        reason: 'over-limit',
        detail: `file is ${size} bytes, above the ${ceiling} byte ceiling implied by the bounds`,
      });
      return result;
    }
    raw = readFileSync(path, 'utf8');
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

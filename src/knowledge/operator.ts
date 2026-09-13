/**
 * Operator-authored notes (docs/knowledge-base.md sections 11.1 and 16 phase 1).
 *
 * An operator note is the one contribution that does not come from a Run. It exists because a project's
 * conventions are usually already known by a person, and making that person wait for three Runs to
 * independently rediscover them wastes the one knowledge source that is already certain. Atlas lands
 * these `promoted` rather than `candidate`: a human writing it down IS the review that section 12 would
 * otherwise be waiting for.
 *
 * Two things about the path are deliberate.
 *
 * It goes through the OUTBOX rather than POSTing to Atlas directly. An operator who writes down a
 * convention while they are certain of it should not lose it because the knowledge service is
 * restarting, and a synchronous call would turn "Atlas is down" into "your note was rejected", which is
 * a lie about what happened. The outbox is durable, the pusher drains it, and `mercury knowledge flush`
 * forces a pass for the operator who wants to see it land now.
 *
 * It refuses when this host has no Atlas configured, rather than queueing into a void. A note that can
 * never leave this host is not queued, it is discarded with extra steps, and the failure would be
 * invisible: the route would answer 200 and the note would sit in a table forever. That is the
 * documented-setting-nobody-reads failure that #505 is the precedent for.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeConfig } from '../config.ts';
import { OutboxStore } from './outbox.ts';
import { claimHash, validateDraft, type RejectReason } from './validation.ts';
import type { NoteContribution, NoteDraft } from './types.ts';

export type OperatorNoteOutcome =
  | { ok: true; claimHash: string; queued: boolean }
  | { ok: false; status: 400 | 409; error: string; reason?: RejectReason };

/**
 * Validate one operator note and queue it.
 *
 * Returns a status code rather than throwing, because the caller is a route and the two refusal kinds
 * are genuinely different: 400 is "what you sent is not a note", 409 is "this host cannot accept notes
 * right now". Collapsing them would make a misconfigured host look like a mistyped request.
 */
export function submitOperatorNote(
  db: DatabaseSync,
  config: KnowledgeConfig,
  body: unknown,
  recordedAt: string = new Date().toISOString(),
): OperatorNoteOutcome {
  if (!config.atlas) {
    return {
      ok: false,
      status: 409,
      error: 'this host has no Atlas configured, so a note here could never be delivered. '
        + 'Set MERCURY_ATLAS_URL and MERCURY_ATLAS_PROJECT, or record the note in the repository instead.',
    };
  }
  if (!config.atlas.adminToken) {
    // Refused here rather than queued. A row the pusher can never deliver is not durable, it is
    // deferred indefinitely, and the route would have answered 202 to a note that was in fact lost.
    return {
      ok: false,
      status: 409,
      error: 'operator notes need MERCURY_ATLAS_ADMIN_TOKEN: Atlas accepts a note that lands promoted '
        + 'only from an admin token, and this host only holds a contributor token. Without it the note '
        + 'could be queued but never delivered.',
    };
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const draft: NoteDraft = {
    kind: source.kind as NoteDraft['kind'],
    scope: source.scope as string,
    claim: source.claim as string,
    ...(typeof source.detail === 'string' ? { detail: source.detail } : {}),
    ...(Array.isArray(source.evidence) ? { evidence: source.evidence as NoteDraft['evidence'] } : {}),
    ...(Array.isArray(source.contradicts) ? { contradicts: source.contradicts as string[] } : {}),
  };

  // The same bounds and the same closed vocabularies as any other note. An operator route that skipped
  // validation would be a way to write an unbounded claim into a store that every Run reads, and the
  // bounds exist to bound what a Run pays for a pack.
  const validated = validateDraft(draft, config.bounds);
  if (!validated.ok) {
    return { ok: false, status: 400, error: `note refused: ${validated.reason}`, reason: validated.reason };
  }

  const contribution: NoteContribution = {
    projectId: config.atlas.project,
    kind: draft.kind,
    scope: draft.scope,
    claim: draft.claim,
    ...(draft.detail !== undefined ? { detail: draft.detail } : {}),
    evidence: draft.evidence ?? [],
    ...(draft.contradicts ? { contradicts: draft.contradicts } : {}),
    provenance: {
      source: 'operator',
      hostId: config.atlas.hostId,
      // No runId and no harnessVersion: this is not a Run's observation, and inventing either would be
      // the invented provenance that K3 forbids.
      recordedAt,
    },
  };

  const inserted = new OutboxStore(db).insert([{ runId: null, contribution }]);
  // `queued: false` means an identical note was already waiting. It is still a success: the operator's
  // intent is that the project hold this claim, and it does.
  return { ok: true, claimHash: claimHash(draft.kind, draft.scope, draft.claim), queued: inserted > 0 };
}

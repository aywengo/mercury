/**
 * Validation of the `knowledge` block on `POST /api/runs` (docs/knowledge-base.md 9.1, 7.4).
 *
 * Fail-closed on purpose, and asymmetrically so. An omitted block means "use the host default" and never
 * fails. A malformed block is refused, because a caller who tried to control the pack and got it
 * silently ignored would believe their constraint was in force.
 *
 * `require` is the sharpest field. Ingest fails OPEN -- an unknown harness version must never brick a
 * Run -- while an explicit requirement fails CLOSED, because silently running without the pack is the
 * degradation the design forbids. Those two defaults look inconsistent and are not: one is a default
 * nobody asked for, the other is an instruction that went unheeded.
 */

import type { KnowledgeRequest } from './types.ts';

export class KnowledgeRequestError extends Error {}

const SCOPE_SHAPE = /^(project|agent:[a-z0-9][a-z0-9._-]{0,63}|repo:[0-9a-f]{16}(#[^\s#]{1,512})?)$/;

export function parseKnowledgeRequest(raw: unknown): KnowledgeRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new KnowledgeRequestError('knowledge must be an object');
  }
  const body = raw as Record<string, unknown>;
  const out: KnowledgeRequest = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new KnowledgeRequestError('knowledge.enabled must be a boolean');
    out.enabled = body.enabled;
  }
  if (body.require !== undefined) {
    if (typeof body.require !== 'boolean') throw new KnowledgeRequestError('knowledge.require must be a boolean');
    out.require = body.require;
  }
  if (body.maxBytes !== undefined) {
    if (typeof body.maxBytes !== 'number' || !Number.isInteger(body.maxBytes) || body.maxBytes < 0) {
      throw new KnowledgeRequestError('knowledge.maxBytes must be a non-negative integer');
    }
    out.maxBytes = body.maxBytes;
  }
  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes) || body.scopes.some((s) => typeof s !== 'string')) {
      throw new KnowledgeRequestError('knowledge.scopes must be an array of scope strings');
    }
    // Checked against the same grammar parseScope accepts, so a typo is refused here rather than
    // quietly matching nothing. A filter that silently matches no note is indistinguishable from a
    // Run that legitimately has no knowledge, which is the worst possible failure for a filter.
    for (const scope of body.scopes as string[]) {
      if (!SCOPE_SHAPE.test(scope)) {
        throw new KnowledgeRequestError(
          `knowledge.scopes contains an invalid scope: ${JSON.stringify(scope)} `
          + '(expected "project", "agent:<id>", "repo:<16-hex>" or "repo:<16-hex>#<path>")',
        );
      }
    }
    out.scopes = [...new Set(body.scopes as string[])];
  }
  return out;
}

/** Why a Run that asked for knowledge cannot get it, phrased so the caller can act on it. */
export function knowledgeCapabilityMessage(agent: string, reason: string): string {
  return `agent "${agent}" cannot receive a knowledge pack (${reason}); drop knowledge.require or choose another agent`;
}

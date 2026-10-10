/**
 * L1-2 (#855, docs/laya-l1-issues.md): the candidate hard filter, pure.
 *
 * Laya only ranks inside the admissible set (laya-integration-design.md §6.2). This module
 * computes that set from the task's declared candidates and the `GET /api/agents` response,
 * before the question is built (L1-3) and before any dispatch (L1-4). It is deliberately
 * pure: no client, no fetch, no clock.
 *
 * Preset constraints (`required`/`modelRequired`) are NOT checked here. The template's
 * preset is applied server-side, and the server refuses a conflict with 400; duplicating
 * `resolvePreset` here would drift (#855). Instead, L1-4 treats a 400 on a *selected* pair
 * as a fallback. The server re-validates on POST /api/runs regardless — this filter exists
 * to avoid offering Laya an option the server would refuse, not to replace its check.
 */

import { validateModelShape } from '../../domain/modelShape.ts';
import type { AgentCapabilitySummary } from '../../domain/types.ts';

/** One operator-declared `{agent, model?, describe}` candidate (§4.2 select.candidates[]). */
export interface SelectCandidate {
  agent: string;
  model?: string;
  describe: string;
}

/** The `GET /api/agents` response body (routes.ts): ids plus the parallel capabilities field. */
export interface AgentsResponse {
  agents: string[];
  defaultAgent: string;
  capabilities: Record<string, AgentCapabilitySummary>;
}

export interface DroppedCandidate {
  /** Index into the ORIGINAL candidates array; order of `admitted` is preserved. */
  index: number;
  reason: string;
}

export interface FilterResult {
  /** Candidates that passed, in the original order (§6.3: option keys `A…` stay stable). */
  admitted: SelectCandidate[];
  dropped: DroppedCandidate[];
}

/**
 * Drop candidates the server would refuse: an agent absent from `GET /api/agents`, a model on
 * an agent whose static capabilities lack `perRunModel: true`, or a model that fails
 * `validateModelShape` (imported, never copied, so the bot and the server cannot drift).
 * Everything else is admitted, in the original order.
 */
export function filterCandidates(candidates: SelectCandidate[], agentsResponse: AgentsResponse): FilterResult {
  const known = new Set(agentsResponse.agents);
  const admitted: SelectCandidate[] = [];
  const dropped: DroppedCandidate[] = [];
  candidates.forEach((cand, index) => {
    if (!known.has(cand.agent)) {
      dropped.push({ index, reason: `agent '${cand.agent}' is not registered on this host` });
      return;
    }
    if (cand.model !== undefined) {
      const caps = agentsResponse.capabilities[cand.agent];
      if (caps?.static?.perRunModel !== true) {
        dropped.push({ index, reason: `agent '${cand.agent}' does not accept a per-Run model` });
        return;
      }
      try {
        validateModelShape(cand.model, `select.candidates[${index}].model`);
      } catch (err) {
        dropped.push({ index, reason: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    admitted.push(cand);
  });
  return { admitted, dropped };
}

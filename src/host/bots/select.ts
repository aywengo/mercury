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
import type { LayaFailureReason, LayaOption, LayaResult } from '../../laya/types.ts';

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

// -- L1-3 (#856): the question and the decision rule (pure) --
//
// §6.3 builds ONE `choice` question over the admitted PAIRS (harness x model are not independent:
// two independent argmaxes can produce a pair that was never offered). Option keys are opaque
// (`A`, `B`, ...) with the operator's `describe` as the option text -- upstream reports checkpoints
// following semantic or boolean-like keys instead of descriptions, and semantic keys do not protect
// against negation errors. The state allowlist (task text, template name, repository basename,
// declared skills) is built and redacted by the CLIENT (buildLayaState); this function never
// redacts and never sends.
//
// §6.4 is implemented by `decide` exactly as written: no call below 2 candidates; a client failure
// is `sidecar_unavailable` (transport could not produce a usable body) or `invalid_response`
// (the body came back but was not usable); the gate is the CALIBRATED `answerConfidence`
// (`answer_confidence`, the quantity min_confidence is defined against) -- never upstream's
// entropy-based `confidence`; shadow mode never changes what runs. Every outcome returns the
// #854 selection record so L1-4 can attach it to the dispatch verbatim.

/** Everything the question needs from the dispatch (§6.3 state allowlist, §6.7). */
export interface SelectCtx {
  /** The (raw) task text. Redaction is the client's job, never this function's. */
  task: string;
  /** The task's template name. */
  template: string;
  /** Repository URL or path; only the basename reaches the sidecar (client-side). */
  repository: string;
  /** Declared skills. */
  skills: string[];
}

/** The task's `select` block (src/host/bots/config.ts validates the shape). */
export interface SelectConfig {
  mode: 'shadow' | 'enforce';
  /** Required for enforce; in shadow the threshold still gates the RECORDED laya pick? No -- §6.4
   *  records the shadow pick with its confidence; only enforce changes what runs. Optional. */
  minConfidence?: number;
}

/** The template's literal fallback (§6.4: `fallback` is the template's agent/model). */
export interface TemplateDefault {
  agent: string;
  model?: string;
}

/** One `choice` question over the admitted pairs (§6.3). Options carry opaque keys only. */
export interface SelectQuestion {
  options: LayaOption[];
  /** The state the caller passes to the client, BEFORE redaction -- the client redacts. */
  ctx: SelectCtx;
}

/** The `decide` outcome: what to run, plus the #854 record (already shaped for validateSelection). */
export interface DecideOutcome {
  chosen: TemplateDefault;
  /**
   * The #854 selection record. `reason` uses the #854 closed enum: `single_candidate`,
   * `sidecar_unavailable`, `invalid_response`, `below_threshold`, `shadow`, `selected`
   * (a `no_candidates` dispatch fails before any record exists).
   */
  record: Record<string, unknown>;
}

/** The injected client surface `decide` needs: exactly one ask, exactly the LayaResult union. */
export interface DecideClient {
  ask(question: { options: LayaOption[] }, state: SelectCtx): Promise<LayaResult>;
}

/** Opaque option keys: `A`, `B`, ..., up to the 12-candidate cap (§6.3). */
export function optionKey(index: number): string {
  return String.fromCharCode(65 + index);
}

/**
 * Build the §6.3 question from the ADMITTED candidates (run filterCandidates first): one choice
 * over pairs, opaque keys, `describe` as option text, and the state allowlist carried to the
 * client which redacts and sends. Pure; never throws on inputs the filter already admitted.
 */
export function buildSelectQuestion(admitted: SelectCandidate[], ctx: SelectCtx): SelectQuestion {
  return {
    options: admitted.map((cand, i) => ({ key: optionKey(i), describe: cand.describe })),
    ctx,
  };
}

/** Client failure reasons that mean "the sidecar produced no usable answer" as a class. */
const TRANSPORT_FAILURES = new Set<LayaFailureReason>(['unreachable', 'timeout', 'http_status', 'over_cap']);

/**
 * The §6.4 decision rule. `admitted` is the filter's output; `client` is injected (the real
 * LayaClient satisfies DecideClient); `templateDefault` is the fallback that runs unless Laya
 * picks above threshold in enforce mode.
 *
 * - 0 admitted: throws — the dispatch fails exactly as a literal template with no admissible
 *   candidate would (§6.4 "No call"); no record exists because nothing was decided.
 * - 1 admitted: no call, `reason: single_candidate`.
 * - >=2 admitted: one ask. A failed call is `sidecar_unavailable` (transport) or
 *   `invalid_response` (body); a calibrated `answerConfidence` below `minConfidence` is
 *   `below_threshold`; shadow records Laya's pick under `laya` and keeps the template default.
 */
export async function decide(
  admitted: SelectCandidate[],
  client: DecideClient,
  cfg: SelectConfig,
  templateDefault: TemplateDefault,
  ctx: SelectCtx,
): Promise<DecideOutcome> {
  if (admitted.length === 0) {
    throw new Error('select: no admissible candidates — dispatch fails as a literal template would (§6.4)');
  }
  const base: Record<string, unknown> = {
    via: 'laya',
    mode: cfg.mode,
    chosen: { agent: templateDefault.agent, ...(templateDefault.model !== undefined ? { model: templateDefault.model } : {}) },
    candidatesOffered: admitted.length,
    candidatesFiltered: 0,
  };
  if (admitted.length === 1) {
    // No call (§6.4). Two corrections against the first L1-3 draft (#866 review):
    // - SHADOW never changes what runs, so the template default stays `chosen` even when the
    //   only admissible pair differs from it; only `enforce` runs the single candidate. (The
    //   draft said "that candidate is chosen", which contradicted the shadow property.)
    // - Laya was not asked, so the record carries NO `laya` (#854 no-pick rule): a pick that
    //   never happened must not be recorded as one.
    const only = { agent: admitted[0]!.agent, ...(admitted[0]!.model !== undefined ? { model: admitted[0]!.model } : {}) };
    const chosen = cfg.mode === 'shadow' ? (base.chosen as TemplateDefault) : only;
    return {
      chosen,
      record: { ...base, chosen, reason: 'single_candidate' },
    };
  }

  const question = buildSelectQuestion(admitted, ctx);
  const result = await client.ask({ options: question.options }, ctx);
  const latencyMs = Math.round(Math.max(0, result.latencyMs));
  if (!result.ok) {
    const reason = TRANSPORT_FAILURES.has(result.reason) ? 'sidecar_unavailable' : 'invalid_response';
    return {
      chosen: templateDefault,
      // `detail` is deliberately NOT recorded: the #854 schema has no free-text field, and
      // wedging the error string into `checkpoint` would corrupt a typed field.
      record: { ...base, reason },
    };
  }
  const answer = result.answers[0]!;
  const layaPick = admitted.find((_, i) => optionKey(i) === answer.key)!;
  const layaActor = { agent: layaPick.agent, ...(layaPick.model !== undefined ? { model: layaPick.model } : {}) };
  const distribution: Record<string, number> = {};
  for (const a of result.answers) distribution[a.key] = a.probability;
  const recordCommon: Record<string, unknown> = {
    ...base,
    laya: layaActor,
    answerConfidence: answer.probability,
    distribution,
    checkpoint: result.checkpoint,
    latencyMs,
  };
  // §6.4 gate: the CALIBRATED answerConfidence, not upstream's entropy confidence.
  if (cfg.minConfidence !== undefined && answer.probability < cfg.minConfidence) {
    return {
      chosen: templateDefault,
      record: { ...recordCommon, reason: 'below_threshold' },
    };
  }
  if (cfg.mode === 'shadow') {
    return {
      chosen: templateDefault,
      record: { ...recordCommon, reason: 'shadow' },
    };
  }
  return {
    chosen: layaActor,
    record: {
      ...base,
      laya: layaActor,
      chosen: layaActor,
      answerConfidence: answer.probability,
      distribution,
      checkpoint: result.checkpoint,
      latencyMs,
      reason: 'selected',
    },
  };
}

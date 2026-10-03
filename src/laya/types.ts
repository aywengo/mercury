/**
 * Wire types for the Laya sidecar contract (docs/laya-integration-design.md §5.2, §6.3).
 *
 * The sidecar exposes upstream's Jev-compatible `POST /v1/systemone` route. Mercury never imports
 * Python and never loads weights; this module is the host's whole integration surface (dispatcher
 * selection, L1). It lives in `src/laya/`, not under `host/` (issue #825 open decision): it is
 * generic client code, not installer logic. Fleet reuse (L2) would need the coupling contract
 * revised deliberately — `fleet/` never imports `src/` today, so Fleet gets its own client then.
 *
 * Fail-closed vocabulary: every invalid response carries a stable `reason` the caller can record
 * (`docs/…` §6.4 decision rule). The client returns a discriminated union, so a Laya failure is a
 * value, never an exception past the caller.
 */

/** One offered option: opaque key + the operator's description (§6.3). Becomes one `criteria`
 *  entry on the wire. */
export interface LayaOption {
  key: string;
  describe: string;
}

/** The state block. Built from an ALLOWLIST (§6.3): redacted task text, template name,
 *  repository basename, declared skills. Nothing else — no other Runs, no events. */
export interface LayaState {
  task: string;
  template: string;
  repository: string;
  skills: string[];
}

/** The raw request body, in the `laya-serve` (0.3.25) wire shape: `state` is the task text,
 *  `questions` carries the ONE choice question keyed by id, its options under `criteria`
 *  ({key: describe}). `instructions` names what the decision is about; `task` names the
 *  checkpoint task head Mercury uses. */
export interface LayaRequest {
  state: string;
  task?: string;
  questions: Record<string, {
    type: 'choice';
    instructions: string;
    criteria: Record<string, string>;
  }>;
}

/** One answer row, in MERCURY's projected form: the option key it names, the choice text echoed by
 *  the sidecar, and the calibrated probability of that answer (upstream `answer_confidence`,
 *  §6.4 — `max(p)`, the quantity the min_confidence gate is defined against). */
export interface LayaAnswer {
  key: string;
  choice: string;
  probability: number;
}

/** The RAW response body from `laya-serve` (0.3.25): `answers` keyed by question id, each answer
 *  an object with `type: 'choice'`, `choice`, `probabilities`, `confidence` (normalized-entropy
 *  score) and the calibrated `answer_confidence`; the checkpoint id at root `model` and the
 *  routing report under `routing`. Only `answers[qid]` rows are validated; the rest is ignored. */
export interface LayaRawResponse {
  model?: unknown;
  routing?: unknown;
  answers?: Record<string, unknown>;
}

/** A validated response, projected onto Mercury's shape: answers plus the checkpoint id that
 *  produced them (recorded in the `selection` attribution row, §6.5). */
export interface LayaResponse {
  answers: LayaAnswer[];
  checkpoint: string;
}

/** Every documented invalid outcome (§5.2, §11). `unreachable` covers connection and deadline
 *  failures; the others are responses the sidecar returned but Mercury must not use. */
export type LayaFailureReason =
  | 'unreachable'
  | 'timeout'
  | 'http_status'
  | 'over_cap'
  | 'malformed'
  | 'unknown_answer_key'
  | 'choice_not_offered'
  | 'non_finite_probability'
  | 'empty_answers'
  | 'redaction_failed';

/** The discriminated union every caller consumes: Laya failures are values (§5.2). */
export type LayaResult =
  | { ok: true; answers: LayaAnswer[]; checkpoint: string; latencyMs: number }
  | { ok: false; reason: LayaFailureReason; detail?: string; latencyMs: number };

/** Guard for the success arm. */
export function isLayaOk(result: LayaResult): result is Extract<LayaResult, { ok: true }> {
  return result.ok;
}

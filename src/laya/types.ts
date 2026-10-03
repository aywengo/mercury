/**
 * Wire types for the Laya sidecar contract (docs/laya-integration-design.md §5.2, §6.3).
 *
 * The sidecar exposes upstream's Jev-compatible `POST /v1/systemone` route. Mercury never imports
 * Python and never loads weights; this module is the whole integration surface, shared by the host
 * (dispatcher selection, L1) and Fleet (task-affinity classification, L2) — hence `src/laya/`, not
 * under `host/` (issue #825 open decision, resolved: Fleet imports it too).
 *
 * Fail-closed vocabulary: every invalid response carries a stable `reason` the caller can record
 * (`docs/…` §6.4 decision rule). The client returns a discriminated union, so a Laya failure is a
 * value, never an exception past the caller.
 */

/** One offered option: opaque key + the operator's description (§6.3). */
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

/** The request body: one `choice` question over the offered options plus the state block. */
export interface LayaRequest {
  question: {
    options: LayaOption[];
  };
  state: LayaState;
}

/** One answer row: which option was picked (by key), the reported choice text, and the calibrated
 *  probability of that answer (`answer_confidence`, §6.4). */
export interface LayaAnswer {
  key: string;
  choice: string;
  probability: number;
}

/** A valid response body (before the client's own validation): answers plus the checkpoint id
 *  that produced them (recorded in the `selection` attribution row, §6.5). */
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

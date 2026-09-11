/**
 * Goal-capability resolution (docs/goals.md section 13).
 *
 * Pure functions over the static support matrix and a detected version. No I/O, so the
 * fail-closed rules are testable without spawning anything.
 */

import type { AgentGoalCapability, AgentGoalSupport, AgentVersionInfo } from './types.ts';

/**
 * Compare dotted numeric versions component-wise.
 *
 * Component-wise, not lexical: `0.20.5` is NEWER than `0.3.3`, and a string compare
 * gets that backwards. Every harness version measured so far is dotted-decimal, but
 * each adapter owns its own extraction (see 13.3) -- this function only ever sees the
 * numeric core.
 *
 * Returns negative when a < b, 0 when equal, positive when a > b.
 *
 * Prerelease and build suffixes are NOT modelled: `1.0.0-rc1` and `1.0.0` compare equal
 * because both reduce to [1,0,0]. That is deliberate rather than an oversight -- no
 * threshold in the matrix is a prerelease, and inventing semver precedence rules nobody
 * has asked for would be a larger surface to get wrong than the gap it closes. If a
 * threshold ever lands on a prerelease, this is the place that changes.
 */
export function compareVersions(a: string, b: string): number {
  const pa = numericCore(a);
  const pb = numericCore(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Leading run of dot-separated integers, e.g. "v0.20.5 (2026.8.19)" -> [0,20,5]. */
export function numericCore(raw: string): number[] {
  const m = raw.match(/\d+(?:\.\d+)*/);
  if (!m) return [];
  return m[0].split('.').map((n) => Number.parseInt(n, 10));
}

/** The individual things Mercury may want to do with a goal. */
export type GoalCapabilityField =
  | 'set' | 'track' | 'tokenBudget' | 'contract' | 'gates' | 'maxTurns';

/** Every field, in matrix order. One list so the registry and any future surface agree. */
export const GOAL_CAPABILITY_FIELDS: readonly GoalCapabilityField[] = [
  'set', 'track', 'tokenBudget', 'contract', 'gates', 'maxTurns',
];

/**
 * Decide whether Mercury can do `field` with a goal on this agent right now.
 *
 * `field` defaults to `set`, which is the question "can this agent carry a goal at all".
 * The other fields answer a different and equally load-bearing question: whether a
 * particular PART of the goal spec means anything to this backend. See
 * resolveGoalFieldCapability.
 *
 * The ordering is the whole point and each branch is load-bearing:
 *
 * 1. No declared support -> `unsupported`. This is a statement about the backend, and
 *    it does not depend on the version, so a failed probe must not soften it.
 * 2. Support declared but version unknown -> `version-unknown`. Fail closed. Unknown is
 *    not assume-yes (that is #459) and not assume-newest either, since newest is exactly
 *    what a stale mirror or a spoofed binary would claim.
 * 3. Version below the threshold -> `version-too-old`.
 *
 * Note what is NOT here: nothing in this module can make an agent run or not run.
 * Capability failure degrades the goal feature only (13.5). Refusing to execute an agent
 * because its version string changed would brick every harness upgrade until the parser
 * caught up, which is a far worse failure than a goal nobody can set.
 */
export function resolveGoalCapability(
  support: AgentGoalSupport | undefined,
  info: AgentVersionInfo | null,
  field: GoalCapabilityField = 'set',
): AgentGoalCapability {
  const required = support?.[field];
  if (!required) {
    return { supported: false, reason: 'unsupported', detectedVersion: info?.version ?? null, detectedRaw: info?.raw ?? null };
  }
  const detected = info?.version ?? null;
  if (!detected) {
    return {
      supported: false,
      reason: 'version-unknown',
      requiredVersion: required,
      detectedVersion: null,
      detectedRaw: info?.raw ?? null,
    };
  }
  if (compareVersions(detected, required) < 0) {
    return {
      supported: false,
      reason: 'version-too-old',
      requiredVersion: required,
      detectedVersion: detected,
      detectedRaw: info?.raw ?? null,
    };
  }
  return { supported: true, detectedVersion: detected, detectedRaw: info?.raw ?? null };
}

/**
 * Decide whether one specific goal field means anything to this backend.
 *
 * This exists because `set` answering yes does NOT imply the rest do. PrimeAgent carries an
 * objective and reports its status, and has no concept of a deterministic gate or a
 * verification contract at all (docs/goals.md 13.2). Before this function, admission asked
 * only about `set`, so `goal.gates` was accepted, persisted, and rendered on a Run whose
 * harness will never evaluate it -- which is the issue #459 failure mode (advertise a
 * capability nobody honours) reproduced inside the feature built to prevent it.
 *
 * Persisting a field is worse than dropping it here: dropping is invisible, persisting and
 * rendering it shows an operator a list of gates that nothing will ever run, and the Run
 * still reaches COMPLETED. The honest answer is a 400 naming the field.
 */
export function resolveGoalFieldCapability(
  support: AgentGoalSupport | undefined,
  info: AgentVersionInfo | null,
  field: GoalCapabilityField,
): AgentGoalCapability {
  return resolveGoalCapability(support, info, field);
}

/**
 * Human-facing reason string. Names the threshold and the detected version, because
 * "unsupported" without either is not actionable -- the operator cannot tell whether to
 * upgrade the harness, fix the probe, or drop the goal.
 */
export function goalCapabilityMessage(agent: string, cap: AgentGoalCapability): string {
  if (cap.supported) return `${agent} supports goals`;
  switch (cap.reason) {
    case 'unsupported':
      return `${agent} does not support goals (no non-interactive goal interface)`;
    case 'version-unknown':
      return `goal requires ${agent} >= ${cap.requiredVersion}; the installed version could not be determined`;
    case 'version-too-old':
      return `goal requires ${agent} >= ${cap.requiredVersion}; detected ${cap.detectedVersion}`;
    default:
      return `${agent} does not support goals`;
  }
}
/** How each field reads in a 400. `goal.gates` alone is terse; naming the concept tells the
 *  operator what to look for in their harness's documentation. */
const FIELD_LABEL: Record<GoalCapabilityField, string> = {
  set: 'goal',
  track: 'goal tracking',
  tokenBudget: 'goal.tokenBudget',
  contract: 'goal.contract',
  gates: 'goal.gates',
  maxTurns: 'goal.maxTurns',
};

/**
 * Reason string for a rejected goal FIELD. Distinct from goalCapabilityMessage because the
 * question differs: there it is "can this agent carry a goal", here it is "does this part of
 * your goal mean anything to it". The answer must name the field, or the caller narrows the
 * wrong thing and retries with the same gates.
 */
export function goalFieldCapabilityMessage(
  agent: string,
  field: GoalCapabilityField,
  cap: AgentGoalCapability,
): string {
  const label = FIELD_LABEL[field];
  switch (cap.reason) {
    case 'version-unknown':
      return `${label} requires ${agent} >= ${cap.requiredVersion}; the installed version could not be determined`;
    case 'version-too-old':
      return `${label} requires ${agent} >= ${cap.requiredVersion}; detected ${cap.detectedVersion}`;
    default:
      // `unsupported` is a statement about the backend, not a transient probe failure, so it
      // is worth saying plainly that retrying will not help.
      return `${label} is not supported by ${agent} (it has no equivalent concept that reports back to Mercury)`;
  }
}

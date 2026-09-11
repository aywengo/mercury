/**
 * Goal input validation and objective resolution (docs/goals.md section 5).
 *
 * Pure on purpose: this is the layer that decides whether a request is admissible, and it
 * has to be testable without a database, a harness, or a worker.
 */

import { MAX_GOAL_GATE_TIMEOUT_MS, MAX_GOAL_OBJECTIVE_CHARS } from './types.ts';
import type { GoalContract, GoalGate, GoalSpec } from './types.ts';

export class GoalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalValidationError';
  }
}

/** A goal with its objective resolved and every field normalised. */
export interface ResolvedGoalSpec {
  objective: string;
  contract?: GoalContract;
  gates?: GoalGate[];
  tokenBudget?: number;
  maxTurns?: number;
}

/**
 * Resolve and validate a caller-supplied goal against the Run's task.
 *
 * `objective` defaults to the task text. That default is safe because the caller still
 * opted in by sending `goal` at all, and the judgement stays with the harness -- but the
 * cap applies to the RESOLVED value. A task longer than the cap with no explicit objective
 * is rejected rather than truncated: a truncated objective is a different objective, and
 * silently asking for something narrower than the user asked for is worse than refusing.
 */
export function resolveGoalSpec(input: unknown, task: string): ResolvedGoalSpec {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new GoalValidationError('goal must be an object');
  }
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    (k) => !['objective', 'contract', 'gates', 'tokenBudget', 'maxTurns'].includes(k),
  );
  if (unknown.length > 0) {
    // Rejecting unknown keys is the whole point: a typo like `objectiv` would otherwise be
    // dropped and the Run would carry a goal nobody asked for.
    throw new GoalValidationError(`goal has unknown field(s): ${unknown.join(', ')}`);
  }

  const objectiveRaw = raw.objective;
  let objective: string;
  if (objectiveRaw === undefined || objectiveRaw === null || objectiveRaw === '') {
    objective = task;
  } else if (typeof objectiveRaw !== 'string') {
    throw new GoalValidationError('goal.objective must be a string');
  } else {
    objective = objectiveRaw.trim();
  }
  if (objective.length === 0) {
    // Reachable: an empty task with no explicit objective.
    throw new GoalValidationError('goal objective is empty after trimming');
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_CHARS) {
    throw new GoalValidationError(
      `goal objective is ${objective.length} chars, over the ${MAX_GOAL_OBJECTIVE_CHARS} limit `
      + '(set goal.objective explicitly to something shorter; it is not truncated)',
    );
  }

  const out: ResolvedGoalSpec = { objective };

  if (raw.contract !== undefined && raw.contract !== null) {
    if (typeof raw.contract !== 'object' || Array.isArray(raw.contract)) {
      throw new GoalValidationError('goal.contract must be an object');
    }
    const c = raw.contract as Record<string, unknown>;
    const bad = Object.keys(c).filter((k) => !['outcome', 'verification', 'constraints', 'boundaries', 'stopWhen'].includes(k));
    if (bad.length) throw new GoalValidationError(`goal.contract has unknown field(s): ${bad.join(', ')}`);
    const contract: GoalContract = {};
    for (const key of ['outcome', 'verification', 'constraints', 'boundaries', 'stopWhen'] as const) {
      const v = c[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') throw new GoalValidationError(`goal.contract.${key} must be a string`);
      contract[key] = v;
    }
    // An all-empty contract is equivalent to none; normalise so storage and comparison agree.
    if (Object.keys(contract).length > 0) out.contract = contract;
  }

  if (raw.gates !== undefined && raw.gates !== null) {
    if (!Array.isArray(raw.gates)) throw new GoalValidationError('goal.gates must be an array');
    const gates = raw.gates.map((g, i) => validateGate(g, i));
    // An empty list is normalised away, matching the contract handling below. `gates: []` asks
    // for no gates, which is the same request as omitting the field -- and leaving `[]` in the
    // resolved spec would make capability admission refuse a caller who asked for nothing, while
    // the identical caller who omitted the field got through. That asymmetry has no meaning to
    // hang on the request, and it would also store `[]` where null already means the same thing.
    if (gates.length > 0) out.gates = gates;
  }

  if (raw.tokenBudget !== undefined && raw.tokenBudget !== null) {
    if (typeof raw.tokenBudget !== 'number' || !Number.isInteger(raw.tokenBudget) || raw.tokenBudget <= 0) {
      throw new GoalValidationError('goal.tokenBudget must be a positive integer');
    }
    out.tokenBudget = raw.tokenBudget;
  }

  if (raw.maxTurns !== undefined && raw.maxTurns !== null) {
    if (typeof raw.maxTurns !== 'number' || !Number.isInteger(raw.maxTurns) || raw.maxTurns <= 0) {
      throw new GoalValidationError('goal.maxTurns must be a positive integer');
    }
    out.maxTurns = raw.maxTurns;
  }

  return out;
}

/**
 * A gate's timeout is mandatory and bounded. An unbounded gate cannot be distinguished from
 * a hung one, and this codebase has already paid more wall-clock time to that ambiguity than
 * to any bug it would have caught.
 */
function validateGate(input: unknown, index: number): GoalGate {
  const at = `goal.gates[${index}]`;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new GoalValidationError(`${at} must be an object`);
  }
  const g = input as Record<string, unknown>;
  const bad = Object.keys(g).filter((k) => !['command', 'timeoutMs', 'maxRetries'].includes(k));
  if (bad.length) throw new GoalValidationError(`${at} has unknown field(s): ${bad.join(', ')}`);
  if (typeof g.command !== 'string' || g.command.trim() === '') {
    throw new GoalValidationError(`${at}.command must be a non-empty string`);
  }
  if (typeof g.timeoutMs !== 'number' || !Number.isFinite(g.timeoutMs) || g.timeoutMs <= 0) {
    throw new GoalValidationError(`${at}.timeoutMs must be a positive number`);
  }
  if (g.timeoutMs > MAX_GOAL_GATE_TIMEOUT_MS) {
    // Positive is not the same as bounded. See MAX_GOAL_GATE_TIMEOUT_MS for why the ceiling
    // is the point of the field rather than a detail of it.
    throw new GoalValidationError(
      `${at}.timeoutMs is ${g.timeoutMs}ms, over the ${MAX_GOAL_GATE_TIMEOUT_MS}ms ceiling `
      + '(a gate that may run indefinitely is indistinguishable from a hung one)',
    );
  }
  if (typeof g.maxRetries !== 'number' || !Number.isInteger(g.maxRetries) || g.maxRetries < 0) {
    throw new GoalValidationError(`${at}.maxRetries must be a non-negative integer`);
  }
  return { command: g.command.trim(), timeoutMs: Math.floor(g.timeoutMs), maxRetries: g.maxRetries };
}

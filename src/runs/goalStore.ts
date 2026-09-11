/**
 * Goal persistence (docs/goals.md section 5).
 *
 * One row per Run, updated in place. The event stream is the history; this table is the
 * current answer, so a second append-only copy here would only create a second source of
 * truth to disagree with the first after a partial failure.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Redactor } from '../domain/redact.ts';
import type { GoalContract, GoalGate, GoalPatch, GoalState, GoalStatus } from '../domain/types.ts';

interface GoalRow {
  run_id: string;
  objective: string;
  contract_json: string | null;
  gates_json: string | null;
  token_budget: number | null;
  status: string;
  tokens_used: number | null;
  time_used_seconds: number | null;
  turns_used: number | null;
  last_verdict: string | null;
  last_reason: string | null;
  last_error: string | null;
  paused_reason: string | null;
  source: string;
  updated_at: string;
}

/** Harness text is agent-controlled; bound it before it reaches a row or an SSE frame. */
export const MAX_GOAL_TEXT_CHARS = 2000;

function bound(text: string | undefined | null): string | null {
  if (text === undefined || text === null) return null;
  return text.length > MAX_GOAL_TEXT_CHARS ? `${text.slice(0, MAX_GOAL_TEXT_CHARS)}…` : text;
}

function rowToGoal(row: GoalRow): GoalState {
  return {
    runId: row.run_id,
    status: row.status as GoalStatus,
    objective: row.objective,
    contract: row.contract_json ? (JSON.parse(row.contract_json) as GoalContract) : undefined,
    gates: row.gates_json ? (JSON.parse(row.gates_json) as GoalGate[]) : undefined,
    tokenBudget: row.token_budget ?? undefined,
    tokensUsed: row.tokens_used ?? undefined,
    timeUsedSeconds: row.time_used_seconds ?? undefined,
    turnsUsed: row.turns_used ?? undefined,
    lastVerdict: (row.last_verdict as GoalState['lastVerdict']) ?? undefined,
    lastReason: row.last_reason ?? undefined,
    lastError: row.last_error ?? undefined,
    pausedReason: row.paused_reason ?? undefined,
    source: row.source as GoalState['source'],
    updatedAt: row.updated_at,
  };
}

export class GoalStore {
  private db: DatabaseSync;
  private redactor: Redactor | null;

  /**
   * `redactor` is optional for the same reason EventStore takes one optionally: a caller with
   * no configured secrets has nothing to redact. Production always passes one.
   */
  constructor(db: DatabaseSync, redactor?: Redactor) {
    this.db = db;
    this.redactor = redactor ?? null;
  }

  /**
   * Sanitise agent-controlled text before it reaches a row.
   *
   * Order matters: redact FIRST, then bound. Bounding first can cut a secret in half and leave
   * the tail looking innocuous, and redaction can only shorten, so the cap still holds after.
   *
   * This is not redundant with EventStore's redaction. Goal text is written straight to
   * `run_goals` here and never passes through the event path, so without this a credential in
   * harness `lastReason` would sit unredacted in a column that the dashboard and CLI read.
   */
  private sanitize(text: string | undefined | null): string | null {
    if (text === undefined || text === null) return null;
    return bound(this.redactor ? this.redactor.redact(text) : text);
  }

  insert(goal: GoalState): void {
    this.db.prepare(
      `INSERT INTO run_goals (
         run_id, objective, contract_json, gates_json, token_budget, status,
         tokens_used, time_used_seconds, turns_used, last_verdict, last_reason,
         last_error, paused_reason, source, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      goal.runId,
      goal.objective,
      goal.contract ? JSON.stringify(goal.contract) : null,
      goal.gates ? JSON.stringify(goal.gates) : null,
      goal.tokenBudget ?? null,
      goal.status,
      goal.tokensUsed ?? null,
      goal.timeUsedSeconds ?? null,
      goal.turnsUsed ?? null,
      goal.lastVerdict ?? null,
      bound(goal.lastReason),
      bound(goal.lastError),
      bound(goal.pausedReason),
      goal.source,
      goal.updatedAt,
    );
  }

  get(runId: string): GoalState | null {
    const row = this.db.prepare('SELECT * FROM run_goals WHERE run_id = ?').get(runId) as GoalRow | undefined;
    return row ? rowToGoal(row) : null;
  }

  /**
   * Apply a patch and return the stored result.
   *
   * Returns null when the Run has no goal rather than throwing: the finalisation path calls
   * this for every Run that ends, and most Runs have no goal. Making that an error would put
   * a control-flow exception on the hottest path in the worker.
   */
  update(runId: string, patch: GoalPatch, now: string): GoalState | null {
    const existing = this.get(runId);
    if (!existing) return null;
    const next: GoalState = {
      ...existing,
      status: patch.status ?? existing.status,
      objective: patch.objective ?? existing.objective,
      tokensUsed: patch.tokensUsed ?? existing.tokensUsed,
      timeUsedSeconds: patch.timeUsedSeconds ?? existing.timeUsedSeconds,
      turnsUsed: patch.turnsUsed ?? existing.turnsUsed,
      lastVerdict: patch.lastVerdict ?? existing.lastVerdict,
      lastReason: patch.lastReason !== undefined ? this.sanitize(patch.lastReason) ?? undefined : existing.lastReason,
      lastError: patch.lastError !== undefined ? this.sanitize(patch.lastError) ?? undefined : existing.lastError,
      pausedReason: patch.pausedReason !== undefined ? this.sanitize(patch.pausedReason) ?? undefined : existing.pausedReason,
      source: patch.source ?? existing.source,
      updatedAt: now,
    };
    this.db.prepare(
      `UPDATE run_goals SET
         objective = ?, status = ?, tokens_used = ?, time_used_seconds = ?, turns_used = ?,
         last_verdict = ?, last_reason = ?, last_error = ?, paused_reason = ?,
         source = ?, updated_at = ?
       WHERE run_id = ?`,
    ).run(
      next.objective,
      next.status,
      next.tokensUsed ?? null,
      next.timeUsedSeconds ?? null,
      next.turnsUsed ?? null,
      next.lastVerdict ?? null,
      next.lastReason ?? null,
      next.lastError ?? null,
      next.pausedReason ?? null,
      next.source,
      next.updatedAt,
      runId,
    );
    return next;
  }

  /** True when the Run carries a goal that is still open. Drives the `unmet` decision. */
  /**
   * Goal status for each of the given Runs, in one query.
   *
   * Bounded by the caller's page size, so this cannot grow with the table. Runs with no goal
   * are absent from the result rather than mapped to a status: "no goal" is not a goal state,
   * and inventing one here would make the dashboard unable to tell the two apart.
   */
  statusesFor(runIds: readonly string[]): Record<string, GoalStatus> {
    if (runIds.length === 0) return {};
    const marks = runIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT run_id, status FROM run_goals WHERE run_id IN (${marks})`)
      .all(...runIds) as { run_id: string; status: string }[];
    const out: Record<string, GoalStatus> = {};
    for (const r of rows) out[r.run_id] = r.status as GoalStatus;
    return out;
  }

  isOpen(runId: string): boolean {
    const row = this.db.prepare('SELECT status FROM run_goals WHERE run_id = ?').get(runId) as { status: string } | undefined;
    return row?.status === 'active';
  }
}

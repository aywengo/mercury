// Durable Run persistence and lifecycle transitions (Mercury.md sections 5-6).

import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tx } from '../db/database.ts';
import { assertTransition, isTerminal } from '../domain/stateMachine.ts';
import type { ErrorKind, RepositoryContext, Run, RunConstraints, RunStatus } from '../domain/types.ts';

export interface RunRow {
  id: string;
  owner_id: string;
  task: string;
  repository_json: string;
  repositories_json: string | null;
  workspace_branch: string | null;
  workspace_path: string | null;
  agent: string;
  status: string;
  attempt: number;
  retry_of: string | null;
  error: string | null;
  error_kind: string | null;
  constraints_json: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  cancellation_requested_at: string | null;
  final_commits_json: string;
  pr_url: string | null;
}

export function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    ownerId: row.owner_id,
    task: row.task,
    repository: JSON.parse(row.repository_json) as RepositoryContext,
    repositories: row.repositories_json ? JSON.parse(row.repositories_json) as RepositoryContext[] : undefined,
    workspaceBranch: row.workspace_branch,
    workspacePath: row.workspace_path,
    agent: row.agent,
    status: row.status as RunStatus,
    attempt: row.attempt,
    retryOf: row.retry_of,
    error: row.error,
    errorKind: row.error_kind as ErrorKind,
    constraints: JSON.parse(row.constraints_json) as RunConstraints,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    cancellationRequestedAt: row.cancellation_requested_at,
    finalCommits: JSON.parse(row.final_commits_json) as string[],
    prUrl: row.pr_url,
  };
}

export class RunStore {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  insert(run: Run): void {
    this.db
      .prepare(
        `INSERT INTO runs (
          id, owner_id, task, repository_json, repositories_json, workspace_branch, workspace_path, agent, status,
          attempt, retry_of, error, error_kind, constraints_json, created_at, started_at, completed_at,
          lease_owner, lease_expires_at, cancellation_requested_at, final_commits_json, pr_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id, run.ownerId, run.task, JSON.stringify(run.repository), run.repositories ? JSON.stringify(run.repositories) : null,
        run.workspaceBranch, run.workspacePath,
        run.agent, run.status, run.attempt, run.retryOf, run.error, run.errorKind, JSON.stringify(run.constraints),
        run.createdAt, run.startedAt, run.completedAt, run.leaseOwner, run.leaseExpiresAt,
        run.cancellationRequestedAt, JSON.stringify(run.finalCommits), run.prUrl,
      );
  }

  get(id: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  list(opts: { ownerId?: string; status?: RunStatus; limit: number; cursor?: string }): { runs: Run[]; nextCursor: string | null } {
    const clauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (opts.ownerId) {
      clauses.push('owner_id = ?');
      params.push(opts.ownerId);
    }
    if (opts.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    // cursor format: "<createdAt>|<id>" (keyset pagination with id tiebreaker)
    if (opts.cursor) {
      const [createdAt, id] = opts.cursor.split('|');
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(createdAt, createdAt, id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params, opts.limit + 1) as unknown as RunRow[];
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit).map(rowToRun);
    const nextCursor = hasMore && page.length > 0
      ? `${page[page.length - 1].createdAt}|${page[page.length - 1].id}`
      : null;
    return { runs: page, nextCursor };
  }

  /**
   * Runs in the given statuses that have been idle since `idleBeforeIso`.
   *
   * This exists because the stuck-run check used to call `list({ status, limit: 200 })`, which is
   * `ORDER BY created_at DESC` -- newest first -- and discard `nextCursor`. A run becomes stuck by
   * being OLD and quiet, so past 200 live runs the qualifying runs were exactly the ones excluded:
   * the safety net did not degrade under load, it inverted (issue #137, a Round 1 finding that had
   * been wrongly closed as already fixed).
   *
   * The threshold is pushed into SQL rather than filtered in JavaScript. Two reasons: the scan is no
   * longer bounded by a page size chosen for an unrelated reason, and it stops shipping every live run
   * to JS to throw almost all of them away.
   *
   * `limit` is OPTIONAL and the stuck-run caller passes none: an alert that silently reported the
   * first 500 idle runs would be the same class of bug this method exists to fix. Pass a limit only
   * where a bounded result is the actual requirement.
   *
   * The comparison is `<=`, not `<`. The rule this replaced was `idleMs >= thresholdMs`, which
   * rearranges to `ref <= now - thresholdMs`; a strict `<` drops a run whose last activity lands
   * exactly on the boundary. Reproduced before fixing: a run whose only reference timestamp equals
   * `idleBeforeIso` is stuck under the old rule and was missing from the result.
   *
   * Idle reference is COALESCE(newest event timestamp, started_at, created_at) -- the same definition
   * the previous per-run JavaScript used, via EventStore.lastActivity().
   *
   * Timestamps are compared as strings. Every one of them is written by `new Date().toISOString()`, a
   * fixed-width UTC format in which lexicographic order is chronological order; parsing on both sides
   * would only add a way to get it wrong.
   *
   * This reads the events table, which RunStore does not otherwise touch. It lives here rather than
   * being split across two stores because the result is a set of Runs and the query must be a single
   * statement to be correct under concurrent appends; splitting it would reintroduce exactly the
   * read-then-write race the rest of this file avoids.
   */
  listIdle(statuses: readonly RunStatus[], idleBeforeIso: string, limit?: number): Run[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    // Omitted limit => no LIMIT clause at all, so the result cannot be silently truncated.
    const bounded = limit !== undefined;
    const rows = this.db
      .prepare(
        `SELECT * FROM runs r
          WHERE r.status IN (${placeholders})
            -- Cheap prefilter: a run that started after the threshold cannot be idle past it, so
            -- SQLite short-circuits the AND and never runs the correlated events subquery for it.
            -- Same query plan either way (verified with EXPLAIN QUERY PLAN); the win is per-row.
            -- Measured on 3,000 live runs that are mostly busy: 0.20 ms/call with this line,
            -- 1.55 ms without. Behaviour is identical -- there is deliberately no test for it.
            AND COALESCE(r.started_at, r.created_at) <= ?
            AND COALESCE(
                  (SELECT MAX(e.timestamp) FROM events e WHERE e.run_id = r.id),
                  r.started_at,
                  r.created_at
                ) <= ?
          ORDER BY COALESCE(
                     (SELECT MAX(e2.timestamp) FROM events e2 WHERE e2.run_id = r.id),
                     r.started_at,
                     r.created_at
                   ) ASC,
                   r.id ASC
          ${bounded ? 'LIMIT ?' : ''}`,
      )
      .all(...statuses, idleBeforeIso, idleBeforeIso, ...(bounded ? [limit] : [])) as unknown as RunRow[];
    return rows.map(rowToRun);
  }

  transition(id: string, to: RunStatus, extra?: Partial<Omit<Run, 'error' | 'errorKind'>>): Run {
    const run = this.get(id);
    if (!run) throw new Error(`Run ${id} not found`);
    assertTransition(run.status, to);
    const sets: string[] = ['status = ?'];
    const params: (string | number | null)[] = [to];
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        const col = camelToSnake(k);
        sets.push(`${col} = ?`);
        params.push(v === null ? null : typeof v === 'object' ? JSON.stringify(v) : (v as string | number));
      }
    }
    // Guard the write on the status we just validated (issue #48). Without it this
    // was read -> assertTransition -> unconditional UPDATE, so two concurrent
    // transitions could both read RUNNING, both pass validation, and last-write-wins:
    // a CANCELLED run could be silently overwritten by COMPLETED. The state machine
    // was correct in isolation and unenforced at the only place that matters.
    // A conditional write also needs issue #49's BEGIN IMMEDIATE to be useful --
    // under a deferred BEGIN the write could fail outright instead of waiting.
    params.push(id, run.status);
    const result = this.db
      .prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ? AND status = ?`)
      .run(...params);
    if (result.changes !== 1) {
      const current = this.get(id);
      throw new Error(
        `Run ${id} transition ${run.status} -> ${to} lost a race: status is now ${current?.status ?? 'gone'}`,
      );
    }
    const updated = this.get(id);
    if (!updated) throw new Error(`Run ${id} disappeared after transition`);
    return updated;
  }

  setError(id: string, error: string, errorKind: ErrorKind): void {
    this.db.prepare('UPDATE runs SET error = ?, error_kind = ? WHERE id = ?').run(error, errorKind, id);
  }

  /**
   * Record the workspace. When `baseCommit` is given (git-worktree mode) it is
   * pinned onto the Run's repository record so retries reuse the exact base
   * (Mercury.md section 21).
   */
  setWorkspace(id: string, branch: string, path: string, baseCommit?: string): void {
    if (baseCommit) {
      const run = this.get(id);
      if (run) {
        this.db
          .prepare('UPDATE runs SET repository_json = ? WHERE id = ?')
          .run(JSON.stringify({ ...run.repository, baseCommit }), id);
      }
    }
    this.db.prepare('UPDATE runs SET workspace_branch = ?, workspace_path = ? WHERE id = ?').run(branch, path, id);
  }

  setFinalCommits(id: string, commits: string[], prUrl: string | null): void {
    this.db
      .prepare('UPDATE runs SET final_commits_json = ?, pr_url = ? WHERE id = ?')
      .run(JSON.stringify(commits), prUrl, id);
  }

  requestCancellation(id: string): void {
    this.db
      .prepare('UPDATE runs SET cancellation_requested_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  isCancellationRequested(id: string): boolean {
    const row = this.db.prepare('SELECT cancellation_requested_at FROM runs WHERE id = ?').get(id) as
      | { cancellation_requested_at: string | null }
      | undefined;
    return row?.cancellation_requested_at != null;
  }

  isTerminal(id: string): boolean {
    const run = this.get(id);
    return run ? isTerminal(run.status) : true;
  }
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

export function newRunId(): string {
  return 'run_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

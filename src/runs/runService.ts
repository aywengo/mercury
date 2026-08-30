// Run creation, input, cancellation, retry (Mercury.md sections 7, 19-21).

import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tx } from '../db/database.ts';
import { isTerminal } from '../domain/stateMachine.ts';
import type { Redactor } from '../domain/redact.ts';
import type { RepositoryContext, ResolvedSkill, Run, RunConstraints, RunStatus } from '../domain/types.ts';
import { EventStore } from '../events/eventStore.ts';
import type { SkillRegistry } from '../skills/skillRegistry.ts';
import type { SkillSelector } from '../skills/skillSelector.ts';
import { RunStore, newRunId } from './runStore.ts';

export interface CreateRunInput {
  ownerId: string;
  task: string;
  repository?: RepositoryContext;
  /** Additional repositories (roadmap #6); `repositories` or `repository` both work. */
  repositories?: RepositoryContext[];
  agent?: string;
  skills?: string[];
  constraints?: Partial<RunConstraints>;
  idempotencyKey?: string;
}

export interface RunServiceDeps {
  db: DatabaseSync;
  runs: RunStore;
  events: EventStore;
  skills: SkillRegistry;
  selector: SkillSelector;
  knownAgents: string[];
  defaultMaxDurationMs: number;
  defaultMaxRetries: number;
  /** Optional secret redactor; input values are redacted at write time (issue #36). */
  redactor?: Redactor;
}

export class RunService {
  private deps: RunServiceDeps;

  constructor(deps: RunServiceDeps) {
    this.deps = deps;
  }

  /** Registered agent ids (the adapters wired at startup). */
  listAgents(): string[] {
    return [...this.deps.knownAgents];
  }

  create(input: CreateRunInput): Run {
    if (!input.task || input.task.trim().length === 0) {
      throw new Error('task is required');
    }
    if (input.constraints) validateConstraints(input.constraints);
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.ownerId, input.idempotencyKey);
      if (existing) return existing;
    }
    const agent = input.agent ?? 'primeagent';
    if (!this.deps.knownAgents.includes(agent)) {
      throw new Error(`Unknown agent: ${agent} (known: ${this.deps.knownAgents.join(', ')})`);
    }
    const available = this.deps.skills.list();
    const skillIds = input.skills && input.skills.length > 0
      ? input.skills
      : this.deps.selector.select(input.task, available, 4);
    const resolved = this.deps.skills.resolve(skillIds);

    const constraints: RunConstraints = {
      maxDurationMs: input.constraints?.maxDurationMs ?? this.deps.defaultMaxDurationMs,
      maxRetries: input.constraints?.maxRetries ?? this.deps.defaultMaxRetries,
      maxTokens: input.constraints?.maxTokens,
      maxCost: input.constraints?.maxCost,
      resourceLimits: input.constraints?.resourceLimits,
      allowedNetworks: input.constraints?.allowedNetworks,
    };

    // `repository` is the primary (the workspace checks it out); `repositories`
    // holds additional repos cloned under workspace/repos/. When only the list
    // form is given, its first entry is the primary.
    const repositories = input.repositories && input.repositories.length > 0
      ? input.repositories
      : undefined;
    const repository = input.repository ?? (repositories?.[0] ?? {});

    const now = new Date().toISOString();
    const run: Run = {
      id: newRunId(),
      ownerId: input.ownerId,
      task: input.task,
      repository,
      repositories,
      workspaceBranch: null,
      workspacePath: null,
      agent,
      status: 'QUEUED',
      attempt: 1,
      retryOf: null,
      error: null,
      errorKind: null,
      constraints,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      cancellationRequestedAt: null,
      finalCommits: [],
      prUrl: null,
    };

    try {
      tx(this.deps.db, () => {
        this.deps.runs.insert(run);
        for (const skill of resolved) {
          this.deps.db
            .prepare('INSERT INTO run_skills (run_id, skill_id, skill_version, skill_hash, snapshot_json) VALUES (?, ?, ?, ?, ?)')
            .run(run.id, skill.id, skill.version, skill.hash, JSON.stringify(skill));
        }
        if (input.idempotencyKey) {
          this.deps.db
            .prepare('INSERT INTO idempotency_keys (owner, key, run_id, created_at) VALUES (?, ?, ?, ?)')
            .run(input.ownerId, input.idempotencyKey, run.id, now);
        }
        this.deps.events.append(run.id, 'run.created', { runId: run.id, agent, status: 'QUEUED' });
        this.deps.events.append(run.id, 'run.queued', { runId: run.id });
        for (const skill of resolved) {
          this.deps.events.append(run.id, 'skill.selected', { skill: skill.id, version: skill.version, hash: skill.hash });
        }
      });
      return run;
    } catch (err) {
      // Check-then-insert race (issue #24): a concurrent POST with the same
      // (owner, key) may have won between our dedup SELECT and this INSERT.
      // The tx rolled back (no partial run); return the winner's run instead
      // of surfacing a raw UNIQUE-constraint 400.
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const existing = this.findByIdempotencyKey(input.ownerId, input.idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }
  }

  get(runId: string, ownerId: string, isAdmin: boolean): Run | null {
    const run = this.deps.runs.get(runId);
    if (!run) return null;
    if (!isAdmin && run.ownerId !== ownerId) return null;
    return run;
  }

  list(opts: { ownerId: string; isAdmin: boolean; status?: RunStatus; limit: number; cursor?: string }) {
    return this.deps.runs.list({
      ownerId: opts.isAdmin ? undefined : opts.ownerId,
      status: opts.status,
      limit: opts.limit,
      cursor: opts.cursor,
    });
  }

  getSkills(runId: string): ResolvedSkill[] {
    const rows = this.deps.db
      .prepare('SELECT snapshot_json FROM run_skills WHERE run_id = ? ORDER BY skill_id')
      .all(runId) as { snapshot_json: string }[];
    return rows.map((r) => JSON.parse(r.snapshot_json) as ResolvedSkill);
  }

  submitInput(runId: string, ownerId: string, isAdmin: boolean, value: unknown): void {
    const run = this.get(runId, ownerId, isAdmin);
    if (!run) throw new Error('Run not found');
    if (run.status !== 'NEEDS_INPUT') {
      throw new Error(`Run is not waiting for input (status: ${run.status})`);
    }
    const safeValue = this.deps.redactor ? this.deps.redactor.redactJson(value) : value;
    this.deps.db
      .prepare('INSERT INTO run_inputs (id, run_id, input_json, created_at) VALUES (?, ?, ?, ?)')
      .run('inp_' + randomUUID().replace(/-/g, '').slice(0, 16), runId, JSON.stringify(safeValue), new Date().toISOString());
  }

  cancel(runId: string, ownerId: string, isAdmin: boolean): Run {
    const run = this.get(runId, ownerId, isAdmin);
    if (!run) throw new Error('Run not found');
    if (isTerminal(run.status)) throw new Error(`Run already terminal (${run.status})`);
    if (run.status === 'QUEUED') {
      const updated = this.deps.runs.transition(runId, 'CANCELLED', { completedAt: new Date().toISOString() });
      this.deps.events.append(runId, 'run.cancelling', { runId });
      this.deps.events.append(runId, 'run.cancelled', { runId });
      return updated;
    }
    // STARTING / RUNNING / NEEDS_INPUT: cooperative cancellation; worker honors it.
    this.deps.runs.requestCancellation(runId);
    this.deps.events.append(runId, 'run.cancelling', { runId });
    return this.deps.runs.get(runId)!;
  }

  retry(runId: string, ownerId: string, isAdmin: boolean, opts: { auto?: boolean } = {}): Run {
    const original = this.get(runId, ownerId, isAdmin);
    if (!original) throw new Error('Run not found');
    if (!isTerminal(original.status)) throw new Error(`Run not terminal (${original.status})`);
    if (original.status === 'COMPLETED') throw new Error('Cannot retry a completed Run');
    if (original.attempt >= original.constraints.maxRetries + 1) {
      throw new Error(`Max retries reached (${original.constraints.maxRetries})`);
    }
    const skills = this.getSkills(runId).map((s) => s.id);
    // original.repository carries the pinned base commit (set when the original
    // workspace was created); a fresh resolve happens only when the original
    // never got a base commit (setup failed before workspace creation).
    const created = this.create({
      ownerId: original.ownerId,
      task: original.task,
      repository: { ...original.repository },
      repositories: original.repositories,
      agent: original.agent,
      skills,
      constraints: { ...original.constraints },
    });
    // link the retry to its original (retryOf) and bump the attempt counter
    this.deps.db
      .prepare('UPDATE runs SET retry_of = ?, attempt = ? WHERE id = ?')
      .run(original.id, original.attempt + 1, created.id);
    return this.deps.runs.get(created.id)!;
  }

  private findByIdempotencyKey(ownerId: string, key: string): Run | null {
    const row = this.deps.db
      .prepare('SELECT run_id FROM idempotency_keys WHERE owner = ? AND key = ?')
      .get(ownerId, key) as { run_id: string } | undefined;
    return row ? this.deps.runs.get(row.run_id) : null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

const NUMERIC_CONSTRAINT_KEYS = ['maxDurationMs', 'maxRetries', 'maxTokens', 'maxCost'] as const;
const CONSTRAINT_KEYS = new Set(['maxDurationMs', 'maxRetries', 'maxTokens', 'maxCost', 'resourceLimits', 'allowedNetworks']);

/** Validate a client-supplied constraints object (issue #28). */
function validateConstraints(c: Record<string, unknown>): void {
  for (const key of Object.keys(c)) {
    if (!CONSTRAINT_KEYS.has(key)) {
      throw new Error(`Unknown constraint: ${key}`);
    }
  }
  for (const key of NUMERIC_CONSTRAINT_KEYS) {
    const v = c[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error(`constraint ${key} must be a finite integer`);
    }
    if (v < 0) {
      throw new Error(`constraint ${key} must be >= 0`);
    }
    if (v > Number.MAX_SAFE_INTEGER) {
      throw new Error(`constraint ${key} must be <= ${Number.MAX_SAFE_INTEGER}`);
    }
  }
  const rl = c.resourceLimits;
  if (rl !== undefined) {
    if (typeof rl !== 'object' || rl === null || Array.isArray(rl)) {
      throw new Error('constraint resourceLimits must be an object');
    }
    for (const [k, v] of Object.entries(rl)) {
      if (!['cpu', 'memory', 'disk'].includes(k)) {
        throw new Error(`Unknown resourceLimits key: ${k}`);
      }
      if (typeof v !== 'string') {
        throw new Error(`resourceLimits.${k} must be a string`);
      }
    }
  }
  const an = c.allowedNetworks;
  if (an !== undefined) {
    if (!Array.isArray(an) || an.some((x) => typeof x !== 'string')) {
      throw new Error('constraint allowedNetworks must be an array of strings');
    }
  }
}

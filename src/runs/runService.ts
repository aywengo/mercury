// Run creation, input, cancellation, retry (Mercury.md sections 7, 19-21).

import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tx } from '../db/database.ts';
import { isTerminal } from '../domain/stateMachine.ts';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.ts';
import type { Redactor } from '../domain/redact.ts';
import type { AgentCapabilitySummary, GoalState, RepositoryContext, ResolvedSkill, Run, RunConstraints, RunStatus } from '../domain/types.ts';
import { goalCapabilityMessage } from '../domain/goalSupport.ts';
import { GoalValidationError, resolveGoalSpec } from '../domain/goalSpec.ts';
import type { GoalStore } from './goalStore.ts';
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
  /**
   * Optional objective for the Run (docs/goals.md). `undefined` means no goal and the Run
   * behaves exactly as before. Validated and resolved against `task` in create(); an
   * omitted objective defaults to the task text.
   */
  goal?: unknown;
  idempotencyKey?: string;
}

export interface RunServiceDeps {
  db: DatabaseSync;
  runs: RunStore;
  events: EventStore;
  skills: SkillRegistry;
  selector: SkillSelector;
  knownAgents: string[];
  /**
   * Per-agent capability snapshot, resolved from what each adapter declares plus the
   * harness version detected at startup. Optional: absent means nothing is known, which
   * resolves to "no agent supports goals" rather than "all do".
   *
   * Supplied as a function rather than a value because the underlying probes are
   * detached -- the answer changes once they land, and a snapshot taken at construction
   * would freeze every agent as version-unknown for the process lifetime.
   */
  agentCapabilities?: () => Record<string, AgentCapabilitySummary>;
  /** Goal persistence. Absent means goals are not wired and any `goal` input is rejected. */
  goals?: GoalStore;
  /** Agent id used when create input omits `agent` (MERCURY_DEFAULT_AGENT; default `fake`). */
  defaultAgent: string;
  defaultMaxDurationMs: number;
  defaultMaxRetries: number;
  /** Optional secret redactor; input values are redacted at write time (issue #36). */
  redactor?: Redactor;
}

export class RunService {
  private deps: RunServiceDeps;

  constructor(deps: RunServiceDeps) {
    // Fail at construction, not on the first POST: an unknown default is an operator
    // misconfiguration and must not wait for a Run to surface it.
    if (!deps.knownAgents.includes(deps.defaultAgent)) {
      throw new Error(
        `MERCURY_DEFAULT_AGENT=${deps.defaultAgent} is not a registered agent (known: ${deps.knownAgents.join(', ')})`,
      );
    }
    this.deps = deps;
  }

  /** Registered agent ids (the adapters wired at startup). */
  listAgents(): string[] {
    return [...this.deps.knownAgents];
  }
  /** Capability snapshot for every registered agent (docs/goals.md 13.6). */
  listAgentCapabilities(): Record<string, AgentCapabilitySummary> {
    return this.deps.agentCapabilities?.() ?? {};
  }


  /** Agent id used when create input omits `agent`. */
  defaultAgent(): string {
    return this.deps.defaultAgent;
  }

  create(input: CreateRunInput): Run {
    if (!input.task || input.task.trim().length === 0) {
      throw new ValidationError('task is required');
    }
    if (input.constraints) validateConstraints(input.constraints);
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.ownerId, input.idempotencyKey);
      if (existing) return existing;
    }
    const agent = input.agent ?? this.deps.defaultAgent;
    if (!this.deps.knownAgents.includes(agent)) {
      throw new ValidationError(`Unknown agent: ${agent} (known: ${this.deps.knownAgents.join(', ')})`);
    }

    // Goal admission. Everything about this block is fail-closed, because the failure mode
    // this feature was designed against is accepting a goal and silently not honouring it
    // (issue #459). A goal that cannot be tracked is refused here with the reason, before any
    // state is written -- not accepted, stored, and then never updated.
    let goalState: GoalState | null = null;
    if (input.goal !== undefined && input.goal !== null) {
      let spec;
      try {
        spec = resolveGoalSpec(input.goal, input.task);
      } catch (err) {
        throw new ValidationError(err instanceof GoalValidationError ? err.message : `invalid goal: ${String(err)}`);
      }
      if (!this.deps.goals) {
        throw new ValidationError('goals are not enabled on this server');
      }
      const cap = this.deps.agentCapabilities?.()[agent]?.goals;
      if (!cap?.supported) {
        throw new ValidationError(
          goalCapabilityMessage(agent, cap ?? { supported: false, reason: 'unsupported' }),
        );
      }
      // Redact before persisting. `runs.task` is redacted at write time because tasks
      // carry credentials (issue #43); resolving the objective from the RAW task and storing
      // it unredacted in a new table would route around that protection entirely, so this is
      // a leak rather than an audit note.
      //
      // Applied to the resolved value, not just the default: an explicit objective is free
      // text supplied by the same caller that supplies the task, and is no less likely to
      // carry a key. Contract fields and gate commands are the same kind of text.
      const redact = this.deps.redactor;
      const safeObjective = redact ? redact.redact(spec.objective) : spec.objective;
      const safeContract = spec.contract && redact
        ? Object.fromEntries(
            Object.entries(spec.contract).map(([k, v]) => [k, redact.redact(v)]),
          ) as GoalState['contract']
        : spec.contract;
      const safeGates = spec.gates && redact
        ? spec.gates.map((g) => ({ ...g, command: redact.redact(g.command) }))
        : spec.gates;

      goalState = {
        runId: '',
        status: 'active',
        objective: safeObjective,
        contract: safeContract,
        gates: safeGates,
        tokenBudget: spec.tokenBudget,
        // The caller set this; a harness reports back under 'harness'.
        source: 'operator',
        updatedAt: new Date().toISOString(),
      };
    }
    const available = this.deps.skills.list();
    // An omitted `skills` means "choose for me"; an explicitly empty array means
    // "no skills". Collapsing the two (issue #459) made every Run carry at least one
    // skill, because select() falls back rather than returning nothing -- and a Run
    // that always carries skill ids cannot be handed to a backend that resolves them
    // in its own namespace. HermesAgentAdapter passes `-s <id>`, Hermes looks that up
    // in its installed-skill store, and an unknown name is a fatal exit, so Hermes
    // could not execute any Run at all. `null` stays "omitted" so a JSON caller that
    // sends null keeps today's behaviour.
    const skillIds = input.skills === undefined || input.skills === null
      ? this.deps.selector.select(input.task, available, 4)
      : input.skills;
    const resolved = this.deps.skills.resolve(skillIds);

    const constraints: RunConstraints = {
      maxDurationMs: input.constraints?.maxDurationMs ?? this.deps.defaultMaxDurationMs,
      maxRetries: input.constraints?.maxRetries ?? this.deps.defaultMaxRetries,
      budgetTokens: input.constraints?.budgetTokens,
      budgetCost: input.constraints?.budgetCost,
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
    // Task text and repo URLs can embed secrets (issue #43); redact at write time.
    const safeTask = this.deps.redactor ? this.deps.redactor.redact(input.task) : input.task;
    const safeRepository = this.deps.redactor ? this.deps.redactor.redactJson(repository) as RepositoryContext : repository;
    const safeRepositories = this.deps.redactor && repositories ? this.deps.redactor.redactJson(repositories) as RepositoryContext[] : repositories;
    const run: Run = {
      id: newRunId(),
      ownerId: input.ownerId,
      task: safeTask,
      repository: safeRepository,
      repositories: safeRepositories,
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
        if (goalState) {
          // runId is only known here, so the row is built after the run id exists.
          this.deps.goals!.insert({ ...goalState, runId: run.id });
          this.deps.events.append(run.id, 'goal.created', {
            objective: goalState.objective,
            contract: goalState.contract,
            gates: goalState.gates,
            tokenBudget: goalState.tokenBudget,
          });
        }
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
    if (!run) throw new NotFoundError('run not found');
    if (run.status !== 'NEEDS_INPUT') {
      throw new ConflictError(`Run is not waiting for input (status: ${run.status})`);
    }
    const safeValue = this.deps.redactor ? this.deps.redactor.redactJson(value) : value;
    this.deps.db
      .prepare('INSERT INTO run_inputs (id, run_id, input_json, created_at) VALUES (?, ?, ?, ?)')
      .run('inp_' + randomUUID().replace(/-/g, '').slice(0, 16), runId, JSON.stringify(safeValue), new Date().toISOString());
  }

  cancel(runId: string, ownerId: string, isAdmin: boolean): Run {
    const run = this.get(runId, ownerId, isAdmin);
    if (!run) throw new NotFoundError('run not found');
    if (isTerminal(run.status)) throw new ConflictError(`Run already terminal (${run.status})`);
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
    if (!original) throw new NotFoundError('run not found');
    if (!isTerminal(original.status)) throw new ConflictError(`Run not terminal (${original.status})`);
    if (original.status === 'COMPLETED') throw new ConflictError('Cannot retry a completed Run');
    if (original.attempt >= original.constraints.maxRetries + 1) {
      throw new ConflictError(`Max retries reached (${original.constraints.maxRetries})`);
    }
    const skills = this.getSkills(runId).map((s) => s.id);
    // original.repository carries the pinned base commit (set when the original
    // workspace was created); a fresh resolve happens only when the original
    // never got a base commit (setup failed before workspace creation).
    // A goal is inherited like the task, repository, agent, skills and constraints are.
    // Retry re-attempts the SAME work, and the objective is part of what that work is --
    // inheriting everything about the work except its success condition is incoherent, and
    // the retry endpoint takes no body, so without this a retried Run could never carry a
    // goal at all.
    //
    // Only the SPEC is copied, never the status: the new Run starts its own attempt, so the
    // objective is open again. If the goal can no longer be honoured -- harness downgraded,
    // version now undetectable -- create() rejects the retry with the reason rather than
    // producing an untracked retry that looks like the original.
    const originalGoal = this.deps.goals?.get(runId);

    const created = this.create({
      ownerId: original.ownerId,
      task: original.task,
      repository: { ...original.repository },
      repositories: original.repositories,
      agent: original.agent,
      skills,
      constraints: { ...original.constraints },
      goal: originalGoal
        ? {
            objective: originalGoal.objective,
            contract: originalGoal.contract,
            gates: originalGoal.gates,
            tokenBudget: originalGoal.tokenBudget,
          }
        : undefined,
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

const NUMERIC_CONSTRAINT_KEYS = ['maxDurationMs', 'maxRetries', 'budgetTokens', 'budgetCost'] as const;
const CONSTRAINT_KEYS = new Set(['maxDurationMs', 'maxRetries', 'budgetTokens', 'budgetCost', 'resourceLimits', 'allowedNetworks']);

// Renamed by issue #63 because max* implied enforcement that does not exist. Rejecting them with a
// migration message (rather than the generic "Unknown constraint") is deliberate: a stale client
// would otherwise get an error that names neither the new spelling nor the reason.
const RENAMED_CONSTRAINTS: Record<string, string> = Object.assign(Object.create(null), {
  maxTokens: 'budgetTokens',
  maxCost: 'budgetCost',
});

/** Validate a client-supplied constraints object (issue #28). */
function validateConstraints(c: Record<string, unknown>): void {
  for (const key of Object.keys(c)) {
    // Object.hasOwn, not a bare index: a plain object literal inherits from Object.prototype, so
    // `RENAMED_CONSTRAINTS['toString']` returns the toString FUNCTION, which is truthy. A client
    // sending `{ toString: 1 }` would then get "constraint toString was renamed to function
    // toString() { [native code] }..." instead of the correct "Unknown constraint: toString".
    // Verified against node: toString, constructor, valueOf, hasOwnProperty and __proto__ all
    // resolve to something truthy through the prototype chain.
    const renamed = Object.hasOwn(RENAMED_CONSTRAINTS, key) ? RENAMED_CONSTRAINTS[key] : undefined;
    if (renamed) {
      throw new ValidationError(
        `constraint ${key} was renamed to ${renamed}: it is recorded but not enforced, so the ` +
        `max* name implied a guarantee that does not exist`,
      );
    }
    if (!CONSTRAINT_KEYS.has(key)) {
      throw new ValidationError(`Unknown constraint: ${key}`);
    }
  }
  for (const key of NUMERIC_CONSTRAINT_KEYS) {
    const v = c[key];
    if (v === undefined) continue;
    // budgetCost is a money amount, so fractional values are the normal case: `budgetCost: 2.5`
    // means two dollars and fifty cents. Requiring an integer here made the field unable to
    // express any non-whole budget, rejecting exactly the values it exists to accept. The other
    // three are genuine counts/durations and stay integer-only.
    const integral = key !== 'budgetCost';
    if (typeof v !== 'number' || !Number.isFinite(v) || (integral && !Number.isInteger(v))) {
      throw new ValidationError(`constraint ${key} must be a finite ${integral ? 'integer' : 'number'}`);
    }
    if (v < 0) {
      throw new ValidationError(`constraint ${key} must be >= 0`);
    }
    if (v > Number.MAX_SAFE_INTEGER) {
      throw new ValidationError(`constraint ${key} must be <= ${Number.MAX_SAFE_INTEGER}`);
    }
  }
  const rl = c.resourceLimits;
  if (rl !== undefined) {
    if (typeof rl !== 'object' || rl === null || Array.isArray(rl)) {
      throw new ValidationError('constraint resourceLimits must be an object');
    }
    for (const [k, v] of Object.entries(rl)) {
      if (!['cpu', 'memory', 'disk'].includes(k)) {
        throw new ValidationError(`Unknown resourceLimits key: ${k}`);
      }
      if (typeof v !== 'string') {
        throw new ValidationError(`resourceLimits.${k} must be a string`);
      }
    }
  }
  const an = c.allowedNetworks;
  if (an !== undefined) {
    if (!Array.isArray(an) || an.some((x) => typeof x !== 'string')) {
      throw new ValidationError('constraint allowedNetworks must be an array of strings');
    }
  }
}

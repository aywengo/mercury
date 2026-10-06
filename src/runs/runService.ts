// Run creation, input, cancellation, retry (Mercury.md sections 7, 19-21).

import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tx } from '../db/database.ts';
import { isTerminal } from '../domain/stateMachine.ts';
import { TERMINAL_GOAL_STATUSES } from '../domain/goalEvents.ts';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.ts';
import type { Redactor } from '../domain/redact.ts';
import type { AgentCapabilitySummary, GoalState, GoalStatus, GoalSummary, RepositoryContext, ResolvedSkill, Run, RunConstraints, RunStatus } from '../domain/types.ts';
import { goalCapabilityMessage, goalFieldCapabilityMessage } from '../domain/goalSupport.ts';
import { GoalValidationError, resolveGoalSpec } from '../domain/goalSpec.ts';
import type { GoalStore } from './goalStore.ts';
import { EventStore } from '../events/eventStore.ts';
import type { SkillRegistry } from '../skills/skillRegistry.ts';
import type { SkillSelector } from '../skills/skillSelector.ts';
import { parseByteLimit, parseCpuLimit } from '../sandbox/resourceLimits.ts';
import { RunStore, newRunId } from './runStore.ts';
import { PresetStore, type RunPresetRow } from './presetStore.ts';
import { WorkflowStore, type RunWorkflowRow } from './workflowStore.ts';
import type { PresetRegistry } from '../presets/presetRegistry.ts';
import type { ResolvedRolePreset } from '../presets/types.ts';
import { resolvePreset, type PresetCallerInput } from '../presets/resolvePreset.ts';
import type { ReplicaStore } from '../knowledge/replica.ts';
import type { WorkflowRegistry } from '../workflows/workflowRegistry.ts';
import type { LoadedWorkflow } from '../workflows/types.ts';
import type { LoadedPreset } from '../presets/types.ts';
import { resolveWorkflowStages, WorkflowPresetResolutionError } from '../workflows/resolveWorkflow.ts';
import { renderPlan } from '../workflows/renderPlan.ts';
import type { ResolvedWorkflow } from './workflowStore.ts';
import { selectPack, type PackSelection } from '../knowledge/pack.ts';
import { KnowledgeRequestError, knowledgeCapabilityMessage, parseKnowledgeRequest } from '../knowledge/request.ts';
import type { KnowledgeRequest } from '../knowledge/types.ts';

export interface KnowledgeSelectionDeps {
  /** The Atlas project this host contributes to and reads (section 5). */
  projectId: string;
  replica: ReplicaStore;
  /** Host ceiling on pack size. A per-Run `maxBytes` is clamped to it, never allowed past it. */
  packMaxBytes: number;
  /** MERCURY_KNOWLEDGE_INJECT. When false, Runs get no pack unless they ask for one. */
  injectByDefault: boolean;
  /**
   * Which agents can receive a pack, from the same capability snapshot goals use (section 7.4).
   *
   * Supplied as a function because the underlying probes are detached and the answer changes when they
   * land. An agent absent from the map is UNKNOWN, which fails open: no pack, no error, because an
   * unverified harness must not brick a Run. `require: true` is what turns unknown into a refusal.
   */
  capabilities?: () => Record<string, AgentCapabilitySummary>;
}

export interface CreateRunInput {
  ownerId: string;
  task: string;
  repository?: RepositoryContext;
  /** Additional repositories (roadmap #6); `repositories` or `repository` both work. */
  repositories?: RepositoryContext[];
  agent?: string;
  skills?: string[];
  /**
   * Skill snapshots to store verbatim instead of resolving `skills` against the live registry.
   *
   * Only retry uses this (#506). A Run's skill rows are a snapshot for a reason: they pin the
   * exact bytes, version and hash the Run was created with. Re-resolving by id at execution time
   * silently substitutes whatever the registry holds now, so editing a skill changes what an
   * already-queued Run does, and deleting one makes `resolveOne` throw and the Run fail to start.
   */
  skillSnapshots?: ResolvedSkill[];
  constraints?: Partial<RunConstraints>;
  /**
   * Optional objective for the Run (docs/goals.md). `undefined` means no goal and the Run
   * behaves exactly as before. Validated and resolved against `task` in create(); an
   * omitted objective defaults to the task text.
   */
  goal?: unknown;
  /**
   * Per-Run control over the knowledge pack (docs/knowledge-base.md 9.1). `undefined` means "use the
   * host default", which never fails; a malformed block is refused. Validated in create() so HTTP and
   * in-process callers hit identical rules, exactly as `goal` does.
   */
  knowledge?: unknown;
  /**
   * Role Preset selection (docs/crew/role-presets.md section 5). `undefined` means no preset
   * and the Run behaves exactly as before. Resolved in create() against the builtin registry;
   * a caller-supplied `version` is an optimistic guard against resolving an unexpected
   * current definition.
   */
  preset?: { id: string; version?: string };
  /**
   * A preset snapshot to store verbatim instead of resolving `preset` against the registry.
   * Only retry uses this, exactly like `skillSnapshots`: a retried Run must execute the SAME
   * bytes its parent executed, not a re-resolution of whatever the registry holds now.
   */
  presetSnapshot?: ResolvedRolePreset;
  /**
   * Advisory Workflow Template selection (docs/crew/workflows.md section 3.1, issue #809).
   * `undefined` means no workflow and the Run behaves exactly as before. Resolved in create()
   * against the builtin registry; a caller-supplied `version` is the same optimistic guard the
   * `preset` block uses. There is no HTTP endpoint for this yet (W-3 #810); the service-level
   * and CLI paths land here.
   */
  workflow?: { id: string; version?: string };
  /**
   * A workflow snapshot to store verbatim instead of resolving `workflow` against the registry.
   * Only retry uses this, exactly like `presetSnapshot` and `skillSnapshots`: a retried Run
   * must execute the SAME template bytes and stage guidance its parent executed (#842 review).
   */
  workflowSnapshot?: {
    workflow: ResolvedWorkflow;
    stagePresets: { stageIndex: number; snapshot: ResolvedRolePreset }[];
    skills: ResolvedSkill[];
  };
  /**
   * Per-Run model override (docs/laya-integration-design.md §13 P-1, issue #823). `undefined`
   * means "no caller model" and the Run behaves exactly as before. Resolution, one rule for both
   * paths: caller.model → preset model → none. Refused fail-closed when the effective agent's
   * static capabilities lack `perRunModel: true`, with the same unknown/undeclared/false wording
   * the preset path uses.
   */
  model?: string;
  /**
   * Where `model` came from, when the caller already knows (retry, #832 r1). Retry copies the
   * parent's model; recording it as 'caller' would rewrite the explainability record's origin.
   * Only retry passes this; the HTTP surface does not expose it.
   */
  modelSource?: 'caller' | 'preset';
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
   * Builtin preset registry. Absent means presets are off: a `preset` block on a Run is
   * rejected rather than ignored (section 8.4 vocabulary, same shape as knowledge/goals).
   */
  presets?: PresetRegistry;
  /**
   * Builtin workflow registry (docs/crew/workflows.md section 3.1, issue #809). Absent means
   * workflows are off: a `workflow` block on a Run is rejected rather than ignored, the same
   * rule the `preset` block follows.
   */
  workflows?: WorkflowRegistry;
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
  /**
   * Knowledge selection. Absent means the feature is off: no pack is selected, and a `knowledge` block
   * on the request is rejected rather than ignored (section 8.4).
   *
   * Reads the local replica only. Nothing here may reach the network -- that is the decision which
   * makes an Atlas outage cost freshness instead of costing Run creation (section 8.3).
   */
  knowledge?: KnowledgeSelectionDeps;
  /** Agent id used when create input omits `agent` (MERCURY_DEFAULT_AGENT; default `fake`). */
  defaultAgent: string;
  defaultMaxDurationMs: number;
  defaultMaxRetries: number;
  /** Optional secret redactor; input values are redacted at write time (issue #36). */
  redactor?: Redactor;
}

/**
 * Model shape validation (#823, hardened in #832 r1): non-empty, <= 200 chars, no whitespace or
 * control characters (C0 and C1, via \p{Cc}). Applied to the CALLER value and to the RESOLVED
 * value - a preset-declared model must satisfy the same contract, because both reach argv or
 * session config. `label` names the origin in the error so an operator can tell which field
 * carried the bad value.
 */
export function validateModelShape(model: string, label: string): void {
  if (typeof model !== 'string' || model.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  if (model.length > 200) {
    throw new ValidationError(`${label} must be at most 200 characters`);
  }
  // \p{Cc} covers C0 (U+0000-U+001F) AND C1 (U+007F-U+009F); \s covers unicode whitespace.
  if (new RegExp('\\p{Cc}', 'u').test(model) || /\s/u.test(model)) {
    throw new ValidationError(`${label} must not contain whitespace or control characters: ${JSON.stringify(model)}`);
  }
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

  /** Per-Run preset snapshots (section 6). Lazy: absent when presets are not wired. */
  private presetStore(): PresetStore | null {
    if (!this.deps.presets) return null;
    return new PresetStore(this.deps.db);
  }

  /** Per-Run workflow snapshots (workflows.md section 5, issue #809). */
  private workflowStore(): WorkflowStore {
    return new WorkflowStore(this.deps.db);
  }

  /** The immutable workflow snapshot a Run stores (workflows.md section 5). */
  private workflowSnapshot(loaded: LoadedWorkflow): ResolvedWorkflow {
    return {
      schemaVersion: 1,
      id: loaded.id,
      version: loaded.version,
      description: loaded.description,
      mode: loaded.mode,
      stages: loaded.stages,
      maxStages: loaded.maxStages,
      trust: loaded.trust,
      source: { kind: loaded.source.kind, relativePath: loaded.source.relativePath },
      templateJson: loaded.templateJson,
      files: loaded.files,
      contentHash: loaded.contentHash,
    };
  }

  /**
   * One stage preset's snapshot (section 3.1.1 rule 6). The stage preset does not set Run
   * constraints -- the workflow resolution already produced the narrowest set, and THAT set
   * is what the worker applies and the run row carries -- so the per-stage snapshot records
   * the resolved Run set rather than inventing a per-stage one. `effectiveSkills` is empty for
   * the same reason: the Run's skills are the union row set, not per-stage lists.
   */
  private stagePresetSnapshot(preset: LoadedPreset, agentId: string): ResolvedRolePreset {
    return {
      schemaVersion: 1,
      id: preset.id,
      version: preset.version,
      role: preset.role,
      description: preset.description,
      trust: preset.trust,
      instruction: preset.instruction,
      effectiveAgent: { id: agentId },
      effectiveSkills: [],
      effectiveConstraints: { maxDurationMs: 0, maxRetries: 0 },
      source: { kind: preset.source.kind, relativePath: preset.source.relativePath },
      files: preset.files,
      contentHash: preset.contentHash,
    };
  }

  /** Registered agent ids (the adapters wired at startup). */
  listAgents(): string[] {
    return [...this.deps.knownAgents];
  }

  /**
   * Owner-transfer for a removed bot's Runs (§17.7, #760): rewrites owner_id for every Run of
   * `fromOwner` inside one transaction and appends a `run.owner_reassigned` event per Run, so
   * the audit trail survives the ownership change.
   *
   * Validation is shape-only for `toOwner` on purpose: the common case is transferring to a
   * NEW owner (the operator inheriting a dead bot's Runs) who may own no Runs yet - there is no
   * server-side owner registry to check against, and the admin caller names the target.
   *
   * Redaction is unaffected: events pass the redactor at append time and were already redacted
   * at write time; the transfer changes WHO can read them (owner-scoped listing), not WHAT is
   * stored. No secret material rides on the event payload.
   */
  reassignRuns(opts: { fromOwner: string; toOwner: string }): { transferred: number; runIds: string[] } {
    const OWNER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
    const from = opts.fromOwner.trim();
    const to = opts.toOwner.trim();
    if (!OWNER_RE.test(from)) throw new ValidationError(`fromOwner must match ${OWNER_RE.source}; got '${opts.fromOwner}'`);
    if (!OWNER_RE.test(to)) throw new ValidationError(`toOwner must match ${OWNER_RE.source}; got '${opts.toOwner}'`);
    if (from === to) throw new ValidationError('fromOwner and toOwner must differ');
    const runIds = this.deps.runs.reassignOwner(from, to);
    for (const runId of runIds) {
      this.deps.events.append(runId, 'run.owner_reassigned', { fromOwner: from, toOwner: to });
    }
    return { transferred: runIds.length, runIds };
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
    // Per-Run model shape validation (#823). It reaches argv/config in the adapters (P1-2/P1-3),
    // so it must be a single shell-safe token: no whitespace or control characters, bounded
    // length. An empty string is 'no model' vs an invalid value — refused rather than silently
    // dropped, because a dropped override silently executes with the wrong model.
    if (input.model !== undefined) {
      validateModelShape(input.model, 'model');
    }
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.ownerId, input.idempotencyKey);
      if (existing) return existing;
    }

    // Preset resolution (section 5): BEFORE agent/skills/constraints so the preset acts as
    // defaults the caller can override (and required fields the caller cannot). A retry that
    // carries presetSnapshot skips resolution entirely -- same bytes as the parent, exactly
    // like skillSnapshots.
    let presetSnapshot: ResolvedRolePreset | null = input.presetSnapshot ?? null;
    if (input.preset && !presetSnapshot) {
      if (!this.deps.presets) {
        throw new ValidationError('presets are not enabled on this server; remove the preset block');
      }
      const loaded = this.deps.presets.get(input.preset.id);
      if (input.preset.version && loaded.version !== input.preset.version) {
        throw new ValidationError(
          `preset ${JSON.stringify(input.preset.id)} is version ${loaded.version}, not the requested ${input.preset.version}`,
        );
      }
      if (!loaded.enabled) {
        throw new ValidationError(`preset ${JSON.stringify(loaded.id)} is disabled`);
      }
      const stat = this.deps.agentCapabilities?.();
      const selection = resolvePreset(
        loaded.manifest,
        {
          agent: input.agent,
          // Caller surface exists now (#823): the caller's model wins unless the preset requires
          // its own (modelRequired conflict stays enforced inside resolvePreset).
          model: input.model,
          skills: input.skills,
          constraints: input.constraints,
        } satisfies PresetCallerInput,
        {
          defaultAgent: this.deps.defaultAgent,
          defaultMaxDurationMs: this.deps.defaultMaxDurationMs,
          defaultMaxRetries: this.deps.defaultMaxRetries,
        },
        {
          knownAgents: this.deps.knownAgents,
          staticCapabilities: (agentId) => stat?.[agentId]?.static,
        },
      );

      // Skills: auto-selection (section 3.2 step 2) needs the task text and the available
      // list, so the selector runs here, not inside resolvePreset -- which flags the case
      // (empty start list, autoSelect not disabled). A nativeNames backend with
      // preset skills is a guaranteed fatal exit (issue #507's lesson), so preset skills fail
      // closed for one instead of being silently recorded.
      let skillIds = selection.effectiveSkillIds;
      if (selection.autoSelect) {
        const skillDelivery = this.deps.agentCapabilities?.()[selection.effectiveAgent.id]?.static?.skills;
        if (skillDelivery !== 'nativeNames') {
          // Section 3.2 as amended by #724: the selector runs whenever the start list is empty,
          // and the preset's required skills are appended AFTER its picks (steps 3-4). The
          // selector's budget shrinks by the DISTINCT required count so the merged, deduplicated
          // list still fits the effective maximum without dropping a required skill -- required
          // skills are "always present" by definition.
          // Validation caps DISTINCT ids, so dedupe before the budget math: duplicates in the
          // required list would otherwise shrink the selector's budget more than the final
          // deduped list needs.
          const required: string[] = [];
          const seenRequired = new Set<string>();
          for (const id of selection.effectiveSkillIds) {
            if (seenRequired.has(id)) continue;
            seenRequired.add(id);
            required.push(id);
          }
          const cap = selection.skillCap;
          const picks = this.deps.selector.select(
            input.task,
            this.deps.skills.list(),
            Math.max(0, cap - required.length),
          );
          const seen = new Set<string>();
          skillIds = [];
          for (const id of [...picks, ...required]) {
            if (seen.has(id)) continue;
            seen.add(id);
            skillIds.push(id);
          }
          // Step 5, enforced on the final merged list rather than assumed from the budget: a
          // selector that ignores its budget or an over-cap required set fails the Run at
          // creation with the same message resolveSkillIds uses for the named path.
          if (skillIds.length > cap) {
            throw new ValidationError(
              `preset resolves to ${skillIds.length} skills; the effective maximum is ${cap}`,
            );
          }
        }
      }
      if (skillIds.length > 0
        && this.deps.agentCapabilities?.()[selection.effectiveAgent.id]?.static?.skills === 'nativeNames') {
        throw new ValidationError(
          `preset ${JSON.stringify(loaded.id)} names skills, but agent ${JSON.stringify(selection.effectiveAgent.id)}`
          + ' resolves skill names in its own store; a missing one is a fatal exit. Run this preset'
          + ' on an agent that reads workspace skills.',
        );
      }
      const resolvedSkills = this.deps.skills.resolve(skillIds);
      presetSnapshot = {
        schemaVersion: 1,
        id: loaded.id,
        version: loaded.version,
        role: loaded.role,
        description: loaded.description,
        trust: loaded.trust,
        instruction: loaded.instruction,
        effectiveAgent: selection.effectiveAgent,
        effectiveSkills: resolvedSkills,
        effectiveConstraints: selection.effectiveConstraints,
        source: { kind: loaded.source.kind, relativePath: loaded.source.relativePath },
        files: loaded.files,
        contentHash: loaded.contentHash,
      };
    }

    // Advisory Workflow Template resolution (docs/crew/workflows.md section 3.1, issue #809).
    // BEFORE skills/constraints like the preset block: the stage presets act as demands the
    // caller cannot ignore and ceilings the caller cannot widen (section 3.1.1). Fail-closed
    // like every other admission block: a template or preset reference that cannot resolve is
    // a refused creation, never a Run that silently runs without its plan.
    let resolvedWorkflow: {
      /** The workflow resolution's effective agent (section 3.1.1 rules 1-2) -- the agent and
       * model the Run row must carry (#842 review r2: discarding these ran a template whose
       * stage required `hermes` on the system default agent instead). */
      effectiveAgent: { id: string; model?: string };
      snapshot: ResolvedWorkflow;
      /** Each referenced stage preset's snapshot (section 3.1.1 rule 6), in stage order. */
      stagePresets: { stageIndex: number; presetId: string; snapshot: ResolvedRolePreset }[];
      /** Stage index -> that stage preset's instruction text, for the plan renderer. */
      stageInstructions: Record<number, string>;
      skills: import('../domain/types.ts').ResolvedSkill[];
      constraints: RunConstraints;
    } | null = null;
    if (input.workflowSnapshot !== undefined) {
      // Internal retry path (#842 review): the parent's stored snapshot rows, verbatim. No
      // registry read at all -- the template may have been deleted or rewritten since the
      // parent ran, and the retry must execute the parent's bytes, not a re-resolution. The
      // Run row's constraints ARE the parent's effective set (retry copies original.constraints),
      // which is exactly the set resolution would have produced.
      const wfSnap = input.workflowSnapshot.workflow;
      if (input.workflow !== undefined) {
        throw new ValidationError('workflow and workflowSnapshot are mutually exclusive');
      }
      resolvedWorkflow = {
        // Retry passes the parent's agent/model explicitly, so this is not consulted -- the
        // parent's values are the resolution's output, already persisted on its Run row.
        effectiveAgent: { id: input.agent ?? this.deps.defaultAgent },
        snapshot: wfSnap,
        stagePresets: input.workflowSnapshot.stagePresets.map((sp) => ({
          stageIndex: sp.stageIndex,
          presetId: sp.snapshot.id,
          snapshot: sp.snapshot,
        })),
        stageInstructions: Object.fromEntries(
          input.workflowSnapshot.stagePresets.map((sp) => [sp.stageIndex, sp.snapshot.instruction]),
        ),
        skills: input.workflowSnapshot.skills,
        constraints: {
          maxDurationMs: input.constraints?.maxDurationMs ?? this.deps.defaultMaxDurationMs,
          maxRetries: input.constraints?.maxRetries ?? this.deps.defaultMaxRetries,
          notAfter: input.constraints?.notAfter,
          botTask: input.constraints?.botTask,
          budgetTokens: input.constraints?.budgetTokens,
          budgetCost: input.constraints?.budgetCost,
          resourceLimits: input.constraints?.resourceLimits,
          allowedNetworks: input.constraints?.allowedNetworks,
        },
      };
    } else if (input.workflow !== undefined) {
      if (input.workflow === null || typeof input.workflow !== 'object' || Array.isArray(input.workflow)) {
        throw new ValidationError('workflow must be an object with an id');
      }
      // Closed shape (#842 review r4): an unknown key is refused, never ignored. A typo such as
      // `versoin` would otherwise drop the version pin silently and run the current template --
      // the exact downgrade the pin exists to catch.
      for (const key of Object.keys(input.workflow as object)) {
        if (key !== 'id' && key !== 'version') {
          const hint = /^v/i.test(key) ? " (did you mean 'version'?)" : /^i/i.test(key) ? " (did you mean 'id'?)" : '';
          throw new ValidationError(`workflow has unknown key ${JSON.stringify(key)}${hint}; allowed keys: id, version`);
        }
      }
      const wf = input.workflow as { id?: unknown; version?: unknown };
      if (typeof wf.id !== 'string' || wf.id.length === 0) {
        throw new ValidationError('workflow.id must be a non-empty string');
      }
      if (wf.version !== undefined && (typeof wf.version !== 'string' || wf.version.length === 0)) {
        throw new ValidationError('workflow.version must be a non-empty string when given');
      }
      if (input.preset !== undefined) {
        throw new ValidationError(
          'preset and workflow are mutually exclusive: an advisory workflow renders per-stage'
          + ' preset guidance for its own steps, so a Run-wide preset has no place in it',
        );
      }
      if (!this.deps.workflows) {
        throw new ValidationError('workflows are not enabled on this server; remove the workflow block');
      }
      // Version pin = optimistic guard, the same rule the preset block applies: a pinned
      // version that does not resolve is refused rather than silently re-resolved.
      let loaded: LoadedWorkflow;
      try {
        loaded = this.deps.workflows.get(wf.id);
      } catch (err) {
        if (err instanceof NotFoundError) {
          // Unknown template -> the W-1 code vocabulary (issue #809 acceptance 5): the
          // registry's NotFoundError becomes a validation error carrying the code, so service
          // callers branch on codes, not prose. An INVALID template is not rewritten: its
          // WorkflowValidationFailure already carries the W-1 findings.
          throw new WorkflowPresetResolutionError('WORKFLOW_NOT_FOUND', 'workflow.id',
            `workflow ${JSON.stringify(wf.id)} does not resolve in the workflow registry`);
        }
        throw err;
      }
      if (wf.version !== undefined && loaded.version !== wf.version) {
        throw new ValidationError(
          `workflow ${JSON.stringify(loaded.id)} is version ${loaded.version}, not the requested ${wf.version}`,
        );
      }
      if (!this.deps.presets) {
        throw new ValidationError(
          'workflows resolve stage presets, so presets must be enabled on this server',
        );
      }
      const stageSelection = resolveWorkflowStages(
        loaded,
        {
          agent: input.agent,
          model: input.model,
          skills: input.skills,
          constraints: input.constraints,
        },
        {
          defaultAgent: this.deps.defaultAgent,
          defaultMaxDurationMs: this.deps.defaultMaxDurationMs,
          defaultMaxRetries: this.deps.defaultMaxRetries,
        },
        {
          knownAgents: this.deps.knownAgents,
          staticCapabilities: (agentId) => this.deps.agentCapabilities?.()[agentId]?.static,
        },
        (id) => this.deps.presets!.get(id),
      );
      // Skill resolution (section 3.1.1 rule 4): the union of the stages' required skills,
      // then the per-stage deterministic selector picks, deduped, then the cap. Exceeding the
      // cap FAILS with a finding naming the stages -- nothing is dropped.
      let skillIds = [...stageSelection.requiredSkillIds];
      const seenSkill = new Set(skillIds);
      for (const stage of stageSelection.autoSelectStages) {
        const preset = stageSelection.stagePresets.find((s) => s.stageIndex === stage.stageIndex)?.preset;
        if (!preset) continue;
        const skillDeliveryForStage = this.deps.agentCapabilities?.()[stageSelection.effectiveAgent.id]?.static?.skills;
        if (skillDeliveryForStage === 'nativeNames') continue; // guarded again below, on the merged list
        const picks = this.deps.selector.select(
          // The stage's own task: selection guidance is per step, never the whole plan.
          loaded.stages[stage.stageIndex]?.task ?? input.task,
          this.deps.skills.list(),
          Math.max(0, stageSelection.skillCap - seenSkill.size),
        );
        for (const id of picks) {
          if (seenSkill.has(id)) continue;
          seenSkill.add(id);
          skillIds.push(id);
        }
      }
      if (skillIds.length > 0
        && this.deps.agentCapabilities?.()[stageSelection.effectiveAgent.id]?.static?.skills === 'nativeNames') {
        throw new ValidationError(
          `workflow ${JSON.stringify(loaded.id)} resolves skills, but agent`
          + ` ${JSON.stringify(stageSelection.effectiveAgent.id)} resolves skill names in its own`
          + ' store; a missing one is a fatal exit. Run this workflow on an agent that reads'
          + ' workspace skills.',
        );
      }
      const resolvedWorkflowSkills = this.deps.skills.resolve(skillIds);
      // Stage preset instructions ride the SNAPSHOT: each stage preset is snapshotted with the
      // Run (section 3.1.1 rule 6), so a later preset edit cannot change this Run's plan.
      const stagePresetSnapshots = stageSelection.stagePresets.map((s) => ({
        stageIndex: s.stageIndex,
        presetId: s.presetId,
        snapshot: this.stagePresetSnapshot(s.preset, stageSelection.effectiveAgent.id),
      }));
      resolvedWorkflow = {
        effectiveAgent: stageSelection.effectiveAgent,
        snapshot: this.workflowSnapshot(loaded),
        stagePresets: stagePresetSnapshots,
        stageInstructions: Object.fromEntries(
          stagePresetSnapshots.map((s) => [s.stageIndex, s.snapshot.instruction]),
        ),
        skills: resolvedWorkflowSkills,
        constraints: stageSelection.effectiveConstraints,
      };
    }

    // The workflow resolution's effective agent wins over caller/system fallbacks: it already
    // applied the caller -> required-stage -> default precedence (section 3.1.1 rules 1-2), and
    // persisting anything else executes the template on an agent no stage asked for (#842 r2).
    const presetAgent = presetSnapshot?.effectiveAgent.id;
    const agent = resolvedWorkflow?.effectiveAgent.id ?? input.agent ?? presetAgent ?? this.deps.defaultAgent;
    if (!this.deps.knownAgents.includes(agent)) {
      throw new ValidationError(`Unknown agent: ${agent} (known: ${this.deps.knownAgents.join(', ')})`);
    }

    // Fail closed on the plan channel (#842 review r3): a workflow Run's steps are guidance the
    // adapter must actually deliver. Only the Prime/RPC/Claude adapters inject `workflowPlan`
    // into their prompts; an adapter that never received it would execute the template with
    // every planned step silently omitted. The check keys on the workflow paths ONLY -- the
    // retry path re-uses the parent's agent, which already passed this gate at its creation.
    if (resolvedWorkflow) {
      const stat = this.deps.agentCapabilities?.()[agent]?.static;
      if (stat?.workflowPlan !== true) {
        const declared = stat === undefined
          ? 'unknown -- the agent has no declared static capabilities'
          : stat.workflowPlan === undefined
            ? "undeclared -- the agent's static block omits workflowPlan"
            : "false -- the agent's static block declares workflowPlan: false";
        throw new ValidationError(
          `workflow ${JSON.stringify(resolvedWorkflow?.snapshot.id)} renders an advisory plan,`
          + ` but agent ${JSON.stringify(agent)} has no workflow-plan prompt channel`
          + ` (workflowPlan: ${declared}); pick an adapter that carries the plan`,
        );
      }
    }

    // Per-Run model resolution (#823), ONE rule for both paths: caller.model → preset model →
    // none. On the preset path resolvePreset already applied the same precedence (and enforced
    // the modelRequired conflict); the snapshot's effectiveAgent.model IS the resolved preset
    // model. On the no-preset path the caller's value is the only source.
    //
    // Fail closed on BOTH paths: an effective model on an agent whose static capabilities lack
    // `perRunModel: true` is refused at creation, with the same three-way wording (unknown /
    // undeclared / false) resolvePreset uses for the preset path. Today that refuses every real
    // agent, which is correct until the adapters declare the capability (P1-2..P1-4).
    const presetModel = presetSnapshot?.effectiveAgent.model;
    const model = input.model ?? resolvedWorkflow?.effectiveAgent.model ?? presetModel;
    if (model !== undefined) {
      // The RESOLVED model is validated too (#832 r1): a preset carrying `agent.model: "two
      // words"` passes preset validation today, and only this check keeps the persisted value
      // inside the same contract the caller surface has.
      validateModelShape(model, 'model');
      const stat = this.deps.agentCapabilities?.()[agent]?.static;
      if (stat?.perRunModel !== true) {
        const declared = stat === undefined
          ? 'unknown -- the agent has no declared static capabilities'
          : stat.perRunModel === undefined
            ? "undeclared -- the agent's static block omits perRunModel"
            : "false -- the agent's static block declares perRunModel: false";
        const source = input.model !== undefined ? 'per-Run model' : 'preset model';
        throw new ValidationError(
          `the ${source} ${JSON.stringify(model)} was requested, but agent ${JSON.stringify(agent)}`
          + ` cannot take a per-Run model (perRunModel: ${declared});`
          + ' pick an agent that accepts a per-Run model, or drop the model',
        );
      }
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
      // `set` being supported says nothing about the rest of the spec. Each supplied field is
      // checked against its own matrix entry, because accepting a field the backend cannot act
      // on is the exact failure this feature was written to prevent (issue #459) -- and it is
      // worse than dropping it, since the field is persisted and rendered, so the operator sees
      // gates or a contract that nothing will ever evaluate while the Run sails to COMPLETED.
      //
      // Checked on the RESOLVED spec rather than the raw input: `contract: {}` normalises away
      // to nothing, and refusing that would reject a request that carries no contract at all.
      for (const field of ['tokenBudget', 'contract', 'gates', 'maxTurns'] as const) {
        if (spec[field] === undefined) continue;
        const fieldCap = cap.fields?.[field] ?? { supported: false, reason: 'unsupported' as const };
        if (!fieldCap.supported) {
          throw new ValidationError(goalFieldCapabilityMessage(agent, field, fieldCap));
        }
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
    // A snapshot, when the caller supplies one, replaces resolution rather than supplementing it:
    // resolving the parent's ids here would read the live registry anyway, and would throw for a
    // skill deleted since the parent ran (#506).
    // Which namespace the target backend resolves skills in, read from the capability descriptor
    // rather than a hardcoded per-agent map (#507, using the vocabulary #508 added). A hardcoded map
    // is a second source of truth that drifts from the adapter: the adapter is what actually decides
    // what reaches the child process, so asking it is the only answer that cannot go stale.
    const skillDelivery = this.deps.agentCapabilities?.()[agent]?.static?.skills;
    // ONLY `nativeNames` is disqualifying, and the reason is the failure MODE, not the delivery mode.
    //
    //   workspacePaths -- Mercury ids become workspace paths the worker materialised. Usable.
    //   nativeNames    -- the backend resolves the name in its OWN store and EXITS NON-ZERO on an
    //                     unknown one. Every selected id is a guaranteed Run failure.
    //   none           -- the adapter ignores skills entirely. Harmless: the ids are recorded and
    //                     materialised, nothing forwards them, nothing dies.
    //
    // Treating `none` as incompatible was my first attempt and it broke 8 tests, because the `fake`
    // adapter declares `none` (#508) and every test Run uses it. `none` describes what the adapter
    // forwards, not whether Mercury may hold skill records -- so it must not change selection.
    const canUseMercurySkills = skillDelivery !== 'nativeNames';
    // A preset owns skill selection when it is present: the snapshot's effectiveSkills ARE the
    // resolved list (autoSelect already applied above). A snapshot (retry) carries the parent's
    // exact skill rows. Only a Run without a preset follows the original path.
    const resolved = resolvedWorkflow?.skills ?? (presetSnapshot
      ? presetSnapshot.effectiveSkills
      : input.skillSnapshots ?? this.deps.skills.resolve(
          input.skills === undefined || input.skills === null
            // An omitted `skills` for a nativeNames backend resolves to NOTHING. Not "fallback
            // suppressed" -- even a well-matched Mercury id is a fatal exit there, so selection is skipped
            // rather than merely denied its fallback.
            ? canUseMercurySkills
              ? this.deps.selector.select(input.task, available, 4)
              : []
            : input.skills,
        ));

    // Knowledge admission, validated before anything is written -- the same shape goal admission uses,
    // for the same reason: a block that is accepted and then quietly ignored leaves the caller believing
    // a constraint is in force.
    //
    // The feature being off is a refusal rather than a no-op. A caller who set `scopes` against a host
    // with no Atlas configured would otherwise get a normal-looking Run that knew nothing.
    let knowledgeRequest: KnowledgeRequest | null = null;
    if (input.knowledge !== undefined && input.knowledge !== null) {
      if (!this.deps.knowledge) {
        throw new ValidationError(
          'knowledge is not configured on this server (set MERCURY_ATLAS_URL); remove the knowledge block',
        );
      }
      try {
        knowledgeRequest = parseKnowledgeRequest(input.knowledge);
      } catch (err) {
        throw new ValidationError(err instanceof KnowledgeRequestError ? err.message : String(err));
      }
    }

    // With a preset, the snapshot's effectiveConstraints ARE the Run's constraints: resolution
    // already merged the caller input with preset ceilings/defaults and system policy, and the
    // executed Run must match what the snapshot records (otherwise the snapshot documents
    // limits the worker never applies). The legacy path below is the no-preset behavior.
    const constraints: RunConstraints = resolvedWorkflow
      ? resolvedWorkflow.constraints
      : presetSnapshot
      ? presetSnapshot.effectiveConstraints
      : {
        maxDurationMs: input.constraints?.maxDurationMs ?? this.deps.defaultMaxDurationMs,
        maxRetries: input.constraints?.maxRetries ?? this.deps.defaultMaxRetries,
        // Absolute deadline that counts queue time (#731); inherited verbatim by retries.
        notAfter: input.constraints?.notAfter,
        // Bot attribution hint (dispatcher-bot-design §4.3); recorded verbatim, never enforced.
        botTask: input.constraints?.botTask,
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

    // Whether this Run gets a pack, and whether asking for one is even possible on this agent.
    //
    // The asymmetry is deliberate and comes from section 7.4. Ingest fails OPEN: an agent whose ability
    // to receive a pack is unverified simply gets no pack, because an unknown harness version must not
    // brick a Run. `require: true` fails CLOSED: a caller who asked for the pack and did not get it was
    // given something other than what they asked for, and silence is the wrong way to report that.
    const knowledgeDeps = this.deps.knowledge;
    const wantsPack = knowledgeDeps !== undefined
      && (knowledgeRequest?.enabled ?? knowledgeDeps.injectByDefault);
    const knowledgeCap = knowledgeDeps ? knowledgeDeps.capabilities?.()[agent]?.static?.knowledge : undefined;
    if (knowledgeRequest?.require && !wantsPack) {
      throw new ValidationError(
        knowledgeCapabilityMessage(agent, knowledgeDeps
          ? 'injection is disabled for this host and knowledge.enabled was false'
          : 'knowledge is not configured on this server'),
      );
    }
    if (knowledgeRequest?.require && knowledgeCap === false) {
      throw new ValidationError(knowledgeCapabilityMessage(agent, 'the adapter does not declare knowledge support'));
    }
    // Computed inside the transaction below, because it reads the replica and the snapshot must be
    // consistent with the Run row that references it. Declared here so the event append can see it.
    let knowledgeSelection: PackSelection | null = null;

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
      model: model ?? null,
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
        // The workflow snapshot lands in the SAME transaction as the Run row (workflows.md
        // section 5): a failure before commit leaves no partial Run or snapshot row, and a
        // committed Run always renders from the exact bytes it was created with.
        if (resolvedWorkflow) {
          const wfSnap = resolvedWorkflow.snapshot;
          const row: RunWorkflowRow = {
            runId: run.id,
            workflowId: wfSnap.id,
            workflowVersion: wfSnap.version,
            mode: wfSnap.mode,
            trust: wfSnap.trust,
            contentHash: wfSnap.contentHash,
            sourceKind: wfSnap.source.kind,
            sourcePath: wfSnap.source.relativePath,
            templateJson: wfSnap.templateJson,
            filesJson: JSON.stringify(wfSnap.files),
            snapshot: wfSnap,
          };
          this.workflowStore().insert(row);
          this.deps.events.append(run.id, 'workflow.selected', {
            workflowId: wfSnap.id,
            version: wfSnap.version,
            mode: wfSnap.mode,
            trust: wfSnap.trust,
            hash: wfSnap.contentHash,
            stages: wfSnap.stages.length,
            sourceKind: wfSnap.source.kind,
          });
          // Every stage preset referenced by the template is snapshotted with the Run
          // (section 3.1.1 rule 6), so later preset edits change nothing.
          for (const stage of resolvedWorkflow.stagePresets) {
            const stageRow: RunPresetRow = {
              runId: run.id,
              presetId: stage.snapshot.id,
              presetVersion: stage.snapshot.version,
              role: stage.snapshot.role,
              trust: stage.snapshot.trust,
              contentHash: stage.snapshot.contentHash,
              sourceKind: stage.snapshot.source.kind,
              sourceCommit: stage.snapshot.source.commit ?? null,
              sourcePath: stage.snapshot.source.relativePath,
              stageIndex: stage.stageIndex,
              snapshot: stage.snapshot,
            };
            this.presetStore()!.insert(stageRow);
          }
        }
        if (model !== undefined) {
          // The explainability record L1 builds on (#823): which model, and where it came from.
          // Not emitted for model-less Runs, so a Run created without `model` behaves
          // byte-identically to base. Retry passes the parent's recorded source (#832 r1): the
          // copied model was not chosen by a caller, and the record must not change origin.
          const source = input.modelSource ?? (input.model !== undefined ? 'caller' : 'preset');
          this.deps.events.append(run.id, 'run.model_resolved', { model, source });
        }
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
        // The preset snapshot lands in the SAME transaction as the Run row (section 5): a
        // failure before commit leaves no partial Run or preset row, and a committed Run
        // always carries the exact bytes it was created with.
        if (presetSnapshot) {
          const row: RunPresetRow = {
            runId: run.id,
            presetId: presetSnapshot.id,
            presetVersion: presetSnapshot.version,
            role: presetSnapshot.role,
            trust: presetSnapshot.trust,
            contentHash: presetSnapshot.contentHash,
            sourceKind: presetSnapshot.source.kind,
            sourceCommit: presetSnapshot.source.commit ?? null,
            sourcePath: presetSnapshot.source.relativePath,
            snapshot: presetSnapshot,
          };
          this.presetStore()!.insert(row);
          this.deps.events.append(run.id, 'preset.selected', {
            presetId: presetSnapshot.id,
            version: presetSnapshot.version,
            role: presetSnapshot.role,
            trust: presetSnapshot.trust,
            hash: presetSnapshot.contentHash,
            sourceKind: presetSnapshot.source.kind,
          });
        }

        if (wantsPack && knowledgeDeps) {
          knowledgeSelection = selectPack(knowledgeDeps.replica, {
            projectId: knowledgeDeps.projectId,
            // The REDACTED task, deliberately. Selection is the one place a task string influences what
            // the agent is told, and an unretracted path from a secret-bearing task line could otherwise
            // pull a note into a pack and echo it back through NOTES.md.
            task: safeTask,
            agent,
            repositories: [repository, ...(repositories ?? [])]
              .map((r) => r.url ?? r.localPath ?? '')
              .filter((v) => v.length > 0),
            ...(knowledgeRequest?.scopes ? { scopes: knowledgeRequest.scopes } : {}),
            // A caller may ask for a smaller pack; the host ceiling still applies, or one Run could ask
            // for a pack large enough to crowd out the harness's own context.
            maxBytes: Math.min(knowledgeRequest?.maxBytes ?? knowledgeDeps.packMaxBytes, knowledgeDeps.packMaxBytes),
          });
        }
        if (knowledgeSelection) {
          // Written here rather than by the worker, so a Run always has a snapshot by the time anything
          // can observe it. The worker materializes files; this row is the record of what was chosen,
          // and it must survive the workspace being garbage-collected.
          this.deps.db.prepare(`
            INSERT INTO run_knowledge (run_id, pack_hash, notes_json, note_count, byte_size, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(run.id, knowledgeSelection.packHash, JSON.stringify(knowledgeSelection.notes),
            knowledgeSelection.notes.length, knowledgeSelection.byteSize, now);
          this.deps.events.append(run.id, 'knowledge.selected', {
            packHash: knowledgeSelection.packHash,
            count: knowledgeSelection.notes.length,
            bytes: knowledgeSelection.byteSize,
            // The notes that did not fit. Without this a caller comparing two Runs sees a short pack and
            // cannot tell "nothing else matched" from "the budget cut it off".
            omitted: knowledgeSelection.omitted,
            scopes: knowledgeSelection.scopes,
          });
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

  /**
   * The goal attached to a Run, or null.
   *
   * Exposed as a SEPARATE field from the Run rather than folded into it, for two reasons. The
   * Run type mirrors the `runs` table and is persisted and replayed as that shape; and a
   * consumer that reads `run.status` must not be able to mistake a goal status for it -- the
   * two are orthogonal axes and the whole feature is about keeping them apart.
   */
  getGoal(runId: string): GoalState | null {
    return this.deps.goals?.get(runId) ?? null;
  }

  /**
   * The knowledge pack a Run was created with, or null when it was given none.
   *
   * Read from `run_knowledge`, never re-derived from the replica. That distinction is the point of the
   * table: notes get revised and retired, and a read that joined the current replica would silently
   * rewrite what a past Run was told. Answering "what did this Run know?" from today's data is exactly
   * how an incident review goes wrong.
   */
  getKnowledge(runId: string): { packHash: string; noteCount: number; byteSize: number; selectedAt: string; notes: unknown[] } | null {
    const row = this.deps.db.prepare(
      'SELECT pack_hash, notes_json, note_count, byte_size, created_at FROM run_knowledge WHERE run_id = ?',
    ).get(runId) as { pack_hash: string; notes_json: string; note_count: number; byte_size: number; created_at: string } | undefined;
    if (!row) return null;
    let notes: unknown[] = [];
    try {
      const parsed = JSON.parse(row.notes_json) as unknown;
      if (Array.isArray(parsed)) notes = parsed;
    } catch {
      // A snapshot that will not parse is reported as unreadable rather than as empty. An empty pack
      // would say "this Run was told nothing", which is a different and much more misleading claim.
      notes = [{ unreadable: true }];
    }
    return {
      packHash: row.pack_hash, noteCount: Number(row.note_count), byteSize: Number(row.byte_size),
      selectedAt: row.created_at, notes,
    };
  }

  /**
   * Drop a goal on operator instruction (docs/goals.md 8: `POST /api/runs/:id/goal/cancel`).
   *
   * This is the ONLY writer of `cancelled`, and it existed as a documented capability with no
   * implementation for three phases: `cancelled` sits in MERCURY_ONLY_GOAL_STATUSES, so a harness
   * is refused if it reports it, and nothing else set it. The status, the `goal.cancelled` event
   * type, the dashboard badge and the CLI colour were all live while no code path could produce
   * them -- surface built as if a feature existed.
   *
   * Cancel is a mutation the design allows. Section 12 forbids an operator REPLACING the
   * objective and FORBIDS an operator-authored `complete`, because both would put a
   * Mercury-originated judgement where only the harness may speak. Dropping a goal is neither:
   * it asserts nothing about whether the work was done, and `unmet` -- the status a terminal Run
   * would otherwise produce -- makes a claim about the harness falling short that an operator who
   * deliberately stopped tracking should be able to prevent.
   *
   * Owner-scoped through get(), so another owner's Run is a 404 rather than a 403, matching the
   * repo's standing rule that a Run must not be confirmable at all.
   */
  cancelGoal(runId: string, ownerId: string, isAdmin: boolean): GoalState {
    const run = this.get(runId, ownerId, isAdmin);
    if (!run) throw new NotFoundError('run not found');
    const goals = this.deps.goals;
    if (!goals) throw new ValidationError('goals are not enabled on this server');
    const goal = goals.get(runId);
    if (!goal) throw new NotFoundError('run has no goal');
    if (TERMINAL_GOAL_STATUSES.has(goal.status)) {
      // Refusing rather than no-op'ing matters: `complete` and `unmet` are verdicts, and an
      // operator cancelling a goal that already completed would erase the thing the feature
      // exists to record.
      throw new ConflictError(`goal is already ${goal.status}`);
    }
    const now = new Date().toISOString();
    let updated: GoalState | null = null;
    // Row and event in one transaction, like every other goal write: a `cancelled` row with no
    // event leaves the timeline claiming the goal was still active, and the reverse makes the
    // timeline the only true record of a state the row denies.
    tx(this.deps.db, () => {
      updated = goals.update(runId, { status: 'cancelled', source: 'operator' }, now);
      // Checked rather than asserted. Inside this transaction the row cannot vanish, so null
      // means the invariant is already broken -- but a non-null assertion would return
      // undefined to the caller as if the cancel had succeeded, and the event below would then
      // announce a state change that the row denies. Failing here keeps the transaction the
      // authority.
      if (!updated) throw new ConflictError('goal disappeared while being cancelled');
      this.deps.events.append(runId, 'goal.cancelled', { source: 'operator', runStatus: run.status });
    });
    return updated!;
  }

  /**
   * Goal status per Run for a page of Runs, as a map keyed by run id.
   *
   * Deliberately narrow: status plus `attempted`, not the whole row. The list view needs a word
   * per row, and carrying objectives here would put up to 4000 chars times the page limit into
   * every dashboard poll; the detail endpoint already returns the full row for the one Run a person
   * is looking at.
   *
   * `attempted` is the one field that earns its place beside the status. Status alone renders the
   * two kinds of `unmet` identically, and the list is where an operator actually looks, so the
   * distinction the gauge gained in #489 was invisible exactly where it was most needed (issue
   * #492). Nothing else did.
   *
   * A map rather than a field on each Run for the same reason `/api/agents` gained a parallel
   * `capabilities` field: `runs` stays an array of Run, and existing clients keep working.
   */
  goalStatuses(runIds: string[]): Record<string, GoalSummary> {
    const goals = this.deps.goals;
    if (!goals || runIds.length === 0) return {};
    return goals.statusesFor(runIds);
  }

  getSkills(runId: string): ResolvedSkill[] {
    const rows = this.deps.db
      .prepare('SELECT snapshot_json FROM run_skills WHERE run_id = ? ORDER BY skill_id')
      .all(runId) as { snapshot_json: string }[];
    return rows.map((r) => JSON.parse(r.snapshot_json) as ResolvedSkill);
  }

  /**
   * The preset snapshot a Run was created with, or null.
   *
   * Read from `run_presets`, never re-derived from the registry -- the same rule as
   * getSkills and the knowledge pack: notes get revised and definitions change, and a
   * read that re-resolved would silently rewrite what a past Run was told to be.
   */
  getPreset(runId: string): ResolvedRolePreset | null {
    return this.presetStore()?.get(runId) ?? null;
  }

  /**
   * The builtin preset registry, or null when presets are off. The API read surface
   * (browse/inspect) goes through this accessor so the composition root stays the only place
   * that knows how the registry is built -- exactly like listAgents for the agent ids.
   */
  presetRegistry(): PresetRegistry | null {
    return this.deps.presets ?? null;
  }

  /**
   * The workflow snapshot a Run was created from, or null.
   *
   * Read from `run_workflows`, never re-derived from the registry -- the same rule as
   * getSkills and getPreset: templates get revised, and a read that re-resolved would
   * silently rewrite what a past Run was told to do.
   */
  getWorkflow(runId: string): ResolvedWorkflow | null {
    return this.workflowStore().get(runId);
  }

  /**
   * The workflow's stage preset snapshots, keyed by stage index.
   *
   * A workflow Run writes one run_presets row per referenced stage (section 3.1.1 rule 6), so
   * the listing crosses the stage order with the store's insertion order. Both are
   * deterministic: the stage order comes from the snapshot's manifest and the store returns
   * rows in insertion order.
   */
  getWorkflowStagePresets(runId: string): { stageIndex: number; presetId: string; presetVersion: string; contentHash: string }[] {
    return this.getWorkflowStagePresetSnapshots(runId).map((s) => ({
      stageIndex: s.stageIndex,
      presetId: s.snapshot.id,
      presetVersion: s.snapshot.version,
      contentHash: s.snapshot.contentHash,
    }));
  }

  /**
   * The workflow's stage preset snapshots, keyed by stage index.
   *
   * A workflow Run writes one run_presets row per referenced stage (section 3.1.1 rule 6), so
   * the listing crosses the snapshot's stage order with the store's rows. Both are
   * deterministic: the stage order comes from the stored workflow snapshot and the store
   * returns rows in insertion order. This is what the WORKER renders stage guidance from --
   * the snapshot bytes, never the live registry.
   */
  getWorkflowStagePresetSnapshots(runId: string): { stageIndex: number; snapshot: ResolvedRolePreset }[] {
    const wf = this.getWorkflow(runId);
    if (!wf) return [];
    const rows = this.presetStore()?.listSnapshots(runId) ?? [];
    const byPreset = new Map(rows.map((r) => [r.presetId, r.snapshot]));
    const out: { stageIndex: number; snapshot: ResolvedRolePreset }[] = [];
    wf.stages.forEach((stage, i) => {
      if (!stage.preset) return;
      const snapshot = byPreset.get(stage.preset.id);
      if (!snapshot) {
        // A committed workflow row whose stage rows are missing means the creation write was
        // corrupted (or the rows were deleted outside the product). Fail the read loudly
        // rather than rendering guidance from nowhere (the read-side truth rule).
        throw new Error(
          `workflow stage preset row missing: run ${runId}, stage ${i} (${JSON.stringify(stage.preset.id)})`,
        );
      }
      out.push({ stageIndex: i, snapshot });
    });
    return out;
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
    // The parent's stored snapshots, not its ids (#506). Passing ids would re-resolve against the
    // live registry, so a retried Run would execute skill bytes its parent never saw -- and if a
    // skill had been deleted, create() would throw and the retry could not be attempted at all.
    const skillSnapshots = this.getSkills(runId);
    // The parent's workflow snapshot, verbatim (#842 review): template bytes, stage preset
    // snapshots and the skill rows, the same trio create() writes for a workflow Run. Without
    // this a retried workflow Run silently executes as a plain Run -- no run_workflows row, no
    // stage guidance, no plan -- the exact failure the snapshot rule exists to prevent.
    const parentWorkflow = this.getWorkflow(runId);
    const workflowSnapshot = parentWorkflow
      ? {
          workflow: parentWorkflow,
          stagePresets: this.getWorkflowStagePresetSnapshots(runId),
          skills: skillSnapshots,
        }
      : undefined;
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
    // The parent's recorded model origin (#832 r1): a preset-sourced parent must not become
    // 'caller' on the retry, or the explainability record changes meaning across retries.
    const parentModelSource = original.model
      ? this.deps.events.list(runId).find((e) => e.type === 'run.model_resolved')
        ?.payload as { source?: 'caller' | 'preset' } | undefined
      : undefined;

    const created = this.create({
      ownerId: original.ownerId,
      task: original.task,
      repository: { ...original.repository },
      repositories: original.repositories,
      agent: original.agent,
      // Retry re-attempts the SAME work (#823): the model the parent carried is part of that
      // work, exactly like the skill/preset snapshots. A parent WITHOUT a model stays without.
      model: original.model ?? undefined,
      ...(original.model && parentModelSource?.source ? { modelSource: parentModelSource.source } : {}),
      skillSnapshots,
      ...(workflowSnapshot ? { workflowSnapshot } : {}),
      constraints: { ...original.constraints },
      // The parent's preset snapshot, verbatim (section 6): a retry is the SAME task
      // configuration, so it must not re-resolve "latest" -- a preset edited between the
      // original and the retry must not change what the retry executes.
      presetSnapshot: this.getPreset(runId) ?? undefined,
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
const CONSTRAINT_KEYS = new Set(['maxDurationMs', 'maxRetries', 'budgetTokens', 'budgetCost', 'resourceLimits', 'allowedNetworks', 'notAfter', 'botTask']);

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
      // Section 3.3: malformed values are rejected BEFORE the Run is inserted, not at container
      // start where they first fail. The parsers mirror what the sandbox manager passes to
      // docker/podman (#725).
      if (k === 'cpu' && parseCpuLimit(v) === null) {
        throw new ValidationError(`resourceLimits.cpu ${JSON.stringify(v)} is not a positive decimal (e.g. "1.5")`);
      }
      if (k !== 'cpu' && parseByteLimit(v) === null) {
        throw new ValidationError(`resourceLimits.${k} ${JSON.stringify(v)} is not a positive integer with an optional b/k/m/g suffix (e.g. "512m")`);
      }
    }
  }
  const an = c.allowedNetworks;
  if (an !== undefined) {
    if (!Array.isArray(an) || an.some((x) => typeof x !== 'string')) {
      throw new ValidationError('constraint allowedNetworks must be an array of strings');
    }
  }
  const bt = c.botTask;
  if (bt !== undefined) {
    // A recorded-only hint (§4.3), but the bot's singleFlight groups Runs by it, so constrain it
    // to the same task-name vocabulary the bot config enforces (keys.ts dispatchKey). Anything
    // else would let two different tasks collide under one hint.
    if (typeof bt !== 'string' || !/^[a-z0-9-]+$/.test(bt)) {
      throw new ValidationError('constraint botTask must be a string matching ^[a-z0-9-]+$');
    }
  }
  const na = c.notAfter;
  if (na !== undefined) {
    // An ABSOLUTE deadline must name its offset: a timezone-less '2026-01-01T00:00:00' parses via
    // Date.parse as server-local time, so the same config string means different instants on
    // different hosts. Require an explicit Z or ±hh:mm offset and parse once.
    if (
      typeof na !== 'string'
      || !/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:Z|[+-]\d{2}:\d{2})$/.test(na)
      || Number.isNaN(Date.parse(na))
    ) {
      throw new ValidationError('constraint notAfter must be an ISO-8601 timestamp with an explicit UTC offset (Z or ±hh:mm)');
    }
    // Must be in the future AT CREATION: a deadline already passed would make the Run
    // unstartable by construction, which is a caller mistake, not a queue state (#731).
    if (Date.parse(na) <= Date.now()) {
      throw new ValidationError('constraint notAfter must be in the future');
    }
  }
}

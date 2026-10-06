// Multi-preset resolution for advisory workflow creation (docs/crew/workflows.md section 3.1.1).
//
// Pure and deterministic: the same template, caller input, system policy and capability answers
// produce the same resolution. Nothing here touches the database or the filesystem -- the caller
// (RunService.create) owns transaction, snapshots and events.
//
// The rule is deliberately conservative (section 3.1.1): a multi-stage plan can never get a
// wider ceiling, an extra agent or more skills than its strictest stage allows. Stage presets
// are DEFAULTS and DEMANDS for their own step; the Run's caller and the system defaults still
// win wherever the stages do not agree.

import { ValidationError } from '../domain/errors.ts';
import type { RunConstraints } from '../domain/types.ts';
import type { AgentStaticCapabilities } from '../domain/types.ts';
import type { ResolvedSkill } from '../domain/types.ts';
import type { LoadedPreset } from '../presets/types.ts';
import { SKILL_SYSTEM_CAP, resolveSkillIds } from '../presets/resolvePreset.ts';

/** The caller surface for a workflow create (docs/crew/workflows.md section 5, issue #809). */
export interface WorkflowCallerInput {
  agent?: string;
  model?: string;
  skills?: string[];
  constraints?: Partial<RunConstraints>;
}

/** Host policy the workflow can only narrow (the same shape resolvePreset takes). */
export interface WorkflowSystemPolicy {
  defaultAgent: string;
  defaultMaxDurationMs: number;
  defaultMaxRetries: number;
}

export interface WorkflowCapabilityLookup {
  knownAgents: readonly string[];
  staticCapabilities?: (agent: string) => AgentStaticCapabilities | undefined;
}

/**
 * The pure resolution result. Skills resolve to FULL snapshots because the union crosses
 * preset boundaries (section 3.1.1 rule 4): the caller needs the bytes, not just ids, and
 * dedupe must keep the first preset's exact bytes rather than re-resolving by id.
 */
export interface ResolvedWorkflowSelection {
  effectiveAgent: { id: string; model?: string };
  effectiveConstraints: RunConstraints;
  /**
   * Union of the stage presets' `skills.required`, de-duplicated, each stage preset's
   * auto-selection applied per stage (section 3.1.1 rule 4), then the deterministic selector
   * budget on top (RunService owns the selector). Stage defaults are deliberately NOT unioned:
   * rule 4 unions REQUIRED skills, and a stage's soft defaults would silently widen the plan.
   */
  requiredSkillIds: string[];
  /**
   * Skill ids each stage preset wants auto-selected for, keyed by stage index, in stage
   * order. RunService runs the deterministic selector over these per stage and merges the
   * picks into the union before the cap check.
   */
  autoSelectStages: { stageIndex: number; presetId: string }[];
  /** The system cap in force for the union (section 3.1.1 rule 4: exceed it and creation fails). */
  skillCap: number;
  /** Stage presets resolved for their own step, in stage order (instruction guidance). */
  stagePresets: { stageIndex: number; presetId: string; preset: LoadedPreset }[];
}

/**
 * One preset the template references failed to resolve. Carries the W-1 finding code verbatim
 * so creation fails with "the W-1 finding codes" (issue #809 acceptance 5) instead of a
 * different vocabulary for the same fact.
 */
export class WorkflowPresetResolutionError extends ValidationError {
  readonly code: string;
  readonly field: string;
  constructor(code: string, field: string, message: string) {
    super(message);
    this.name = 'WorkflowPresetResolutionError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Resolve a Run that names one preset per stage (section 3.1.1).
 *
 * Stages contribute DEMANDS only -- a required agent, a required model, a sandbox
 * requirement, ceilings, required skills -- read straight from each stage manifest. A stage's
 * non-required agent or model preference is ignored (rules 1-2), so it is never resolved and
 * never capability-checked: an advisory Run is performed by ONE agent, and the only agent
 * whose capabilities matter is that final one (#842 review r4). Single-preset resolution per
 * stage got both directions wrong: it refused Runs over agents no stage required (an
 * unregistered or role-instruction-less preference) and checked the stage's agent instead of
 * the final one (a sandbox demand slipped past a `sandbox: false` final agent). It also
 * pre-empted the W-2 conflict codes with the single-preset wording.
 */
export function resolveWorkflowStages(
  workflow: { id: string; stages: { id: string; preset?: { id: string; version?: string } }[] },
  caller: WorkflowCallerInput,
  system: WorkflowSystemPolicy,
  caps: WorkflowCapabilityLookup,
  getPreset: (id: string) => LoadedPreset,
): ResolvedWorkflowSelection {
  const stagePresets: ResolvedWorkflowSelection['stagePresets'] = [];
  const agentVotes = new Map<string, { stageIndex: number; required: boolean }>();
  const modelVotes = new Map<string, { stageIndex: number; required: boolean }>();
  const requiredSkillIds: string[] = [];
  const seenSkills = new Set<string>();
  const autoSelectStages: { stageIndex: number; presetId: string }[] = [];
  const sandboxStages: number[] = [];

  workflow.stages.forEach((stage, stageIndex) => {
    if (!stage.preset) return;
    let loaded: LoadedPreset;
    try {
      loaded = getPreset(stage.preset.id);
    } catch {
      // The W-1 code for a dead reference: validation (registry load) refuses unknown presets
      // with WORKFLOW_STAGE_PRESET_MISSING, and the creation path reports the same code so a
      // caller cannot tell the two checks apart (issue #809 acceptance 5).
      throw new WorkflowPresetResolutionError(
        'WORKFLOW_STAGE_PRESET_MISSING',
        `stages[${stageIndex}].preset`,
        `preset ${JSON.stringify(stage.preset.id)} does not resolve in the preset registry`,
      );
    }
    stagePresets.push({ stageIndex, presetId: loaded.id, preset: loaded });

    // A sandbox-required stage must not lose its demand in the fold (rule 3, #842 review r2):
    // the constraint fold below applies the empty-resourceLimits sentinel for these stages,
    // and the final agent is checked against the demand once the agent is known.
    if (loaded.manifest.requires?.sandbox === true) sandboxStages.push(stageIndex);

    // Rule 1 -- agent: only a REQUIRED agent is a demand. A preference is ignored: no vote,
    // no resolution, no capability check (#842 review r4).
    const manifestAgent = loaded.manifest.agent;
    if (manifestAgent?.required === true) {
      if (!manifestAgent.id) {
        throw new ValidationError(`stages[${stageIndex}].preset ${JSON.stringify(loaded.id)} requires an agent but declares none`);
      }
      if (!agentVotes.has(manifestAgent.id)) agentVotes.set(manifestAgent.id, { stageIndex, required: true });
    }

    // Rule 2 -- model: the same agreement rule; a non-required model is ignored.
    if (manifestAgent?.modelRequired === true) {
      if (!manifestAgent.model) {
        throw new ValidationError(`stages[${stageIndex}].preset ${JSON.stringify(loaded.id)} requires a model but declares none`);
      }
      if (!modelVotes.has(manifestAgent.model)) modelVotes.set(manifestAgent.model, { stageIndex, required: true });
    }

    // Rule 4 -- skills: the union of the stages' REQUIRED skills, de-duplicated by first
    // occurrence. Duplicates are recorded so a later over-cap failure can name the stages
    // that demanded them.
    for (const id of loaded.manifest.skills?.required ?? []) {
      if (!seenSkills.has(id)) {
        seenSkills.add(id);
        requiredSkillIds.push(id);
      }
    }
    // Auto-selection is per stage (section 3.1.1 rule 4 defers to role-presets section 3.2):
    // a stage whose preset resolves empty runs the deterministic selector, exactly like a
    // single-preset Run would. Stage DEFAULT skills stay stage-local -- they are the soft
    // start list that rule feeds, not part of the Run-wide union.
    // The single-preset skill rule (role-presets section 3.2), shared rather than copied, with
    // the caller's skill list -- the only caller input skill precedence consumes.
    if (resolveSkillIds(loaded.manifest, { skills: caller.skills }).autoSelect) {
      autoSelectStages.push({ stageIndex, presetId: loaded.id });
    }
  });

  // Rule 4 verdict: the union over the cap fails with a finding naming the stages (nothing
  // is dropped). Selector picks are merged later by the caller; the REQUIRED union alone
  // failing the cap is a template defect, so it is refused here at resolution time.
  if (requiredSkillIds.length > SKILL_SYSTEM_CAP) {
    const demands = stagePresets
      .filter((s) => (s.preset.manifest.skills?.required ?? []).length > 0)
      .map((s) => `stages[${s.stageIndex}] (${s.presetId})`);
    throw new WorkflowSkillCapError(requiredSkillIds.length, SKILL_SYSTEM_CAP, {
      stages: demands,
      skills: [...seenSkills],
    });
  }

  // Rule 1 verdict: two different REQUIRED agents cannot share one Run (one agent performs
  // every step). Different preset DEFAULTS do not conflict -- they are ignored -- but a
  // required agent always wins over the caller, and two different required agents fail.
  const requiredAgents = new Set<string>();
  for (const [agentId, vote] of agentVotes) {
    if (vote.required) requiredAgents.add(agentId);
  }
  if (requiredAgents.size > 1) {
    const named = [...requiredAgents].sort().map((a) => JSON.stringify(a)).join(' and ');
    throw new WorkflowPresetResolutionError(
      'WORKFLOW_STAGE_AGENT_CONFLICT',
      'stages',
      `stages require different agents (${named}); one agent performs every step of an`
      + ' advisory Run, so the template is unusable in this mode',
    );
  }
  if (requiredAgents.size === 1) {
    const required = [...requiredAgents][0]!;
    if (caller.agent !== undefined && caller.agent !== required) {
      throw new WorkflowPresetResolutionError(
        'WORKFLOW_STAGE_AGENT_CONFLICT',
        'agent',
        `a stage requires agent ${JSON.stringify(required)}; caller asked for ${JSON.stringify(caller.agent)}`,
      );
    }
  }
  const requiredAgent = requiredAgents.size === 1 ? [...requiredAgents][0]! : undefined;

  // Rule 2 verdict: same shape as the agent rule.
  const requiredModels = new Set<string>();
  for (const [modelId, vote] of modelVotes) {
    if (vote.required) requiredModels.add(modelId);
  }
  if (requiredModels.size > 1) {
    const named = [...requiredModels].sort().map((m) => JSON.stringify(m)).join(' and ');
    throw new WorkflowPresetResolutionError(
      'WORKFLOW_STAGE_MODEL_CONFLICT',
      'stages',
      `stages require different models (${named}); one agent performs every step of an`
      + ' advisory Run, so the template is unusable in this mode',
    );
  }
  if (requiredModels.size === 1) {
    const required = [...requiredModels][0]!;
    if (caller.model !== undefined && caller.model !== required) {
      throw new WorkflowPresetResolutionError(
        'WORKFLOW_STAGE_MODEL_CONFLICT',
        'model',
        `a stage requires model ${JSON.stringify(required)}; caller asked for ${JSON.stringify(caller.model)}`,
      );
    }
  }
  const requiredModel = requiredModels.size === 1 ? [...requiredModels][0]! : undefined;

  // Rules 1-2 result: the caller wins unless a stage REQUIRED the other value. Non-required
  // stage preferences are ignored (rule 1: "no stage gets to pick the agent for all the
  // others"), so the fallback is caller -> system default, never a stage default.
  const agent = requiredAgent ?? caller.agent ?? system.defaultAgent;
  if (!caps.knownAgents.includes(agent)) {
    throw new ValidationError(`Unknown agent: ${agent} (known: ${caps.knownAgents.join(', ')})`);
  }
  const model = requiredModel ?? caller.model;

  // Capabilities are checked ONCE, against the agent that performs every step (#842 review r4).
  // The plan channel (workflowPlan) and the per-Run model (perRunModel) are enforced by
  // RunService on this same final agent; the sandbox demand is checked here because only this
  // function knows which stages made it. Role instructions are NOT required: advisory stage
  // instructions travel inside the plan, never as a Run-wide role instruction (section 5).
  if (sandboxStages.length > 0 && caps.staticCapabilities?.(agent)?.sandbox === false) {
    const named = sandboxStages.map((i) => `stages[${i}]`).join(', ');
    throw new WorkflowPresetResolutionError(
      'WORKFLOW_STAGE_SANDBOX_CONFLICT',
      'agent',
      `${named} require${sandboxStages.length === 1 ? 's' : ''} sandboxed execution, but agent`
      + ` ${JSON.stringify(agent)} declares sandbox: false; pick an agent that runs sandboxed`,
    );
  }

  // Rule 3 -- constraints: the narrowest ceiling across all stage presets (scalar minimums,
  // the most restrictive networkMode), applied to the CALLER's constraints; defaults come
  // from the caller, otherwise the system default, never from a stage preset.
  const effectiveConstraints = narrowestConstraints(workflow, caller, system, getPreset, sandboxStages);

  return {
    effectiveAgent: { id: agent, ...(model !== undefined ? { model } : {}) },
    effectiveConstraints,
    requiredSkillIds,
    autoSelectStages,
    skillCap: SKILL_SYSTEM_CAP,
    stagePresets,
  };
}

/**
 * Rule 3: start from the caller's constraints (system defaults where absent) and narrow by
 * EVERY stage preset's ceilings. Stage preset DEFAULTS are not consulted: rule 3 says defaults
 * come from the caller, otherwise the system default, never from a stage preset.
 */
function narrowestConstraints(
  workflow: { stages: { preset?: { id: string; version?: string } }[] },
  caller: WorkflowCallerInput,
  system: WorkflowSystemPolicy,
  getPreset: (id: string) => LoadedPreset,
  sandboxStages: readonly number[],
): RunConstraints {
  const effective: RunConstraints = {
    maxDurationMs: caller.constraints?.maxDurationMs ?? system.defaultMaxDurationMs,
    maxRetries: caller.constraints?.maxRetries ?? system.defaultMaxRetries,
    // Absolute deadline that counts queue time (#731); recorded verbatim.
    notAfter: caller.constraints?.notAfter,
    botTask: caller.constraints?.botTask,
    budgetTokens: caller.constraints?.budgetTokens,
    budgetCost: caller.constraints?.budgetCost,
    resourceLimits: caller.constraints?.resourceLimits,
    allowedNetworks: caller.constraints?.allowedNetworks,
  };
  for (const [stageIdx, stage] of workflow.stages.entries()) {
    if (!stage.preset) continue;
    // Isolation applies before the ceilings guard: a stage can demand sandboxing without
    // naming any ceiling (#842 review r2). The sentinel is injected only when nothing already
    // requests isolation (#842 review r3): the caller's own limits are isolation requests too,
    // and overwriting them WIDENS the effective policy (a 512m caller limit would be lost).
    if (sandboxStages.includes(stageIdx) && effective.resourceLimits === undefined) {
      effective.resourceLimits = {};
    }
    const ceilings = getPreset(stage.preset.id).manifest.constraints?.ceilings;
    if (!ceilings) continue;
    if (ceilings.maxDurationMs !== undefined) {
      effective.maxDurationMs = Math.min(effective.maxDurationMs, ceilings.maxDurationMs);
    }
    if (ceilings.maxRetries !== undefined) {
      effective.maxRetries = Math.min(effective.maxRetries, ceilings.maxRetries);
    }
    if (ceilings.resourceLimits) {
      const rl: NonNullable<RunConstraints['resourceLimits']> = { ...(effective.resourceLimits ?? {}) };
      for (const key of ['cpu', 'memory', 'disk'] as const) {
        const ceiling = ceilings.resourceLimits[key];
        if (ceiling === undefined) continue;
        const value = rl[key];
        // "Narrower" is not measurable for a string limit (the resolvePreset rule, section
        // 3.3): a ceiling is applied only when the field is unset, and a value that is ALREADY
        // set must equal the ceiling or creation fails -- a caller value above a stage ceiling
        // would admit a Run past the sandbox policy, and two stage presets with incompatible
        // ceilings have no honest intersection (#842 review). Equality is fine, in both cases.
        if (value === undefined) {
          rl[key] = ceiling;
        } else if (value !== ceiling) {
          throw new WorkflowPresetResolutionError(
            'WORKFLOW_STAGE_RESOURCE_CONFLICT',
            `constraints.resourceLimits.${key}`,
            `resourceLimits.${key} = ${JSON.stringify(value)} conflicts with stage preset`
            + ` ${JSON.stringify(stage.preset.id)}'s ceiling ${JSON.stringify(ceiling)};`
            + ' narrower cannot be measured, so differing values are refused, not kept',
          );
        }
      }
      if (rl.cpu !== undefined || rl.memory !== undefined || rl.disk !== undefined) {
        effective.resourceLimits = rl;
      }
    }
    if (ceilings.networkMode === 'none') {
      // The most restrictive networkMode wins (rule 3: none beats bridge). A recorded
      // allowedNetworks list under a none ceiling is emptied -- the coarse vocabulary's
      // honest narrow (the resolvePreset #723 rule).
      effective.allowedNetworks = [];
    }
  }
  return effective;
}

/** Over-cap union error naming the stages that demanded skills (section 3.1.1 rule 4). */
export class WorkflowSkillCapError extends ValidationError {
  readonly code = 'WORKFLOW_STAGE_SKILLS_CAP';
  constructor(total: number, cap: number, demands: { stages: string[]; skills: string[] }) {
    super(
      `workflow's stage presets resolve to ${total} required skills; the effective maximum is ${cap}.`
      + ` Demanded by stages ${demands.stages.join(', ')} (skills: ${demands.skills.join(', ')});`
      + ' nothing is dropped silently -- remove a skill from the template or split the plan',
    );
    this.name = 'WorkflowSkillCapError';
  }
}

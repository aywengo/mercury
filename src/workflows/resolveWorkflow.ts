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
import { SKILL_SYSTEM_CAP } from '../presets/resolvePreset.ts';

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
 * `resolvePreset` takes the caller, system and capability inputs this function forwards; the
 * per-stage preset gets the caller input EXACTLY as a single-preset Run would, so the same
 * conflict rules (required agent/model, ceiling refusal) apply inside a stage too. The
 * stage-by-stage results then combine under the agreement rules.
 */
export function resolveWorkflowStages(
  workflow: { id: string; stages: { id: string; preset?: { id: string; version?: string } }[] },
  caller: WorkflowCallerInput,
  system: WorkflowSystemPolicy,
  caps: WorkflowCapabilityLookup,
  resolvePreset: typeof import('../presets/resolvePreset.ts').resolvePreset,
  getPreset: (id: string) => LoadedPreset,
): ResolvedWorkflowSelection {
  const stagePresets: ResolvedWorkflowSelection['stagePresets'] = [];
  const agentVotes = new Map<string, { stageIndex: number; required: boolean }>();
  const modelVotes = new Map<string, { stageIndex: number; required: boolean }>();
  const requiredSkillIds: string[] = [];
  const seenSkills = new Set<string>();
  const autoSelectStages: { stageIndex: number; presetId: string }[] = [];

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

    // The stage preset resolves with the caller input a single-preset Run would carry, so its
    // own required-agent/required-model/ceiling refusals apply per stage. The per-stage result's
    // agent preference feeds the agreement vote below; its constraints feed the narrowest-ceiling
    // fold; its required skills feed the union.
    // Constraints are folded separately below (rule 3: the narrowest ceiling across stages),
    // so the per-stage call receives no caller constraints: resolvePreset's ceiling-refusal
    // rule is a single-preset rule ("the caller asked past MY ceiling"), while a workflow
    // fold must only narrow -- the caller's scalar value survives the fold unless a stage
    // ceiling is lower (decided in workflows.md 3.1.1 rule 3, not a per-stage refusal).
    const stageSelection = resolvePreset(loaded.manifest, { ...caller, constraints: undefined }, system, caps);

    // Rule 1 -- agent: required beats preference; preferences are ignored, never resolved.
    const manifestAgent = loaded.manifest.agent;
    if (manifestAgent?.required === true && manifestAgent.id) {
      const vote = agentVotes.get(manifestAgent.id);
      if (!vote || !vote.required) agentVotes.set(manifestAgent.id, { stageIndex, required: true });
    } else if (stageSelection.effectiveAgent.id !== caller.agent
      && stageSelection.effectiveAgent.id !== system.defaultAgent) {
      // A preset DEFAULT (non-required) reached only through the preset, not through the caller:
      // a preference, which rule 1 says is ignored.
      const presetDefault = manifestAgent?.id;
      if (presetDefault && presetDefault !== caller.agent) {
        const vote = agentVotes.get(presetDefault);
        if (!vote) agentVotes.set(presetDefault, { stageIndex, required: false });
      }
    }

    // Rule 2 -- model: same agreement rule as the agent.
    if (manifestAgent?.modelRequired === true && manifestAgent.model) {
      const vote = modelVotes.get(manifestAgent.model);
      if (!vote || !vote.required) modelVotes.set(manifestAgent.model, { stageIndex, required: true });
    } else if (loaded.manifest.agent?.model && loaded.manifest.agent.model !== caller.model) {
      const vote = modelVotes.get(loaded.manifest.agent.model);
      if (!vote) modelVotes.set(loaded.manifest.agent.model, { stageIndex, required: false });
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
    if (stageSelection.autoSelect) {
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

  // Rule 3 -- constraints: the narrowest ceiling across all stage presets (scalar minimums,
  // the most restrictive networkMode), applied to the CALLER's constraints; defaults come
  // from the caller, otherwise the system default, never from a stage preset.
  const effectiveConstraints = narrowestConstraints(workflow, caller, system, getPreset);

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
  for (const stage of workflow.stages) {
    if (!stage.preset) continue;
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

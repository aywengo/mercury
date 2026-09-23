// Preset resolution for Run creation (docs/crew/role-presets.md sections 3 and 5).
//
// Pure and deterministic: the same manifest, source bytes, caller input and system policy
// produce the same effective values. Nothing here touches the database or the filesystem --
// the caller (RunService.create) owns transaction, snapshots and events.

import { ValidationError } from '../domain/errors.ts';
import type { RunConstraints } from '../domain/types.ts';
import type { AgentStaticCapabilities } from '../domain/types.ts';
import type { RolePresetManifest } from './types.ts';

/** What the caller may influence when a preset is selected (API shape, section 5). */
export interface PresetCallerInput {
  agent?: string;
  model?: string;
  /**
   * Caller skill list. `undefined` means "use preset defaults"; an EXPLICIT empty array means
   * "no skills" -- defaults are skipped and auto-selection is suppressed. `required` skills are
   * appended in both cases (the caller cannot remove them, section 3.2).
   */
  skills?: string[];
  constraints?: Partial<RunConstraints>;
}

/** Host policy the preset can only narrow (section 3.3: system policy is authoritative). */
export interface PresetSystemPolicy {
  defaultAgent: string;
  defaultMaxDurationMs: number;
  defaultMaxRetries: number;
}

/** Everything resolution needs to know about the selected adapter (section 8). */
export interface PresetCapabilityLookup {
  knownAgents: readonly string[];
  /** Static capabilities of the selected agent, or undefined when unknown. */
  staticCapabilities?: (agent: string) => AgentStaticCapabilities | undefined;
}

/** The pure resolution result; RunService turns this into the stored snapshot. */
export interface ResolvedPresetSelection {
  effectiveAgent: { id: string; model?: string };
  /**
   * Effective skill ids in final order: caller-or-defaults first, required appended,
   * deduplicated by first occurrence, capped. Snapshot resolution happens in RunService,
   * which owns the registry.
   */
  effectiveSkillIds: string[];
  /**
   * True when the start list was empty, the caller provided no list, and the preset has not
   * disabled auto-selection: RunService must run the deterministic selector and then append the
   * preset's required skills (#724). An explicit caller `[]` keeps this false -- "no skills" is
   * a decision, not an absence of one.
   */
  autoSelect: boolean;
  /** Effective skill maximum (min of the manifest max and the system cap) for the selector budget. */
  skillCap: number;
  effectiveConstraints: RunConstraints;
  /** True when the preset demanded sandboxing (RunService/worker fail closed on it). */
  requiresSandbox: boolean;
}

/** System cap on effective skills (section 3.2 step 5); the manifest max can only lower it. */
export const SKILL_SYSTEM_CAP = 4;

export function resolvePreset(
  manifest: RolePresetManifest,
  caller: PresetCallerInput,
  system: PresetSystemPolicy,
  caps: PresetCapabilityLookup,
): ResolvedPresetSelection {
  const skillResolution = resolveSkillIds(manifest, caller);
  return {
    effectiveAgent: resolveAgent(manifest, caller, system, caps),
    effectiveSkillIds: skillResolution.ids,
    autoSelect: skillResolution.autoSelect,
    skillCap: skillResolution.cap,
    effectiveConstraints: resolveConstraints(manifest, caller, system),
    requiresSandbox: manifest.requires?.sandbox === true,
  };
}

/**
 * Agent precedence (section 3.1):
 *   required=true -> the preset's id is mandatory; a differing caller is an ERROR, not an
 *   override. Otherwise caller > preset > system default. The final id passes the same
 *   known-agent check a Run without a preset passes.
 */
function resolveAgent(
  manifest: RolePresetManifest,
  caller: PresetCallerInput,
  system: PresetSystemPolicy,
  caps: PresetCapabilityLookup,
): { id: string; model?: string } {
  const presetAgent = manifest.agent;
  let id: string;
  if (presetAgent?.required === true) {
    const required = presetAgent.id;
    if (!required) {
      // validatePreset rejects this shape; resolution refuses it too, because this function
      // is also the guard for manifests that reach it from other sources.
      throw new ValidationError('preset requires an agent but declares none');
    }
    if (caller.agent !== undefined && caller.agent !== required) {
      throw new ValidationError(
        `preset requires agent ${JSON.stringify(required)}; caller asked for ${JSON.stringify(caller.agent)}`,
      );
    }
    id = required;
  } else {
    id = caller.agent ?? presetAgent?.id ?? system.defaultAgent;
  }
  if (!caps.knownAgents.includes(id)) {
    throw new ValidationError(`Unknown agent: ${id} (known: ${caps.knownAgents.join(', ')})`);
  }

  // Model: structured default, never argv (section 3.1). Caller wins unless modelRequired;
  // a required model with a conflicting caller model is rejected, and a model the selected
  // adapter cannot express fails closed.
  let model: string | undefined;
  if (presetAgent?.modelRequired === true) {
    const required = presetAgent.model;
    if (!required) {
      throw new ValidationError('preset requires a model but declares none');
    }
    if (caller.model !== undefined && caller.model !== required) {
      throw new ValidationError(
        `preset requires model ${JSON.stringify(required)}; caller asked for ${JSON.stringify(caller.model)}`,
      );
    }
    model = required;
  } else {
    model = caller.model ?? presetAgent?.model;
  }
  // Capability vocabulary (section 8), enforced AT CREATION: a Run admitted here must not
  // discover at execution time that its harness never received the role, or that the sandbox
  // request the preset demands is one the adapter refuses. Unknown capabilities fail closed:
  // "unknown" is not supported, which is the same rule the goal fields use (docs/status.md).
  //
  // Every VALID preset carries an instruction: an absent manifest block means the default
  // INSTRUCTION.md file, and validation refuses a missing file (PRESET_INSTRUCTION_MISSING).
  // So the role-instruction check is unconditional -- there is no instruction-less preset for
  // a 'none' agent to be admissible on.
  const stat = caps.staticCapabilities?.(id);
  if (stat === undefined || stat.roleInstruction === undefined || stat.roleInstruction === 'none') {
    // Three distinct reasons, three distinct wordings: an operator fixing this needs to know
    // whether the adapter was never measured ('unknown'), simply does not declare the field
    // ('undeclared'), or measured 'none'. All three refuse; only the first two are fixable by
    // declaring an honest value.
    const declared = stat === undefined
      ? 'unknown -- the agent has no declared static capabilities'
      : stat.roleInstruction === undefined
        ? "undeclared -- the agent's static block omits roleInstruction"
        : "none -- the agent's static block declares roleInstruction: 'none'";
    throw new ValidationError(
      `preset ${JSON.stringify(manifest.id)} carries a role instruction, but agent`
      + ` ${JSON.stringify(id)} cannot receive one (roleInstruction: ${declared});`
      + ' pick an agent that applies role instructions',
    );
  }
  if (manifest.requires?.sandbox === true && stat.sandbox === false) {
    throw new ValidationError(
      `preset ${JSON.stringify(manifest.id)} requires sandboxed execution, but agent`
      + ` ${JSON.stringify(id)} declares sandbox: false`,
    );
  }
  if (model !== undefined && stat.perRunModel !== true) {
    // stat is non-undefined here: the role-instruction check above threw otherwise.
    throw new ValidationError(
      `preset sets a model but agent ${JSON.stringify(id)} cannot take a per-Run model`,
    );
  }
  return { id, ...(model !== undefined ? { model } : {}) };
}

/**
 * Skill precedence (section 3.2): caller list when PROVIDED (an explicit empty array means
 * "no skills" -- it suppresses defaults AND auto-select), otherwise preset defaults; required
 * appended in every case (the caller cannot remove them); dedupe by first occurrence; cap.
 *
 * Auto-select fires only when nothing names a skill (no caller list, empty defaults, empty
 * required) and the preset has not disabled it. Selection itself needs the task text and the
 * available-skill list -- inputs this pure function does not have -- so the result carries an
 * `autoSelect` flag and RunService runs the selector.
 */
function resolveSkillIds(
  manifest: RolePresetManifest,
  caller: PresetCallerInput,
): { ids: string[]; autoSelect: boolean; cap: number } {
  const s = manifest.skills;
  // Section 3.2 step 1, as amended by #724: the caller provides a LIST; an explicit empty list
  // means "no skills" and suppresses defaults and auto-selection -- it is a decision, not an
  // absence. Absent falls back to the preset defaults.
  const callerProvided = caller.skills !== undefined;
  const start = callerProvided ? [...(caller.skills as string[])] : [...(s?.defaults ?? [])];
  const required = s?.required ?? [];
  // Step 2 as specified: the selector runs whenever the START list is empty -- a required-only
  // preset keeps auto-selection, with the required skills appended AFTER the selector's picks
  // (RunService owns the selector and does the append, then dedupes and caps). An explicit
  // caller [] still suppresses it: the list is empty because the caller chose that (step 1
  // amendment), not because nobody named a skill.
  const autoSelect = start.length === 0 && !callerProvided && s?.autoSelect !== false;
  const cap = Math.min(s?.max ?? SKILL_SYSTEM_CAP, SKILL_SYSTEM_CAP);
  if (autoSelect) {
    return { ids: required, autoSelect: true, cap };
  }
  const ids = [...start, ...required];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length > cap) {
    throw new ValidationError(
      `preset resolves to ${out.length} skills; the effective maximum is ${cap}`,
    );
  }
  return { ids: out, autoSelect: false, cap };
}

/**
 * Constraint math (section 3.3): for scalar limits,
 *   effective = min(systemCeiling, presetCeiling, caller ?? presetDefault ?? systemDefault).
 * Preset ceilings can only narrow system policy; caller values cannot widen a ceiling.
 */
function resolveConstraints(
  manifest: RolePresetManifest,
  caller: PresetCallerInput,
  system: PresetSystemPolicy,
): RunConstraints {
  const defaults = manifest.constraints?.defaults ?? {};
  const ceilings = manifest.constraints?.ceilings ?? {};
  const call = caller.constraints ?? {};

  const scalar = (
    callerValue: number | undefined,
    presetDefault: number | undefined,
    presetCeiling: number | undefined,
    systemDefault: number,
    field: string,
  ): number => {
    let v = callerValue ?? presetDefault ?? systemDefault;
    if (presetCeiling !== undefined) {
      if (callerValue !== undefined && callerValue > presetCeiling) {
        throw new ValidationError(
          `constraint ${field} = ${callerValue} exceeds the preset ceiling of ${presetCeiling}`,
        );
      }
      v = Math.min(v, presetCeiling);
    }
    return v;
  };

  const effective: RunConstraints = {
    maxDurationMs: scalar(
      call.maxDurationMs, defaults.maxDurationMs, ceilings.maxDurationMs,
      system.defaultMaxDurationMs, 'maxDurationMs',
    ),
    maxRetries: scalar(
      call.maxRetries, defaults.maxRetries, ceilings.maxRetries,
      system.defaultMaxRetries, 'maxRetries',
    ),
  };

  // Budgets are recorded-only (issue #63) and the design gives them no ceiling: the preset
  // default is recorded when present, the caller value wins otherwise. Nothing enforces them.
  const bt = call.budgetTokens ?? defaults.budgetTokens;
  const bc = call.budgetCost ?? defaults.budgetCost;
  if (bt !== undefined) effective.budgetTokens = bt;
  if (bc !== undefined) effective.budgetCost = bc;

  // resourceLimits are strings; "narrower" is not measurable, so a caller value on a field the
  // preset ceilinged is refused unless equal (section 3.3: caller cannot widen a ceiling).
  const rl: RunConstraints['resourceLimits'] = {
    ...(defaults.resourceLimits ?? {}),
    ...(call.resourceLimits ?? {}),
  };
  for (const key of ['cpu', 'memory', 'disk'] as const) {
    const ceiling = ceilings.resourceLimits?.[key];
    if (ceiling === undefined) continue;
    const value = rl[key];
    if (value === undefined) rl[key] = ceiling;
    else if (value !== ceiling) {
      throw new ValidationError(
        `resourceLimits.${key} = ${JSON.stringify(value)} conflicts with the preset ceiling ${JSON.stringify(ceiling)}`,
      );
    }
  }
  if (rl.cpu !== undefined || rl.memory !== undefined || rl.disk !== undefined) {
    effective.resourceLimits = rl;
  }

  // networkMode ceiling (section 3.3): the preset speaks the honest coarse vocabulary; the
  // constraint keeps the existing allowedNetworks shape (empty = none, non-empty = bridge).
  // A ceiling is an upper bound and can only NARROW (#723): no network is narrower than
  // 'none', so the none ceiling forces an empty list regardless of defaults (a manifest whose
  // defaults violate its own ceiling is refused at load; resolution still fails closed here),
  // and 'bridge' admits caller [] -- no network is a valid narrowing of bridge. Only a caller
  // value WIDER than the ceiling is rejected.
  if (ceilings.networkMode === 'none') {
    if (call.allowedNetworks !== undefined && call.allowedNetworks.length > 0) {
      throw new ValidationError(
        'constraint allowedNetworks conflicts with the preset network ceiling (none)',
      );
    }
    effective.allowedNetworks = [];
  } else if (ceilings.networkMode === 'bridge') {
    effective.allowedNetworks = call.allowedNetworks ?? defaults.allowedNetworks;
  } else if (call.allowedNetworks !== undefined || defaults.allowedNetworks !== undefined) {
    effective.allowedNetworks = call.allowedNetworks ?? defaults.allowedNetworks;
  }

  // requires.sandbox (section 3.3): the preset demands an isolated Run. The honest request in
  // the existing constraints vocabulary is a resourceLimits/allowedNetworks field, because that
  // is exactly what SandboxManager.requiresSandbox keys on. When neither the preset defaults
  // nor the caller requested isolation, inject an empty resourceLimits object -- "isolate, with
  // runtime defaults" -- rather than silently running unsandboxed. A worker without a container
  // runtime fails the Run closed with a clear error; that is the fail-closed path the design
  // asks for.
  if (manifest.requires?.sandbox === true
    && effective.resourceLimits === undefined
    && effective.allowedNetworks === undefined) {
    effective.resourceLimits = {};
  }
  return effective;
}

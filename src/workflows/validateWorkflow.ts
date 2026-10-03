// Structured validation for one workflow directory (docs/crew/workflows.md section 4).
//
// Findings carry stable codes because they are API surface: the registry, the W-2 creation
// path and the tests branch on the code, never on the message. The hard-error list is the
// issue list, in the order it states it; each check runs so that ONE malformed aspect does
// not mask the others (a template with a bad mode AND an oversized task reports both).
//
// Advisory mode enforces nothing (section 3.1), so a template must not appear to: `mode:
// 'staged'` is refused with its own code (Phase 9), and `gate`, `carryForward` and
// `repositoryInput` -- the enforcement vocabulary -- are refused in advisory mode. "No
// recursive references" holds by construction: the manifest's key set is closed, no field
// can name another workflow, and unknown keys (which is where a reference would sneak in)
// are a hard error, pinned by test.

import type {
  WorkflowFinding,
  WorkflowStage,
  WorkflowTemplateManifest,
  WorkflowValidation,
} from './types.ts';
import { WORKFLOW_STAGE_SYSTEM_CAP, WORKFLOW_TASK_MAX_BYTES } from './types.ts';

/** A preset the template references, resolved against the same registry Run creation uses. */
export interface WorkflowPresetLookup {
  /**
   * The resolved preset's definition version, or null when the id (or the requested
   * version of it) does not resolve. ABSENT lookup means no presets are visible, so every
   * referenced preset is reported missing -- a registry that cannot see presets must not
   * silently approve references to them (the same rule as preset -> skill references).
   */
  (id: string, version?: string): { version: string } | null;
}

export interface ValidateWorkflowDeps {
  presetLookup?: WorkflowPresetLookup;
}

const SAFE_WORKFLOW_ID = /^[a-z0-9][a-z0-9._-]*$/;
// Semver text, identical to the preset rule ("valid semantic version text").
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const MANIFEST_KEYS = new Set(['schemaVersion', 'id', 'version', 'description', 'mode', 'stages', 'maxStages']);
const STAGE_KEYS = new Set(['id', 'preset', 'task']);

/**
 * Validate an already-parsed manifest against its directory.
 *
 * `dirId` is the directory's name (the id must match it). Pure: no I/O, no env.
 */
export function validateWorkflowTemplate(
  dirId: string,
  manifest: unknown,
  deps: ValidateWorkflowDeps = {},
): WorkflowValidation {
  const findings: WorkflowFinding[] = [];
  const add = (code: string, field: string, message: string) =>
    findings.push({ code, field, message });

  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return {
      valid: false,
      findings: [{ code: 'WORKFLOW_MANIFEST_SHAPE', field: '', message: 'workflow.json must be a JSON object' }],
    };
  }
  const m = manifest as Record<string, unknown>;

  // Unknown keys are a hard error, not a warning: the manifest is intentionally small, and
  // "accepted but silently ignored" is the failure mode the repo refuses elsewhere. It is
  // also how `trust` or a workflow reference would sneak in -- trust is assigned by the
  // registry, and recursive workflow references do not exist in this schema.
  for (const key of Object.keys(m)) {
    if (!MANIFEST_KEYS.has(key)) {
      add('WORKFLOW_UNKNOWN_KEYS', key, `unknown manifest key: ${JSON.stringify(key)}`);
    }
  }

  if (m.schemaVersion !== 1) {
    add('WORKFLOW_SCHEMA_VERSION', 'schemaVersion', 'schemaVersion must be exactly 1');
  }

  const id = m.id;
  if (typeof id !== 'string' || !SAFE_WORKFLOW_ID.test(id)) {
    add('WORKFLOW_ID', 'id', 'id must be a safe lowercase path segment (a-z0-9, then a-z0-9._-)');
  } else if (id !== dirId) {
    add('WORKFLOW_ID_MISMATCH', 'id', `id ${JSON.stringify(id)} must match its directory ${JSON.stringify(dirId)}`);
  }

  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) {
    add('WORKFLOW_VERSION', 'version', 'version must be valid semantic version text, e.g. "1.0.0"');
  }

  if (typeof m.description !== 'string' || m.description.trim().length === 0) {
    add('WORKFLOW_DESCRIPTION', 'description', 'description must be a non-empty string');
  }

  // Mode: exactly 'advisory'. The 'staged' value gets its own code -- it is a DESIGN mode a
  // reader may legitimately write today (Phase 9), so the refusal must be branchable, not a
  // generic shape error. Any other value is a shape error.
  if (m.mode === 'staged') {
    add('WORKFLOW_MODE_STAGED', 'mode', "mode 'staged' is not implemented yet (Phase 9); only 'advisory' templates are accepted");
  } else if (m.mode !== 'advisory') {
    add('WORKFLOW_MODE', 'mode', "mode must be the string 'advisory'");
  }

  // Stages: shape first, then per-stage checks. Stage-level advisory refusals (gate,
  // carryForward, repositoryInput) apply in advisory mode -- the only mode this schema
  // accepts -- regardless of the other findings, so one bad aspect never masks another.
  const stages = m.stages;
  let stageList: unknown[] = [];
  if (!Array.isArray(stages)) {
    add('WORKFLOW_STAGES', 'stages', 'stages must be an array with at least one stage');
  } else if (stages.length === 0) {
    add('WORKFLOW_STAGES', 'stages', 'stages must contain at least one stage');
  } else if (stages.length > WORKFLOW_STAGE_SYSTEM_CAP) {
    add('WORKFLOW_STAGES_LIMIT', 'stages',
      `stages has ${stages.length} entries; at most ${WORKFLOW_STAGE_SYSTEM_CAP} are allowed`);
    stageList = stages;
  } else {
    stageList = stages;
  }

  const stageIds = new Set<string>();
  stageList.forEach((stage, i) => {
    const field = `stages[${i}]`;
    if (typeof stage !== 'object' || stage === null || Array.isArray(stage)) {
      add('WORKFLOW_STAGE_SHAPE', field, 'stage must be a JSON object');
      return;
    }
    const s = stage as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      if (!STAGE_KEYS.has(key)) {
        add('WORKFLOW_STAGE_UNKNOWN_KEYS', `${field}.${key}`, `unknown stage key: ${JSON.stringify(key)}`);
      }
    }

    const stageId = s.id;
    if (typeof stageId !== 'string' || stageId.trim().length === 0) {
      add('WORKFLOW_STAGE_ID', `${field}.id`, 'stage id must be a non-empty string');
    } else if (stageIds.has(stageId)) {
      add('WORKFLOW_STAGE_ID_DUPLICATE', `${field}.id`, `duplicate stage id: ${JSON.stringify(stageId)}`);
    } else {
      stageIds.add(stageId);
    }

    if (typeof s.task !== 'string' || s.task.trim().length === 0) {
      add('WORKFLOW_STAGE_TASK', `${field}.task`, 'task must be a non-empty string');
    } else if (Buffer.byteLength(s.task, 'utf8') > WORKFLOW_TASK_MAX_BYTES) {
      add('WORKFLOW_STAGE_TASK_SIZE', `${field}.task`,
        `task is ${Buffer.byteLength(s.task, 'utf8')} bytes; at most ${WORKFLOW_TASK_MAX_BYTES} are allowed`);
    }

    const preset = s.preset;
    if (preset !== undefined) {
      if (typeof preset !== 'object' || preset === null || Array.isArray(preset)) {
        add('WORKFLOW_STAGE_PRESET', `${field}.preset`, 'preset must be an object with an id');
      } else {
        const p = preset as Record<string, unknown>;
        // Closed shape like the manifest and stage objects above: a typo such as `versoin`
        // must fail loudly, not silently downgrade the step to "any version" -- the very
        // version pin the author wrote would be dropped (round-1 review, #812).
        for (const key of Object.keys(p)) {
          if (key !== 'id' && key !== 'version') {
            add('WORKFLOW_STAGE_PRESET', `${field}.preset.${key}`, `unknown preset key: ${JSON.stringify(key)}`);
          }
        }
        if (p.version !== undefined && (typeof p.version !== 'string' || p.version.length === 0)) {
          add('WORKFLOW_STAGE_PRESET', `${field}.preset.version`, 'preset.version must be a non-empty string when given');
        }
        if (typeof p.id !== 'string' || p.id.length === 0) {
          add('WORKFLOW_STAGE_PRESET', `${field}.preset.id`, 'preset.id must be a non-empty string');
        } else {
          // Resolution happens against the SAME registry Run creation resolves against, so
          // "must resolve" here means "must resolve at creation too" (section 4). The finding
          // names the id so an author can tell which reference is dead.
          const version = typeof p.version === 'string' ? p.version : undefined;
          const resolved = deps.presetLookup?.(p.id, version) ?? null;
          if (resolved === null) {
            if (version !== undefined) {
              add('WORKFLOW_STAGE_PRESET_VERSION_MISSING', `${field}.preset`,
                `preset ${JSON.stringify(p.id)} does not resolve at version ${JSON.stringify(version)}`);
            } else {
              add('WORKFLOW_STAGE_PRESET_MISSING', `${field}.preset`,
                `preset ${JSON.stringify(p.id)} does not resolve in the preset registry`);
            }
          }
        }
      }
    }

    // Advisory refuses the enforcement vocabulary. The codes name the refused field so the
    // author is told exactly what to delete; per-stage fields, so all stages report.
    if (s.gate !== undefined) {
      add('WORKFLOW_STAGE_GATE_ADVISORY', `${field}.gate`,
        'gate is refused in advisory mode: advisory enforces nothing (workflows.md section 3.1)');
    }
    if (s.carryForward !== undefined) {
      add('WORKFLOW_STAGE_CARRY_FORWARD_ADVISORY', `${field}.carryForward`,
        'carryForward is refused in advisory mode: advisory enforces nothing (workflows.md section 3.1)');
    }
    if (s.repositoryInput !== undefined) {
      add('WORKFLOW_STAGE_REPOSITORY_INPUT_ADVISORY', `${field}.repositoryInput`,
        'repositoryInput is refused in advisory mode: advisory enforces nothing (workflows.md section 3.1)');
    }
  });

  // maxStages: the explicit step bound, checked UNCONDITIONALLY (omission is a finding, not
  // an implied bound -- the field is required and the rendered step count must be stated,
  // not guessed). It must be an integer between the stage count and the system cap; a value
  // below the stage count would render more steps than promised.
  const ms = m.maxStages;
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 1) {
    add('WORKFLOW_MAX_STAGES', 'maxStages', 'maxStages must be a positive integer');
  } else {
    if (Array.isArray(stages) && ms < stages.length) {
      add('WORKFLOW_MAX_STAGES_LOW', 'maxStages',
        `maxStages ${ms} is below the ${stages.length} declared stages`);
    }
    if (ms > WORKFLOW_STAGE_SYSTEM_CAP) {
      add('WORKFLOW_MAX_STAGES_CAP', 'maxStages',
        `maxStages ${ms} exceeds the system cap of ${WORKFLOW_STAGE_SYSTEM_CAP}`);
    }
  }

  return { valid: findings.length === 0, findings };
}

/** The stage list of a manifest that already passed validation (registry internals). */
export function validatedStages(manifest: WorkflowTemplateManifest): WorkflowStage[] {
  return manifest.stages;
}

// Structured validation for one preset directory (docs/crew/role-presets.md section 2.1).
//
// Findings carry stable codes because they are API surface: the registry, the diagnostic API
// (Phase 3) and the tests branch on the code, never on the message. The hard-error list is the
// design's list, in the order the design states it; each check runs so that ONE malformed aspect
// does not mask the others (a preset with a bad id AND a missing instruction reports both).

import { readlinkSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  PresetConstraintCeilings,
  PresetFinding,
  PresetValidation,
} from './types.ts';
import { ValidationError } from '../domain/errors.ts';

export const PRESET_INSTRUCTION_MAX_BYTES = 32 * 1024;
/** System cap on effective skills (section 3.2 step 5); the manifest max can only lower it. */
export const PRESET_SKILL_SYSTEM_CAP = 4;

export interface ValidatePresetDeps {
  /**
   * Skill existence, from the same registry Run creation resolves against. Absent
   * (no skills configured) means every referenced skill is missing -- a registry
   * that cannot see skills must not silently approve references to them.
   */
  skillExists?: (id: string) => boolean;
  /** Known agent ids, from the same list Run creation validates agent against. */
  knownAgents?: readonly string[];
}

const SAFE_PRESET_ID = /^[a-z0-9][a-z0-9._-]*$/;
// Semver text (section 2.1: "valid semantic version text"). Full semver incl. prerelease/build.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const NUMERIC_CEILING_KEYS = ['maxDurationMs', 'maxRetries'] as const;

const MANIFEST_KEYS = new Set([
  'schemaVersion', 'id', 'version', 'description', 'role', 'tags', 'enabled',
  'instruction', 'agent', 'skills', 'constraints', 'requires',
]);

/**
 * Validate an already-parsed manifest against its directory.
 *
 * `dir` is the preset directory (used for the instruction containment checks) and `dirId`
 * the directory's name (the id must match it). Pure: no writes, no network, no env.
 */
export function validatePreset(
  dirId: string,
  dir: string,
  manifest: unknown,
  deps: ValidatePresetDeps = {},
): PresetValidation {
  const findings: PresetFinding[] = [];
  const add = (code: string, field: string, message: string) =>
    findings.push({ code, field, message });

  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return {
      valid: false,
      findings: [{ code: 'PRESET_MANIFEST_SHAPE', field: '', message: 'preset.json must be a JSON object' }],
    };
  }
  const m = manifest as Record<string, unknown>;

  // Unknown keys are a hard error, not a warning: the manifest is intentionally small, and
  // "accepted but silently ignored" is the failure mode the repo refuses elsewhere (issue #459).
  // It is also how `trust` would sneak in if it were ever added to the JSON -- trust is assigned
  // by the registry, never declared.
  for (const key of Object.keys(m)) {
    if (!MANIFEST_KEYS.has(key)) {
      add('PRESET_UNKNOWN_KEYS', key, `unknown manifest key: ${JSON.stringify(key)}`);
    }
  }

  if (m.schemaVersion !== 1) {
    add('PRESET_SCHEMA_VERSION', 'schemaVersion', 'schemaVersion must be exactly 1');
  }

  const id = m.id;
  if (typeof id !== 'string' || !SAFE_PRESET_ID.test(id)) {
    add('PRESET_ID', 'id', 'id must be a safe lowercase path segment (a-z0-9, then a-z0-9._-)');
  } else if (id !== dirId) {
    add('PRESET_ID_MISMATCH', 'id', `id ${JSON.stringify(id)} must match its directory ${JSON.stringify(dirId)}`);
  }

  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) {
    add('PRESET_VERSION', 'version', 'version must be valid semantic version text, e.g. "1.0.0"');
  }

  if (typeof m.description !== 'string' || m.description.trim().length === 0) {
    add('PRESET_DESCRIPTION', 'description', 'description must be a non-empty string');
  }
  if (typeof m.role !== 'string' || m.role.trim().length === 0) {
    add('PRESET_ROLE', 'role', 'role must be a non-empty string');
  }
  if (m.tags !== undefined) {
    if (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string')) {
      add('PRESET_TAGS', 'tags', 'tags must be an array of strings');
    }
  }
  if (m.enabled !== undefined && typeof m.enabled !== 'boolean') {
    add('PRESET_ENABLED', 'enabled', 'enabled must be a boolean');
  }

  // Instruction: containment first, then existence, size, and (in the registry) decodability.
  // An ABSENT block means the default file (INSTRUCTION.md) -- the type's comment on
  // `instruction.file` says exactly that, and every shipped preset relies on it. An EXPLICIT
  // null is not "absent": it is a shape error, because silently defaulting a value the author
  // wrote is the accepted-but-ignored failure mode the repo refuses.
  const inst = m.instruction === undefined ? { file: 'INSTRUCTION.md' } : m.instruction;
  if (typeof inst !== 'object' || inst === null || Array.isArray(inst)) {
    add('PRESET_INSTRUCTION', 'instruction', 'instruction must be an object with a file field');
  } else {
    const rawFile = (inst as Record<string, unknown>).file;
    const file = rawFile === undefined ? 'INSTRUCTION.md' : rawFile;
    if (typeof file !== 'string' || file.length === 0) {
      add('PRESET_INSTRUCTION_PATH', 'instruction.file', 'instruction.file must be a non-empty string');
    } else {
      // Containment by the same rules the skill registry applies (section 7 reuses them):
      // no absolute paths, no ".." -- checked on the RAW path, because a normalized escape
      // check alone would let `sub/../INSTRUCTION.md` through, and the design (section 2.1)
      // rejects the segment itself, not just the escape.
      const abs = resolve(dir, file);
      const rel = relative(dir, abs);
      // The escape test is SEGMENT-based, not prefix-based: '..foo.md' is a legitimate file
      // name that startsWith('..') would wrongly reject, while the '..' SEGMENT is what
      // escapes. The raw-path segment checks below cover 'sub/../x' games; the rel check
      // covers platforms where resolve() normalizes differently.
      const escapes =
        isAbsolute(file) ||
        rel === '' ||
        rel.split(sep).includes('..') ||
        file.split('/').includes('..') ||
        file.split('\\').includes('..');
      if (escapes) {
        add('PRESET_INSTRUCTION_PATH', 'instruction.file',
          'instruction.file must stay inside the preset directory (no absolute paths, no "..")');
      } else if (hasSymlinkComponent(dir, abs)) {
        // A symlink between the preset directory and the instruction file turns a
        // lexically-contained path into an outside read. The skill registry refuses the same
        // shape, for the same reason: these bytes get materialized into workspaces.
        add('PRESET_INSTRUCTION_PATH', 'instruction.file',
          'instruction.file must not cross a symlink inside the preset directory');
      } else {
        let st: import('node:fs').Stats | null = null;
        try {
          st = statSync(abs);
        } catch {
          add('PRESET_INSTRUCTION_MISSING', 'instruction.file', `instruction file not found: ${JSON.stringify(file)}`);
        }
        // A directory (or any non-regular file) would pass existence and then die on read with
        // EISDIR in the registry -- surface it here, with a stable code, while we still know why.
        if (st && !st.isFile()) {
          add('PRESET_INSTRUCTION_PATH', 'instruction.file',
            `instruction.file must be a regular file: ${JSON.stringify(file)}`);
        } else if (st) {
          const size = instructionSize(abs);
          if (size !== null && size > PRESET_INSTRUCTION_MAX_BYTES) {
            add('PRESET_INSTRUCTION_SIZE', 'instruction.file',
              `instruction file is ${size} bytes; the limit is ${PRESET_INSTRUCTION_MAX_BYTES}`);
          }
        }
      }
    }
  }

  // Skills: shape, existence, dedup-aware cap.
  const skills = m.skills;
  if (skills !== undefined) {
    if (typeof skills !== 'object' || skills === null || Array.isArray(skills)) {
      add('PRESET_SKILLS_SHAPE', 'skills', 'skills must be an object');
    } else {
      const s = skills as Record<string, unknown>;
      for (const key of ['defaults', 'required'] as const) {
        if (s[key] !== undefined && (!Array.isArray(s[key]) || (s[key] as unknown[]).some((x) => typeof x !== 'string'))) {
          add('PRESET_SKILLS_SHAPE', `skills.${key}`, `skills.${key} must be an array of skill ids`);
        }
      }
      if (s.autoSelect !== undefined && typeof s.autoSelect !== 'boolean') {
        add('PRESET_SKILLS_SHAPE', 'skills.autoSelect', 'skills.autoSelect must be a boolean');
      }
      if (s.max !== undefined) {
        if (typeof s.max !== 'number' || !Number.isInteger(s.max) || s.max < 0) {
          add('PRESET_SKILLS_SHAPE', 'skills.max', 'skills.max must be a non-negative integer');
        } else if (s.max > PRESET_SKILL_SYSTEM_CAP) {
          add('PRESET_SKILL_CAP', 'skills.max',
            `skills.max ${s.max} exceeds the system cap of ${PRESET_SKILL_SYSTEM_CAP}`);
        }
      }
      const defaults = Array.isArray(s.defaults) ? (s.defaults as string[]) : [];
      const required = Array.isArray(s.required) ? (s.required as string[]) : [];
      const exists = deps.skillExists ?? (() => false);
      defaults.forEach((id, i) => {
        if (!exists(id)) add('PRESET_SKILL_MISSING', `skills.defaults[${i}]`, `skill not found: ${JSON.stringify(id)}`);
      });
      required.forEach((id, i) => {
        if (!exists(id)) add('PRESET_SKILL_MISSING', `skills.required[${i}]`, `skill not found: ${JSON.stringify(id)}`);
      });
      // Cap AFTER deduplication (section 2.1), preserving first occurrence. The manifest max
      // participates only when it is a VALID non-negative integer: NaN/Infinity/fractions are
      // already PRESET_SKILLS_SHAPE findings above, and letting them into Math.min would mask
      // the cap finding (NaN comparisons are always false) or misreport the bound.
      const deduped = new Set([...required, ...defaults]);
      const manifestMax = typeof s.max === 'number' && Number.isInteger(s.max) && s.max >= 0
        ? s.max
        : undefined;
      const effectiveMax = manifestMax !== undefined
        ? Math.min(manifestMax, PRESET_SKILL_SYSTEM_CAP)
        : PRESET_SKILL_SYSTEM_CAP;
      if (deduped.size > effectiveMax) {
        add('PRESET_SKILL_CAP', 'skills',
          `required + defaults name ${deduped.size} distinct skills; the effective maximum is ${effectiveMax}`);
      }
    }
  }

  // Agent: shape; required implies id; required id must exist.
  const agent = m.agent;
  if (agent !== undefined) {
    if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) {
      add('PRESET_AGENT_SHAPE', 'agent', 'agent must be an object');
    } else {
      const a = agent as Record<string, unknown>;
      if (a.id !== undefined && (typeof a.id !== 'string' || a.id.trim().length === 0)) {
        add('PRESET_AGENT_SHAPE', 'agent.id', 'agent.id must be a non-empty string');
      }
      if (a.required !== undefined && typeof a.required !== 'boolean') {
        add('PRESET_AGENT_SHAPE', 'agent.required', 'agent.required must be a boolean');
      }
      if (a.model !== undefined && (typeof a.model !== 'string' || a.model.trim().length === 0)) {
        add('PRESET_AGENT_SHAPE', 'agent.model', 'agent.model must be a non-empty string');
      }
      if (a.modelRequired !== undefined && typeof a.modelRequired !== 'boolean') {
        add('PRESET_AGENT_SHAPE', 'agent.modelRequired', 'agent.modelRequired must be a boolean');
      }
      if (a.required === true && typeof a.id !== 'string') {
        add('PRESET_AGENT_REQUIRED_ID', 'agent.id', 'agent.required=true needs agent.id');
      }
      if (typeof a.id === 'string' && a.id.trim().length > 0
        && deps.knownAgents && !deps.knownAgents.includes(a.id)) {
        add('PRESET_AGENT_UNKNOWN', 'agent.id',
          `unknown agent: ${JSON.stringify(a.id)} (known: ${deps.knownAgents.join(', ')})`);
      }
    }
  }

  // Constraints: defaults validated as caller constraints are (shape + numeric sanity);
  // ceilings checked against their own declared vocabulary.
  const constraints = m.constraints;
  if (constraints !== undefined) {
    if (typeof constraints !== 'object' || constraints === null || Array.isArray(constraints)) {
      add('PRESET_CONSTRAINTS_SHAPE', 'constraints', 'constraints must be an object');
    } else {
      const c = constraints as Record<string, unknown>;
      if (c.defaults !== undefined) {
        validateConstraintObject(c.defaults, 'constraints.defaults', add);
      }
      if (c.ceilings !== undefined) {
        validateCeilings(c.ceilings, add);
      }
    }
  }

  // requires.sandbox: the RUN-level fail-closed check belongs to resolution (Phase 2), which
  // knows the effective constraints and the sandbox runtime. The manifest-level check here is
  // shape only.
  const requires = m.requires;
  if (requires !== undefined) {
    if (typeof requires !== 'object' || requires === null || Array.isArray(requires)) {
      add('PRESET_REQUIRES_SHAPE', 'requires', 'requires must be an object');
    } else {
      const r = requires as Record<string, unknown>;
      if (r.sandbox !== undefined && typeof r.sandbox !== 'boolean') {
        add('PRESET_REQUIRES_SHAPE', 'requires.sandbox', 'requires.sandbox must be a boolean');
      }
    }
  }

  return { valid: findings.length === 0, findings };
}

/**
 * Throw the findings as one ValidationError. Used by consumers that need a preset to be
 * valid right now (registry load of a specific id, resolution) and want the structured
 * codes preserved in the message.
 */
export function findingsToError(id: string, findings: PresetFinding[]): ValidationError {
  const detail = findings.map((f) => `${f.code}(${f.field}): ${f.message}`).join('; ');
  return new ValidationError(`preset ${JSON.stringify(id)} is invalid: ${detail}`);
}

function validateConstraintObject(
  value: unknown,
  field: string,
  add: (code: string, field: string, message: string) => void,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    add('PRESET_CONSTRAINT', field, 'must be an object');
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!['maxDurationMs', 'maxRetries', 'budgetTokens', 'budgetCost', 'resourceLimits', 'allowedNetworks'].includes(key)) {
      add('PRESET_CONSTRAINT', `${field}.${key}`, `unknown constraint: ${key}`);
    }
  }
  for (const key of ['maxDurationMs', 'maxRetries', 'budgetTokens', 'budgetCost'] as const) {
    const v = obj[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || (key !== 'budgetCost' && !Number.isInteger(v))) {
      add('PRESET_CONSTRAINT', `${field}.${key}`, 'must be a finite number');
    } else if (v < 0) {
      add('PRESET_CONSTRAINT', `${field}.${key}`, 'must be >= 0');
    } else if (v > Number.MAX_SAFE_INTEGER) {
      // The same bound Run creation enforces: a preset that validates here but overflows
      // when applied would move the failure from creation (actionable) to execution (mystery).
      add('PRESET_CONSTRAINT', `${field}.${key}`, `must be <= ${Number.MAX_SAFE_INTEGER}`);
    }
  }
  const rl = obj.resourceLimits;
  if (rl !== undefined) {
    if (typeof rl !== 'object' || rl === null || Array.isArray(rl)) {
      add('PRESET_CONSTRAINT', `${field}.resourceLimits`, 'must be an object');
    } else {
      for (const [k, v] of Object.entries(rl as Record<string, unknown>)) {
        if (!['cpu', 'memory', 'disk'].includes(k)) {
          add('PRESET_CONSTRAINT', `${field}.resourceLimits.${k}`, `unknown resourceLimits key: ${k}`);
        } else if (typeof v !== 'string') {
          add('PRESET_CONSTRAINT', `${field}.resourceLimits.${k}`, 'must be a string');
        }
      }
    }
  }
  const an = obj.allowedNetworks;
  if (an !== undefined && (!Array.isArray(an) || an.some((x) => typeof x !== 'string'))) {
    add('PRESET_CONSTRAINT', `${field}.allowedNetworks`, 'must be an array of strings');
  }
}

function validateCeilings(
  value: unknown,
  add: (code: string, field: string, message: string) => void,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    add('PRESET_CONSTRAINT', 'constraints.ceilings', 'must be an object');
    return;
  }
  const c = value as Record<string, unknown> & PresetConstraintCeilings;
  const allowed = new Set(['maxDurationMs', 'maxRetries', 'resourceLimits', 'networkMode']);
  for (const key of Object.keys(c)) {
    if (!allowed.has(key)) {
      add('PRESET_CONSTRAINT', `constraints.ceilings.${key}`, `unknown ceiling: ${key}`);
    }
  }
  for (const key of NUMERIC_CEILING_KEYS) {
    const v = c[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
      add('PRESET_CONSTRAINT', `constraints.ceilings.${key}`, 'must be a finite integer');
    } else if (v < 0) {
      add('PRESET_CONSTRAINT', `constraints.ceilings.${key}`, 'must be >= 0');
    } else if (v > Number.MAX_SAFE_INTEGER) {
      add('PRESET_CONSTRAINT', `constraints.ceilings.${key}`, `must be <= ${Number.MAX_SAFE_INTEGER}`);
    }
  }
  if (c.resourceLimits !== undefined) {
    const rl = c.resourceLimits;
    if (typeof rl !== 'object' || rl === null || Array.isArray(rl)) {
      add('PRESET_CONSTRAINT', 'constraints.ceilings.resourceLimits', 'must be an object');
    } else {
      for (const [k, v] of Object.entries(rl as Record<string, unknown>)) {
        if (!['cpu', 'memory', 'disk'].includes(k)) {
          add('PRESET_CONSTRAINT', `constraints.ceilings.resourceLimits.${k}`, `unknown resourceLimits key: ${k}`);
        } else if (typeof v !== 'string') {
          add('PRESET_CONSTRAINT', `constraints.ceilings.resourceLimits.${k}`, 'must be a string');
        }
      }
    }
  }
  if (c.networkMode !== undefined && c.networkMode !== 'none' && c.networkMode !== 'bridge') {
    add('PRESET_CONSTRAINT', 'constraints.ceilings.networkMode', 'networkMode must be "none" or "bridge"');
  }
}

/**
 * True when any component BETWEEN the preset directory and `abs` (inclusive of the leaf)
 * is a symlink. Symlinks in the directory's ANCESTRY are not this function's business:
 * temp dirs on macOS live under /private anyway.
 */
function hasSymlinkComponent(root: string, abs: string): boolean {
  let cur = abs;
  while (cur !== root && cur.startsWith(root + sep)) {
    try {
      readlinkSync(cur);
      return true;
    } catch {
      // not a symlink (or does not exist) -- keep walking up
    }
    cur = dirname(cur);
  }
  return false;
}

/** File size in bytes, or null when it cannot be stat'ed (missing file already reported). */
function instructionSize(abs: string): number | null {
  try {
    return statSync(abs).size;
  } catch {
    return null;
  }
}

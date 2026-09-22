// Role Preset manifest + snapshot types (docs/crew/role-presets.md sections 2 and 4).
//
// Pure types, no I/O: validation lives in validatePreset.ts, the filesystem registry in
// presetRegistry.ts, and Run resolution in resolvePreset.ts (Phase 2).

import type { RunConstraints } from '../domain/types.ts';

/**
 * One preset's on-disk manifest (presets/<id>/preset.json). Intentionally small:
 * no argv, no MCP servers, no vendored skills, no graphs. `trust` is ABSENT by
 * design -- trust is assigned by the registry from provenance, and a manifest
 * cannot declare itself trusted (docs/crew/role-presets.md section 2).
 */
export interface RolePresetManifest {
  schemaVersion: 1;
  id: string;
  /** Semver text. Identity of the DEFINITION, not of any Run's snapshot. */
  version: string;
  description: string;
  /** The role label shown in the dashboard, e.g. "Code reviewer". */
  role: string;
  tags?: string[];
  /** false removes the preset from browsing and Run creation without deleting it. */
  enabled?: boolean;

  /** Absent means { file: 'INSTRUCTION.md' }. */
  instruction?: {
    /** Preset-relative file. Default: INSTRUCTION.md. */
    file?: string;
  };

  agent?: {
    /** Default agent id; MANDATORY when required is true. */
    id?: string;
    /** true rejects a caller-supplied agent that differs. */
    required?: boolean;
    /** Structured model default. A string, never an argv fragment. */
    model?: string;
    /** true rejects a caller-supplied model that differs. */
    modelRequired?: boolean;
  };

  skills?: {
    /** Used when the caller supplies no explicit skill list. */
    defaults?: string[];
    /** Always present; the caller cannot remove them. */
    required?: string[];
    /** false suppresses the deterministic selector when defaults resolve empty. */
    autoSelect?: boolean;
    /** Effective maximum; capped by the system cap (section 3.2). */
    max?: number;
  };

  constraints?: {
    /** Recorded defaults for the Run. Caller values may override but not widen ceilings. */
    defaults?: Partial<RunConstraints>;
    /** Upper bounds. System policy is authoritative; a ceiling can only narrow it. */
    ceilings?: PresetConstraintCeilings;
  };

  requires?: {
    /** The Run must execute sandboxed; resolution fails closed when it cannot. */
    sandbox?: boolean;
  };
}

export interface PresetConstraintCeilings {
  maxDurationMs?: number;
  maxRetries?: number;
  resourceLimits?: { cpu?: string; memory?: string; disk?: string };
  networkMode?: 'none' | 'bridge';
}

/**
 * A structured validation finding with a stable code. Codes are API surface:
 * tests pin them, and callers branch on them instead of matching prose.
 */
export interface PresetFinding {
  code: string;
  /** Manifest field the finding is about, e.g. "agent.id" or "skills.required[2]". */
  field: string;
  message: string;
}

/** The result of validating one preset directory. */
export interface PresetValidation {
  valid: boolean;
  findings: PresetFinding[];
}

/**
 * A preset the registry loaded and validated. Phase 1 shape: the manifest, the
 * instruction bytes it references, the preset's own files and their canonical
 * hash. Effective agent/skills/constraints (caller-aware) are resolved per Run
 * in Phase 2 and never mutate this object.
 */
export interface LoadedPreset {
  id: string;
  version: string;
  role: string;
  description: string;
  tags: string[];
  enabled: boolean;
  manifest: RolePresetManifest;
  /** Resolved instruction file content (UTF-8). */
  instruction: string;
  /** Preset-relative instruction path, e.g. "INSTRUCTION.md". */
  instructionFile: string;
  /** Every preset file, keyed by preset-relative POSIX path, content included. */
  files: Record<string, string>;
  /**
   * SHA-256 over a canonical, code-unit-sorted sequence of relative file paths
   * and UTF-8 content (section 4). Locale-independent by construction; pinned by
   * test to prove it does not drift with the host.
   */
  contentHash: string;
  /** Registry-assigned. A manifest cannot set it (section 2). */
  trust: 'builtin';
  source: {
    kind: 'builtin';
    /** Preset-directory-relative path of the manifest, for diagnostics only. */
    relativePath: string;
  };
}

/** A diagnostic list entry for a preset that failed validation. */
export interface InvalidPreset {
  id: string;
  validation: PresetFinding[];
}

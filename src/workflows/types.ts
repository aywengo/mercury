// Workflow Template manifest + loaded types (docs/crew/workflows.md section 4).
//
// Pure types, no I/O: validation lives in validateWorkflow.ts, the filesystem registry in
// workflowRegistry.ts. W-1 (#808) ships the advisory-mode schema and registry only: nothing
// creates Runs from templates (W-2 #809) and there is no API (W-3 #810).
//
// Section 4's interface is the staged-mode shape. This issue implements advisory mode
// exclusively, and the issue's adaptation list (refuse `staged`, refuse `gate`,
// `carryForward` and `repositoryInput`) is applied to the type surface:
// - `mode` is exactly 'advisory' (the `staged` literal is refused by validation, not just
//   absent from the type);
// - `gate`, `carryForward` and `repositoryInput` are absent from WorkflowStage: a template
//   that carries them is INVALID, not silently stripped -- advisory mode enforces nothing
//   (section 3.1), so a template must not appear to;
// - `preset` is optional per stage. Advisory mode is guidance for one Run with ONE agent
//   performing every step (section 3.1); a stage without `preset` is a step the Run's own
//   (default) agent performs, with no preset instruction rendered for it. The issue's builtin
//   template needs exactly that: "the default agent implements". Staged mode, which requires
//   a preset per stage, is Phase 9 and refused here.

/**
 * One workflow's on-disk manifest (workflows/<id>/workflow.json). `trust` is ABSENT by
 * design -- trust is assigned by the registry from provenance, and a manifest cannot
 * declare itself trusted (the same rule as Role Presets, docs/crew/role-presets.md section 2).
 */
export interface WorkflowTemplateManifest {
  schemaVersion: 1;
  id: string;
  /** Semver text. Identity of the DEFINITION, not of any snapshot. */
  version: string;
  description: string;
  /** Exactly 'advisory'. 'staged' is Phase 9 and refused by validation. */
  mode: 'advisory';
  stages: WorkflowStage[];
  /**
   * An explicit cap on rendered steps. Advisory plans are rendered into one prompt, so the
   * bound must be stated, not implied (roadmap section 12 acceptance 2: step bounds are
   * visible). Must be an integer between the stage count and the system cap.
   */
  maxStages: number;
}

export interface WorkflowStage {
  /** Unique within the template; the step identity agents report step events against. */
  id: string;
  /**
   * Role Preset whose instruction renders as this step's guidance. Absent = the Run's
   * default agent performs the step without preset guidance (see the file comment).
   */
  preset?: {
    id: string;
    version?: string;
  };
  /** Instruction for this step. At most WORKFLOW_TASK_MAX_BYTES UTF-8 bytes. */
  task: string;
}

/** Hard stage cap for the advisory release -- the same bound section 4 states for staged. */
export const WORKFLOW_STAGE_SYSTEM_CAP = 16;
/** Hard per-task size cap (section 4: "task template at most 16 KiB"). */
export const WORKFLOW_TASK_MAX_BYTES = 16 * 1024;

/**
 * A structured validation finding with a stable code. Codes are API surface: tests pin them,
 * and callers branch on them instead of matching prose (mirrors PresetFinding).
 */
export interface WorkflowFinding {
  code: string;
  /** Manifest field the finding is about, e.g. "mode" or "stages[2].preset.id". */
  field: string;
  message: string;
}

/** The result of validating one workflow directory. */
export interface WorkflowValidation {
  valid: boolean;
  findings: WorkflowFinding[];
}

/**
 * A workflow the registry loaded and validated. Phase 1 shape: the manifest, the template
 * file bytes it was parsed from, and their canonical hash. Resolution into Run prompts is
 * W-2 and never mutates this object.
 */
export interface LoadedWorkflow {
  id: string;
  version: string;
  description: string;
  mode: 'advisory';
  stages: WorkflowStage[];
  maxStages: number;
  manifest: WorkflowTemplateManifest;
  /** The exact workflow.json bytes, for the W-2 snapshot to store verbatim. */
  templateJson: string;
  /** Every workflow file, keyed by workflow-relative POSIX path, content included. */
  files: Record<string, string>;
  /**
   * SHA-256 over a canonical, code-unit-sorted sequence of relative file paths and UTF-8
   * content (section 4). Locale-independent by construction; pinned by test.
   */
  contentHash: string;
  /** Registry-assigned. A manifest cannot set it (the same rule as presets). */
  trust: 'builtin';
  source: {
    kind: 'builtin';
    /** Workflow-directory-relative path of the manifest, for diagnostics only. */
    relativePath: string;
  };
}

/** A diagnostic list entry for a workflow that failed validation. */
export interface InvalidWorkflow {
  id: string;
  validation: WorkflowFinding[];
}

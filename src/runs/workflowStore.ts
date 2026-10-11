// Per-Run Workflow Template snapshot persistence (docs/crew/workflows.md section 5, issue #809).
//
// One row per Run, inserted in the Run-creation transaction next to run_skills and
// run_presets. The row is written once and never updated: a workflow snapshot is immutable by
// construction, and the event stream carries the history. Modelled on PresetStore.

import type { DatabaseSync } from 'node:sqlite';
import type { WorkflowTemplateManifest } from '../workflows/types.ts';

/** The resolved workflow snapshot: identity, the verbatim template bytes, and every file. */
export interface ResolvedWorkflow {
  schemaVersion: 1;
  id: string;
  /** The resolved DEFINITION version (W-1 registry), not a caller-echoed pin. */
  version: string;
  description: string;
  mode: 'advisory';
  stages: WorkflowTemplateManifest['stages'];
  maxStages: number;
  trust: 'builtin';
  source: {
    kind: 'builtin';
    relativePath: string;
  };
  /** The exact workflow.json bytes (templateJson), stored verbatim. */
  templateJson: string;
  /** Workflow-relative POSIX path -> content, the same map the content hash covers. */
  files: Record<string, string>;
  /** SHA-256 over the canonical file sequence; the durable snapshot identity. */
  contentHash: string;
}

export interface RunWorkflowRow {
  runId: string;
  workflowId: string;
  workflowVersion: string;
  mode: string;
  trust: string;
  contentHash: string;
  sourceKind: string;
  sourcePath: string;
  templateJson: string;
  filesJson: string;
  /** The full ResolvedWorkflow, JSON-encoded. The materialization source of truth. */
  snapshot: ResolvedWorkflow;
}

interface WorkflowDbRow {
  run_id: string;
  workflow_id: string;
  workflow_version: string;
  mode: string;
  trust: string;
  content_hash: string;
  source_kind: string;
  source_path: string;
  template_json: string;
  files_json: string;
  snapshot_json: string;
}

function rowToSnapshot(row: WorkflowDbRow): ResolvedWorkflow {
  return {
    ...(JSON.parse(row.snapshot_json) as ResolvedWorkflow),
    // Identity columns are authoritative over the JSON: they are what dashboards join on,
    // and a snapshot that disagrees with its own row is a bug this keeps visible rather
    // than something a reader has to reconcile (the PresetStore rule).
    id: row.workflow_id,
    version: row.workflow_version,
    mode: row.mode as ResolvedWorkflow['mode'],
    trust: row.trust as ResolvedWorkflow['trust'],
    contentHash: row.content_hash,
    source: {
      kind: row.source_kind as ResolvedWorkflow['source']['kind'],
      relativePath: row.source_path,
    },
    templateJson: row.template_json,
    files: JSON.parse(row.files_json) as Record<string, string>,
  };
}

export class WorkflowStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Insert one snapshot. Called inside the Run-creation transaction; never updated. */
  insert(row: RunWorkflowRow): void {
    this.db.prepare(`
      INSERT INTO run_workflows (
        run_id, workflow_id, workflow_version, mode, trust, content_hash,
        source_kind, source_path, template_json, files_json, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.runId, row.workflowId, row.workflowVersion, row.mode, row.trust, row.contentHash,
      row.sourceKind, row.sourcePath, row.templateJson, row.filesJson, JSON.stringify(row.snapshot),
    );
  }

  /** The Run's workflow snapshot, or null when the Run was not created from a template. */
  get(runId: string): ResolvedWorkflow | null {
    const row = this.db
      .prepare('SELECT * FROM run_workflows WHERE run_id = ?')
      .get(runId) as WorkflowDbRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }
}

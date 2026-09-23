// Per-Run preset snapshot persistence (docs/crew/role-presets.md section 6).
//
// One row per Run, inserted in the Run-creation transaction next to run_skills. The row is
// written once and never updated: a preset snapshot is immutable by construction, and the
// event stream carries the history.

import type { DatabaseSync } from 'node:sqlite';
import type { ResolvedRolePreset } from '../presets/types.ts';

export interface RunPresetRow {
  runId: string;
  presetId: string;
  presetVersion: string;
  role: string;
  trust: string;
  contentHash: string;
  sourceKind: string;
  sourceCommit: string | null;
  sourcePath: string;
  /** The full ResolvedRolePreset, JSON-encoded. The materialization source of truth. */
  snapshot: ResolvedRolePreset;
}

interface PresetDbRow {
  run_id: string;
  preset_id: string;
  preset_version: string;
  role: string;
  trust: string;
  content_hash: string;
  source_kind: string;
  source_commit: string | null;
  source_path: string;
  snapshot_json: string;
}

function rowToSnapshot(row: PresetDbRow): ResolvedRolePreset {
  return {
    ...(JSON.parse(row.snapshot_json) as ResolvedRolePreset),
    // Identity columns are authoritative over the JSON: they are what dashboards join on,
    // and a snapshot that disagrees with its own row is a bug this keeps visible rather
    // than something a reader has to reconcile.
    id: row.preset_id,
    version: row.preset_version,
    role: row.role,
    trust: row.trust as ResolvedRolePreset['trust'],
    contentHash: row.content_hash,
  };
}

export class PresetStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Insert one snapshot. Called inside the Run-creation transaction; never updated. */
  insert(row: RunPresetRow): void {
    this.db.prepare(`
      INSERT INTO run_presets (
        run_id, preset_id, preset_version, role, trust, content_hash,
        source_kind, source_commit, source_path, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.runId, row.presetId, row.presetVersion, row.role, row.trust, row.contentHash,
      row.sourceKind, row.sourceCommit, row.sourcePath, JSON.stringify(row.snapshot),
    );
  }

  /** The Run's preset snapshot, or null when the Run has no preset. */
  get(runId: string): ResolvedRolePreset | null {
    const row = this.db
      .prepare('SELECT * FROM run_presets WHERE run_id = ?')
      .get(runId) as PresetDbRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }
}

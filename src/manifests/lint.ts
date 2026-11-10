// Linting of the builtin manifests (issue #868, Crew Phase 11 CP-1).
//
// Validates every builtin preset manifest and every builtin workflow template in the
// source tree with the SAME registries and validators Run creation uses, so a typo in
// a committed manifest is a red build at commit time instead of a structured finding
// at runtime, when something first resolves the entry.
//
// This module adds no validation rules of its own: every finding carries the stable
// code, field and message of the underlying validator (PRESET_*, WORKFLOW_*). The
// registries already give per-entry isolation and deterministic order; this file only
// joins the two builtin roots and shapes the result for the CLI and CI.
//
// One discovery edge the registries cannot cover: their directory scan skips names
// that are not safe ids (stray-directory protection, like the skill registry), so a
// manifest under such a directory never reaches a validator — at runtime or in this
// guard. The guard surfaces those directories with the registry's own id-refusal,
// so a committed manifest with an invalid directory name is a red build (#868).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../paths.ts';
import { SkillRegistry } from '../skills/skillRegistry.ts';
import { PresetRegistry } from '../presets/presetRegistry.ts';
import { WorkflowRegistry } from '../workflows/workflowRegistry.ts';

export interface BuiltinManifestFinding {
  kind: 'preset' | 'workflow';
  /** The preset/workflow id: the directory name under presets/ or workflows/. */
  id: string;
  /** Repo-relative path of the offending manifest. */
  file: string;
  /** The validator's stable finding code (PRESET_*, WORKFLOW_*). */
  code: string;
  field: string;
  message: string;
}

export interface BuiltinLintReport {
  findings: BuiltinManifestFinding[];
  /** Directories under presets/ that hold a manifest (valid + invalid). */
  presetsChecked: number;
  /** Directories under workflows/ that hold a manifest (valid + invalid). */
  workflowsChecked: number;
  valid: boolean;
}

export interface LintBuiltinOptions {
  /** Package root holding presets/ and workflows/. Default: packageRoot(). */
  rootDir?: string;
  /** Skill registry root for resolving preset skill references. Default: <rootDir>/.agents/skills. */
  skillsDir?: string;
  /**
   * Known agent ids for resolving preset agent references. Absent: that check is skipped —
   * a bare checkout has no host configuration to derive the list from, and the shipped
   * manifests do not reference agents.
   */
  knownAgents?: readonly string[];
}

/**
 * Manifests under a directory the registry's discovery skipped by id shape. All three
 * registries skip unsafe directory names so one stray directory cannot take a listing
 * down; a skipped directory that HOLDS a manifest is not stray — the runtime refuses
 * it on its id contract (loadOne's "Unsafe ... id") — so the guard surfaces it. Asking
 * the registry's own get() produces the refusal the runtime would throw, before any
 * file I/O; it is mapped with the registry's stable load-failure code, the way
 * listAll's catch maps a non-validation error. Directories without a manifest stay
 * silent (the stray rule both registries pin in listAll).
 */
function skippedManifestFindings(
  root: string,
  kind: 'preset' | 'workflow',
  knownIds: Iterable<string>,
  askRegistry: (id: string) => unknown,
): BuiltinManifestFinding[] {
  const rootName = kind === 'preset' ? 'presets' : 'workflows';
  const manifest = kind === 'preset' ? 'preset.json' : 'workflow.json';
  const dir = join(root, rootName);
  if (!existsSync(dir)) return [];
  const known = new Set(knownIds);
  const out: BuiltinManifestFinding[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || known.has(d.name)) continue;
    if (!existsSync(join(dir, d.name, manifest))) continue; // stray directory: no manifest
    try {
      askRegistry(d.name);
    } catch (err) {
      out.push({
        kind,
        id: d.name,
        file: `${rootName}/${d.name}/${manifest}`,
        code: kind === 'preset' ? 'PRESET_LOAD_FAILED' : 'WORKFLOW_LOAD_FAILED',
        field: '',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export function lintBuiltinManifests(opts: LintBuiltinOptions = {}): BuiltinLintReport {
  const root = opts.rootDir ?? packageRoot();
  // Same layout as the package root itself: <root>/.agents/skills — the real repo
  // path in production, the fixture's own skills in tests.
  const skillsDir = opts.skillsDir ?? join(root, '.agents', 'skills');
  const skills = new SkillRegistry(skillsDir);
  const presets = new PresetRegistry(join(root, 'presets'), {
    skills,
    knownAgents: opts.knownAgents,
  });
  const workflows = new WorkflowRegistry(join(root, 'workflows'), { presets });

  const findings: BuiltinManifestFinding[] = [];
  const p = presets.listAll();
  for (const inv of p.invalid) {
    for (const f of inv.validation) {
      findings.push({ kind: 'preset', id: inv.id, file: `presets/${inv.id}/preset.json`, code: f.code, field: f.field, message: f.message });
    }
  }
  const w = workflows.listAll();
  for (const inv of w.invalid) {
    for (const f of inv.validation) {
      findings.push({ kind: 'workflow', id: inv.id, file: `workflows/${inv.id}/workflow.json`, code: f.code, field: f.field, message: f.message });
    }
  }
  // Manifests under directories discovery skipped by id shape (see
  // skippedManifestFindings): the registry's own refusal, so the guard fails where
  // the runtime would refuse the entry.
  const skippedPresets = skippedManifestFindings(
    root, 'preset', [...p.presets.map((x) => x.id), ...p.invalid.map((x) => x.id)], (id) => presets.get(id));
  const skippedWorkflows = skippedManifestFindings(
    root, 'workflow', [...w.workflows.map((x) => x.id), ...w.invalid.map((x) => x.id)], (id) => workflows.get(id));
  findings.push(...skippedPresets, ...skippedWorkflows);
  // Deterministic print order: presets first, then code-unit sort on file, code and
  // field. The registry order alone is per-kind id order, which is enough for counts
  // but not for a line-for-line stable CI log.
  findings.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'preset' ? -1 : 1;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : a.field < b.field ? -1 : a.field > b.field ? 1 : 0;
  });

  return {
    findings,
    // Skipped-manifest directories hold a manifest, so they count as checked.
    presetsChecked: p.presets.length + p.invalid.length + skippedPresets.length,
    workflowsChecked: w.workflows.length + w.invalid.length + skippedWorkflows.length,
    valid: findings.length === 0,
  };
}

export interface BuiltinLintCli {
  exitCode: 0 | 1;
  lines: string[];
}

/**
 * CLI/CI rendering: one line per finding (`<file>: <code> <field>: <message>`) plus one
 * summary line. `exitCode` is the command's contract: 0 on a clean tree, 1 on any finding.
 */
export function formatBuiltinLint(report: BuiltinLintReport): BuiltinLintCli {
  const lines = report.findings.map(
    (f) => `${f.file}: ${f.code}${f.field ? ` ${f.field}:` : ''} ${f.message}`,
  );
  lines.push(
    report.valid
      ? `ok: no findings in ${report.presetsChecked} builtin preset(s), ${report.workflowsChecked} builtin workflow template(s)`
      : `FAIL: ${report.findings.length} finding(s) in ${report.presetsChecked} builtin preset(s), ${report.workflowsChecked} builtin workflow template(s)`,
  );
  return { exitCode: report.valid ? 0 : 1, lines };
}

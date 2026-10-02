// Builtin workflow registry: workflows/<id>/workflow.json
// (docs/crew/workflows.md sections 3.1 and 4; issue #808).
//
// Modelled on the preset registry (src/presets/presetRegistry.ts): per-template error
// isolation (one malformed directory must not hide the valid templates next to it),
// deterministic code-unit ordering, registry-assigned trust, and the canonical
// locale-independent content hash. list() returns only valid templates; listAll()
// additionally returns invalid entries with their findings for diagnostic callers.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { dataPath } from '../paths.ts';
import { NotFoundError, ValidationError } from '../domain/errors.ts';
import { assertNoSymlinkBelow, compareSkillIds, resolveContained } from '../skills/skillRegistry.ts';
import type { SkillRegistry } from '../skills/skillRegistry.ts';
import { PresetRegistry } from '../presets/presetRegistry.ts';
import { validateWorkflowTemplate, type ValidateWorkflowDeps } from './validateWorkflow.ts';
import type { InvalidWorkflow, LoadedWorkflow, WorkflowFinding } from './types.ts';

/** Where the shipped workflows live (package root, like presets/). */
export function builtinWorkflowsDir(): string {
  return dataPath('workflows');
}

export interface WorkflowRegistryDeps {
  /**
   * Preset existence for reference validation. ABSENT means no presets are visible, so
   * every referenced preset is reported missing -- a registry that cannot see presets must
   * not silently approve references to them (the same rule as preset -> skill references;
   * the composition root passes the registry explicitly).
   */
  presets?: PresetRegistry;
}

/**
 * Sanitize an unexpected load error for the diagnostics surface, exactly like the preset
 * registry: Node I/O messages embed absolute host paths, and diagnostics must not leak
 * filesystem layout. Occurrences of the registry root become the relative form; any other
 * absolute path collapses to its basename; the message is length-capped.
 */
function sanitizeLoadError(err: unknown, rootDir: string): string {
  let msg = String(err instanceof Error ? err.message : err);
  msg = msg.split(rootDir + sep).join('');
  msg = msg.split(rootDir).join('.');
  msg = msg.replace(/(?:[\\\/][A-Za-z0-9._-]+)+/g, (m) => m.slice(Math.max(m.lastIndexOf('/'), m.lastIndexOf('\\')) + 1));
  return msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
}

export class WorkflowRegistry {
  private readonly rootDir: string;
  private readonly deps: WorkflowRegistryDeps;

  constructor(rootDir: string, deps: WorkflowRegistryDeps = {}) {
    this.rootDir = rootDir;
    this.deps = deps;
  }

  /**
   * Valid templates, deterministic order. "Deterministic" means CODE-UNIT order on the id
   * (compareSkillIds), never localeCompare (issue #86's lesson, the same one the preset
   * registry applies).
   */
  list(): LoadedWorkflow[] {
    const out: LoadedWorkflow[] = [];
    for (const id of this.directoryIds()) {
      const loaded = this.loadOne(id, { throwOnError: false });
      if (loaded !== null) out.push(loaded);
    }
    return out.sort((a, b) => compareSkillIds(a.id, b.id));
  }

  /**
   * Everything on disk: valid templates AND invalid entries with their findings.
   */
  listAll(): { workflows: LoadedWorkflow[]; invalid: InvalidWorkflow[] } {
    const workflows: LoadedWorkflow[] = [];
    const invalid: InvalidWorkflow[] = [];
    for (const id of this.directoryIds()) {
      try {
        const loaded = this.loadOne(id, { throwOnError: true });
        if (loaded !== null) workflows.push(loaded);
      } catch (err) {
        // A directory without workflow.json is a STRAY, not an invalid template: listings
        // skip it entirely, for the same reason the preset registry skips stray directories.
        if (err instanceof NotFoundError) continue;
        invalid.push({ id, validation: err instanceof WorkflowValidationFailure ? err.findings : [{
          code: 'WORKFLOW_LOAD_FAILED', field: '', message: sanitizeLoadError(err, this.rootDir),
        }] });
      }
    }
    workflows.sort((a, b) => compareSkillIds(a.id, b.id));
    invalid.sort((a, b) => compareSkillIds(a.id, b.id));
    return { workflows, invalid };
  }

  /** One template, loaded and validated. */
  get(id: string): LoadedWorkflow {
    const loaded = this.loadOne(id, { throwOnError: true });
    if (loaded === null) throw new NotFoundError(`Workflow not found: ${JSON.stringify(id)}`);
    return loaded;
  }

  /**
   * The canonical content hash for a file map: SHA-256 over code-unit-sorted
   * `path\0content` pairs joined by `\0` -- the SAME construction the preset and skill
   * registries use (PresetRegistry.contentHash), so every snapshot hash in the product is
   * computed one way. Locale-independent by construction.
   */
  static contentHash(files: Record<string, string>): string {
    return PresetRegistry.contentHash(files);
  }

  private directoryIds(): string[] {
    if (!exists(this.rootDir)) return [];
    return readdirSync(this.rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      // Skip names that cannot be workflow ids: one stray directory must not make every
      // listing throw, for the same reason the preset registry skips them.
      .filter((id) => /^[a-z0-9][a-z0-9._-]*$/.test(id));
  }

  private loadOne(
    id: string,
    opts: { throwOnError: boolean },
  ): LoadedWorkflow | null {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
      throw new ValidationError(`Unsafe workflow id: ${JSON.stringify(id)}`);
    }
    // Contained + symlink-free, not merely joined (the preset registry's rule, write and
    // read side). A repo checkout the operator does not trust ships workflows/ too; a
    // symlinked manifest would otherwise turn this read into an arbitrary host-file read.
    try {
      return this.loadOneChecked(id, opts);
    } catch (err) {
      if (!opts.throwOnError) return null;
      throw err;
    }
  }

  private loadOneChecked(
    id: string,
    opts: { throwOnError: boolean },
  ): LoadedWorkflow | null {
    const dir = resolveContained(this.rootDir, id);
    assertNoSymlinkBelow(this.rootDir, dir);
    const manifestPath = join(dir, 'workflow.json');
    assertNoSymlinkBelow(this.rootDir, manifestPath);
    if (!exists(manifestPath)) {
      // A directory without workflow.json is a STRAY directory, not a template: listing
      // skips it and get() reports not-found (the preset registry's stray-directory rule).
      throw new NotFoundError(`Workflow not found: ${JSON.stringify(id)}`);
    }
    let templateJson: string;
    try {
      // Read as bytes first, then decode with fatal: true so a template that is not UTF-8
      // fails with a structured finding instead of silently producing U+FFFD replacement
      // characters (the preset registry's instruction-decoding rule).
      const bytes = readFileSync(manifestPath);
      templateJson = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (err) {
      throw new WorkflowValidationFailure(id, [{
        code: 'WORKFLOW_MANIFEST_ENCODING', field: 'workflow.json',
        message: `workflow.json could not be read as UTF-8: ${err instanceof Error ? err.message : String(err)}`,
      }]);
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(templateJson);
    } catch (err) {
      const finding: WorkflowFinding = {
        code: 'WORKFLOW_MANIFEST_PARSE', field: 'workflow.json',
        message: `workflow.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
      throw new WorkflowValidationFailure(id, [finding]);
    }

    // One registry read per template load, not one per referenced preset: validation asks
    // membership questions against a closure over get().
    // A DISABLED preset does not resolve: Run creation refuses disabled presets
    // (RunService throws "preset ... is disabled"), so a reference the creation path would
    // reject must fail validation now, not at W-2 creation time.
    const lookup = this.deps.presets
      ? (presetId: string, version?: string) => {
          try {
            const loaded = this.deps.presets!.get(presetId);
            if (!loaded.enabled) return null;
            if (version !== undefined && loaded.version !== version) return null;
            return { version: loaded.version };
          } catch {
            return null;
          }
        }
      : undefined;
    const deps: ValidateWorkflowDeps = { presetLookup: lookup };

    const validation = validateWorkflowTemplate(id, manifest, deps);
    if (!validation.valid) {
      if (opts.throwOnError) throw new WorkflowValidationFailure(id, validation.findings);
      return null;
    }

    const m = manifest as import('./types.ts').WorkflowTemplateManifest;
    const files: Record<string, string> = {};
    collectFiles(dir, dir, files);
    // The files map keys are workflow-RELATIVE POSIX paths (the preset registry's rule).
    for (const [absPath, content] of Object.entries({ ...files })) {
      const rel = relative(dir, absPath).split(sep).join('/');
      delete files[absPath];
      files[rel] = content;
    }

    return {
      id,
      version: m.version,
      description: m.description,
      mode: m.mode,
      stages: m.stages,
      maxStages: m.maxStages,
      manifest: m,
      templateJson,
      files,
      contentHash: WorkflowRegistry.contentHash(files),
      // Registry-assigned provenance (the preset rule). Nothing in the manifest feeds this.
      trust: 'builtin',
      source: { kind: 'builtin', relativePath: `workflows/${id}/workflow.json` },
    };
  }
}

/** Structured failure carrying the findings (registry internals and tests). */
export class WorkflowValidationFailure extends ValidationError {
  readonly findings: WorkflowFinding[];
  constructor(id: string, findings: WorkflowFinding[]) {
    super(`workflow ${JSON.stringify(id)} is invalid: ` + findings.map((f) => `${f.field || '(root)'}: ${f.code} ${f.message}`).join('; '));
    this.name = 'WorkflowValidationFailure';
    this.findings = findings;
  }
}

function collectFiles(dir: string, base: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // A symlink inside a workflow directory would be followed by readFileSync and fold
      // arbitrary host bytes into the snapshot hash -- the preset registry refuses rather
      // than skips, and so does this one.
      throw new ValidationError(
        `Workflow file component is a symlink, refusing to follow it: ${JSON.stringify(relative(base, full))}`,
      );
    }
    if (entry.isDirectory()) {
      collectFiles(full, base, out);
    } else if (entry.isFile()) {
      out[full] = readFileSync(full, 'utf8');
    }
  }
}

function exists(p: string): boolean {
  try {
    // One stat, two questions (the preset registry's single-stat rule).
    const st = statSync(p);
    return st.isFile() || st.isDirectory();
  } catch {
    return false;
  }
}

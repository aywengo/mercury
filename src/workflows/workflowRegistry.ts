// Builtin workflow registry: workflows/<id>/workflow.json
// (docs/crew/workflows.md sections 3.1 and 4; issue #808).
//
// Modelled on the preset registry (src/presets/presetRegistry.ts): per-template error
// isolation (one malformed directory must not hide the valid templates next to it),
// deterministic code-unit ordering, registry-assigned trust, and the canonical
// locale-independent content hash. list() returns only valid templates; listAll()
// additionally returns invalid entries with their findings for diagnostic callers.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dataPath } from '../paths.ts';
import { NotFoundError, ValidationError } from '../domain/errors.ts';
import { assertNoSymlinkBelow, compareSkillIds, resolveContained } from '../skills/skillRegistry.ts';
import type { SkillRegistry } from '../skills/skillRegistry.ts';
import { PresetRegistry } from '../presets/presetRegistry.ts';
import { validateWorkflowTemplate, type ValidateWorkflowDeps } from './validateWorkflow.ts';
import type { InvalidWorkflow, LoadedWorkflow, WorkflowFinding } from './types.ts';

/** The UTF-8 byte-order mark: legal in a JSON file, stripped by TextDecoder, kept on disk. */
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

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
        if (err instanceof WorkflowLoadError) {
          // Already sanitized at the throw site (the only place that knows both the root and
          // the raw error); report it verbatim instead of sanitizing a second time, which
          // would strip the message down to its last path-like fragment.
          invalid.push({ id, validation: [{
            code: 'WORKFLOW_LOAD_FAILED', field: '', message: err.message,
          }] });
          continue;
        }
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
    try {
      if (!exists(this.rootDir)) return [];
    } catch (err) {
      // The root must be readable for any listing to make sense; a non-ENOENT stat failure
      // is an environment problem (round-2 review, #812). Surface it, never an empty list.
      throw new WorkflowLoadError('(registry root)', err, this.rootDir);
    }
    // A stat-able but unreadable root (EACCES on the root itself) fails here; sanitize it
    // the same way - a raw Node error would embed the absolute root path (round-2 review).
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(this.rootDir, { withFileTypes: true });
    } catch (err) {
      throw new WorkflowLoadError('(registry root)', err, this.rootDir);
    }
    return entries
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
    let manifestPresent: boolean;
    try {
      manifestPresent = exists(manifestPath);
    } catch (err) {
      // A stat failure other than ENOENT (EACCES on a parent, EIO) is a load problem, not a
      // stray-directory signal: report it like every other read failure (round-2 review,
      // #812 - exists() used to collapse it to absence, silently skipping the template in
      // listAll() and misreporting it as not-found in get()).
      throw new WorkflowLoadError(id, err, this.rootDir);
    }
    if (!manifestPresent) {
      // A directory without workflow.json is a STRAY directory, not a template: listing
      // skips it and get() reports not-found (the preset registry's stray-directory rule).
      throw new NotFoundError(`Workflow not found: ${JSON.stringify(id)}`);
    }
    // Read as bytes FIRST, outside the decoding catch: an I/O failure (unreadable file, a
    // manifest path that is a directory, permissions) is a WORKFLOW_LOAD_FAILED with a
    // sanitized message, not a decoding problem, and its raw Node message must never reach
    // the diagnostics surface via listAll() (listAll reports WorkflowValidationFailure
    // findings verbatim, which is correct for validation but leaks paths for read errors).
    // WorkflowLoadError is deliberately NOT a WorkflowValidationFailure: listAll() catches
    // it and re-reports it as WORKFLOW_LOAD_FAILED through sanitizeLoadError -- the only
    // place that maps raw load errors to findings.
    let bytes: Buffer;
    try {
      bytes = readFileSync(manifestPath);
    } catch (err) {
      throw new WorkflowLoadError(id, err, this.rootDir);
    }
    // Decode with fatal: true so a template that is not UTF-8 fails with a structured finding
    // instead of silently producing U+FFFD replacement characters (the preset registry's
    // instruction-decoding rule). TextDecoder strips a leading UTF-8 BOM (WHATWG decoding);
    // templateJson must stay the VERBATIM file text, so put the BOM back when it was there --
    // the snapshot contract (LoadedWorkflow.templateJson) and the files map must agree.
    let templateJson: string;
    try {
      templateJson = (bytes.subarray(0, 3).equals(BOM) ? BOM : Buffer.alloc(0))
        + new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new WorkflowValidationFailure(id, [{
        code: 'WORKFLOW_MANIFEST_ENCODING', field: 'workflow.json',
        message: 'workflow.json is not valid UTF-8',
      }]);
    }

    let manifest: unknown;
    try {
      // Parse the BOM-STRIPPED text: JSON.parse refuses a leading BOM (V8 throws
      // "Unexpected token '\ufeff'"), and a BOM-prefixed template must be judged by its
      // content, not rejected as unparsable.
      manifest = JSON.parse(templateJson.replace(/^\uFEFF/, ''));
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
    try {
      collectFiles(dir, dir, files);
    } catch (err) {
      // An unreadable extra file (EACCES on notes.md, EIO) must not escape get() as a raw
      // Node error embedding absolute host paths: listAll() sanitizes this via its catch,
      // get() needs the same guarantee (round-2 review, #812).
      throw new WorkflowLoadError(id, err, this.rootDir);
    }
    // The files map keys are workflow-RELATIVE POSIX paths (the preset registry's rule).
    // path.relative anchors a RELATIVE `to` at process.cwd(), not at `from` (all keys are
    // absolute here today, but the BOM restore below can only ever add 'workflow.json' --
    // anchor every `to` at `dir` explicitly so a relative key can never silently become a
    // cwd-relative path on a future edit).
    for (const [absPath, content] of Object.entries({ ...files })) {
      const rel = relative(dir, isAbsolute(absPath) ? absPath : resolve(dir, absPath)).split(sep).join('/');
      delete files[absPath];
      files[rel] = content;
    }
    // The manifest entry keeps the exact on-disk bytes (BOM included): templateJson (decoded
    // above, BOM restored) and files['workflow.json'] (raw read) must be the same string,
    // because the W-2 snapshot stores templateJson verbatim while the hash covers the files
    // map -- a mismatch would make the promised snapshot and the hashed content diverge
    // (round-1 review, #812: a BOM'd manifest produced exactly that divergence). Fail loudly
    // rather than snapshot a subtly different manifest.
    if (files['workflow.json'] !== templateJson) {
      throw new WorkflowValidationFailure(id, [{
        code: 'WORKFLOW_LOAD_FAILED', field: 'workflow.json',
        message: 'workflow.json could not be read consistently (decoded text differs from the file bytes)',
      }]);
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

/**
 * A workflow.json that could not be READ (I/O error, or the manifest path is a directory).
 * Thrown as a class so listAll() reports a sanitized WORKFLOW_LOAD_FAILED finding here, at
 * the one place that knows the registry root -- Node I/O messages embed absolute host paths
 * (e.g. "ENOENT: no such file or directory, open '/Users/.../workflow.json'") and must not
 * reach the diagnostics surface verbatim (the preset registry's sanitizeLoadError rule).
 */
class WorkflowLoadError extends Error {
  constructor(id: string, err: unknown, rootDir: string) {
    super(`workflow ${JSON.stringify(id)} could not be read: ${sanitizeLoadError(err, rootDir)}`);
    this.name = 'WorkflowLoadError';
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
  } catch (err) {
    // Only ENOENT means absence. A stat failure like EACCES on a parent directory is an
    // environment problem, not a stray-directory signal: treating it as absence made
    // listAll() silently skip a real template and get() report not-found instead of a
    // load failure (round-2 review, #812). Rethrow; the caller's load-error path reports
    // it as a sanitized WORKFLOW_LOAD_FAILED finding.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}

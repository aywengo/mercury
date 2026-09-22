// Builtin preset registry: presets/<id>/{preset.json, INSTRUCTION.md, ...}
// (docs/crew/role-presets.md sections 2, 4 and 11).
//
// Per-preset error isolation (section 2.1): one malformed directory must not hide
// the valid presets next to it. list() returns only valid presets; listAll()
// additionally returns invalid entries with their findings for authorized
// diagnostic callers (the API decides who may ask -- Phase 3).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { dataPath } from '../paths.ts';
import { NotFoundError, ValidationError } from '../domain/errors.ts';
import { compareSkillIds } from '../skills/skillRegistry.ts';
import type { SkillRegistry } from '../skills/skillRegistry.ts';
import { findingsToError, validatePreset, type ValidatePresetDeps } from './validatePreset.ts';
import type { InvalidPreset, LoadedPreset, PresetFinding } from './types.ts';

/** Where the shipped presets live (package root, like .agents/skills). */
export function builtinPresetsDir(): string {
  return dataPath('presets');
}

export interface PresetRegistryDeps {
  /** Skill existence for reference validation; defaults to this repo's registry. */
  skills?: SkillRegistry;
  /** Known agent ids, from the same list Run creation validates against. */
  knownAgents?: readonly string[];
}

export class PresetRegistry {
  private readonly rootDir: string;
  private readonly deps: PresetRegistryDeps;

  constructor(rootDir: string, deps: PresetRegistryDeps = {}) {
    this.rootDir = rootDir;
    this.deps = deps;
  }

  /**
   * Valid presets, deterministic order. "Deterministic" means CODE-UNIT order on
   * the id (compareSkillIds), never localeCompare (issue #86): a host-dependent
   * order would make two hosts list the same directory differently.
   */
  list(opts: { includeDisabled?: boolean } = {}): LoadedPreset[] {
    const out: LoadedPreset[] = [];
    for (const id of this.directoryIds()) {
      const loaded = this.loadOne(id, { throwOnError: false });
      if (loaded !== null && (opts.includeDisabled || loaded.enabled)) out.push(loaded);
    }
    return out.sort((a, b) => compareSkillIds(a.id, b.id));
  }

  /**
   * Everything on disk: valid presets AND invalid entries with their findings.
   * The caller decides who may see invalid entries (section 2.1 keeps them out
   * of the ordinary list).
   */
  listAll(): { presets: LoadedPreset[]; invalid: InvalidPreset[] } {
    const presets: LoadedPreset[] = [];
    const invalid: InvalidPreset[] = [];
    for (const id of this.directoryIds()) {
      try {
        const loaded = this.loadOne(id, { throwOnError: true });
        if (loaded !== null) presets.push(loaded);
      } catch (err) {
        invalid.push({ id, validation: err instanceof PresetValidationFailure ? err.findings : [{
          code: 'PRESET_LOAD_FAILED', field: '', message: String(err instanceof Error ? err.message : err),
        }] });
      }
    }
    presets.sort((a, b) => compareSkillIds(a.id, b.id));
    invalid.sort((a, b) => compareSkillIds(a.id, b.id));
    return { presets, invalid };
  }

  /** One preset, loaded and validated. */
  get(id: string): LoadedPreset {
    const loaded = this.loadOne(id, { throwOnError: true });
    if (loaded === null) throw new NotFoundError(`Preset not found: ${JSON.stringify(id)}`);
    return loaded;
  }

  /**
   * The canonical content hash for a file map: SHA-256 over code-unit-sorted
   * `path\0content` pairs joined by `\0` -- the same construction the skill
   * registry uses, and locale-independent by construction (section 4).
   */
  static contentHash(files: Record<string, string>): string {
    return createHash('sha256')
      .update(Object.entries(files)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([p, c]) => `${p}\0${c}`)
        .join('\0'))
      .digest('hex');
  }

  private directoryIds(): string[] {
    if (!exists(this.rootDir)) return [];
    return readdirSync(this.rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      // Skip names that cannot be preset ids: one stray directory must not make
      // every listing throw, for the same reason the skill registry skips them.
      .filter((id) => /^[a-z0-9][a-z0-9._-]*$/.test(id));
  }

  private loadOne(
    id: string,
    opts: { throwOnError: boolean },
  ): LoadedPreset | null {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
      throw new ValidationError(`Unsafe preset id: ${JSON.stringify(id)}`);
    }
    const dir = resolve(this.rootDir, id);
    const manifestPath = join(dir, 'preset.json');
    if (!exists(manifestPath)) {
      throw new NotFoundError(`Preset not found: ${JSON.stringify(id)}`);
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      const finding: PresetFinding = {
        code: 'PRESET_MANIFEST_ENCODING', field: 'preset.json',
        message: `preset.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
      if (opts.throwOnError) throw new PresetValidationFailure(id, [finding]);
      return null;
    }

    // One registry read per preset load, not one per referenced skill: validation asks
    // membership questions against a Set, so a large catalog stays O(presets x refs).
    const skillIds = this.deps.skills ? new Set(this.deps.skills.list().map((s) => s.id)) : null;
    const deps: ValidatePresetDeps = {
      skillExists: (skillId) => (skillIds ? skillIds.has(skillId) : false),
      knownAgents: this.deps.knownAgents,
    };
    const validation = validatePreset(id, dir, manifest, deps);
    if (!validation.valid) {
      if (opts.throwOnError) throw new PresetValidationFailure(id, validation.findings);
      return null;
    }

    const m = manifest as import('./types.ts').RolePresetManifest;
    const instFile = m.instruction?.file ?? 'INSTRUCTION.md';
    // Validation already proved the path is contained and a regular file, but the READ can
    // still fail (permissions changed between stat and read) -- keep it inside the finding
    // contract instead of letting it degrade to PRESET_LOAD_FAILED.
    let instructionBytes: Buffer;
    try {
      instructionBytes = readFileSync(join(dir, instFile));
    } catch {
      throw new PresetValidationFailure(id, [{
        code: 'PRESET_INSTRUCTION_MISSING', field: 'instruction.file',
        message: `instruction file ${JSON.stringify(instFile)} could not be read`,
      }]);
    }
    // Decoded with fatal: true so a preset whose instruction is not UTF-8 fails with a
    // structured finding instead of silently producing U+FFFD replacement characters.
    let instruction: string;
    try {
      instruction = new TextDecoder('utf-8', { fatal: true }).decode(instructionBytes);
    } catch {
      throw new PresetValidationFailure(id, [{
        code: 'PRESET_INSTRUCTION_ENCODING', field: 'instruction.file',
        message: `instruction file ${JSON.stringify(instFile)} is not valid UTF-8`,
      }]);
    }

    const files: Record<string, string> = {};
    collectFiles(dir, dir, files);
    // The files map keys are preset-RELATIVE POSIX paths (section 4: "relative file paths").
    for (const [absPath, content] of Object.entries({ ...files })) {
      const rel = relative(dir, absPath).split(sep).join('/');
      delete files[absPath];
      files[rel] = content;
    }

    return {
      id,
      version: m.version,
      role: m.role,
      description: m.description,
      tags: m.tags ?? [],
      enabled: m.enabled ?? true,
      manifest: m,
      instruction,
      instructionFile: instFile,
      files,
      contentHash: PresetRegistry.contentHash(files),
      // Registry-assigned provenance (section 2). Nothing in the manifest feeds this.
      trust: 'builtin',
      source: { kind: 'builtin', relativePath: `presets/${id}/preset.json` },
    };
  }
}

/** Structured failure carrying the findings (registry internals and tests). */
export class PresetValidationFailure extends ValidationError {
  readonly findings: PresetFinding[];
  constructor(id: string, findings: PresetFinding[]) {
    super(findingsToError(id, findings).message);
    this.name = 'PresetValidationFailure';
    this.findings = findings;
  }
}

function collectFiles(dir: string, base: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, base, out);
    } else if (entry.isFile()) {
      out[full] = readFileSync(full, 'utf8');
    }
  }
}

function exists(p: string): boolean {
  try {
    return statSync(p).isFile() || statSync(p).isDirectory();
  } catch {
    return false;
  }
}

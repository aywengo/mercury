// Filesystem skill registry (.agents/skills/<id>/SKILL.md) with content snapshots
// (Mercury.md sections 10-11, 28).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { ResolvedSkill } from '../domain/types.ts';
import { ValidationError } from '../domain/errors.ts';

/**
 * A skill id must be one safe path segment (issue #58).
 *
 * Ids arrive from the API (`body.skills`) and are joined onto the registry root, so
 * before this check `skills: ["../../../../somewhere"]` resolved to any directory on
 * the host that happened to contain a SKILL.md -- and writeSkills then copied that
 * whole tree into the run workspace. That is an arbitrary-directory read, not a
 * malformed-input error.
 *
 * Excluding separators is what actually does the work: "." and ".." cannot match
 * because the id must start alphanumeric, and no "/" or "\" can appear at all.
 */
const SAFE_SKILL_ID = /^[a-z0-9][a-z0-9._-]*$/;

export function assertSafeSkillId(id: string): string {
  if (typeof id !== 'string' || !SAFE_SKILL_ID.test(id)) {
    throw new ValidationError(`Unsafe skill id: ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * Resolve symlinks on the longest existing prefix of `abs` and re-append the rest.
 * The destination of a write usually does not exist yet, so realpathSync on it would
 * throw; walking up to the nearest existing ancestor is what lets containment apply
 * to paths about to be created.
 */
function realpathNearest(abs: string): string {
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return missing.length === 0 ? realpathSync(cur) : join(realpathSync(cur), ...missing);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // reached the filesystem root with nothing existing
      missing.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** True when `abs` is `root` itself or strictly below it, on already-realpathed paths. */
function isContained(realRoot: string, abs: string): boolean {
  // Compare against root + separator, not root alone. A bare startsWith(root) treats a
  // sibling named `/root-evil` as if it were inside `/root`. Also avoids building `//`
  // when root is the filesystem root itself, which would reject every child of `/`.
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return abs === realRoot || abs.startsWith(prefix);
}

/**
 * Resolve `rel` inside `root`, refusing anything that escapes it (issue #58).
 *
 * Used for the per-file relative paths a resolved skill carries, and for both halves of
 * the destination in writeSkills -- containment there is defence in depth, so a future
 * caller that takes them from input cannot reintroduce the traversal.
 *
 * Containment is checked twice: lexically, then through symlinks. The lexical check
 * alone is not enough, because a run workspace is a git worktree of a repo that may be
 * untrusted, and git happily checks out `.agents/skills` as a symlink. Lexical
 * containment would then approve a path whose real target is anywhere on the host,
 * turning writeSkills into a write primitive outside the workspace.
 *
 * Both sides go through realpath. Resolving only the target would break every path
 * under a symlinked root -- on macOS /tmp is a symlink to /private/tmp, so a
 * /tmp/... root would reject its own children.
 */
export function resolveContained(root: string, rel: string): string {
  const absRoot = resolve(root);
  const abs = resolve(absRoot, rel);
  if (!isContained(absRoot, abs)) {
    throw new ValidationError(`Skill path escapes the skill root: ${JSON.stringify(rel)}`);
  }
  const realRoot = realpathNearest(absRoot);
  const realAbs = realpathNearest(abs);
  if (!isContained(realRoot, realAbs)) {
    throw new ValidationError(`Skill path escapes the skill root through a symlink: ${JSON.stringify(rel)}`);
  }
  assertNoSymlinkBelow(absRoot, abs);
  return abs;
}

/**
 * Refuse if the root itself, or any component between it and `abs`, is a symlink.
 *
 * The realpath containment above cannot catch this on its own: if the root's own last
 * component is a symlink, realpath resolves it and the attacker's target *becomes* the
 * root, so the target is trivially "contained". That is sound for a root an operator
 * chose, and unsound here, where the root is `workspace/.agents/skills` and its last
 * component is created by checking out a repo that may be untrusted. So the root's own
 * component and everything below it must not be symlinks, while symlinks in the root's
 * ANCESTRY stay allowed -- /tmp is a symlink on macOS and must keep working.
 */
function assertNoSymlinkBelow(root: string, abs: string): void {
  const rel = relative(root, abs);
  const parts = rel === '' ? [] : rel.split(sep);
  // Walk by RELATIVE component and resolve to an absolute path only for the syscall. Keeping the
  // relative form for the message is deliberate (issue #66): this error reaches an HTTP client,
  // and both the walked path and the symlink target can be absolute, which would hand back the
  // on-disk layout the containment work exists to hide. The symlink TARGET is withheld for the
  // same reason -- it is server state, and the client already has everything it needs from the
  // relative component it supplied.
  for (let i = 0; i <= parts.length; i++) {
    const step = i === 0 ? root : join(root, ...parts.slice(0, i));
    const label = i === 0 ? '<skill root>' : parts.slice(0, i).join('/');
    try {
      readlinkSync(step);
    } catch {
      continue; // does not exist yet, so it cannot be a symlink
    }
    throw new ValidationError(`Skill path component is a symlink, refusing to follow it: ${JSON.stringify(label)}`);
  }
}

export interface SkillMeta {
  id: string;
  version: string;
  description: string;
  capabilities: string[];
}

/**
 * Canonical ordering for skill ids (issue #81). Single source of truth so the
 * registry, the selector tie-break and the tests cannot order the same list
 * differently. Deliberately code-unit order rather than `localeCompare`: the
 * latter is locale- and ICU-build-sensitive, so an id containing punctuation or
 * upper case could sort one way on a developer machine and another in CI.
 */
export function compareSkillIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class SkillRegistry {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  list(): SkillMeta[] {
    if (!exists(this.rootDir)) return [];
    return readdirSync(this.rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((id) => exists(join(this.rootDir, id, 'SKILL.md')))
      // Skip directories whose name is not a safe skill id (issue #58). Without this,
      // list() can hand back ids that resolve() now rejects, and the auto-selection path
      // (runService: selector.select(task, skills.list(), 4) -> skills.resolve(ids)) would
      // throw out of run creation. A stray `.hidden`, `Code-Review` or `my skill`
      // directory -- or a stray `.DS_Store` tree -- must not make every run fail to
      // create. Skipping rather than throwing keeps one odd directory from taking down the
      // whole registry; all 12 shipped skills comply.
      .filter((id) => SAFE_SKILL_ID.test(id))
      .map((id) => this.readMeta(id))
      .sort((a, b) => compareSkillIds(a.id, b.id));
  }

  resolve(ids: string[]): ResolvedSkill[] {
    const seen = new Set<string>();
    const out: ResolvedSkill[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(this.resolveOne(id));
    }
    return out;
  }

  private resolveOne(id: string): ResolvedSkill {
    // Contained, not merely joined (issue #58).
    const dir = resolveContained(this.rootDir, assertSafeSkillId(id));
    const skillPath = join(dir, 'SKILL.md');
    if (!exists(skillPath)) {
      throw new ValidationError(`Skill not found: ${JSON.stringify(id)}`);
    }
    const meta = this.readMeta(id);
    const files: Record<string, string> = {};
    collectFiles(dir, dir, files);
    const content = files['SKILL.md'] ?? '';
    // Code-unit ordering via compareSkillIds, NOT localeCompare (issue #86).
    //
    // localeCompare depends on the host locale and the ICU build, so two hosts can order the same
    // set of paths differently. collectFiles() is recursive, so any skill with more than one file
    // can hash differently on two machines from byte-identical content -- files differing only by
    // punctuation or case are enough (locale puts '-' below '.' while code-unit order puts '.'
    // below '-').
    //
    // This matters because the hash is an audit artifact, not an internal detail: it is persisted
    // to run_skills.skill_hash, emitted in skill.selected events, and handed to the adapters. A
    // host-dependent hash means "which skill version did this run use" has no single answer, and a
    // canary comparison across hosts reports a difference that is only the locale.
    //
    // Reusing compareSkillIds rather than inlining `a < b` keeps one canonical ordering for the
    // whole registry, which is why that helper exists.
    const hash = createHash('sha256')
      .update(Object.entries(files)
        .sort(([a], [b]) => compareSkillIds(a, b))
        .map(([p, c]) => `${p}\0${c}`)
        .join('\0'))
      .digest('hex');
    return {
      id,
      version: meta.version,
      description: meta.description,
      capabilities: meta.capabilities,
      path: skillPath,
      content,
      files,
      hash,
    };
  }

  private readMeta(id: string): SkillMeta {
    const raw = readFileSync(join(this.rootDir, id, 'SKILL.md'), 'utf8');
    const fm = parseFrontmatter(raw);
    const capabilities = Array.isArray(fm.capabilities)
      ? fm.capabilities.map(String)
      : typeof fm.capabilities === 'string'
        ? fm.capabilities.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    return {
      id,
      version: String(fm.version ?? '0.0.0'),
      description: String(fm.description ?? ''),
      capabilities,
    };
  }
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return {};
  const out: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      out[kv[1]] = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
    } else {
      out[kv[1]] = value.replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

function collectFiles(dir: string, base: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, base, out);
    } else if (entry.isFile()) {
      out[relative(base, full).split('\\').join('/')] = readFileSync(full, 'utf8');
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

// Filesystem skill registry (.agents/skills/<id>/SKILL.md) with content snapshots
// (Mercury.md sections 10-11, 28).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ResolvedSkill } from '../domain/types.ts';

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
    const dir = join(this.rootDir, id);
    const skillPath = join(dir, 'SKILL.md');
    if (!exists(skillPath)) {
      throw new Error(`Skill not found: ${id} (expected ${skillPath})`);
    }
    const meta = this.readMeta(id);
    const files: Record<string, string> = {};
    collectFiles(dir, dir, files);
    const content = files['SKILL.md'] ?? '';
    const hash = createHash('sha256')
      .update(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([p, c]) => `${p}\0${c}`).join('\0'))
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

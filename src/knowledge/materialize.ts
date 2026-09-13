/**
 * Materializing a pack into a workspace (docs/knowledge-base.md 9.2, 9.4).
 *
 * Two layers, and the split matters. Everything here is harness-NEUTRAL: three files that any agent can
 * read and write, with no protocol, no MCP, and no prompt change. Rendering the pack into a channel a
 * specific harness reads is the adapter's job and lives in `src/adapters/` (Crew invariant 6).
 *
 * The file is the point. Every backend Mercury supports can read a file from its working directory and
 * write one back; none of them needs to learn a new event. That is what makes the tier-1 loop work with
 * a harness Mercury has never met.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { EvidenceRef, Note } from './types.ts';

export const PACK_DIR = '.mercury/knowledge';
export const PACK_FILE = `${PACK_DIR}/pack.json`;
export const NOTES_FILE = `${PACK_DIR}/NOTES.md`;
/** Tier 1: the agent appends here, and the harvester reads it back (section 7.1). */
export const NOTES_JSONL = '.mercury/notes.jsonl';

/**
 * The synthetic skill directory of section 9.3, for harnesses that read a skill directory.
 *
 * The name is deliberately not configurable. `GENERATED_PATHS` below has to exclude exactly the directory
 * that gets written, and a name chosen at runtime is a name the exclusion can silently miss -- which
 * would put a generated pack in a user's pull request, the outcome K1 exists to prevent.
 */
export const SKILL_ID = 'mercury-knowledge';
export const SKILL_DIR = `.agents/skills/${SKILL_ID}`;
export const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;

/** Paths Mercury generates and no agent should ever commit (section 9.4). */
export const GENERATED_PATHS = ['.mercury/', `${SKILL_DIR}/`];

const SPECIFICITY: Record<string, number> = { path: 0, repo: 1, project: 2, agent: 3 };

function specificity(scope: string): number {
  if (scope.includes('#')) return SPECIFICITY.path!;
  if (scope.startsWith('repo:')) return SPECIFICITY.repo!;
  if (scope.startsWith('agent:')) return SPECIFICITY.agent!;
  return SPECIFICITY.project!;
}

/** An evidence reference as plain text. Links, not prose, so a reader can follow them. */
function evidenceLabel(e: EvidenceRef): string {
  switch (e.type) {
    case 'commit': return `commit ${e.sha?.slice(0, 12) ?? '?'}`;
    case 'pr': return e.url;
    case 'issue': return e.url;
    case 'run-event': return `run ${e.runId ?? '?'}`;
    case 'repo-file': return `${e.path ?? '?'}@${e.sha?.slice(0, 8) ?? '?'}`;
    default: return String((e as { type?: string }).type ?? 'evidence');
  }
}

/**
 * The pack rendered for a reader with no context (section 9.2).
 *
 * Self-contained on purpose: what the pack is, what each note claims, and what to do with the file at
 * the bottom. The closing instruction is the whole tier-1 mechanism, and it travels through the same
 * channel as the knowledge so it needs no adapter support and no prompt change anywhere.
 */
export function renderNotesMd(projectId: string, packHash: string, notes: readonly Note[]): string {
  const lines: string[] = [];
  lines.push(`# Project knowledge: ${projectId}`);
  lines.push('');
  lines.push(`Pack \`${packHash}\` — ${notes.length} note${notes.length === 1 ? '' : 's'}, most specific first.`);
  lines.push('');
  if (notes.length === 0) {
    lines.push('No promoted knowledge applies to this task yet. The contribution instructions at the');
    lines.push('bottom still apply: what you learn here is the only way this list ever gets longer.');
    lines.push('');
  }

  const byScope = new Map<string, Note[]>();
  for (const note of notes) {
    const bucket = byScope.get(note.scope);
    if (bucket) bucket.push(note); else byScope.set(note.scope, [note]);
  }
  const scopes = [...byScope.keys()].sort(
    (a, b) => specificity(a) - specificity(b) || a.localeCompare(b),
  );
  for (const scope of scopes) {
    lines.push(`## ${scope}`);
    lines.push('');
    for (const note of byScope.get(scope)!) {
      const corr = `seen in ${note.corroboration?.runs ?? 0} Run${(note.corroboration?.runs ?? 0) === 1 ? '' : 's'} on ${note.corroboration?.harnesses ?? 0} harness${(note.corroboration?.harnesses ?? 0) === 1 ? '' : 'es'}`;
      const flags = [
        note.contested ? '**contested — another note contradicts this one**' : '',
      ].filter(Boolean);
      lines.push(`- **${note.kind}** — ${note.claim}${flags.length ? ` (${flags.join('; ')})` : ''}`);
      if (note.detail) for (const para of note.detail.split('\n')) lines.push(`  ${para}`);
      const evidence = (note.evidence ?? []).map(evidenceLabel);
      if (evidence.length) lines.push(`  - evidence: ${evidence.join(', ')}`);
      lines.push(`  - ${corr}`);
    }
    lines.push('');
  }

  lines.push('## Contributing what you learn');
  lines.push('');
  lines.push(`If you learn something durable about this project, append ONE JSON object per line to \`${NOTES_JSONL}\`.`);
  lines.push('Write what you would want to know on your first day here: a convention that is not in any');
  lines.push('README, a command that is faster than the obvious one, a way this project has been broken');
  lines.push('before. Do not write anything specific to this task, anything about a person, or anything');
  lines.push('you would not want repeated to every future agent here.');
  lines.push('');
  lines.push('Each line takes the fields `kind`, `scope`, `claim`, and optionally `detail`, `evidence`,');
  lines.push('`contradicts`. `kind` is one of `fact`, `convention`, `command`, `pitfall`, `decision`,');
  lines.push('`preference`. `scope` is `project`, `repo:<16-hex>`, `repo:<16-hex>#<path>` or');
  lines.push('`agent:<id>`. `claim` is one sentence, `detail` is the why. Evidence entries take');
  lines.push('`{"type":"issue","url":...}`, `{"type":"commit","sha":...}`, `{"type":"pr","url":...}`,');
  lines.push('`{"type":"run-event","runId":...}` or `{"type":"repo-file","repo":...,"path":...,"sha":...}`.');
  lines.push('');
  lines.push('You do not choose whether it is trusted. Mercury assigns the identity, provenance and');
  lines.push('corroboration, and a note becomes project-wide guidance only after it has been seen more');
  lines.push('than once. Lines that break those rules are refused and reported, never silently dropped.');
  lines.push('');
  return lines.join('\n');
}

/**
 * The pack as a skill, for a harness that reads a `.agents/skills/<id>/SKILL.md` directory (section 9.3).
 *
 * The body is the same rendered pack the neutral file carries, not a pointer to it. A skill that says
 * "go read another file" costs the harness a step it has no reason to take, and the whole argument for
 * the skill channel is that PrimeAgent opens this file unprompted -- so the knowledge has to be inside
 * the thing it already opens.
 *
 * The frontmatter matches what `writeSkills()` produces for a registry skill, because PrimeAgent parses
 * these the same way and a skill it cannot parse is a skill it skips without saying so.
 */
export function renderSkillMd(projectId: string, packHash: string, notes: readonly Note[]): string {
  const front = [
    '---',
    `name: ${SKILL_ID}`,
    'version: 1.0.0',
    `description: Project knowledge promoted by the team, gathered from earlier Runs on ${projectId}.`,
    'capabilities: [knowledge, context]',
    '---',
    '',
  ].join('\n');
  return `${front}${renderNotesMd(projectId, packHash, notes)}`;
}

export interface MaterializedPack {
  packPath: string;
  notesPath: string;
  notesFile: string;
  /** The synthetic skill of section 9.3, for adapters that render into a skill channel. */
  skillPath: string;
  /** True when a SKILL.md was already there and was left alone -- the project owns that name. */
  skillSkipped: boolean;
  count: number;
  packHash: string;
  /** Paths that could not be excluded from git, if any. */
  notExcluded: string[];
}

/**
 * Write the neutral files and keep them out of the diff.
 *
 * Returns the paths rather than logging them, because the caller writes the context pointer and needs
 * the same values; two sources for the pointer string is how a pointer ends up naming a file that was
 * never written.
 */
export function materializeKnowledge(
  workspacePath: string,
  opts: { projectId: string; packHash: string; notes: readonly Note[] },
): MaterializedPack {
  const packPath = join(workspacePath, PACK_FILE);
  const notesPath = join(workspacePath, NOTES_FILE);
  const jsonlPath = join(workspacePath, NOTES_JSONL);

  mkdirSync(dirname(packPath), {recursive: true});
  // Verbatim snapshot, so the workspace copy and run_knowledge agree byte for byte.
  writeFileSync(packPath, `${JSON.stringify({ packHash: opts.packHash, notes: opts.notes }, null, 2)}\n`);
  writeFileSync(notesPath, renderNotesMd(opts.projectId, opts.packHash, opts.notes));
  // Created empty rather than absent, so an agent that appends without checking cannot fail, and so the
  // harvester can tell "nothing learned" from "the workspace was never materialized".
  if (!existsSync(jsonlPath)) {
    mkdirSync(dirname(jsonlPath), {recursive: true});
    writeFileSync(jsonlPath, '');
  }

  // The skill rendering, written alongside the neutral files so a harness that reads skills and a harness
  // that reads files both get the same pack from the same materialization. Written after the neutral
  // files and before the exclusion pass, so the directory is covered by the exclude it is already in.
  const skillPath = join(workspacePath, SKILL_FILE);
  // A SKILL.md already here was put here by the repository checkout or by writeSkills, both of which run
  // before this -- a workspace is a fresh worktree per Run, so nothing else has had a chance to write it.
  // That makes it the project's file, and section 9.4 is unambiguous: Mercury never modifies a tracked
  // file. Overwriting it would also be the one way a pack could show up as a diff in someone's pull
  // request, since `info/exclude` cannot un-track a path git is already tracking.
  //
  // The pack still arrives: the neutral files and the context pointer are written regardless, so losing
  // the skill rendering costs a channel and not the knowledge. The caller logs the collision, because an
  // operator who renamed a skill into Mercury's namespace should find out from the Run rather than by
  // noticing the pack never seems to land.
  let skillSkipped = false;
  if (existsSync(skillPath)) {
    skillSkipped = true;
  } else {
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, renderSkillMd(opts.projectId, opts.packHash, opts.notes));
  }

  const notExcluded = excludeFromGit(workspacePath, GENERATED_PATHS);
  return {
    packPath, notesPath, notesFile: jsonlPath, skillPath, skillSkipped, count: opts.notes.length,
    packHash: opts.packHash, notExcluded,
  };
}

/**
 * Append generated paths to the worktree's own ignore file (section 9.4).
 *
 * `info/exclude` rather than `.gitignore` because the latter is a TRACKED file, and editing it would
 * make Mercury the author of a diff in the user's repository -- the exact thing K1 forbids. `exclude`
 * lives in git's own directory, is never committed, and `git rev-parse --git-path` resolves it correctly
 * for the linked-worktree layout the workspace manager creates, where `.git` is a file pointing
 * elsewhere and naively joining paths would write to a location git never reads.
 *
 * Excluded paths cannot be swept up by an agent's `git add -A` or `git commit -a`, which is the realistic
 * way a generated NOTES.md would otherwise reach a pull request.
 */
export function excludeFromGit(workspacePath: string, paths: readonly string[]): string[] {
  let excludeFile: string;
  try {
    const rel = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: workspacePath, encoding: 'utf8', timeout: 10_000,
    }).trim();
    if (!rel) return [...paths];
    excludeFile = resolve(workspacePath, rel);
  } catch {
    // Not a git workspace (a copy-mode checkout), so there is no index for these files to pollute.
    return [...paths];
  }
  const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  const missing = paths.filter((p) => !existing.split('\n').includes(p));
  if (missing.length === 0) return [];
  mkdirSync(dirname(excludeFile), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  // A marker comment, so a person reading this file knows a machine wrote these lines and why.
  appendFileSync(excludeFile, `${prefix}# mercury knowledge pack (generated; never commit)\n${missing.join('\n')}\n`);
  return [];
}

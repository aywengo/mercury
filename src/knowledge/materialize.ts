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
import { resolveContained } from '../skills/skillRegistry.ts';
import { ValidationError } from '../domain/errors.ts';
import type { EvidenceRef, Note } from './types.ts';

/**
 * A generated path that is really inside this workspace.
 *
 * `join()` is lexical. A workspace is a git checkout of a repository that may be untrusted, and git
 * checks out `.mercury` or `.agents/skills` as a symlink without complaint -- so `join(ws, '.mercury',
 * 'notes.jsonl')` can name a file anywhere on the host the worker can write to, and Mercury would write
 * the pack there. Measured before this guard existed: a repository shipping `.mercury` as a symlink
 * received `pack.json`, `NOTES.md` and `notes.jsonl` outside the workspace, and one shipping
 * `.agents/skills` as a symlink received the generated SKILL.md the same way.
 *
 * `resolveContained` is the guard `writeSkills()` already uses for exactly this reason, and reusing it
 * rather than writing a second one is the point -- two containment helpers is two chances for them to
 * disagree about what "inside" means. It resolves both sides through realpath, so a workspace under a
 * symlinked ancestor (macOS `/tmp` is `/private/tmp`) still works, and refuses only a symlink at or below
 * the workspace root.
 *
 * The message is re-thrown in knowledge terms because the shared helper speaks of skill roots, and an
 * operator reading a log about a knowledge pack should not have to work out why it mentions skills.
 *
 * Throwing is deliberate and it fails the Run. The alternative is writing the pack wherever the
 * repository pointed, which is not a degraded Run but a host compromise dressed up as a successful one.
 */
export function containedPath(workspacePath: string, rel: string): string {
  try {
    return resolveContained(workspacePath, rel);
  } catch (err) {
    throw new ValidationError(
      `knowledge path ${JSON.stringify(rel)} escapes the workspace: ${(err as Error).message}`);
  }
}

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
export const AGENTS_MD_FILE = 'AGENTS.md';
/**
 * The Claude Code channel of section 9.3. Its own name rather than a shared `AGENTS.md`, because
 * Claude Code reads `CLAUDE.md` and Hermes reads `AGENTS.md`; writing the wrong one is a silent
 * no-op, which is the worst way for an injection channel to fail.
 */
export const CLAUDE_MD_FILE = 'CLAUDE.md';
/**
 * Every path Mercury generates into a workspace.
 *
 * Both harness files are listed even though each is written by exactly one adapter, because the
 * exclusion runs once, before any adapter starts, and it cannot know which adapter will run. A
 * generated `CLAUDE.md` missing from this list is a pack that an agent's `git add -A` puts into a
 * pull request -- the outcome section 9.4 exists to prevent, and K1's reason for refusing a second
 * copy of knowledge in git.
 */
export const GENERATED_PATHS = ['.mercury/', `${SKILL_DIR}/`, AGENTS_MD_FILE, CLAUDE_MD_FILE];

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
/**
 * The example note an agent is shown, as one JSON line.
 *
 * Built with `JSON.stringify` rather than written as a literal string so the example cannot drift into
 * being invalid JSON -- which matters because this line is the only part of the contribution
 * instructions an agent actually copies, and a rejected example teaches agents that writing notes does
 * not work. `test/knowledgeHarvest.test.ts` feeds it through the real harvester and asserts it is
 * accepted, so the schema and the example fail together rather than the example quietly going stale.
 *
 * Exported for that test. Not exported for any runtime use.
 *
 * Scoped to `project` rather than `repo:<hash>` on purpose. A hash copied verbatim into every workspace
 * would name a repository that does not exist: the note is accepted by both the host and Atlas, and is
 * then scoped to something no Run ever matches, so it is silently never delivered -- the worst failure
 * this path has, because nothing reports it. An agent cannot compute the real hash from anything it is
 * given, so the example must not require one.
 */
export const NOTE_EXAMPLE_LINE = JSON.stringify({
  kind: 'command',
  scope: 'project',
  claim: 'Atlas tests run with `npm run test:atlas`; `npm test` runs all four suites.',
  detail: 'The Commands block in AGENTS.md lists only `npm test`, which is four times slower '
    + 'when the only thing that changed is under atlas/.',
  evidence: [{ type: 'repo-file', repo: 'mercury', path: 'package.json', sha: 'a08c528' }],
});

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
  lines.push('Before you report the task done, ask whether you learned something durable about this');
  lines.push('project that no README states. If you did, append ONE JSON object per line to');
  lines.push(`\`${NOTES_JSONL}\`.`);
  lines.push('Write what you would want to know on your first day here: a convention that is not in any');
  lines.push('README, a command that is faster than the obvious one, a way this project has been broken');
  lines.push('before. Do not write anything specific to this task, anything about a person, or anything');
  lines.push('you would not want repeated to every future agent here.');
  lines.push('');
  lines.push('Copy this line and change only the values. It is a complete, accepted note:');
  lines.push('');
  lines.push('```json');
  lines.push(NOTE_EXAMPLE_LINE);
  lines.push('```');
  lines.push('');
  lines.push('Each line takes the fields `kind`, `scope`, `claim`, and optionally `detail`, `evidence`,');
  lines.push('`contradicts`. `kind` is one of `fact`, `convention`, `command`, `pitfall`,');
  lines.push('`decision`, `artifact-pointer`. `scope` is `project`, `repo:<16-hex>`,');
  lines.push('`repo:<16-hex>#<path>` or');
  lines.push('`agent:<id>`. `claim` is one sentence, `detail` is the why. Evidence entries take');
  lines.push('`{"type":"issue","url":...}`, `{"type":"pr","url":...}`,');
  lines.push('`{"type":"commit","repo":...,"sha":...}`,');
  lines.push('`{"type":"run-event","hostId":...,"runId":...,"seq":...}` or');
  lines.push('`{"type":"repo-file","repo":...,"path":...,"sha":...}`. `pitfall` and `decision` are refused');
  lines.push('without at least one evidence entry.');
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
/**
 * The project id as one YAML-safe line.
 *
 * `MERCURY_ATLAS_PROJECT` is operator configuration rather than agent input, so this is defence against a
 * copy-paste accident and not against an attacker. It is cheap because the failure it prevents is silent:
 * a value carrying a newline followed by `---` closes the frontmatter block early, and a harness that
 * cannot parse a skill skips it without reporting anything. The Run would then proceed with no knowledge
 * and no indication that the pack was there all along.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const SKILL_DESCRIPTION_PREFIX = 'Project knowledge promoted by the team, gathered from earlier Runs on ';

export function renderSkillMd(projectId: string, packHash: string, notes: readonly Note[]): string {
  const front = [
    '---',
    `name: ${SKILL_ID}`,
    'version: 1.0.0',
    `description: ${SKILL_DESCRIPTION_PREFIX}${oneLine(projectId)}.`,
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
  /** Whether the pack is out of the agent's diff, and why not when it is not. */
  exclude: ExcludeOutcome;
}

/**
 * Result of keeping the generated pack out of the agent's diff (section 9.4).
 *
 * Three outcomes because there are two different reasons a path can end up unexcluded, and only one of
 * them is a problem. Collapsing them is what made the copy-mode warning fire on every Run (issue #593).
 */
export type ExcludeOutcome =
  /** Written to the repository's own ignore file, or already present in it. */
  | { status: 'excluded' }
  /**
   * The workspace is not a git working tree, so there is nothing to exclude. Copy mode strips `.git`,
   * so there is no index for `git add -A` to sweep and `recordCommits` finds no commits; the pack is out
   * of the diff by construction rather than by exclusion. An agent could still `git init` a throwaway
   * repository here, but that repository has no remote and is not the project's.
   */
  | { status: 'no-repository'; paths: string[] }
  /** A real git workspace whose ignore file could not be written. The pack is genuinely committable. */
  | { status: 'failed'; paths: string[] };

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
  const packPath = containedPath(workspacePath, PACK_FILE);
  const notesPath = containedPath(workspacePath, NOTES_FILE);
  const jsonlPath = containedPath(workspacePath, NOTES_JSONL);

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
  const skillPath = containedPath(workspacePath, SKILL_FILE);
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

  const exclude = excludeFromGit(workspacePath, GENERATED_PATHS);
  return {
    packPath, notesPath, notesFile: jsonlPath, skillPath, skillSkipped, count: opts.notes.length,
    packHash: opts.packHash, exclude,
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
export function excludeFromGit(workspacePath: string, paths: readonly string[]): ExcludeOutcome {
  let excludeFile: string;
  try {
    const rel = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: workspacePath, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!rel) return { status: 'no-repository', paths: [...paths] };
    excludeFile = resolve(workspacePath, rel);
  } catch {
    // `git rev-parse --git-path` fails for exactly one reason worth naming: the directory is not a git
    // working tree. Copy mode strips `.git` (workspaceManager.ts), so every copy-mode Run lands here.
    // That is not a failure. With no repository there is no index for `git add -A` to sweep, and
    // `recordCommits` runs `git log` and gets nothing back, so the pack cannot reach the project's
    // history. It is not a sealed container: an agent that ran `git init` here would create a repository
    // and Mercury would then record its commits -- but that repository has no remote and is not the
    // project's, which is the boundary section 9.4 actually protects. Issue #593: this branch used to
    // return the paths as a plain failure, so the warning fired on every copy-mode Run and an operator
    // could not tell it apart from a pack that really was left committable.
    return { status: 'no-repository', paths: [...paths] };
  }
  try {
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    const missing = paths.filter((p) => !existing.split('\n').includes(p));
    if (missing.length === 0) return { status: 'excluded' };
    mkdirSync(dirname(excludeFile), { recursive: true });
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    // A marker comment, so a person reading this file knows a machine wrote these lines and why.
    appendFileSync(excludeFile, `${prefix}# mercury knowledge pack (generated; never commit)\n${missing.join('\n')}\n`);
  } catch {
    // A git workspace whose ignore file we could not write. This is the case the warning is for.
    return { status: 'failed', paths: [...paths] };
  }
  return { status: 'excluded' };
}

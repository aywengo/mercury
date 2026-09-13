/**
 * The PrimeAgent rendering of a knowledge pack (docs/knowledge-base.md 9.3), and the gap that left it
 * unwritten (#547).
 *
 * Phase 2 shipped the neutral files and the context pointer but never the skill, while `GENERATED_PATHS`
 * already excluded `.agents/skills/mercury-knowledge/` -- so the exclusion was guarding a directory
 * nothing created. These tests are what makes the two halves agree: the file exists, it is parseable as a
 * skill, and the adapter actually names it on argv.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SKILL_DIR, SKILL_FILE, SKILL_ID, materializeKnowledge, renderSkillMd,
} from '../src/knowledge/materialize.ts';
import { PrimeAgentAdapter } from '../src/adapters/primeAgentAdapter.ts';
import type { Note, NoteKind } from '../src/knowledge/types.ts';
import type { ResolvedSkill, Run, RunContext } from '../src/domain/types.ts';
import { makeGitRepo, tempDir } from './helpers.ts';

const MOCK = join(import.meta.dirname, 'fixtures', 'mock-prime-agent-rpc.mjs');

function note(claim: string): Note {
  return {
    noteId: 'note_0001', seq: 1, revision: 1, projectId: 'proj', tier: 'promoted',
    kind: 'command' as NoteKind, scope: 'project', claim, evidence: [],
    corroboration: { runs: 1, harnesses: 1, hosts: 1 },
    provenance: { source: 'agent-reported', hostId: 'host-a', recordedAt: '2026-01-01T00:00:00.000Z' },
  } as Note;
}

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: 'run_test', ownerId: 'alice', task: 'Fix the flaky test',
    repository: { localPath: '/tmp/repo' }, workspaceBranch: null, workspacePath: null,
    agent: 'primeagent', status: 'QUEUED', attempt: 1, retryOf: null, error: null, errorKind: null,
    constraints: { maxDurationMs: 60_000, maxRetries: 2 }, createdAt: now, startedAt: null,
    completedAt: null, leaseOwner: null, leaseExpiresAt: null, cancellationRequestedAt: null,
    finalCommits: [], prUrl: null, ...overrides,
  };
}

function makeContext(opts: { skills?: ResolvedSkill[]; knowledge?: boolean } = {}): {
  context: RunContext; workspacePath: string;
} {
  const workspacePath = tempDir('mercury-skill-');
  const run = makeRun();
  const context: RunContext = {
    run, repository: run.repository,
    workspace: { path: workspacePath, branch: 'agent/' + run.id, baseCommit: 'abc123', mode: 'copy' },
    skills: opts.skills ?? [], constraints: run.constraints,
  };
  if (opts.knowledge) context.knowledge = { packHash: 'pack_abc', path: '.mercury/knowledge/NOTES.md', count: 1 };
  return { context, workspacePath };
}

async function argvOf(adapter: PrimeAgentAdapter, context: RunContext, workspacePath: string): Promise<string[]> {
  const argvFile = join(workspacePath, 'argv.json');
  process.env.MOCK_RPC_ARGV_FILE = argvFile;
  const handle = await adapter.start(context);
  for await (const _ev of handle.events) { /* drain so the child finishes */ }
  await handle.exit;
  delete process.env.MOCK_RPC_ARGV_FILE;
  return JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
}

function skillArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--skill') out.push(argv[i + 1]!);
  return out;
}

// ---------- materialization ----------

test('materializing a pack writes the synthetic skill the spec names', () => {
  const ws = makeGitRepo(tempDir('mercury-skill-mat-'));
  const written = materializeKnowledge(ws, { projectId: 'proj', packHash: 'pack_abc', notes: [note('run glimmer-check')] });
  assert.ok(existsSync(written.skillPath), 'the skill file the adapter will be told to read');
  assert.equal(written.skillPath, join(ws, SKILL_FILE));
  const body = readFileSync(written.skillPath, 'utf8');
  assert.ok(body.includes('glimmer-check'), 'the knowledge is IN the skill, not a pointer to another file');
});

test('the skill parses as a skill: frontmatter with the fields writeSkills produces', () => {
  const md = renderSkillMd('proj', 'pack_abc', [note('run glimmer-check')]);
  const lines = md.split('\n');
  assert.equal(lines[0], '---', 'frontmatter must open the file or the parser skips the skill silently');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, 'frontmatter must close');
  const fm = lines.slice(1, end).join('\n');
  for (const field of ['name:', 'version:', 'description:', 'capabilities:']) {
    assert.ok(fm.includes(field), `frontmatter is missing ${field}`);
  }
  assert.ok(fm.includes(`name: ${SKILL_ID}`), 'the name must match the directory, or the skill is mislabelled');
  assert.ok(!fm.includes('\n---\n'), 'a `---` inside the body would truncate the frontmatter read');
});

test('the skill directory is the one GENERATED_PATHS excludes', () => {
  // The whole point of #547 being a bug rather than a missing feature: the exclusion already named this
  // directory before anything wrote it. If the two ever disagree, a generated pack can reach a commit.
  const ws = makeGitRepo(tempDir('mercury-skill-excl-'));
  materializeKnowledge(ws, { projectId: 'proj', packHash: 'p', notes: [] });
  const exclude = readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude.includes(`${SKILL_DIR}/`), `info/exclude must name ${SKILL_DIR}/, saw: ${exclude}`);
  assert.equal(existsSync(join(ws, SKILL_FILE)), true, 'and that path is now a real file');
});

// ---------- adapter argv ----------

test('the adapter passes --skill for the knowledge pack', async () => {
  const { context, workspacePath } = makeContext({ knowledge: true });
  materializeKnowledge(workspacePath, { projectId: 'proj', packHash: 'pack_abc', notes: [note('run glimmer-check')] });
  const adapter = new PrimeAgentAdapter(MOCK);
  try {
    const argv = await argvOf(adapter, context, workspacePath);
    const skills = skillArgv(argv);
    assert.ok(skills.some((p) => p.endsWith(join('.agents', 'skills', SKILL_ID))),
      `expected the knowledge skill on argv, saw ${JSON.stringify(skills)}`);
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('no pack, no --skill: a Run without knowledge does not advertise one', async () => {
  const { context, workspacePath } = makeContext({ knowledge: false });
  const adapter = new PrimeAgentAdapter(MOCK);
  try {
    const argv = await argvOf(adapter, context, workspacePath);
    assert.deepEqual(skillArgv(argv), [], 'argv must not name a directory that is not there');
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('a pointer without the file on disk does not produce --skill', async () => {
  // The worker writes both together, so this is the half-written case. Advertising the skill would make
  // argv assert something false about the workspace.
  const { context, workspacePath } = makeContext({ knowledge: true });
  const adapter = new PrimeAgentAdapter(MOCK);
  try {
    const argv = await argvOf(adapter, context, workspacePath);
    assert.deepEqual(skillArgv(argv), []);
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('a project that owns the mercury-knowledge id is not passed twice', async () => {
  const { context, workspacePath } = makeContext({ knowledge: true });
  const owned: ResolvedSkill = {
    id: SKILL_ID, version: '1.0.0', description: 'the project owns this name', capabilities: [],
    path: '/unused', content: '# mine\n', files: { 'SKILL.md': '# mine\n' }, hash: 'abc',
  };
  context.skills = [owned];
  mkdirSync(join(workspacePath, '.agents', 'skills', SKILL_ID), { recursive: true });
  writeFileSync(join(workspacePath, '.agents', 'skills', SKILL_ID, 'SKILL.md'), '# mine\n');
  const adapter = new PrimeAgentAdapter(MOCK);
  try {
    const argv = await argvOf(adapter, context, workspacePath);
    const skills = skillArgv(argv);
    assert.equal(skills.filter((p) => p.endsWith(join('.agents', 'skills', SKILL_ID))).length, 1,
      'a duplicated --skill would load the same directory twice');
  } finally {
    adapter.cancel(context.run.id).catch(() => {});
  }
});

test('a project that owns the skill name is left alone and reported', () => {
  // Section 9.4: Mercury never modifies a tracked file. A SKILL.md already present at materialization
  // came from the checkout or from writeSkills, so it belongs to the project and overwriting it would
  // put a generated pack into a user's diff -- the one thing info/exclude cannot undo.
  const ws = makeGitRepo(tempDir('mercury-skill-collide-'));
  const dir = join(ws, '.agents', 'skills', SKILL_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# the project owns this name\n');
  const written = materializeKnowledge(ws, { projectId: 'proj', packHash: 'p', notes: [note('run glimmer-check')] });
  assert.equal(written.skillSkipped, true, 'the collision has to be visible to the caller');
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '# the project owns this name\n',
    'the project file is untouched');
  assert.ok(existsSync(join(ws, '.mercury/knowledge/NOTES.md')),
    'and the pack still reaches the agent through the neutral files');
});

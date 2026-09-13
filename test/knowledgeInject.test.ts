/**
 * Injection: from replica to workspace (docs/knowledge-base.md 9.2, 9.4, 16 phase 2).
 *
 * The chain this covers is the one a Run actually experiences: a promoted note in the replica becomes a
 * row in run_knowledge, becomes three files in the workspace, becomes a pointer in the context file, and
 * can be read back over the API. Each link is where a phase-2 bug would hide, and each looks fine from
 * the side.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { openDatabase } from '../src/db/database.ts';
import { ReplicaStore } from '../src/knowledge/replica.ts';
import { NOTES_FILE, excludeFromGit, materializeKnowledge, renderNotesMd } from '../src/knowledge/materialize.ts';
import { repoIdentity } from '../src/knowledge/identity.ts';
import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';
import type { KnowledgeSelectionDeps } from '../src/runs/runService.ts';
import type { Note } from '../src/knowledge/types.ts';
import { execFileSync } from 'node:child_process';

const HASH = repoIdentity('https://github.com/aywengo/mercury.git')!.hash;

function note(over: Partial<Note> & { noteId: string; seq: number }): Note {
  return {
    revision: 1, projectId: 'mercury', kind: 'fact', scope: 'project',
    claim: `claim ${over.noteId}`, evidence: [], tier: 'promoted',
    corroboration: { runs: 3, harnesses: 2, hosts: 1 },
    provenance: { source: 'agent-reported', hostId: 'host-a', recordedAt: '2026-01-01T00:00:00.000Z' },
    ...over,
  } as Note;
}

function selectionWith(notes: Note[], over: Partial<KnowledgeSelectionDeps> = {}): KnowledgeSelectionDeps {
  const replica = new ReplicaStore(openDatabase(':memory:'));
  if (notes.length) replica.applyBatch('mercury', notes, Math.max(...notes.map((n) => n.seq)), '2026-01-02T00:00:00.000Z');
  return { projectId: 'mercury', replica, packMaxBytes: 32_768, injectByDefault: true, ...over };
}

const REPO_URL = 'https://github.com/aywengo/mercury.git';

/** A real local repo, because the workspace manager needs one to create a worktree.
 *  The `url` is carried alongside `localPath` so selection resolves the repository identity from the
 *  remote rather than from the host-local `file/...` form, which is what a real Run looks like. */
function repoFixture(): string {
  return makeGitRepo(tempDir('mercury-knowledge-repo-'));
}

test('a created Run records its pack and emits knowledge.selected', async () => {
  const env = makeEnv({ knowledge: selectionWith([note({ noteId: 'n-a', seq: 1 })]) });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'fix the build', repository: { url: REPO_URL } });
    const stored = env.runService.getKnowledge(run.id);
    assert.ok(stored, 'the snapshot must exist by the time anything can observe the Run');
    assert.equal(stored!.noteCount, 1);
    assert.equal((stored!.notes[0] as Note).noteId, 'n-a');

    const events = env.events.list(run.id, 0, 100);
    const selected = events.find((e) => e.type === 'knowledge.selected');
    assert.ok(selected, 'the timeline must show what the Run was told');
    const payload = selected!.payload as { packHash: string; count: number; omitted: number };
    assert.equal(payload.count, 1);
    assert.equal(payload.packHash, stored!.packHash, 'the event and the stored snapshot must agree');
  } finally {
    env.close();
  }
});

test('an empty replica still yields a pack, because that is how a project starts learning', async () => {
  // The first instinct here was to record nothing when nothing matched. That breaks the tier-1 loop at
  // its cold start: NOTES.md is the ONLY place an agent learns that `.mercury/notes.jsonl` exists, so a
  // project with no promoted knowledge would never receive its first note. An empty pack is the pack that
  // teaches contribution.
  const repo = repoFixture();
  const env = makeEnv({ knowledge: selectionWith([]), knowledgeProject: 'mercury', workspaceMode: 'git-worktree', repoDir: repo });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'fix the build', repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' } });
    const stored = env.runService.getKnowledge(run.id);
    assert.ok(stored, 'selection ran and found nothing, which is a recorded fact rather than an absence');
    assert.equal(stored!.noteCount, 0);

    const events = env.events.list(run.id, 0, 100);
    const selected = events.find((e) => e.type === 'knowledge.selected');
    assert.ok(selected, 'the timeline distinguishes "no knowledge existed" from "knowledge was never configured"');
    assert.equal((selected!.payload as { count: number }).count, 0);

    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);
    const done = env.runs.get(run.id)!;
    const md = readFileSync(join(done.workspacePath!, NOTES_FILE), 'utf8');
    assert.ok(md.includes('No promoted knowledge applies'));
    assert.ok(md.includes('Contributing'), 'the contribution instruction survives an empty pack');
    assert.ok(existsSync(join(done.workspacePath!, '.mercury/notes.jsonl')));
  } finally {
    env.close();
  }
});

test('a knowledge block is refused when the feature is off, not ignored', async () => {
  const env = makeEnv();
  try {
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'fix', knowledge: { scopes: ['project'] } }),
      /knowledge is not configured/,
      'a caller who set scopes against a host with no Atlas must be told, not quietly given a Run that knows nothing',
    );
  } finally {
    env.close();
  }
});

test('an invalid scope is refused, and require fails only when the pack genuinely will not arrive', async () => {
  const env = makeEnv({ knowledge: selectionWith([note({ noteId: 'n-a', seq: 1 })]) });
  try {
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'fix', knowledge: { scopes: ['repo:nope'] } }),
      /invalid scope/,
      'a typo in a filter must be refused, not quietly matched against nothing',
    );
    // require is satisfiable here: the neutral files reach every workspace, so the pack does arrive even
    // for an adapter that declares nothing about knowledge. Refusing on UNKNOWN would mean an unverified
    // harness bricks a Run, which is the fail-open half of section 7.4.
    const ok = env.runService.create({ ownerId: 'alice', task: 'fix', repository: { url: REPO_URL }, knowledge: { require: true } });
    assert.ok(env.runService.getKnowledge(ok.id));
  } finally {
    env.close();
  }

  const off = makeEnv({ knowledge: selectionWith([note({ noteId: 'n-a', seq: 1 })], { injectByDefault: false }) });
  try {
    assert.throws(
      () => off.runService.create({ ownerId: 'alice', task: 'fix', knowledge: { require: true } }),
      /cannot receive a knowledge pack/,
      'a requirement that will not be met must be refused at the door, not accepted and ignored',
    );
  } finally {
    off.close();
  }
});

test('injectByDefault false leaves Runs without a pack unless they ask', async () => {
  const notes = [note({ noteId: 'n-a', seq: 1 })];
  const off = makeEnv({ knowledge: selectionWith(notes, { injectByDefault: false }) });
  try {
    const run = off.runService.create({ ownerId: 'alice', task: 'fix', repository: { url: REPO_URL } });
    assert.equal(off.runService.getKnowledge(run.id), null);
    const opted = off.runService.create({ ownerId: 'alice', task: 'fix', repository: { url: REPO_URL }, knowledge: { enabled: true } });
    assert.equal(off.runService.getKnowledge(opted.id)?.noteCount, 1, 'opt-in still works when the host default is off');
  } finally {
    off.close();
  }
});

test('the worker materializes the neutral files and points the context file at them', async () => {
  const notes = [
    note({ noteId: 'n-cmd', seq: 1, kind: 'command', claim: 'Run one test file with node --test test/x.test.ts' }),
    note({ noteId: 'n-path', seq: 2, scope: `repo:${HASH}#src/queue`, kind: 'pitfall', claim: 'the lease test flakes under load' }),
  ];
  const repo = repoFixture();
  const env = makeEnv({ knowledge: selectionWith(notes), knowledgeProject: 'mercury', workspaceMode: 'git-worktree', repoDir: repo });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'fix the lease expiry in src/queue/leaseExpiry.test.ts',
      repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => ['COMPLETED', 'FAILED'].includes(env.runs.get(run.id)!.status), 20_000);
    const done = env.runs.get(run.id)!;
    assert.equal(done.status, 'COMPLETED', done.error ?? '');

    const ws = done.workspacePath!;
    const packPath = join(ws, '.mercury/knowledge/pack.json');
    const notesPath = join(ws, NOTES_FILE);
    const jsonl = join(ws, '.mercury/notes.jsonl');
    assert.ok(existsSync(packPath), 'pack.json must exist before the adapter starts');
    assert.ok(existsSync(notesPath), 'NOTES.md is the file every harness is told to read');
    assert.ok(existsSync(jsonl), 'the tier-1 file is created empty so an agent can append without checking');

    const pack = JSON.parse(readFileSync(packPath, 'utf8')) as { packHash: string; notes: Note[] };
    assert.equal(pack.packHash, env.runService.getKnowledge(run.id)!.packHash,
      'the workspace copy and the database snapshot must be the same pack');
    assert.equal(pack.notes.length, 2);

    const md = readFileSync(notesPath, 'utf8');
    assert.ok(md.includes('node --test test/x.test.ts'), 'the claim reaches the agent verbatim');
    assert.ok(md.includes('seen in 3 Runs on 2 harnesses'), 'corroboration is shown, so a reader can weigh it');
    assert.ok(md.includes('.mercury/notes.jsonl'), 'the contribution instruction travels with the pack');
    assert.ok(md.includes('mercury'), 'the header names the project');

    // The fake adapter reads the files back and echoes the hash (section 9.3), so this asserts the pack
    // was readable by something running in the workspace -- not merely that a file exists somewhere.
    const msg = env.events.list(run.id, 0, 200).find((e) => e.type === 'agent.message');
    assert.ok(msg, 'the adapter reported what it read');
    const payload = msg!.payload as { packHash: string; packReadable: boolean; packBytes: number };
    assert.equal(payload.packReadable, true, 'the adapter found the files the worker wrote');
    assert.equal(payload.packHash, pack.packHash);
    assert.ok(payload.packBytes > 0);
  } finally {
    env.close();
  }
});

test('a host with no Atlas writes no knowledge block and no files', async () => {
  // No knowledge deps at all -- the state a `mercury server` without MERCURY_ATLAS_URL runs in.
  const repo = repoFixture();
  const env = makeEnv({ workspaceMode: 'git-worktree', repoDir: repo });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'fix', repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' } });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);
    const done = env.runs.get(run.id)!;
    assert.ok(!existsSync(join(done.workspacePath!, '.mercury')),
      'an unconfigured host writes no knowledge directory at all');
    const msgs = env.events.list(run.id, 0, 200).filter((e) => e.type === 'agent.message');
    assert.equal(msgs.length, 0, 'nothing echoes a pack hash when there is no pack');
  } finally {
    env.close();
  }
});

test('generated paths land in info/exclude, resolved through git for a worktree', () => {
  const dir = tempDir('mercury-exclude-');
  // A real worktree, because `info/exclude` lives somewhere else there than in a normal checkout, and
  // the whole reason to call `git rev-parse --git-path` is that the naive path is wrong here.
  const origin = join(dir, 'origin');
  execFileSync('git', ['init', '--bare', origin], { timeout: 30_000 });
  const seed = join(dir, 'seed');
  execFileSync('git', ['init', seed], { timeout: 30_000 });
  writeFileSync(join(seed, 'README.md'), '# seed\n');
  execFileSync('git', ['-C', seed, 'add', 'README.md'], { timeout: 30_000 });
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed'], { timeout: 30_000 });
  execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', origin], { timeout: 30_000 });
  execFileSync('git', ['-C', seed, 'push', '-u', 'origin', 'HEAD'], { timeout: 30_000 });
  const work = join(dir, 'work');
  execFileSync('git', ['-C', seed, 'worktree', 'add', work, 'HEAD'], { timeout: 30_000 });

  const notExcluded = materializeKnowledge(work, {
    projectId: 'mercury', packHash: 'abc', notes: [note({ noteId: 'n-a', seq: 1 })],
  }).notExcluded;
  assert.deepEqual(notExcluded, [], 'a git workspace must exclude the pack');

  const excludePath = execFileSync('git', ['-C', work, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8', timeout: 30_000 }).trim();
  const content = readFileSync(resolve(work, excludePath), 'utf8');
  assert.ok(content.includes('.mercury/'), 'the generated directory is excluded');
  // The point of excluding: an agent's `git add -A` cannot sweep the pack into a commit.
  execFileSync('git', ['-C', work, 'add', '-A'], { timeout: 30_000 });
  const staged = execFileSync('git', ['-C', work, 'diff', '--cached', '--name-only'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(staged.trim(), '', 'nothing generated is staged by git add -A');
});

test('a non-git workspace reports the paths it could not exclude instead of failing the Run', () => {
  const dir = tempDir('mercury-nongit-');
  const missing = excludeFromGit(dir, ['.mercury/']);
  assert.deepEqual(missing, ['.mercury/'],
    'copy-mode workspaces have no index to pollute, but the caller still needs to know nothing was excluded');
});

test('NOTES.md renders an empty pack without pretending there is knowledge', () => {
  const md = renderNotesMd('mercury', 'deadbeef', []);
  assert.ok(md.includes('No promoted knowledge applies'));
  assert.ok(md.includes('Contributing'), 'the contribution instruction is present even with nothing to contribute yet');
});

test('a contested note is rendered as contested', () => {
  const md = renderNotesMd('mercury', 'abc', [note({ noteId: 'n-c', seq: 1, contested: true, claim: 'tabs' })]);
  assert.ok(md.toLowerCase().includes('contested'),
    'showing one side of an open disagreement as settled is worse than omitting the note');
});

test('GET /api/runs/:id/knowledge is owner-scoped and reports the snapshot', async () => {
  const env = makeEnv({ knowledge: selectionWith([note({ noteId: 'n-a', seq: 1 })]) });
  const stream = (await import('../src/events/eventStream.ts')).EventStream;
  const app = (await import('../src/api/server.ts')).createApp({
    runService: env.runService, events: env.events, stream: new stream(env.db, env.events, 10),
    queue: env.queue, db: env.db,
    apiTokens: new Map([['tok-bob', 'bob']]), adminToken: 'tok-admin',
  });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const created = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { authorization: 'Bearer tok-admin', 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'fix the build', repository: { url: REPO_URL } }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { runId: string };

    const mine = await fetch(`${base}/api/runs/${createdBody.runId}/knowledge`, { headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(mine.status, 200);
    const kb = await mine.json() as { knowledge: { noteCount: number; notes: Note[] } };
    assert.equal(kb.knowledge.noteCount, 1);

    // A different owner cannot read it, and gets 404 rather than 403 -- the pack can contain another
    // team's conventions, so its very existence is not public.
    const theirs = await fetch(`${base}/api/runs/${createdBody.runId}/knowledge`, { headers: { authorization: 'Bearer tok-bob' } });
    assert.equal(theirs.status, 404);

    const detail = await fetch(`${base}/api/runs/${createdBody.runId}`, { headers: { authorization: 'Bearer tok-admin' } });
    const detailBody = await detail.json() as { knowledge: unknown };
    assert.ok(detailBody.knowledge, 'the sibling field is what a renderer should use');
  } finally {
    (await import('../src/api/server.ts')).closeServer(server);
    env.close();
  }
});

test('the knowledge block reaches RunService over HTTP', async () => {
  // The route has to forward `body.knowledge` to runService.create(). It did not, and the only reason
  // anyone noticed is that this test exists: every other test in the feature calls create() in-process,
  // so validation was right, the route was right, and the seam between them was empty.
  const env = makeEnv({ knowledge: selectionWith([note({ noteId: 'n-a', seq: 1 })]) });
  const { EventStream } = await import('../src/events/eventStream.ts');
  const { closeServer, createApp } = await import('../src/api/server.ts');
  const app = createApp({
    runService: env.runService, events: env.events, stream: new EventStream(env.db, env.events, 10),
    queue: env.queue, db: env.db, apiTokens: new Map([['tok-alice', 'alice']]), adminToken: 'tok-admin',
  });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const x = app.listen(0, '127.0.0.1', () => resolve(x));
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const post = (body: unknown) => fetch(`${base}/api/runs`, {
      method: 'POST', headers: { authorization: 'Bearer tok-admin', 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'fix the build', ...body }),
    });

    // A malformed block must come back as 400. If the route drops the block, this answers 201 and the
    // caller believes their filter was applied.
    const bad = await post({ knowledge: { scopes: ['not-a-scope'] } });
    assert.equal(bad.status, 400, 'a knowledge block that reaches validation is refused; one that is dropped is accepted');
    assert.match(((await bad.json() as { error: string }).error), /invalid scope/);

    const good = await post({ knowledge: { maxBytes: 4096 } });
    assert.equal(good.status, 201);
    const { runId } = await good.json() as { runId: string };
    assert.ok(env.runService.getKnowledge(runId), 'the Run created over HTTP got a pack');
  } finally {
    await closeServer(server);
    env.close();
  }
});

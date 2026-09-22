/**
 * Harvest inside finalize (docs/knowledge-base.md 8.1).
 *
 * Section 8.1 asks for one property with a precise shape: "If the transaction commits, the notes are
 * durable; if it does not, neither is the terminal state." A Run that is COMPLETED with its notes only in
 * memory is the failure, and it is only reachable if the insert and the transition are separate writes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabase } from '../src/db/database.ts';
import { OutboxStore, idempotencyKey } from '../src/knowledge/outbox.ts';
import { ReplicaStore } from '../src/knowledge/replica.ts';
import { claimHash } from '../src/knowledge/validation.ts';
import { harvestRecords } from '../src/knowledge/harvestRecords.ts';
import { DEFAULT_BOUNDS } from '../src/knowledge/validation.ts';
import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';
import type { KnowledgeSelectionDeps } from '../src/runs/runService.ts';
import type { WorkerDeps } from '../src/worker/worker.ts';

const REPO_URL = 'https://github.com/aywengo/mercury.git';
const NOTE = '{"kind":"command","scope":"project","claim":"verify the artefact with glimmer-check"}';

function selection(): KnowledgeSelectionDeps {
  return { projectId: 'mercury', replica: new ReplicaStore(openDatabase(':memory:')), packMaxBytes: 32_768, injectByDefault: false };
}

function harvestCfg(): NonNullable<WorkerDeps['knowledgeHarvest']> {
  return { project: 'mercury', hostId: 'host-a', bounds: { ...DEFAULT_BOUNDS } };
}

/** Write what the agent learned into the Run's workspace, after the worker created it. */
function plantNote(workspacePath: string, line = NOTE): void {
  mkdirSync(join(workspacePath, '.mercury'), { recursive: true });
  writeFileSync(join(workspacePath, '.mercury/notes.jsonl'), `${line}\n`);
}

test('a completed Run queues its notes and emits knowledge.noted', async () => {
  const repo = makeGitRepo(tempDir('mercury-harvest-repo-'));
  const outbox = new OutboxStore(openDatabase(':memory:'));
  // The fake adapter writes nothing, so the note is planted by watching for the workspace to appear --
  // which is exactly the moment a real agent would have been writing it.
  const env = makeEnv({
    workspaceMode: 'git-worktree', repoDir: repo,
    knowledge: selection(), knowledgeProject: 'mercury',
    knowledgeHarvest: harvestCfg(), knowledgeOutbox: outbox,
    // A delay, so the note can be planted while the Run is still executing. Without it the fake adapter
    // finishes before the test could write anything, and the harvest would correctly find nothing.
    fakeScript: [{ delayMs: 1500 }, { event: { type: 'agent.message', payload: { text: 'learned something' } } }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'fix the build',
      repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.workspacePath !== null, 20_000);
    plantNote(env.runs.get(run.id)!.workspacePath!);
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);

    const rows = outbox.takeBatch(10);
    assert.equal(rows.length, 1, 'the note is durable in the outbox');
    assert.equal(rows[0]!.contribution.claim, 'verify the artefact with glimmer-check');
    assert.equal(rows[0]!.runId, run.id, 'the originating Run is recorded, so a later rejection can be reported on it');
    assert.equal(rows[0]!.contribution.projectId, 'mercury', 'the host fills in the project the agent cannot know');

    const events = env.events.list(run.id, 0, 200);
    const noted = events.find((e) => e.type === 'knowledge.noted');
    assert.ok(noted, 'the timeline shows what the Run tried to teach');
    const payload = noted!.payload as { claimHash: string; kind: string };
    assert.equal(payload.claimHash, claimHash('command', 'project', 'verify the artefact with glimmer-check'));

    // The idempotency key must be derived, not random: a batch delivered but unacknowledged has to be
    // deduplicated by Atlas rather than counted twice as corroboration.
    // The property is that the key is DERIVED, not random: a batch Atlas applied but whose
    // acknowledgement was lost is re-sent with the same key, so Atlas answers `duplicate` and the note
    // gains no extra corroboration. A random key would make an ordinary retry look like a second Run
    // independently reaching the same conclusion -- and corroboration is the number promotion reads.
    assert.equal(rows[0]!.idempotencyKey, idempotencyKey(run.id, rows[0]!.contribution));
  } finally {
    env.close();
  }
});

test('a refused line is reported with its reason and never queued', async () => {
  const repo = makeGitRepo(tempDir('mercury-harvest-repo-'));
  const outbox = new OutboxStore(openDatabase(':memory:'));
  const env = makeEnv({
    workspaceMode: 'git-worktree', repoDir: repo,
    knowledge: selection(), knowledgeProject: 'mercury',
    knowledgeHarvest: harvestCfg(), knowledgeOutbox: outbox,
    fakeScript: [{ delayMs: 1500 }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'fix', repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.workspacePath !== null, 20_000);
    plantNote(env.runs.get(run.id)!.workspacePath!, 'this is not json');
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);

    assert.equal(outbox.depth(), 0, 'a malformed line queues nothing');
    const rejected = env.events.list(run.id, 0, 200).filter((e) => e.type === 'knowledge.rejected');
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0]!.payload as { reason: string }).reason, 'malformed-json');
  } finally {
    env.close();
  }
});

test('a Run that wrote nothing completes without touching the outbox', async () => {
  const repo = makeGitRepo(tempDir('mercury-harvest-repo-'));
  const outbox = new OutboxStore(openDatabase(':memory:'));
  const env = makeEnv({
    workspaceMode: 'git-worktree', repoDir: repo,
    knowledge: selection(), knowledgeProject: 'mercury',
    knowledgeHarvest: harvestCfg(), knowledgeOutbox: outbox,
    fakeScript: [{ delayMs: 1500 }],
  });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'fix', repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' } });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);
    assert.equal(outbox.depth(), 0);
    assert.equal(env.events.list(run.id, 0, 200).filter((e) => e.type.startsWith('knowledge.')).length, 0,
      'no knowledge events for a Run that had none');
  } finally {
    env.close();
  }
});

test('a host with no Atlas harvests nothing', async () => {
  // The outbox would fill with rows nothing can ever deliver, which on /metrics is indistinguishable
  // from a host whose Atlas is down -- and only one of those needs an operator at 3am.
  const repo = makeGitRepo(tempDir('mercury-harvest-repo-'));
  const env = makeEnv({ workspaceMode: 'git-worktree', repoDir: repo });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'fix', repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' } });
    await waitFor(() => env.runs.get(run.id)!.workspacePath !== null, 20_000);
    plantNote(env.runs.get(run.id)!.workspacePath!);
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);
    assert.equal(env.events.list(run.id, 0, 200).filter((e) => e.type === 'knowledge.noted').length, 0);
  } finally {
    env.close();
  }
});

test('the note and the terminal state commit together', async () => {
  // Section 8.1's property, checked structurally rather than by hoping. The COMPLETED branch of finalize
  // must contain the outbox insert and the transition inside ONE tx() call, with only the async git work
  // outside it. A test cannot provoke a crash mid-transaction, so it pins the shape that makes the crash
  // safe, and says so rather than pretending to have simulated the crash.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/worker/worker.ts', import.meta.url), 'utf8');
  const start = src.indexOf("if (outcome.status === 'COMPLETED')");
  assert.ok(start > 0);
  const branch = src.slice(start, src.indexOf("if (outcome.status === 'CANCELLED')", start));

  const txAt = branch.indexOf('tx(this.deps.db');
  assert.ok(txAt > 0, 'the COMPLETED branch is transactional');
  const insertAt = branch.indexOf('knowledgeOutbox');
  const transitionAt = branch.indexOf("transition(run.id, 'COMPLETED'");
  const commitAt = branch.indexOf('recordCommits');
  assert.ok(insertAt > txAt && transitionAt > txAt,
    'the outbox insert and the terminal transition are in the SAME transaction');
  assert.ok(commitAt < txAt,
    'git work stays outside the transaction; holding a write lock across a repository scan would block every other writer');
});


// --- tier 3, half one: decision records under docs/decisions/ (issue #684) ---------------------
//
// A Run that wrote and committed a record published it to git and to nothing else: the one Run that
// certainly touched the record was exactly the one not asked about it. The harvest reads the
// COMMITTED delta (baseCommit..HEAD) with git show, so the fixture commits the record inside the
// Run's own worktree — which is also why the uncommitted case harvests nothing.

const RECORD = [
  '---',
  'id: 0007',
  'title: Commits are the publish button',
  'status: accepted',
  'date: 2026-09-21',
  'evidence:',
  '  - commit: 7a546bc',
  '---',
  '',
  '## Decision',
  '',
  'A decision record becomes project knowledge when a Run commits it, not when a file appears.',
  '',
  '## Context',
  '',
  'Why this came up.',
  '',
].join('\n');

/** Commit a record inside the Run's worktree, as a real agent would. Identity is explicit because
 *  a CI runner has none -- the worktree inherits the source repo's config, and the fixture repo does
 *  not carry one (only makeGitRepo's initial commit does, via -c flags). */
const GIT_IDENTITY = ['-c', 'user.name=agent', '-c', 'user.email=agent@example.com'];

function gitIn(workspacePath: string, ...args: string[]): void {
  execFileSync('git', ['-C', workspacePath, ...GIT_IDENTITY, ...args]);
}

function plantRecord(workspacePath: string, text: string, name = '0007-commits.md'): void {
  const dir = join(workspacePath, 'docs/decisions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
  gitIn(workspacePath, 'add', 'docs/decisions');
  gitIn(workspacePath, 'commit', '-q', '-m', `record: ${name}`);
}

test('a Run that commits a valid record queues it with repo-record provenance', async () => {
  const repo = makeGitRepo(tempDir('mercury-harvest-repo-'));
  const outbox = new OutboxStore(openDatabase(':memory:'));
  const env = makeEnv({
    workspaceMode: 'git-worktree', repoDir: repo,
    knowledge: selection(), knowledgeProject: 'mercury',
    knowledgeHarvest: harvestCfg(), knowledgeOutbox: outbox,
    fakeScript: [{ delayMs: 1500 }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'decide something',
      repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.workspacePath !== null, 20_000);
    plantRecord(env.runs.get(run.id)!.workspacePath!, RECORD);
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);

    const rows = outbox.takeBatch(10);
    assert.equal(rows.length, 1, 'the committed record is durable in the outbox');
    assert.equal(rows[0]!.contribution.kind, 'decision');
    assert.equal(rows[0]!.contribution.claim,
      'A decision record becomes project knowledge when a Run commits it, not when a file appears.');
    assert.equal(rows[0]!.runId, run.id);
    assert.equal(rows[0]!.contribution.provenance?.source, 'repo-record');
    const selfRef = rows[0]!.contribution.evidence.find((e) => e.type === 'repo-file');
    assert.ok(selfRef, 'the note points back at the record file');
    const head = execFileSync('git', ['-C', env.runs.get(run.id)!.workspacePath!, 'rev-parse', 'HEAD']).toString().trim();
    assert.equal((selfRef as { sha: string }).sha, head);
    const events = env.events.list(run.id, 0, 200);
    const noted = events.find((e) => e.type === 'knowledge.noted');
    assert.ok(noted, 'the accepted record is on the timeline');
    assert.equal((noted!.payload as { source?: string }).source, 'repo-record',
      'the §8.5 payload contract carries the ingest source on the timeline');
  } finally {
    env.close();
  }
});

test('a record that is present but uncommitted produces nothing', async () => {
  const repo = makeGitRepo(tempDir('mercury-harvest-repo-'));
  const outbox = new OutboxStore(openDatabase(':memory:'));
  const env = makeEnv({
    workspaceMode: 'git-worktree', repoDir: repo,
    knowledge: selection(), knowledgeProject: 'mercury',
    knowledgeHarvest: harvestCfg(), knowledgeOutbox: outbox,
    fakeScript: [{ delayMs: 1500 }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'decide',
      repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.workspacePath !== null, 20_000);
    const ws = env.runs.get(run.id)!.workspacePath!;
    mkdirSync(join(ws, 'docs/decisions'), { recursive: true });
    writeFileSync(join(ws, 'docs/decisions/0008-uncommitted.md'), RECORD);
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);
    assert.equal(outbox.depth(), 0, 'an uncommitted edit is not a decision');
    const rejected = env.events.list(run.id, 0, 200).filter((e) => e.type === 'knowledge.rejected');
    assert.equal(rejected.length, 0, 'and it is not a rejection either: nothing was read');
  } finally {
    env.close();
  }
});

test('a rejected record names its path and reason on the timeline', async () => {
  const repo = makeGitRepo(tempDir('mercury-harvest-repo-'));
  const outbox = new OutboxStore(openDatabase(':memory:'));
  const env = makeEnv({
    workspaceMode: 'git-worktree', repoDir: repo,
    knowledge: selection(), knowledgeProject: 'mercury',
    knowledgeHarvest: harvestCfg(), knowledgeOutbox: outbox,
    fakeScript: [{ delayMs: 1500 }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'decide',
      repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.workspacePath !== null, 20_000);
    const noEvidence = RECORD.replace(/evidence:\n[\s\S]*?\n---/, '---');
    plantRecord(env.runs.get(run.id)!.workspacePath!, noEvidence, '0009-no-evidence.md');
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);
    assert.equal(outbox.depth(), 0);
    const rejected = env.events.list(run.id, 0, 200).filter((e) => e.type === 'knowledge.rejected');
    assert.equal(rejected.length, 1);
    const payload = rejected[0]!.payload as { reason: string; path?: string; source?: string };
    assert.equal(payload.reason, 'decision-without-evidence');
    assert.equal(payload.path, 'docs/decisions/0009-no-evidence.md');
    assert.equal(payload.source, 'repo-record', 'the rejection names its ingest source');
  } finally {
    env.close();
  }
});

test('a deleted record is ignored, not guessed at', async () => {
  const repo = makeGitRepo(tempDir('mercury-harvest-repo-'));
  const outbox = new OutboxStore(openDatabase(':memory:'));
  const env = makeEnv({
    workspaceMode: 'git-worktree', repoDir: repo,
    knowledge: selection(), knowledgeProject: 'mercury',
    knowledgeHarvest: harvestCfg(), knowledgeOutbox: outbox,
    fakeScript: [{ delayMs: 1500 }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'decide',
      repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.workspacePath !== null, 20_000);
    const ws = env.runs.get(run.id)!.workspacePath!;
    mkdirSync(join(ws, 'docs/decisions'), { recursive: true });
    writeFileSync(join(ws, 'docs/decisions/0001-old.md'), RECORD);
    gitIn(ws, 'add', 'docs/decisions');
    gitIn(ws, 'commit', '-q', '-m', 'add old record');
    gitIn(ws, 'rm', '-q', 'docs/decisions/0001-old.md');
    gitIn(ws, 'commit', '-q', '-m', 'remove old record');
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);
    assert.equal(outbox.depth(), 0, 'a deletion is a supersession someone forgot to write');
  } finally {
    env.close();
  }
});

test('tier-1 notes and committed records land in one transaction', async () => {
  const repo = makeGitRepo(tempDir('mercury-harvest-repo-'));
  const outbox = new OutboxStore(openDatabase(':memory:'));
  const env = makeEnv({
    workspaceMode: 'git-worktree', repoDir: repo,
    knowledge: selection(), knowledgeProject: 'mercury',
    knowledgeHarvest: harvestCfg(), knowledgeOutbox: outbox,
    fakeScript: [{ delayMs: 1500 }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'decide and note',
      repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.workspacePath !== null, 20_000);
    const ws = env.runs.get(run.id)!.workspacePath!;
    plantNote(ws);
    plantRecord(ws, RECORD, '0010-both.md');
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);
    const rows = outbox.takeBatch(10);
    assert.equal(rows.length, 2, 'both sources queued in the same finalize');
    assert.deepEqual(rows.map((r) => r.contribution.kind).sort(), ['command', 'decision']);
  } finally {
    env.close();
  }
});

test('a git failure inside the harvest becomes a timed-out result, never a thrown error', async () => {
  // The P0-4 contract in one assertion: whatever runGit throws (a deadline kill on a hang, or a
  // fast failure like this non-repository directory), finalize receives a RESULT — the Run cannot
  // die because its harvest threw. The deadline mechanics themselves are proven in
  // gitTimeout.test.ts; this proves the conversion at the harvest boundary.
  const notARepo = tempDir('mercury-harvest-not-repo-');
  const result = await harvestRecords({
    workspacePath: notARepo,
    baseCommit: '0'.repeat(40),
    bounds: { ...DEFAULT_BOUNDS, harvestTimeoutMs: 1_200 },
    notesAccepted: 0,
    repoIdentity: REPO_URL,
    hostId: 'host-a',
    runId: 'run_fail',
    recordedAt: new Date().toISOString(),
  });
  assert.equal(result.failed, true);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]!.reason, 'harvest-timeout');
});

test('copy mode skips the delta: the sentinel baseCommit never reaches git', async () => {
  // The workspace layer pins baseCommit 'copy' in copy mode (workspaceManager.createCopy). A call
  // with that sentinel must be a skip — no git invocation, no rejection — not a diff against the
  // literal string 'copy'.
  const repo = makeGitRepo(tempDir('mercury-harvest-repo-'));
  const result = await harvestRecords({
    workspacePath: repo,
    baseCommit: 'copy',
    bounds: { ...DEFAULT_BOUNDS },
    notesAccepted: 0,
    repoIdentity: REPO_URL,
    hostId: 'host-a',
    runId: 'run_copy',
    recordedAt: new Date().toISOString(),
  });
  assert.equal(result.skipped, true);
  assert.equal(result.failed, false);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.recordsSeen, 0);
});

test('a workspace whose git fails fast still completes the Run with the failure recorded (K4)', async () => {
  // The fast-fail twin: .git gone from the workspace, runGit fails immediately, and the Run still
  // reaches COMPLETED with the harvest failure on the timeline as a rejection.
  const repo = makeGitRepo(tempDir('mercury-harvest-repo-'));
  const outbox = new OutboxStore(openDatabase(':memory:'));
  const env = makeEnv({
    workspaceMode: 'git-worktree', repoDir: repo,
    knowledge: selection(), knowledgeProject: 'mercury',
    knowledgeHarvest: harvestCfg(), knowledgeOutbox: outbox,
    fakeScript: [{ delayMs: 1500 }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'decide',
      repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.workspacePath !== null, 20_000);
    const ws = env.runs.get(run.id)!.workspacePath!;
    rmSync(join(ws, '.git'), { recursive: true, force: true });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);
    assert.equal(env.runs.get(run.id)!.status, 'COMPLETED', 'K4');
    const rejected = env.events.list(run.id, 0, 200).filter((e) => e.type === 'knowledge.rejected');
    assert.ok(rejected.length >= 1, 'the failure is visible on the timeline');
    assert.equal((rejected[0]!.payload as { reason: string }).reason, 'harvest-timeout');
  } finally {
    env.close();
  }
});

/**
 * Harvest inside finalize (docs/knowledge-base.md 8.1).
 *
 * Section 8.1 asks for one property with a precise shape: "If the transaction commits, the notes are
 * durable; if it does not, neither is the terminal state." A Run that is COMPLETED with its notes only in
 * memory is the failure, and it is only reachable if the insert and the transition are separate writes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabase } from '../src/db/database.ts';
import { OutboxStore, idempotencyKey } from '../src/knowledge/outbox.ts';
import { ReplicaStore } from '../src/knowledge/replica.ts';
import { claimHash } from '../src/knowledge/validation.ts';
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

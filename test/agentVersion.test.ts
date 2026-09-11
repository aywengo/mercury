/**
 * The harness version recorded on each Run (docs/goals.md 13.1).
 *
 * "Store the resolved version on the Run so a later diagnosis knows what actually executed it."
 * The design names its reason: issue #465 was hard to close because the fix was on `main` while
 * the installed artifact was still broken, and nothing recorded which binary a Run had talked to.
 * The registry cache answers "what is installed now"; only the Run answers "what ran then".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openDatabase, MIGRATIONS } from '../src/db/database.ts';
import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';
import type { AgentAdapter, AgentVersionInfo } from '../src/domain/types.ts';

function adapterWithVersion(version: string | null, raw?: string): AgentAdapter {
  return {
    capabilities: { goals: { set: '0.3.3' } },
    detectVersion: async (): Promise<AgentVersionInfo> =>
      version === null ? { version: null, raw: raw ?? null, error: 'unparsable' } : { version, raw: raw ?? version },
    start: async () => { throw new Error('not started'); },
    sendInput: async () => {},
    cancel: async () => {},
  } as AgentAdapter;
}

test('v7 migration adds the version columns and leaves existing Runs unknown', () => {
  // The upgrade path is the one that matters: an existing database has Runs whose harness is
  // genuinely unrecordable, and the migration must not invent a value for them.
  const dir = tempDir('mercury-migrate-v7-');
  const dbPath = join(dir, 'test.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    // Everything before v7.
    for (const sql of MIGRATIONS.slice(0, -1)) db.exec(sql);
    const before = db.prepare("SELECT name FROM pragma_table_info('runs') WHERE name IN ('agent_version','agent_version_raw')").all();
    assert.deepEqual(before, [], 'the columns existed before v7');

    db.exec(MIGRATIONS[MIGRATIONS.length - 1]);
    const cols = (db.prepare("SELECT name FROM pragma_table_info('runs') WHERE name IN ('agent_version','agent_version_raw') ORDER BY name").all() as { name: string }[])
      .map((r) => r.name);
    assert.deepEqual(cols, ['agent_version', 'agent_version_raw']);
  } finally { db.close(); }
});

test('openDatabase on a fresh file reaches the v7 schema', () => {
  const dir = tempDir('mercury-v7-fresh-');
  const db = openDatabase(join(dir, 'fresh.db'));
  try {
    const cols = (db.prepare("SELECT name FROM pragma_table_info('runs') WHERE name = 'agent_version'").all() as { name: string }[]);
    assert.equal(cols.length, 1);
  } finally { db.close(); }
});

test('the worker records the cached harness version on the Run', async () => {
  const repo = makeGitRepo(tempDir('mercury-v7-repo-'));
  const env = makeEnv({
    adapters: { pa: adapterWithVersion('0.9.4', 'prime-agent 0.9.4') },
    probeCapabilities: true,
    workspaceMode: 'git-worktree',
    repoDir: repo,
  });
  try {
    await env.agentCapabilities.settle();
    const run = env.runService.create({ ownerId: 'alice', task: 'work', agent: 'pa', repository: { localPath: repo, baseBranch: 'main' } });
    await waitFor(() => { const r = env.runs.get(run.id)!; return r.status === 'COMPLETED' || r.status === 'FAILED'; });
    const stored = env.runs.get(run.id)!;
    assert.equal(stored.agentVersion, '0.9.4');
    assert.equal(stored.agentVersionRaw, 'prime-agent 0.9.4', 'the raw string is the evidence when a parse is wrong');
  } finally { env.close(); }
});

test('an undetermined version is recorded as unknown, not guessed', async () => {
  // 13.7: "undetermined" is a legal value and must render as itself. The failure mode this
  // guards is a Run that reads as if it ran on the newest harness because the probe could not
  // tell -- which is assume-yes (#459) wearing a version number.
  const repo = makeGitRepo(tempDir('mercury-v7-raw-'));
  const env = makeEnv({
    adapters: { pa: adapterWithVersion(null, 'dev build') },
    probeCapabilities: true,
    workspaceMode: 'git-worktree',
    repoDir: repo,
  });
  try {
    await env.agentCapabilities.settle();
    const run = env.runService.create({ ownerId: 'alice', task: 'work', agent: 'pa', repository: { localPath: repo, baseBranch: 'main' } });
    await waitFor(() => { const r = env.runs.get(run.id)!; return r.status === 'COMPLETED' || r.status === 'FAILED'; });
    const stored = env.runs.get(run.id)!;
    assert.equal(stored.agentVersion, null);
    assert.equal(stored.agentVersionRaw, 'dev build', 'the unparsable output is still worth keeping');
  } finally { env.close(); }
});

test('a recorded version is never overwritten by a later probe', () => {
  // Probes are detached and may resolve after the first Run, and the operator may upgrade
  // mid-day. The stored value describes the binary that RAN, so a later answer about the same
  // adapter must not rewrite history.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'work', agent: 'fake' });
    env.runs.setAgentVersion(run.id, '1.0.0', 'acme 1.0.0');
    env.runs.setAgentVersion(run.id, '2.0.0', 'acme 2.0.0');
    const stored = env.runs.get(run.id)!;
    assert.equal(stored.agentVersion, '1.0.0', 'a later probe rewrote what actually ran');
    assert.equal(stored.agentVersionRaw, 'acme 1.0.0');
  } finally { env.close(); }
});

test('an unknown version is not filled in from a later probe either', () => {
  // The tempting asymmetry: allow null -> value "because it can only improve". It would assert
  // that the binary did not change while the Run executed, which is the exact thing this column
  // refuses to guess about. Recording stays null and the UI says so.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'work', agent: 'fake' });
    env.runs.setAgentVersion(run.id, null, 'dev build');
    env.runs.setAgentVersion(run.id, '1.2.3', 'acme 1.2.3');
    assert.equal(env.runs.get(run.id)!.agentVersion, null, 'a null was filled in from a later probe');
  } finally { env.close(); }
});

test('the Run detail API carries the version, so a diagnosis can read it', async () => {
  const repo = makeGitRepo(tempDir('mercury-v7-repo-'));
  const env = makeEnv({
    adapters: { pa: adapterWithVersion('0.9.4', 'prime-agent 0.9.4') },
    probeCapabilities: true,
    workspaceMode: 'git-worktree',
    repoDir: repo,
  });
  try {
    await env.agentCapabilities.settle();
    const run = env.runService.create({ ownerId: 'alice', task: 'work', agent: 'pa', repository: { localPath: repo, baseBranch: 'main' } });
    await waitFor(() => { const r = env.runs.get(run.id)!; return r.status === 'COMPLETED' || r.status === 'FAILED'; });
    const detail = env.runService.get(run.id, 'alice', true)!;
    assert.equal(detail.agentVersion, '0.9.4');
  } finally { env.close(); }
});

test('a broken capability declaration cannot fail the Run', async () => {
  // Section 13.5: capability may gate the goal feature and nothing else. An earlier version of
  // the recording block had no guard, and an adapter whose declaration made the registry throw
  // produced FAILED(infrastructure) before the adapter was even asked to start -- capability
  // failure bricking execution, which is the exact thing that rule forbids. This regression is
  // what an existing redaction test caught when the feature was added.
  const repo = makeGitRepo(tempDir('mercury-v7-broken-'));
  const noCapabilities = {
    // `capabilities` is required by the type; omitting it is what a hand-rolled fixture does.
    detectVersion: async () => { throw new Error('probe exploded'); },
    start: async () => { throw new Error('adapter deliberately fails'); },
    sendInput: async () => {},
    cancel: async () => {},
  } as unknown as AgentAdapter;
  const env = makeEnv({
    adapters: { weird: noCapabilities },
    probeCapabilities: true,
    workspaceMode: 'git-worktree',
    repoDir: repo,
  });
  try {
    await env.agentCapabilities.settle();
    const run = env.runService.create({ ownerId: 'alice', task: 'work', agent: 'weird', repository: { localPath: repo, baseBranch: 'main' } });
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 15_000);
    const final = env.runs.get(run.id)!;
    // The Run failed because the ADAPTER failed, not because recording the version threw.
    assert.match(String(final.error), /adapter deliberately fails/, `wrong failure: ${final.error}`);
    assert.equal(final.agentVersion ?? null, null, 'a version was recorded from a registry that could not answer');
  } finally { env.close(); }
});

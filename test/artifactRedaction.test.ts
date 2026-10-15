import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';
import { redactRunArtifacts, ARTIFACT_DIRS } from '../src/worker/artifactRedaction.ts';

const TOKEN = 'gh-token-abc123def456ghi789jkl'; // synthetic value, built at test time (#944)

test('issue #944: session transcripts are scrubbed of declared secret values', () => {
  const ws = tempDir('mercury-artifacts-');
  const dir = join(ws, '.mercury-sessions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session-1.jsonl');
  writeFileSync(file, JSON.stringify({ env: { GH_TOKEN: TOKEN, TOOL: 'gh' } }) + '\n' + 'ran gh auth token: ' + TOKEN + '\n');
  const scrubbed = redactRunArtifacts(ws, [TOKEN]);
  assert.equal(scrubbed, 1);
  const out = readFileSync(file, 'utf8');
  assert.ok(!out.includes(TOKEN), 'transcript must not contain the secret');
  assert.ok(out.includes('[REDACTED]'), 'text redaction uses the event-redactor rendering');
  // the label survives so a reader can still tell WHICH credential leaked
  assert.ok(out.includes('GH_TOKEN'));
});

test('issue #944: binary kernel snapshots are scrubbed in place at equal length', () => {
  const ws = tempDir('mercury-artifacts-');
  const dir = join(ws, 'session-artifacts', 'run_x', 'kernel');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'kernel-state.dill');
  // A pickle-like binary: NUL bytes make it binary; the secret is stored as a
  // length-prefixed short string, as cpython marshalling would do.
  const prefix = Buffer.from([0x80, 0x04, 0x95, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8c]);
  const payload = Buffer.concat([prefix, Buffer.from([TOKEN.length]), Buffer.from(TOKEN, 'utf8'), Buffer.from([0x00, 0x00])]);
  writeFileSync(file, payload);
  const scrubbed = redactRunArtifacts(ws, [TOKEN]);
  assert.equal(scrubbed, 1);
  const out = readFileSync(file);
  assert.ok(!out.includes(Buffer.from(TOKEN)), 'snapshot must not contain the secret');
  assert.equal(out.length, payload.length, 'binary redaction must keep the byte length');
  assert.ok(out.includes(Buffer.from('[REDACTED]')), 'marker is readable in the binary');
});

test('issue #944: runs with no artifact secrets are untouched and empty dirs are fine', () => {
  const ws = tempDir('mercury-artifacts-');
  assert.equal(redactRunArtifacts(ws, []), 0);
  assert.equal(redactRunArtifacts(ws, [TOKEN]), 0); // no artifact dirs at all
  const dir = join(ws, '.mercury-sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'clean.jsonl'), 'nothing secret here\n');
  assert.equal(redactRunArtifacts(ws, [TOKEN]), 0);
  assert.ok(existsSync(join(dir, 'clean.jsonl')));
});

test('issue #944: a run whose agent writes a transcript and kernel snapshot ends scrubbed', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({
    workspaceMode: 'git-worktree',
    repoDir: repo,
    artifactSecrets: [TOKEN],
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'working' } }, delayMs: 300 },
    ],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'echo the environment',
      agent: 'fake',
      repository: { localPath: repo, baseBranch: 'main' },
    });
    // While the run is executing, seed the artifact dirs the way a real agent kernel would.
    await waitFor(() => {
      const r = env.runs.get(run.id)!;
      return r.status === 'RUNNING' && !!r.workspacePath;
    }, 10_000);
    const ws = env.runs.get(run.id)!.workspacePath!;
    const sessions = join(ws, '.mercury-sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'session.jsonl'), 'env dump: GH_TOKEN=' + TOKEN + '\n');
    const snapDir = join(ws, 'session-artifacts', 'run_x');
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(join(snapDir, 'kernel-state.dill'), Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from(TOKEN)]));
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    assert.ok(!readFileSync(join(sessions, 'session.jsonl'), 'utf8').includes(TOKEN), 'transcript scrubbed at rest');
    assert.ok(!readFileSync(join(snapDir, 'kernel-state.dill')).includes(Buffer.from(TOKEN)), 'snapshot scrubbed at rest');
    // Both dirs stay covered by the redaction pass in step with GENERATED_PATHS.
    for (const d of ARTIFACT_DIRS) {
      assert.ok(['.mercury-sessions/', 'session-artifacts/'].includes(d));
    }
  } finally {
    env.close();
  }
});

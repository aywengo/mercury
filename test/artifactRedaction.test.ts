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

test('issue #944 review on #965: a NUL-free file with invalid UTF-8 is binary and scrubbed at equal length', () => {
  const ws = tempDir('mercury-artifacts-');
  const dir = join(ws, 'session-artifacts', 'run_x');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'blob.bin');
  // No NUL anywhere, but a 0xFF byte makes it invalid UTF-8: the old NUL-only check routed it
  // through the text path, where toString('utf8') would replace the invalid byte with U+FFFD
  // and rewrite the whole file.
  const secretBytes = Buffer.from(TOKEN, 'utf8');
  const buf = Buffer.concat([Buffer.from([0x68, 0x69, 0xff, 0x02]), secretBytes, Buffer.from([0x03, 0xfe, 0x7f])]);
  writeFileSync(file, buf);
  const scrubbed = redactRunArtifacts(ws, [TOKEN]);
  assert.equal(scrubbed, 1);
  const out = readFileSync(file);
  assert.equal(out.length, buf.length, 'byte length preserved');
  assert.ok(!out.includes(secretBytes), 'secret destroyed');
  // every other byte unchanged
  const marker = Buffer.from('[REDACTED]'.padEnd(secretBytes.length, '#'));
  const idx = out.indexOf(marker);
  assert.notEqual(idx, -1, 'equal-length marker present');
  for (let i = 0; i < out.length; i++) {
    if (i < idx || i >= idx + marker.length) assert.equal(out[i], buf[i], 'byte ' + i + ' must be untouched');
  }
});

test('issue #944 review on #965: base64 copies of the secret and of the git x-access-token pair are scrubbed', () => {
  const ws = tempDir('mercury-artifacts-');
  const dir = join(ws, '.mercury-sessions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl');
  const b64 = Buffer.from(TOKEN, 'utf8').toString('base64');
  const gitPair = Buffer.from('x-access-token:' + TOKEN, 'utf8').toString('base64');
  writeFileSync(file, 'auth ' + b64 + ' clone ' + gitPair + '\n');
  const scrubbed = redactRunArtifacts(ws, [TOKEN]);
  assert.equal(scrubbed, 1);
  const out = readFileSync(file, 'utf8');
  assert.ok(!out.includes(b64), 'base64 of the raw value must be gone');
  assert.ok(!out.includes(gitPair), 'base64 of the x-access-token pair must be gone');
});

test('issue #944 review on #965: files above the size cap are skipped and reported', () => {
  const ws = tempDir('mercury-artifacts-');
  const dir = join(ws, '.mercury-sessions');
  mkdirSync(dir, { recursive: true });
  const big = join(dir, 'big.jsonl');
  writeFileSync(big, 'x'.repeat(64) + TOKEN);
  const skipped: string[] = [];
  const scrubbed = redactRunArtifacts(ws, [TOKEN], { maxFileBytes: 16, onSkip: (p) => skipped.push(p) });
  assert.equal(scrubbed, 0);
  assert.deepEqual(skipped, [big]);
  assert.ok(readFileSync(big, 'utf8').includes(TOKEN), 'skipped file is left alone');
});

test('issue #944 review on #965: a run whose agent writes a transcript then fails ends FAILED and scrubbed', async () => {
  const repo = makeGitRepo(tempDir('mercury-repo-'));
  const env = makeEnv({
    workspaceMode: 'git-worktree',
    repoDir: repo,
    artifactSecrets: [TOKEN],
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'working' } }, delayMs: 300 },
      { fail: true },
    ],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'crash after dumping the environment',
      agent: 'fake',
      repository: { localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => {
      const r = env.runs.get(run.id)!;
      return r.status === 'RUNNING' && !!r.workspacePath;
    }, 10_000);
    const ws = env.runs.get(run.id)!.workspacePath!;
    const sessions = join(ws, '.mercury-sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'session.jsonl'), 'env dump: GH_TOKEN=' + TOKEN + '\n');
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 10_000);
    assert.ok(!readFileSync(join(sessions, 'session.jsonl'), 'utf8').includes(TOKEN), 'transcript scrubbed even though the run FAILED');
  } finally {
    env.close();
  }
});

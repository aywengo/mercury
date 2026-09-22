/**
 * `mercury knowledge index <checkout>` (§6.3, issue #685).
 *
 * A repository that already had decision records before Atlas existed had no path into the system
 * except one Run per record. The command parses a checkout at HEAD, queues survivors in the ordinary
 * outbox with `runId: null` and `source: 'repo-record'`, reports accepted/skipped/rejected per path,
 * and fails when anything was rejected so it is usable in CI. It never pushes; `flush` exists for that.
 *
 * The idempotency-key change this rides on: a runless `repo-record` row keys as `index:<claimHash>`,
 * not `operator:<claimHash>` — an indexed decision and an operator note with the same claim are
 * different acts and must not deduplicate against each other in the outbox.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { openDatabase } from '../src/db/database.ts';
import { tempDir } from './helpers.ts';
import { OutboxStore, idempotencyKey } from '../src/knowledge/outbox.ts';
import type { NoteContribution } from '../src/knowledge/types.ts';

const ROOT = resolve(import.meta.dirname, '..');

function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], { cwd: ROOT, env: { ...process.env, ...extraEnv } });
    let stdout = ''; let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('error', rej);
    child.on('close', (code) => { clearTimeout(killer); res({ code, stdout, stderr }); });
  });
}

const clean = (s: string): string => s.split('\n').filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l)).join('\n');

const RECORD = [
  '---',
  'id: 0001',
  'title: Indexed by hand',
  'status: accepted',
  'date: 2026-09-22',
  'evidence:',
  '  - commit: 7a546bc',
  '---',
  '',
  '## Decision',
  '',
  'A record indexed by an operator carries the same provenance as one a Run commits.',
  '',
].join('\n');

function makeCheckout(dir: string, records: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# checkout\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'initial']);
  for (const [name, text] of Object.entries(records)) {
    const p = join(dir, 'docs/decisions', name);
    mkdirSync(join(dir, 'docs/decisions'), { recursive: true });
    writeFileSync(p, text);
  }
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'records']);
  return dir;
}

const INDEX_ENV = {
  MERCURY_DB: '',
  MERCURY_ATLAS_URL: 'http://127.0.0.1:1',
  MERCURY_ATLAS_HOST_ID: 'index-host',
  MERCURY_ATLAS_PROJECT: 'index-proj',
  MERCURY_ATLAS_TOKEN: 'index-token',
};

test('indexing a checkout with three valid records and one proposed queues three and skips one', async () => {
  const dir = makeCheckout(tempDir('mercury-index-checkout-'), {
    '0001-a.md': RECORD,
    '0002-b.md': RECORD.replace('id: 0001', 'id: 0002').replace('Indexed by hand', 'Second decision')
      .replace('carries the same provenance as one a Run commits.', 'is the second record in this checkout.'),
    '0003-c.md': RECORD.replace('id: 0001', 'id: 0003').replace('Indexed by hand', 'Third decision')
      .replace('carries the same provenance as one a Run commits.', 'is the third record in this checkout.'),
    '0004-proposed.md': RECORD.replace('id: 0001', 'id: 0004').replace('status: accepted', 'status: proposed'),
  });
  const dbPath = join(dir, 'index.db');
  const r = await cli(['knowledge', 'index', dir], { ...INDEX_ENV, MERCURY_DB: dbPath });
  try {
    assert.equal(r.code, 0, clean(r.stderr));
    assert.match(r.stdout, /indexed 3, skipped 1, rejected 0/);
    assert.match(r.stdout, /skipped\s+.*0004-proposed\.md/);

    const outbox = new OutboxStore(openDatabase(dbPath));
    const rows = outbox.takeBatch(10);
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.runId, null, 'no Run produced an indexed record');
      assert.equal(row.contribution.provenance?.source, 'repo-record');
      // §6.2: the evidence always includes the self-referencing repo-file entry at HEAD.
      assert.ok(row.contribution.evidence.some((e) => e.type === 'repo-file'),
        'each indexed note points back at its record');
    }
    // The keys are `index:`-prefixed and distinct per claim.
    const keys = rows.map((row) => row.idempotencyKey);
    for (const key of keys) assert.match(key, /^index:[0-9a-f]{64}$/);
    assert.equal(new Set(keys).size, 3, 'one key per claim');
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test('an indexed record and an operator note with the same claim do not share an outbox key', async () => {
  const dir = makeCheckout(tempDir('mercury-index-checkout-'), { '0001-a.md': RECORD });
  const dbPath = join(dir, 'index.db');
  const r = await cli(['knowledge', 'index', dir], { ...INDEX_ENV, MERCURY_DB: dbPath });
  assert.equal(r.code, 0, clean(r.stderr));
  try {
    const db = openDatabase(dbPath);
    const outbox = new OutboxStore(db);
    const rows = outbox.takeBatch(10);
    assert.equal(rows.length, 1);
    const indexedKey = rows[0]!.idempotencyKey;
    assert.match(indexedKey, /^index:/);
    // An operator note for the same claim (what `POST /api/knowledge/notes` queues).
    const contribution = {
      projectId: 'index-proj',
      kind: 'decision',
      scope: 'project',
      claim: RECORD.split('## Decision\n\n')[1]!.split('\n\n')[0]!.trim(),
      evidence: [{ type: 'commit', repo: 'repo', sha: '7a546bc' }],
      provenance: { source: 'operator', hostId: 'index-host', recordedAt: new Date().toISOString() },
    } as NoteContribution;
    const operatorKey = idempotencyKey(null, contribution);
    assert.match(operatorKey, /^operator:/);
    assert.notEqual(operatorKey, indexedKey,
      'an indexed decision and an operator note with the same claim are different acts');
    db.close();
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test('indexing a checkout with a rejected record reports it and exits non-zero', async () => {
  const dir = makeCheckout(tempDir('mercury-index-checkout-'), {
    '0001-a.md': RECORD,
    '0002-bad.md': RECORD.replace('id: 0001', 'id: 0002').replace(/evidence:\n[\s\S]*?\n---/, '---'),
  });
  const dbPath = join(dir, 'index.db');
  const r = await cli(['knowledge', 'index', dir], { ...INDEX_ENV, MERCURY_DB: dbPath });
  try {
    assert.equal(r.code, 1, 'a rejection is a failed command, so the command is usable in CI');
    assert.match(r.stdout, /indexed 1, skipped 0, rejected 1/);
    assert.match(r.stdout, /rejected\s+.*0002-bad\.md\s+decision-without-evidence/);
    const outbox = new OutboxStore(openDatabase(dbPath));
    assert.equal(outbox.depth(), 1, 'the valid record is still queued');
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test('indexing the same checkout twice queues nothing new (acceptance 2, host side)', async () => {
  const dir = makeCheckout(tempDir('mercury-index-checkout-'), {
    '0001-a.md': RECORD,
    '0002-b.md': RECORD.replace('id: 0001', 'id: 0002').replace('Indexed by hand', 'Second decision')
      .replace('carries the same provenance as one a Run commits.', 'is the second record in this checkout.'),
  });
  const dbPath = join(dir, 'index.db');
  const env = { ...INDEX_ENV, MERCURY_DB: dbPath };
  const first = await cli(['knowledge', 'index', dir], env);
  assert.equal(first.code, 0, clean(first.stderr));
  const second = await cli(['knowledge', 'index', dir], env);
  assert.equal(second.code, 0, clean(second.stderr));
  try {
    assert.match(second.stdout, /indexed 2, skipped 0, rejected 0/, 'parsing is not memoized; the report is honest');
    const outbox = new OutboxStore(openDatabase(dbPath));
    assert.equal(outbox.depth(), 2, 'the second pass adds no rows: the keys already exist');
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test('the command refuses with an explanation when no Atlas is configured', async () => {
  const dir = makeCheckout(tempDir('mercury-index-checkout-'), { '0001-a.md': RECORD });
  const dbPath = join(dir, 'index.db');
  const r = await cli(['knowledge', 'index', dir], { MERCURY_DB: dbPath });
  try {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /MERCURY_ATLAS_URL is not set/);
    assert.equal(new OutboxStore(openDatabase(dbPath)).depth(), 0, 'nothing was read');
  } finally {
    rmSync(dbPath, { force: true });
  }
});


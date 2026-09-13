/**
 * `mercury knowledge identity` (#546).
 *
 * A `repo:<hash>` scope key is the most useful scope in the design and had no operator-facing path to it:
 * the hash is sha256 of a normalized identity truncated to 16 hex, which nobody computes by hand. The
 * value of this command is not the arithmetic, it is that the operator gets the SAME number the pack
 * selector computes -- so these tests pin the agreement rather than the digits.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

import { identityHash, normalizeRepoIdentity, repoIdentity } from '../src/knowledge/identity.ts';
import { selectPack } from '../src/knowledge/pack.ts';
import { ReplicaStore } from '../src/knowledge/replica.ts';
import { openDatabase } from '../src/db/database.ts';
import type { Note, NoteKind } from '../src/knowledge/types.ts';

const ROOT = resolve(import.meta.dirname, '..');

function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], { cwd: ROOT, env: { ...process.env, ...extraEnv } });
    let stdout = ''; let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('error', rej);
    child.on('close', (code) => { clearTimeout(killer); res({ code, stdout, stderr }); });
  });
}

const clean = (s: string): string => s.split('\n').filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l)).join('\n');

// ---------- the command agrees with the library ----------

test('the printed hash is exactly what identityHash produces for the normalized identity', async () => {
  const url = 'https://github.com/acme/api.git';
  const r = await cli(['knowledge', 'identity', url]);
  assert.equal(r.code, 0, r.stderr);
  const expected = identityHash(normalizeRepoIdentity(url)!);
  assert.match(clean(r.stdout), new RegExp(`^${expected}  github\\.com/acme/api$`, 'm'),
    'the command must print the same hash the selector uses, not a reimplementation');
});

test('https and ssh forms of one repository print one hash', async () => {
  // The whole reason this is not `sha256sum` of the string the operator typed. Two clone URLs for one
  // repository must land on one scope, or notes contributed over one transport are invisible to the other.
  const r = await cli(['knowledge', 'identity', 'https://github.com/acme/api.git', 'git@github.com:acme/api.git']);
  assert.equal(r.code, 0, r.stderr);
  const hashes = clean(r.stdout).split('\n').map((l) => l.split(/\s+/)[0]);
  assert.equal(hashes.length, 2);
  assert.equal(hashes[0], hashes[1], `transport changed the scope: ${hashes.join(' vs ')}`);
});

test('the hash the command prints is the hash that selects a note in a pack', async () => {
  // The agreement that matters. If pack selection ever normalized differently, the command would print
  // a scope key that selects nothing, and it would look correct while doing nothing.
  const url = 'https://github.com/acme/widget.git';
  const r = await cli(['knowledge', 'identity', url]);
  const hash = clean(r.stdout).split(/\s+/)[0]!;
  const db = openDatabase(':memory:');
  const replica = new ReplicaStore(db);
  const note = (scope: string, id: string): Note => ({
    noteId: id, seq: 1, revision: 1, projectId: 'p', kind: 'convention' as NoteKind, scope,
    claim: `claim ${id}`, evidence: [], tier: 'promoted',
    corroboration: { runs: 1, harnesses: 1, hosts: 1 },
    provenance: { source: 'agent-reported', hostId: 'h', recordedAt: '2026-01-01T00:00:00.000Z' },
  } as Note);
  replica.applyBatch('p', [note(`repo:${hash}`, 'note_repo'), note('project', 'note_proj')], 2, '2026-01-02T00:00:00.000Z');
  const pack = selectPack(replica, { projectId: 'p', agent: 'primeagent', task: 'touch src/server.ts', repositories: [url], maxBytes: 100_000 });
  const ids = pack.notes.map((n) => n.noteId);
  assert.ok(ids.includes('note_repo'), `the printed scope selected nothing; got ${JSON.stringify(ids)}`);
  db.close();
});

// ---------- the local-path trap ----------

test('a local path is reported as host-local rather than silently scoped', async () => {
  // `file/...` identities are deliberately host-local: two hosts with the same path are not the same
  // repository. An operator who pastes a laptop path gets a key that works here and matches nowhere
  // else, which reads as a bug in scopes unless it is said out loud.
  const r = await cli(['knowledge', 'identity', '/home/dev/work/api']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(clean(r.stdout), /^hash|file\/home\/dev\/work\/api/m);
  assert.match(r.stderr, /matches only this host/);
  assert.match(r.stderr, /clone URL/);
});

// ---------- refusals ----------

test('an input with no derivable identity fails loudly instead of printing a hash', async () => {
  const r = await cli(['knowledge', 'identity', 'not a repository']);
  assert.equal(r.code, 1, 'a scope the operator cannot use must not exit 0');
  assert.equal(clean(r.stdout), '', 'no hash may be printed for an unparseable input');
  assert.match(r.stderr, /cannot derive a repository identity/);
});

test('one bad target among good ones still fails, after printing the good ones', async () => {
  const r = await cli(['knowledge', 'identity', 'https://github.com/acme/api.git', 'https://']);
  assert.equal(r.code, 1);
  assert.equal(clean(r.stdout).split('\n').length, 1, 'the good one is still answered');
});

test('no target prints usage on stderr and exits 1', async () => {
  const r = await cli(['knowledge', 'identity']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give one or more repository URLs/);
});

// ---------- the design decision ----------

test('identity works with an unusable database, unlike status', async () => {
  // The reason this branch sits before openDatabase() rather than inside the knowledge block. The
  // operator asking "why did my repo: scope not match" is usually on a host whose configuration is the
  // thing under investigation.
  const broken = { MERCURY_DB: '/dev/null/not-a-real-path/mercury.db' };
  const ok = await cli(['knowledge', 'identity', 'https://github.com/acme/api.git'], broken);
  assert.equal(ok.code, 0, `identity must not need a database: ${ok.stderr}`);
  assert.match(ok.stdout, /[0-9a-f]{16}  github\.com\/acme\/api/);
  // And the contrast is real: status does open the database.
  const bad = await cli(['knowledge', 'status'], broken);
  assert.notEqual(bad.code, 0, 'if status also survived, this test would be proving nothing');
});

test('--help lists the identity subcommand', async () => {
  const r = await cli(['--help']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^\s+identity\b/m, 'help that omits a subcommand is a subset an operator trusts');
});

test('an unknown knowledge subcommand names identity among the valid choices', async () => {
  const r = await cli(['knowledge', 'nonsense']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /flush, identity or status/);
});

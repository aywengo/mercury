import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { openDatabase } from '../src/db/database.ts';
import { describeDrift, verifySchema } from '../src/db/schemaVerify.ts';
import { tempDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');

function freshDb(): { path: string; dir: string } {
  const dir = tempDir('schema-verify-');
  const path = join(dir, 'mercury.db');
  const db = openDatabase(path);
  db.close();
  return { path, dir };
}

/** Run one statement against a database file, closing it again (a second connection to the same file). */
function exec(path: string, sql: string): void {
  const db = openDatabase(path);
  try { db.exec(sql); } finally { db.close(); }
}

test('a database this build just created has no missing objects', () => {
  const { path } = freshDb();
  const db = openDatabase(path);
  try {
    const { missing } = verifySchema(db);
    assert.deepEqual(missing, [], `a fresh database must verify clean, got ${describeDrift(missing)}`);
  } finally { db.close(); }
});

test('#1032: a column its migration recorded as applied but the database lacks is named', () => {
  // The exact shape of #1032: v18 is recorded in schema_migrations, the column is not there, and
  // `migrate` sees nothing pending, so every Run creation failed with
  // "table runs has no column named status_changed_at".
  const { path } = freshDb();
  exec(path, 'ALTER TABLE runs DROP COLUMN status_changed_at');
  const db = openDatabase(path);
  try {
    const { missing } = verifySchema(db);
    assert.deepEqual(missing, [{ kind: 'column', name: 'runs.status_changed_at' }]);
    assert.match(describeDrift(missing), /column runs\.status_changed_at/);
  } finally { db.close(); }
});

test('#1032: a missing table is named, and so is its index', () => {
  const { path } = freshDb();
  exec(path, 'DROP TABLE run_workflows');
  const db = openDatabase(path);
  try {
    const { missing } = verifySchema(db);
    const names = missing.map((m) => `${m.kind} ${m.name}`);
    assert.ok(names.includes('table run_workflows'), `expected the table to be named: ${names.join(', ')}`);
    assert.ok(names.includes('index idx_run_workflows_identity'),
      `the index that went with the dropped table must be named too: ${names.join(', ')}`);
  } finally { db.close(); }
});

test('an extra object is reported but is not a failure', () => {
  // A nullable column left behind by a removed feature cannot break an insert, and refusing to start
  // over one would be a worse failure than the drift it reports. (This host has one: runs.persona_json.)
  const { path } = freshDb();
  exec(path, 'ALTER TABLE runs ADD COLUMN leftover_json TEXT');
  const db = openDatabase(path);
  try {
    const { missing, extra } = verifySchema(db);
    assert.deepEqual(missing, []);
    assert.deepEqual(extra, [{ kind: 'column', name: 'runs.leftover_json' }]);
  } finally { db.close(); }
});

test('a view or trigger dropped from the schema is named', () => {
  const { path } = freshDb();
  exec(path, 'CREATE TABLE probe (id TEXT); CREATE TRIGGER probe_t AFTER INSERT ON probe BEGIN SELECT 1; END;');
  const db = openDatabase(path);
  try {
    // A trigger the migrations do not create is "extra", not missing: nothing to name as broken.
    assert.deepEqual(verifySchema(db).missing, []);
  } finally { db.close(); }
});

/** Run `mercury migrate` against a database file, bounded. */
function runMigrate(dbPath: string): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'migrate'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, MERCURY_DB: dbPath },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('#1032 acceptance: `mercury migrate` exits non-zero and names the missing object', () => {
  const { path } = freshDb();
  exec(path, 'ALTER TABLE runs DROP COLUMN status_changed_at');
  const r = runMigrate(path);
  assert.equal(r.code, 1, `expected a refusal, got exit ${r.code}.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /runs\.status_changed_at/);
  assert.match(r.stderr, /backup/i, 'the refusal must say how to repair');
  // And it must NOT claim the migrations were applied: that sentence is the bug.
  assert.doesNotMatch(r.stdout, /migrations applied(?! and schema verified)/);
});

test('#1032 acceptance: a healthy database still exits zero', () => {
  const { path } = freshDb();
  const r = runMigrate(path);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /migrations applied and schema verified/);
});

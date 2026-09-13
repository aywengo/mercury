import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase, MIGRATIONS } from '../db.ts';

test('migrations: fresh database applies all migrations', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atlas-mig-'));
  const dbPath = join(tmpDir, 'atlas.db');
  
  try {
    const db = openDatabase(dbPath);
    
    // Check that schema_migrations table has one row per migration
    const applied = db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number };
    assert.equal(applied.count, MIGRATIONS.length);
    
    // Check each migration version is present
    const versions = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[])
      .map(r => r.version);
    for (let i = 0; i < MIGRATIONS.length; i++) {
      assert.equal(versions[i], MIGRATIONS[i]?.version);
    }
    
    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('migrations: second open is idempotent', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atlas-mig-'));
  const dbPath = join(tmpDir, 'atlas.db');
  
  try {
    // First open
    const db1 = openDatabase(dbPath);
    const applied1 = db1.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number };
    db1.close();
    
    // Second open
    const db2 = openDatabase(dbPath);
    const applied2 = db2.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number };
    db2.close();
    
    // Should be the same
    assert.equal(applied1.count, applied2.count);
    assert.equal(applied2.count, MIGRATIONS.length);
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('migrations: tables are created', () => {
  const db = openDatabase(':memory:');
  
  // Check that key tables exist
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all() as { name: string }[]).map(r => r.name);
  
  const required = ['projects', 'contributors', 'notes', 'note_revisions', 'note_sources', 'promotions', 'contests', 'idempotency_keys', 'project_seq', 'schema_migrations'];
  for (const table of required) {
    assert.ok(tables.includes(table), `table ${table} should exist`);
  }
  
  db.close();
});

test('migrations: indices are created', () => {
  const db = openDatabase(':memory:');
  
  // Check that indices exist
  const indices = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
  ).all() as { name: string }[]).map(r => r.name);
  
  const required = ['idx_notes_project_seq', 'idx_notes_project_tier_scope', 'idx_notes_project_claim', 'idx_note_sources_note'];
  for (const index of required) {
    assert.ok(indices.includes(index), `index ${index} should exist`);
  }
  
  db.close();
});

test('migrations: schema_migrations has exactly one row per migration', () => {
  const db = openDatabase(':memory:');
  
  // Count rows
  const rows = db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number };
  assert.equal(rows.count, MIGRATIONS.length);
  
  // No duplicates (each version appears exactly once)
  const unique = db.prepare('SELECT COUNT(DISTINCT version) as count FROM schema_migrations').get() as { count: number };
  assert.equal(unique.count, MIGRATIONS.length);
  
  db.close();
});

test('migrations: projects table has correct schema', () => {
  const db = openDatabase(':memory:');
  
  // Check columns exist
  const columns = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[])
    .map(r => r.name);
  
  const required = ['id', 'name', 'repo_identities_json', 'promotion_policy_json', 'created_at'];
  for (const col of required) {
    assert.ok(columns.includes(col), `projects.${col} should exist`);
  }
  
  db.close();
});

test('migrations: notes table has correct schema', () => {
  const db = openDatabase(':memory:');
  
  const columns = (db.prepare('PRAGMA table_info(notes)').all() as { name: string }[])
    .map(r => r.name);
  
  const required = ['note_id', 'project_id', 'current_revision', 'tier', 'kind', 'scope', 'claim_hash', 'seq', 'created_at', 'updated_at'];
  for (const col of required) {
    assert.ok(columns.includes(col), `notes.${col} should exist`);
  }
  
  db.close();
});

// --- migration v2: the live-claim UNIQUE backstop (#566) ------------------------------------------

/**
 * Build a database that is at v1 with the given live notes already present, so a migration can be
 * exercised against data that violates what it is about to require.
 */
function dbAtV1(tmpDir: string, rows: { id: string; claimHash: string; tier: string }[]) {
  const dbPath = join(tmpDir, 'atlas.db');
  const db = openDatabase(dbPath);
  db.exec('BEGIN IMMEDIATE');
  db.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
  db.exec('DROP INDEX IF EXISTS ux_notes_live_claim');
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, repo_identities_json, promotion_policy_json, created_at)
              VALUES ('p', 'p', '[]', NULL, '2020-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO project_seq (project_id, seq) VALUES ('p', 1)
              ON CONFLICT(project_id) DO NOTHING`).run();
  for (const r of rows) {
    db.prepare(`INSERT INTO notes (note_id, project_id, current_revision, tier, kind, scope,
        claim_hash, seq, created_at, updated_at)
        VALUES (?, 'p', 1, ?, 'fact', 'project', ?, ?, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`)
      .run(r.id, r.tier, r.claimHash, 100 + rows.indexOf(r));
  }
  db.exec('COMMIT');
  return { db, dbPath };
}

const LIVE = [
  { id: 'note_a', claimHash: 'hash_dup', tier: 'promoted' },
  { id: 'note_b', claimHash: 'hash_dup', tier: 'candidate' },
];

test('v2: a clean database gains the partial unique index', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atlas-mig-v2-'));
  try {
    const { db } = dbAtV1(tmpDir, [{ id: 'note_ok', claimHash: 'hash_one', tier: 'promoted' }]);
    migrate(db);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_notes_live_claim'").all() as { name: string }[]);
    assert.equal(idx.length, 1, 'the index was not created');
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ux_notes_live_claim'").get() as { sql: string }).sql;
    assert.match(sql, /UNIQUE/i, 'the index is not UNIQUE');
    assert.match(sql, /WHERE tier != 'retired'/, 'the index is not partial -- it would forbid a retired row beside a live one, which #551 depends on');
    db.close();
  } finally { rmSync(tmpDir, { recursive: true, force: true }); }
});

test('v2: a pre-existing collision fails startup naming the project, hash and note ids', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atlas-mig-clash-'));
  try {
    const { db } = dbAtV1(tmpDir, LIVE);
    let message = '';
    assert.throws(() => migrate(db), (err: unknown) => { message = String((err as Error).message); return true; });
    assert.match(message, /project p/, `message does not name the project: ${message}`);
    assert.match(message, /hash_dup/, `message does not name the claim hash: ${message}`);
    assert.match(message, /note_a/, `message does not name note_a: ${message}`);
    assert.match(message, /note_b/, `message does not name note_b: ${message}`);
    // A bare SQLITE_CONSTRAINT is the failure mode the precheck exists to avoid.
    assert.doesNotMatch(message, /SQLITE_CONSTRAINT/, `operator got a raw constraint error: ${message}`);
    // And it must refuse to choose a winner on the operator's behalf.
    assert.match(message, /will not choose which note survives/, 'message does not state that Atlas will not pick a winner');
    db.close();
  } finally { rmSync(tmpDir, { recursive: true, force: true }); }
});

test('v2: the collision is NOT auto-resolved -- both rows survive the failed migration', () => {
  // Section 12: Atlas does not detect contradictions and does not pick a winner. A migration that
  // "helpfully" retired all but the newest note would silently pick, which is the behaviour the design
  // forbids. The failed migration must leave the data exactly as it was.
  //
  // What this test actually pins is the ROLLBACK, not the absence of an auto-resolving statement. A
  // mutation that added a retiring UPDATE to the precheck SURVIVED it, because `migrate()` runs each
  // migration inside `tx()` and the precheck's own throw rolls that write back -- so the guarantee is
  // transactional rather than a property of the precheck's text. That is still the property an operator
  // depends on, and it is the one being asserted; the claim is stated here rather than overstated.
  const tmpDir = mkdtempSync(join(tmpdir(), 'atlas-mig-nosolve-'));
  try {
    const { db } = dbAtV1(tmpDir, LIVE);
    assert.throws(() => migrate(db));
    const live = (db.prepare("SELECT note_id FROM notes WHERE tier != 'retired' ORDER BY note_id").all() as { note_id: string }[]).map(r => r.note_id);
    assert.deepEqual(live, ['note_a', 'note_b'], 'the migration silently retired or deleted a note');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 2').get() as { n: number }).n, 0,
      'the migration was recorded as applied despite failing');
    db.close();
  } finally { rmSync(tmpDir, { recursive: true, force: true }); }
});

test('v2: retiring one side lets the operator clear the collision and start', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atlas-mig-clear-'));
  try {
    const { db } = dbAtV1(tmpDir, LIVE);
    assert.throws(() => migrate(db));
    db.prepare("UPDATE notes SET tier = 'retired' WHERE note_id = 'note_b'").run();
    assert.doesNotThrow(() => migrate(db), 'clearing the collision did not let the migration through');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 2').get() as { n: number }).n, 1);
    db.close();
  } finally { rmSync(tmpDir, { recursive: true, force: true }); }
});

test('v2: the index rejects a second live note at the database level, but allows a retired one beside a live one', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'atlas-mig-enforce-'));
  try {
    const { db } = dbAtV1(tmpDir, [{ id: 'note_live', claimHash: 'hash_x', tier: 'promoted' }]);
    migrate(db);
    const insert = (id: string, tier: string) => db.prepare(`
      INSERT INTO notes (note_id, project_id, current_revision, tier, kind, scope, claim_hash, seq, created_at, updated_at)
      VALUES (?, 'p', 1, ?, 'fact', 'project', 'hash_x', 500, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`).run(id, tier);
    assert.throws(() => insert('note_second', 'candidate'), /UNIQUE constraint failed/,
      'the index did not stop a second live note on one claim');
    assert.doesNotThrow(() => insert('note_hist', 'retired'),
      'the index wrongly forbids a retired row beside a live one -- that is the shape #551 produces');
    db.close();
  } finally { rmSync(tmpDir, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, MIGRATIONS } from '../db.ts';

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

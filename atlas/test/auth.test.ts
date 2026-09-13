import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.ts';
import { AuthIndex, hashToken, seedContributors } from '../auth.ts';
import { NoteStore } from '../notes.ts';
import { createRedactor } from '../redact.ts';
import type { AtlasConfig } from '../config.ts';

test('auth: token hashing', () => {
  const token1 = 'supersecrettoken123456';
  const token2 = 'supersecrettoken123456';
  const token3 = 'differenttoken123456';
  
  const hash1 = hashToken(token1);
  const hash2 = hashToken(token2);
  const hash3 = hashToken(token3);
  
  // Same token produces same hash
  assert.equal(hash1, hash2);
  // Different tokens produce different hashes
  assert.notEqual(hash1, hash3);
  
  // Hashes are hex strings (SHA-256 = 64 hex chars)
  assert.match(hash1, /^[0-9a-f]{64}$/);
});

test('auth: admin token authentication', () => {
  const db = openDatabase(':memory:');
  const adminToken = 'admin-token-123456';
  
  const config: AtlasConfig = {
    dbPath: ':memory:',
    bindHost: '127.0.0.1',
    port: 4100,
    tlsCert: null,
    tlsKey: null,
    adminToken,
    contributorsFile: 'contrib.json',
    readerTokens: [],
    secrets: [],
    maxClaimBytes: 1024,
    maxDetailBytes: 4096,
    maxBatch: 500,
    sweepIntervalMs: 60 * 60 * 1000,
    staleCandidateAgeMs: 30 * 24 * 60 * 60 * 1000,
    idempotencyRetentionMs: 7 * 24 * 60 * 60 * 1000,
    logLevel: 'info',
  };
  
  const auth = new AuthIndex(db, config);
  
  const caller = auth.resolve(adminToken);
  assert.ok(caller);
  assert.equal(caller?.class, 'admin');
  
  db.close();
});

test('auth: invalid token returns null', () => {
  const db = openDatabase(':memory:');
  
  const config: AtlasConfig = {
    dbPath: ':memory:',
    bindHost: '127.0.0.1',
    port: 4100,
    tlsCert: null,
    tlsKey: null,
    adminToken: 'admin-token-123456',
    contributorsFile: 'contrib.json',
    readerTokens: [],
    secrets: [],
    maxClaimBytes: 1024,
    maxDetailBytes: 4096,
    maxBatch: 500,
    sweepIntervalMs: 60 * 60 * 1000,
    staleCandidateAgeMs: 30 * 24 * 60 * 60 * 1000,
    idempotencyRetentionMs: 7 * 24 * 60 * 60 * 1000,
    logLevel: 'info',
  };
  
  const auth = new AuthIndex(db, config);
  
  const caller = auth.resolve('unknown-token');
  assert.equal(caller, null);
  
  db.close();
});

test('auth: reader tokens', () => {
  const db = openDatabase(':memory:');
  const readerTokens = [
    { token: 'reader-token-123456', label: 'fleet-dashboard', projects: ['proj-1', 'proj-2'] },
  ];
  
  const config: AtlasConfig = {
    dbPath: ':memory:',
    bindHost: '127.0.0.1',
    port: 4100,
    tlsCert: null,
    tlsKey: null,
    adminToken: null,
    contributorsFile: 'contrib.json',
    readerTokens,
    secrets: [],
    maxClaimBytes: 1024,
    maxDetailBytes: 4096,
    maxBatch: 500,
    sweepIntervalMs: 60 * 60 * 1000,
    staleCandidateAgeMs: 30 * 24 * 60 * 60 * 1000,
    idempotencyRetentionMs: 7 * 24 * 60 * 60 * 1000,
    logLevel: 'info',
  };
  
  const auth = new AuthIndex(db, config);
  
  const caller = auth.resolve('reader-token-123456');
  assert.ok(caller);
  assert.equal(caller?.class, 'reader');
  assert.equal((caller as any).label, 'fleet-dashboard');
  
  db.close();
});

test('auth: may access checks project permission', () => {
  const db = openDatabase(':memory:');
  
  const config: AtlasConfig = {
    dbPath: ':memory:',
    bindHost: '127.0.0.1',
    port: 4100,
    tlsCert: null,
    tlsKey: null,
    adminToken: 'admin-token',
    contributorsFile: 'contrib.json',
    readerTokens: [{ token: 'reader-token', label: 'reader', projects: ['proj-1'] }],
    secrets: [],
    maxClaimBytes: 1024,
    maxDetailBytes: 4096,
    maxBatch: 500,
    sweepIntervalMs: 60 * 60 * 1000,
    staleCandidateAgeMs: 30 * 24 * 60 * 60 * 1000,
    idempotencyRetentionMs: 7 * 24 * 60 * 60 * 1000,
    logLevel: 'info',
  };
  
  const auth = new AuthIndex(db, config);
  
  // Admin can access any project
  const admin = auth.resolve('admin-token');
  assert.ok(admin);
  assert.ok(auth.mayAccess(admin, 'any-project'));
  
  // Reader can access only bound projects
  const reader = auth.resolve('reader-token');
  assert.ok(reader);
  assert.ok(auth.mayAccess(reader, 'proj-1'));
  assert.ok(!auth.mayAccess(reader, 'other-project'));
  
  db.close();
});

/**
 * #552 follow-up: `'admin'` is the value `contribute()` coalesces a null host into, because the
 * `contributor` column is part of a PRIMARY KEY and SQL NULLs are never equal. A host registered under
 * that name therefore shares an idempotency namespace with the operator path, and the two replay each
 * other's cached responses -- one side's notes are silently discarded and answered with the other's
 * recorded result.
 *
 * Both entry points that can create a contributor are covered, because the bug is the gap between them:
 * a rule enforced only in the file loader would be bypassed by `contributor add`, and vice versa.
 */
test('auth: a contributor file may not bind a token to the reserved host id "admin"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-reserved-'));
  try {
    const file = join(dir, 'contributors.json');
    writeFileSync(file, JSON.stringify({ 'tok-1': { hostId: 'admin', projects: ['p1'] } }));
    const db = openDatabase(':memory:');
    assert.throws(
      () => seedContributors(db, file),
      /reserved/i,
      'a host named "admin" would collide with the operator contribution namespace',
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth: the reserved-name refusal says what to do about it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-reserved-msg-'));
  try {
    const file = join(dir, 'contributors.json');
    writeFileSync(file, JSON.stringify({ 'tok-1': { hostId: 'admin', projects: ['p1'] } }));
    const db = openDatabase(':memory:');
    try {
      seedContributors(db, file);
      assert.fail('expected seedContributors to refuse the reserved id');
    } catch (err) {
      const msg = String((err as Error).message);
      // An operator hitting this at startup needs the remedy in the message, not just the refusal.
      assert.match(msg, /idempotency/i, 'the message must say why the name is taken');
      assert.match(msg, /choose another host id/i, 'the message must say what to do instead');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth: a host id merely containing "admin" is still accepted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-adminish-'));
  try {
    const file = join(dir, 'contributors.json');
    writeFileSync(file, JSON.stringify({
      'tok-1': { hostId: 'admin-box', projects: ['p1'] },
      'tok-2': { hostId: 'build-admin', projects: ['p1'] },
    }));
    const db = openDatabase(':memory:');
    assert.deepEqual(seedContributors(db, file).length, 2,
      'the guard is an exact match, not a substring test that would refuse ordinary host names');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth: addContributor refuses the reserved id too, so the CLI cannot bypass the file rule', () => {
  const db = openDatabase(':memory:');
  const store = new NoteStore(db, { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 }, createRedactor([]));
  assert.throws(
    () => store.addContributor(hashToken('tok'), 'admin', ['p1']),
    /reserved/i,
    'the DB path must enforce the same rule as the file loader',
  );
  // And an ordinary id still goes through.
  store.addContributor(hashToken('tok'), 'host-7', ['p1']);
  db.close();
});

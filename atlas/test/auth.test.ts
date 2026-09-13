import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.ts';
import { AuthIndex, hashToken } from '../auth.ts';
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

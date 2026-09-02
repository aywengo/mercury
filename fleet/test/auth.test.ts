import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCallerTokens, isAdminToken, hostAllowed } from '../auth.ts';

test('a token with no host list grants nothing', () => {
  // The permissive default would be convenient and is the one that turns one leaked token into fleet-wide
  // access, so omission means "no hosts" and an operator must type ":*" to widen it.
  const idx = parseCallerTokens('tok1:alice');
  const caller = idx.resolve('tok1')!;
  assert.deepEqual(caller.allowedHosts, []);
  assert.equal(hostAllowed(caller, 'anything'), false);
});

test('the host list scopes exactly', () => {
  const idx = parseCallerTokens('tok1:alice:box-1+box-2,tok2:bob:*');
  const alice = idx.resolve('tok1')!;
  const bob = idx.resolve('tok2')!;
  assert.deepEqual(alice.allowedHosts, ['box-1', 'box-2']);
  assert.equal(hostAllowed(alice, 'box-1'), true);
  assert.equal(hostAllowed(alice, 'box-3'), false);
  assert.equal(hostAllowed(bob, 'anything'), true);
  assert.equal(idx.resolve('nope'), null);
});

test('malformed entries are skipped rather than guessed at', () => {
  const idx = parseCallerTokens('onlytoken,,tok2:bob,tok3:c:d:e, :x');
  assert.deepEqual(idx.owners(), ['bob']);
});

test('unrestricted owners are reportable for the startup warning', () => {
  const idx = parseCallerTokens('a:alice:*,b:bob,c:carol:x1');
  assert.deepEqual(idx.unrestrictedOwners(), ['alice']);
});

test('admin comparison accepts the right token and rejects everything else', () => {
  assert.equal(isAdminToken('admin-secret', 'admin-secret'), true);
  assert.equal(isAdminToken('admin-secret', 'wrong'), false);
  assert.equal(isAdminToken('admin-secret', ''), false);
  assert.equal(isAdminToken(null, 'anything'), false, 'no admin configured means no admin caller');
});

test('admin comparison rejects a shared prefix', () => {
  // A comparison that reported equality on a shared prefix would be the interesting bug here.
  assert.equal(isAdminToken('abcdefghijklmnop', 'abcdefghijkl'), false);
  assert.equal(isAdminToken('abcdefghijklmnop', 'abcdefghijklmnop'), true);
});

test('admins bypass the allowlist, everyone else does not', () => {
  assert.equal(hostAllowed({ ownerId: 'admin', isAdmin: true, allowedHosts: [] }, 'x'), true);
  assert.equal(hostAllowed({ ownerId: 'a', isAdmin: false, allowedHosts: [] }, 'x'), false);
});

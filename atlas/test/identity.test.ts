import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoIdentity, identityHash, repoIdentity, IDENTITY_HASH_LENGTH } from '../identity.ts';

test('identity: section 5 example', () => {
  // The headline case: three URLs that should produce TWO identities (third differs in path case)
  const id1 = normalizeRepoIdentity('git@github.com:aywengo/mercury.git');
  const id2 = normalizeRepoIdentity('https://github.com/aywengo/mercury');
  const id3 = normalizeRepoIdentity('ssh://git@github.com/aywengo/Mercury.git');
  
  // First two should be the same (path case preserved in id2, normalized in id1)
  assert.equal(id1, 'github.com/aywengo/mercury');
  assert.equal(id2, 'github.com/aywengo/mercury');
  // Third should differ because path case is preserved
  assert.equal(id3, 'github.com/aywengo/Mercury');
  
  // So we get two identities, not one
  assert.notEqual(id1, id3);
  assert.equal(id1, id2);
});

test('identity: credentials, query, fragment are dropped', () => {
  // URL with credentials
  const withCreds = normalizeRepoIdentity('https://user:pass@github.com/org/repo.git');
  const withoutCreds = normalizeRepoIdentity('https://github.com/org/repo');
  assert.equal(withCreds, withoutCreds);
  
  // URL with query and fragment
  const withQuery = normalizeRepoIdentity('https://github.com/org/repo.git?param=value#section');
  assert.equal(withQuery, 'github.com/org/repo');
});

test('identity: default port is dropped, non-default port is kept', () => {
  const defaultHttps = normalizeRepoIdentity('https://github.com:443/org/repo');
  const nonDefault = normalizeRepoIdentity('https://github.com:8443/org/repo');
  const implicit = normalizeRepoIdentity('https://github.com/org/repo');
  
  // Default port should be dropped
  assert.equal(defaultHttps, 'github.com/org/repo');
  assert.equal(implicit, 'github.com/org/repo');
  
  // Non-default port should be kept
  assert.equal(nonDefault, 'github.com:8443/org/repo');
});

test('identity: host case is folded, path case is kept', () => {
  const uppercase = normalizeRepoIdentity('https://GITHUB.COM/org/repo');
  const lowercase = normalizeRepoIdentity('https://github.com/org/repo');
  const mixedPath = normalizeRepoIdentity('https://github.com/org/MyRepo');
  
  // Host case should be folded
  assert.equal(uppercase, lowercase);
  
  // Path case should be preserved
  const withoutPath = normalizeRepoIdentity('https://github.com/org/myrepo');
  assert.notEqual(mixedPath, withoutPath);
});

test('identity: local filesystem paths', () => {
  const absolute = normalizeRepoIdentity('/home/user/mercury');
  const relative = normalizeRepoIdentity('./mercury');
  const tilde = normalizeRepoIdentity('~/mercury');
  
  // All local paths should be prefixed with file/
  assert.ok(absolute?.startsWith('file/'));
  assert.ok(relative?.startsWith('file/'));
  assert.ok(tilde?.startsWith('file/'));
  
  // They should be marked local
  const id1 = repoIdentity('/home/user/mercury');
  const id2 = repoIdentity('~/mercury');
  assert.ok(id1?.local);
  assert.ok(id2?.local);
});

test('identity: invalid inputs return null', () => {
  assert.equal(normalizeRepoIdentity('not-a-repo'), null);
  assert.equal(normalizeRepoIdentity(''), null);
  assert.equal(normalizeRepoIdentity('https://github.com/'), null);
  assert.equal(normalizeRepoIdentity(null as any), null);
  assert.equal(normalizeRepoIdentity(undefined as any), null);
});

test('identity: identity hash is 16 hex chars', () => {
  const id = normalizeRepoIdentity('https://github.com/aywengo/mercury');
  assert.ok(id);
  const hash = identityHash(id);
  
  // Check it's 16 hex characters
  assert.equal(hash.length, IDENTITY_HASH_LENGTH);
  assert.match(hash, /^[0-9a-f]{16}$/);
});

test('identity: hash is stable', () => {
  const id = 'github.com/aywengo/mercury';
  const hash1 = identityHash(id);
  const hash2 = identityHash(id);
  assert.equal(hash1, hash2);
});

test('identity: repoIdentity combines normalization and hashing', () => {
  const id = repoIdentity('https://github.com/aywengo/mercury.git');
  assert.ok(id);
  assert.equal(id.identity, 'github.com/aywengo/mercury');
  assert.equal(id.hash.length, 16);
  assert.match(id.hash, /^[0-9a-f]{16}$/);
  assert.equal(id.local, false);
});

test('identity: trailing .git and / are stripped', () => {
  const withGit = normalizeRepoIdentity('https://github.com/org/repo.git');
  const withSlash = normalizeRepoIdentity('https://github.com/org/repo/');
  const both = normalizeRepoIdentity('https://github.com/org/repo.git/');
  
  assert.equal(withGit, 'github.com/org/repo');
  assert.equal(withSlash, 'github.com/org/repo');
  assert.equal(both, 'github.com/org/repo');
});

test('identity: scp form git@host:org/repo', () => {
  const scpForm = normalizeRepoIdentity('git@github.com:aywengo/mercury');
  const httpsForm = normalizeRepoIdentity('https://github.com/aywengo/mercury');
  
  assert.equal(scpForm, httpsForm);
});

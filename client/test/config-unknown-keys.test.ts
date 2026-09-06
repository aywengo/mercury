// Unknown configuration keys (issue #250).
//
// A misspelled key was accepted and ignored. The failure was already loud (exit 2 / exit 3 / a TLS
// error later), so this is diagnosis, not validation: unknown keys stay non-fatal, and the listing
// names them. These tests pin both halves -- the suggestion when one is safe, and the ABSENCE of a
// suggestion when it would be a guess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findUnknownKeys, findUnknownKeysAt, KNOWN_PROFILE_KEYS, KNOWN_TOP_LEVEL_KEYS } from '../config.ts';
import { listProfiles, renderProfiles } from '../commands/config.ts';

const write = (obj: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-unknown-'));
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  const path = join(dir, 'mercury', 'config.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
};

test('a transposed credential key is named and suggested', () => {
  const found = findUnknownKeys({ profiles: { ci: { url: 'https://x', crednetial: 'c' } } });
  assert.deepEqual(found, [{ scope: 'profile "ci"', key: 'crednetial', suggestion: 'credential' }]);
});

test('a transposed top-level key is named and suggested', () => {
  const found = findUnknownKeys({ currentProfle: 'ci', profiles: {} });
  assert.deepEqual(found, [{ scope: 'top-level', key: 'currentProfle', suggestion: 'currentProfile' }]);
});

test('no suggestion is offered when the nearest key is a guess, not a typo', () => {
  // caCertPathx is what the issue names as the hard case. Suggesting caFile for it is a two-word
  // rename dressed up as a spelling fix; an operator would apply the advice and still be broken.
  const found = findUnknownKeys({ profiles: { ci: { url: 'https://x', caCertPathx: '/x.pem' } } });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.key, 'caCertPathx');
  assert.equal(found[0]!.suggestion, undefined, 'must not guess at a rename');
});

test('a short unknown key gets no spurious near-match', () => {
  // "id" is two edits from "url" purely by coincidence of length.
  assert.equal(findUnknownKeys({ profiles: { ci: { url: 'https://x', id: 'z' } } })[0]?.suggestion, undefined);
});

test('a known key is never reported, so a clean file produces no noise', () => {
  const clean = { currentProfile: 'ci', profiles: { ci: { url: 'https://x', credential: 'c', timeoutMs: 1, caFile: null } } };
  assert.deepEqual(findUnknownKeys(clean), []);
});

test('the schema the reporter uses is the schema the reader accepts', () => {
  // The two lists are the whole risk of this feature: if the reader grows a key and the reporter does
  // not, every existing config file starts reporting a valid key as ignored.
  const src = KNOWN_PROFILE_KEYS.join(' ');
  for (const k of ['url', 'credential', 'timeoutMs', 'caFile']) {
    assert.ok(src.includes(k), `ProfileConfig field ${k} must be in KNOWN_PROFILE_KEYS`);
  }
  assert.deepEqual([...KNOWN_TOP_LEVEL_KEYS].sort(), ['currentProfile', 'profiles']);
});

test('unknown keys are reported but never fatal', () => {
  // The behaviour change the issue explicitly did NOT ask for. Making these fatal would break a file
  // written by a newer client and would convert a warning into a hard failure.
  const path = write({ currentProfile: 'ci', profiles: { ci: { url: 'https://x', crednetial: 'c' } } });
  const listing = listProfiles({ dir: join(path, '..'), env: {} });
  assert.equal(listing.rows.length, 1, 'the profile must still be listed');
  assert.equal(listing.rows[0]!.url, 'https://x');
  assert.equal(listing.unknownKeys.length, 1);
});

test('the report names the key and never its value', () => {
  // Someone who writes "token": "ghp_..." has put a secret in a value. A diagnostic that quoted it
  // would leak exactly what it exists to help them find.
  const secret = 'ghp_' + 'A'.repeat(24);
  const path = write({ currentProfile: 'ci', profiles: { ci: { url: 'https://x', token: secret } } });
  const listing = listProfiles({ dir: join(path, '..'), env: {} });
  for (const ctx of [{ json: false }, { json: true }]) {
    const out = renderProfiles(listing, { json: ctx.json, noColor: true, isTty: false });
    assert.ok(!out.includes(secret), `the value leaked into ${ctx.json ? 'JSON' : 'human'} output`);
    assert.match(out, /token/, 'the key name must still be reported');
  }
});

test('the unknown-key report is appended, so a typo does not hide the other profiles', () => {
  const path = write({
    currentProfile: 'a',
    profiles: { a: { url: 'https://a', credential: 'c' }, b: { url: 'https://b', credential: 'c' },
                c: { url: 'https://c', credential: 'c', crednetial: 'oops' } },
  });
  const listing = listProfiles({ dir: join(path, '..'), env: {} });
  const out = renderProfiles(listing, { json: false, noColor: true, isTty: false });
  for (const n of ['a', 'b', 'c']) assert.match(out, new RegExp(`^\\s*\\*?\\s*${n}\\s+https://`, 'm'));
  assert.match(out, /crednetial/);
});

test('a missing config file produces no findings rather than an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-absent-'));
  assert.deepEqual(findUnknownKeysAt(join(dir, 'mercury', 'config.json')), []);
});

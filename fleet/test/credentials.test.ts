import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCredentials, CredentialError } from '../credentials.ts';

const SECRET = 'tok-live-should-never-print';

function credFile(contents: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cred-'));
  const path = join(dir, 'credentials.json');
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return path;
}

test('a 0600 file resolves refs by name', () => {
  const path = credFile(JSON.stringify({ 'lan-token': SECRET }));
  const store = loadCredentials(path);
  assert.equal(store.secret('lan-token'), SECRET);
  assert.deepEqual(store.names(), ['lan-token']);
});

test('a group- or world-readable credential file is refused', () => {
  for (const mode of [0o644, 0o640, 0o606, 0o666]) {
    const path = credFile(JSON.stringify({ a: SECRET }), mode);
    assert.throws(() => loadCredentials(path), (err: Error) =>
      err instanceof CredentialError && /owner-only/.test(err.message) && /chmod 600/.test(err.message),
      `mode ${mode.toString(8)} must be refused with an actionable message`);
  }
});

test('the insecure escape hatch is explicit', () => {
  const path = credFile(JSON.stringify({ a: SECRET }), 0o644);
  assert.throws(() => loadCredentials(path), CredentialError);
  assert.equal(loadCredentials(path, true).secret('a'), SECRET);
});

test('a missing file says what to do about it', () => {
  assert.throws(() => loadCredentials(join(tmpdir(), 'definitely-not-here-42.json')),
    (err: Error) => /not found/.test(err.message) && /chmod 600/.test(err.message));
});

test('malformed files are refused rather than coerced', () => {
  assert.throws(() => loadCredentials(credFile('{not json')), /not valid JSON/);
  // An array or nested object would otherwise yield a bearer token of "[object Object]" and every probe
  // would fail with 401, which reads like a credential problem instead of the file problem it is.
  assert.throws(() => loadCredentials(credFile('[]')), /must contain a JSON object/);
  assert.throws(() => loadCredentials(credFile('{"a": {"nested": "x"}}')), /is object, not a string/);
  assert.throws(() => loadCredentials(credFile('{"a": null}')), /is null, not a string/);
  assert.throws(() => loadCredentials(credFile('{"a": ""}')), /is empty/);
});

test('an unknown ref lists known NAMES and never any value', () => {
  const path = credFile(JSON.stringify({ 'box-a': SECRET, 'box-b': 'another-secret-xyz' }));
  const store = loadCredentials(path);
  assert.throws(() => store.secret('nope'), (err: Error) => {
    assert.match(err.message, /known refs: box-a, box-b/);
    assert.ok(!err.message.includes(SECRET), 'error text must not carry the secret');
    assert.ok(!err.message.includes('another-secret-xyz'), 'error text must not carry any secret');
    return true;
  });
});

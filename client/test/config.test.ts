import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, normalizeEndpoint, readConfigFile, DEFAULT_TIMEOUT_MS } from '../config.ts';
import { resolveCredential, assertCredentialFileSafe } from '../credentials.ts';
import { UsageError } from '../api/errors.ts';

// Config resolution is pure and network-free, so every branch is reachable here -- including the
// ones that only matter when something is misconfigured, which is exactly when the client is being
// used under pressure and must not guess.

function dirWith(config?: unknown, credentials?: { file: string; mode?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'mercuryctl-')) + '/mercury';
  mkdirSync(dir, { recursive: true });
  if (config !== undefined) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  if (credentials) {
    const path = join(dir, 'credentials.json');
    writeFileSync(path, credentials.file);
    chmodSync(path, credentials.mode ?? 0o600);
  }
  return dir;
}

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

test('a single endpoint works with no config file at all', () => {
  // The common case must not require creating a config file: --url plus the token env var is enough.
  const cfg = resolveConfig({ urlFlag: 'http://127.0.0.1:3000', env: EMPTY_ENV });
  assert.equal(cfg.url, 'http://127.0.0.1:3000');
  assert.equal(cfg.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test('precedence is flags > environment > profile > default', () => {
  const dir = dirWith({
    currentProfile: 'lab',
    profiles: { lab: { url: 'https://lab.example.test', timeoutMs: 1000 } },
  });
  // profile alone
  assert.equal(resolveConfig({ dir, env: EMPTY_ENV }).url, 'https://lab.example.test');
  // env beats profile
  assert.equal(
    resolveConfig({ dir, env: { MERCURY_CLIENT_URL: 'http://127.0.0.1:9' } as NodeJS.ProcessEnv }).url,
    'http://127.0.0.1:9',
  );
  // flag beats env
  assert.equal(
    resolveConfig({
      dir,
      urlFlag: 'http://127.0.0.1:1',
      env: { MERCURY_CLIENT_URL: 'http://127.0.0.1:9' } as NodeJS.ProcessEnv,
    }).url,
    'http://127.0.0.1:1',
  );
  // timeout precedence too
  assert.equal(resolveConfig({ dir, env: EMPTY_ENV }).timeoutMs, 1000);
  assert.equal(resolveConfig({ dir, env: { MERCURY_CLIENT_TIMEOUT_MS: '222' } as NodeJS.ProcessEnv }).timeoutMs, 222);
  assert.equal(resolveConfig({ dir, timeoutFlagMs: 333, env: EMPTY_ENV }).timeoutMs, 333);
});

test('selecting a profile that does not exist is an error naming what does exist', () => {
  const dir = dirWith({ profiles: { lab: { url: 'https://lab.example.test' } } });
  assert.throws(
    () => resolveConfig({ profileFlag: 'prod', dir, env: EMPTY_ENV }),
    /prod.*not defined.*lab/s,
  );
});

test('a config file that exists but does not parse is a hard error', () => {
  // Absent config is fine; a corrupt one must not silently fall back to defaults, because that
  // sends requests to the wrong server and looks like success.
  const dir = mkdtempSync(join(tmpdir(), 'mercuryctl-')) + '/mercury';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), '{ not json');
  assert.throws(() => readConfigFile(join(dir, 'config.json')), /not valid JSON/);
});

test('loopback http is allowed', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.equal(normalizeEndpoint(`http://${host}:3000`), `http://${host}:3000`);
  }
});

test('remote http is refused -- the bearer token would cross the network in clear text', () => {
  assert.throws(() => normalizeEndpoint('http://mercury.example.test'), /refusing plain HTTP/);
  assert.throws(() => normalizeEndpoint('http://10.0.0.5:3000'), /refusing plain HTTP/);
  // and https to the same host is fine
  assert.equal(normalizeEndpoint('https://mercury.example.test'), 'https://mercury.example.test');
});

test('userinfo in the endpoint is refused', () => {
  // It would land in logs and history, and Mercury does not authenticate that way.
  assert.throws(() => normalizeEndpoint('https://tok@example.test'), /userinfo/);
});

test('a trailing slash is normalised away so paths do not double up', () => {
  assert.equal(normalizeEndpoint('https://example.test/'), 'https://example.test');
});

test('a query string on the endpoint is refused rather than silently dropped', () => {
  assert.throws(() => normalizeEndpoint('https://example.test?admin=1'), /query string/);
});

test('a non-http scheme is refused', () => {
  assert.throws(() => normalizeEndpoint('file:///etc/passwd'), /scheme/);
  assert.throws(() => normalizeEndpoint('not a url'), /invalid endpoint/);
});

test('credentials resolve from the environment first', () => {
  const dir = dirWith(undefined, { file: JSON.stringify({ lab: 'from-file' }) });
  const fromEnv = resolveCredential({
    credentialName: 'lab', dir, env: { MERCURY_CLIENT_TOKEN: 'from-env' } as NodeJS.ProcessEnv,
  });
  assert.equal(fromEnv.token, 'from-env');
  assert.equal(fromEnv.origin, 'env');
});

test('credentials fall back to the named profile entry', () => {
  const dir = dirWith(undefined, { file: JSON.stringify({ lab: 'from-file' }) });
  const got = resolveCredential({ credentialName: 'lab', dir, env: EMPTY_ENV });
  assert.equal(got.token, 'from-file');
  assert.equal(got.origin, 'file');
});

test('a group- or world-readable credentials file is refused', () => {
  // The whole point of storing tokens separately is this check. A warning would scroll past once and
  // leave the token exposed; a hard failure forces the chmod.
  for (const mode of [0o644, 0o640, 0o666, 0o604]) {
    const dir = dirWith(undefined, { file: JSON.stringify({ lab: 'secret' }), mode });
    assert.throws(
      () => resolveCredential({ credentialName: 'lab', dir, env: EMPTY_ENV }),
      /readable by group or others|chmod 600/,
      `mode ${mode.toString(8)} should have been refused`,
    );
  }
});

test('mode 0600 is accepted', () => {
  const dir = dirWith(undefined, { file: JSON.stringify({ lab: 'secret' }), mode: 0o600 });
  assert.equal(resolveCredential({ credentialName: 'lab', dir, env: EMPTY_ENV }).token, 'secret');
});

test('the permission check reports the file and the fix but never the token', () => {
  const dir = dirWith(undefined, { file: JSON.stringify({ lab: 'super-secret-value' }), mode: 0o644 });
  const err = (() => {
    try { resolveCredential({ credentialName: 'lab', dir, env: EMPTY_ENV }); return null; }
    catch (e) { return e as Error; }
  })();
  assert.ok(err, 'expected a refusal');
  assert.ok(!err!.message.includes('super-secret-value'), 'the message leaked the token');
  assert.match(err!.message, /chmod 600/);
});

test('a missing credential name is an actionable error', () => {
  const dir = dirWith();
  assert.throws(
    () => resolveCredential({ dir, env: EMPTY_ENV }),
    /no credential configured.*MERCURY_CLIENT_TOKEN/s,
  );
});

test('a named credential absent from the file says which one and where', () => {
  const dir = dirWith(undefined, { file: JSON.stringify({ other: 'x' }) });
  assert.throws(() => resolveCredential({ credentialName: 'lab', dir, env: EMPTY_ENV }), /"lab"/);
});

test('assertCredentialFileSafe skips the check on win32 rather than faking it', () => {
  // Mode bits are not meaningful there. A check that always passes would advertise protection that
  // does not exist, which is worse than an honest no-op.
  const dir = dirWith(undefined, { file: JSON.stringify({ lab: 'x' }), mode: 0o666 });
  assert.doesNotThrow(() => assertCredentialFileSafe(join(dir, 'credentials.json'), 'win32'));
});

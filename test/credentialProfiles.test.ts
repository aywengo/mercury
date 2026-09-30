// Credential profiles CP-2 (issue #784, docs/credential-profiles-design.md §5.1, §5.2, §9, §10):
// the profile FILE only - schema, loader, permission and overlap checks, offline validate. Nothing
// reads profiles for Run behaviour yet (CP-3/CP-4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertProfilesFileSafe,
  credentialProfilesPath,
  loadCredentialProfiles,
  normalizeRepositoryId,
  validateCredentialProfiles,
} from '../src/host/credentials-profiles.ts';
import { tempDir } from './helpers.ts';

function envWith(dir: string): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: join(dir, 'cfg') } as NodeJS.ProcessEnv;
}

function writeProfiles(dir: string, profiles: unknown, mode = 0o600): NodeJS.ProcessEnv {
  const cfg = join(dir, 'cfg', 'mercury');
  mkdirSync(cfg, { recursive: true });
  const path = join(cfg, 'credential-profiles.json');
  writeFileSync(path, JSON.stringify(profiles));
  chmodSync(path, mode);
  return envWith(dir);
}

const VALID = {
  profiles: [
    {
      name: 'nightly',
      repositories: ['https://GitHub.com/Aywengo/Mercury.git', 'git@github.com:aywengo/other.git'],
      owners: ['bot-nightly', 'aywengo'],
      env: { GH_TOKEN: { file: '/tmp/does-not-need-to-exist-for-load.pat' } },
      git: { httpsToken: 'GH_TOKEN', authorName: 'mercury-nightly', authorEmail: 'n@example.com' },
      sandbox: false,
    },
  ],
};

test('absent file means no profiles, not an error (#9)', () => {
  const dir = tempDir('cp2-absent-');
  const loaded = loadCredentialProfiles(envWith(dir));
  assert.deepEqual(loaded, { profiles: [] });
  const lines = validateCredentialProfiles(envWith(dir));
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.ok);
});

test('schema: valid profile loads with normalized repository ids (#784)', () => {
  const dir = tempDir('cp2-valid-');
  const { profiles } = loadCredentialProfiles(writeProfiles(dir, VALID));
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0]!.repositories, ['github.com/aywengo/mercury', 'github.com/aywengo/other']);
  assert.equal(profiles[0]!.sandbox, false);
  assert.equal(profiles[0]!.git?.httpsToken, 'GH_TOKEN');
});

test('normalization table: SSH/HTTPS/.git/case equal; subpaths and bad shapes refused (§5.2)', () => {
  assert.equal(normalizeRepositoryId('https://github.com/A/B.git'), 'github.com/a/b');
  assert.equal(normalizeRepositoryId('git@github.com:a/b.git'), 'github.com/a/b');
  assert.equal(normalizeRepositoryId('github.com/a/b'), 'github.com/a/b');
  assert.equal(normalizeRepositoryId('https://github.com/a/b/'), 'github.com/a/b');
  assert.equal(normalizeRepositoryId('github.com/aywengo/*'), 'github.com/aywengo/*');
  // A bare two-segment id is malformed, NOT a wildcard: accepting it would silently broaden the
  // profile's scope to a whole owner (Copilot review on #799).
  assert.throws(() => normalizeRepositoryId('github.com/aywengo'), /host\/owner\/name or host\/owner\/\*/);
  // '*' is the owner-wide pattern only as the LAST segment; 'a/*/private' is a malformed subpath.
  assert.throws(() => normalizeRepositoryId('github.com/acme/*/private'), /only stands alone as the last segment/);
  assert.equal(normalizeRepositoryId('https://gitlab.com/a/b'), 'gitlab.com/a/b');
  assert.throws(() => normalizeRepositoryId('ftp://github.com/a/b'), /unsupported repository URL scheme/);
  assert.throws(() => normalizeRepositoryId('https://github.com/a/b/c'), /host\/owner\/name/);
  assert.throws(() => normalizeRepositoryId('just-a-name'), /host\/owner\/name/);
  assert.throws(() => normalizeRepositoryId(''), /empty/);
});

test('unknown fields are refused with a suggestion when close (#784)', () => {
  const dir = tempDir('cp2-unknown-');
  const bad = { profiles: [{ ...VALID.profiles[0], repo: ['github.com/a/b'] }] };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, bad)), /unknown field 'repo'.*repositories/s);
});

test('name rules: pattern and uniqueness (#784)', () => {
  const dir = tempDir('cp2-name-');
  const bad = { profiles: [{ ...VALID.profiles[0]!, name: 'Nightly' }] };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, bad)), /name must match/);
  const dup = { profiles: [VALID.profiles[0], VALID.profiles[0]] };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, dup)), /duplicate profile name/);
});

test('owners: non-empty, no wildcards (#784)', () => {
  const dir = tempDir('cp2-owners-');
  const empty = { profiles: [{ ...VALID.profiles[0]!, owners: [] }] };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, empty)), /owners must be a non-empty/);
  const wild = { profiles: [{ ...VALID.profiles[0]!, owners: ['*'] }] };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, wild)), /must not contain wildcards/);
});

test('env: MERCURY_* names refused; values are exactly file or value (#784)', () => {
  const dir = tempDir('cp2-env-');
  const reserved = { profiles: [{ ...VALID.profiles[0]!, env: { MERCURY_DB: { value: 'x' } } }] };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, reserved)), /MERCURY_/);
  const both = { profiles: [{ ...VALID.profiles[0]!, env: { TOK: { file: '/a', value: 'b' } } }] };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, both)), /exactly one of 'file' or 'value'/);
  const neither = { profiles: [{ ...VALID.profiles[0]!, env: { TOK: {} } }] };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, neither)), /exactly one of 'file' or 'value'/);
  const empty = { profiles: [{ ...VALID.profiles[0]!, env: { TOK: { value: '' } } }] };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, empty)), /non-empty string/);
});

test('git.httpsToken must name an env entry (#784)', () => {
  const dir = tempDir('cp2-git-');
  const bad = { profiles: [{ ...VALID.profiles[0]!, env: {}, git: { httpsToken: 'GH_TOKEN' } }] };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, bad)), /does not name an entry/);
});

test('overlapping repository patterns across profiles are refused at load (§9)', () => {
  const dir = tempDir('cp2-overlap-');
  const exact = {
    profiles: [
      { name: 'a', repositories: ['github.com/aywengo/*'], owners: ['x'], env: {} },
      { name: 'b', repositories: ['github.com/aywengo/mercury'], owners: ['x'], env: {} },
    ],
  };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, exact)), /overlapping patterns are refused/);
  const twin = {
    profiles: [
      { name: 'a', repositories: ['github.com/aywengo/mercury'], owners: ['x'], env: {} },
      { name: 'b', repositories: ['https://github.com/Aywengo/Mercury.git'], owners: ['x'], env: {} },
    ],
  };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, twin)), /claimed by both/);
});

test('a file wider than 0600 is refused, same shape as bot-credentials.json (#784)', () => {
  const dir = tempDir('cp2-mode-');
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, VALID, 0o644)), /readable by group or others/);
  assert.throws(() => assertProfilesFileSafe(credentialProfilesPath(envWith(dir))), /chmod 600/);
});

test('malformed JSON is refused without echoing file contents (never-print-values)', () => {
  const dir = tempDir('cp2-json-');
  const cfg = join(dir, 'cfg', 'mercury');
  mkdirSync(cfg, { recursive: true });
  const path = join(cfg, 'credential-profiles.json');
  writeFileSync(path, '{"profiles": [{"name": "a", "token: ghp_ABCDEF0123456789}]}'); // unquoted value inside
  chmodSync(path, 0o600);
  try {
    loadCredentialProfiles(envWith(dir));
    assert.fail('expected a refusal');
  } catch (err) {
    const message = (err as Error).message;
    assert.match(message, /malformed JSON/);
    assert.ok(!message.includes('ghp_ABCDEF'), 'the parse error must not carry file excerpts');
  }
});

test('unknown keys inside git are refused (#784 review)', () => {
  const dir = tempDir('cp2-gitkeys-');
  const bad = { profiles: [{ ...VALID.profiles[0]!, git: { authorEamil: 'typo@example.com' } }] };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, bad)), /unknown field 'git\.authorEamil'/);
});

test('validate: a directory or unreadable file source is not ok (review finding)', () => {
  const dir = tempDir('cp2-src-');
  const cfg = join(dir, 'cfg', 'mercury');
  const secretDir = join(dir, 'secrets');
  mkdirSync(cfg, { recursive: true });
  mkdirSync(secretDir, { recursive: true }); // a DIRECTORY where a file should be
  const path = join(cfg, 'credential-profiles.json');
  writeFileSync(path, JSON.stringify({
    profiles: [{ name: 'n', repositories: ['github.com/a/b'], owners: ['o'], env: { T: { file: secretDir } } }],
  }));
  chmodSync(path, 0o600);
  const lines = validateCredentialProfiles(envWith(dir));
  const line = lines.find((l) => l.message.includes('env \'T\''));
  assert.equal(line?.ok, false);
  assert.match(line!.message, /not a regular file/);
});

test('validate prints profile names, patterns and file-source presence - never values (#784)', () => {
  const dir = tempDir('cp2-validate-');
  const cfg = join(dir, 'cfg', 'mercury');
  mkdirSync(cfg, { recursive: true });
  const path = join(cfg, 'credential-profiles.json');
  writeFileSync(path, JSON.stringify({
    profiles: [
      { name: 'nightly', repositories: ['github.com/aywengo/mercury'], owners: ['bot-nightly'],
        env: { GH_TOKEN: { file: join(dir, 'secret.pat') }, INLINE: { value: 'super-secret-value' } } },
    ],
  }));
  chmodSync(path, 0o600);
  const lines = validateCredentialProfiles(envWith(dir));
  const text = lines.map((l) => l.message).join('\n');
  assert.match(text, /profile 'nightly': repositories 'github\.com\/aywengo\/mercury'/);
  assert.match(text, /env 'GH_TOKEN' source MISSING/);
  assert.ok(!text.includes('super-secret-value'), 'values must never be printed');
  assert.ok(!text.includes('INLINE'), 'value-form env entries are not even named');
  const missing = lines.find((l) => l.message.includes('GH_TOKEN'));
  assert.equal(missing?.ok, false, 'a missing file source is reported not-ok');
});
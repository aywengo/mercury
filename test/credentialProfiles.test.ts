// Credential profiles CP-2 (issue #784, docs/credential-profiles-design.md §5.1, §5.2, §9, §10):
// the profile FILE - schema, loader, permission and overlap checks, offline validate - and CP-3
// (issue #807, §5.3/§5.4): per-Run resolution, creation-time refusal, claim/retry parity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertProfilesFileSafe,
  credentialProfilesPath,
  loadCredentialProfiles,
  normalizeRepositoryId,
  resolveProfile,
  validateCredentialProfiles,
} from '../src/host/credentials-profiles.ts';
import { ForbiddenError } from '../src/domain/errors.ts';
import { makeEnv, makeGitRepo, tempDir, tempFile, waitFor } from './helpers.ts';
import { createRedactor } from '../src/domain/redact.ts';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  assert.throws(() => normalizeRepositoryId('github.com/acme/*/private'), /repositories entry must be/);
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

test('env dictionary has no inherited keys: toString cannot satisfy httpsToken (review round 3)', () => {
  const dir = tempDir('cp2-proto-');
  const bad = { profiles: [{ name: 'n', repositories: ['github.com/a/b'], owners: ['o'],
    env: {}, git: { httpsToken: 'toString' } }] };
  assert.throws(() => loadCredentialProfiles(writeProfiles(dir, bad)), /does not name an entry/);
});

test('__proto__ in the file is an ordinary env key, not prototype mutation (review round 3)', () => {
  const dir = tempDir('cp2-dunder-');
  const before = ({} as Record<string, unknown>).__proto__;
  const raw = '{"profiles":[{"name":"n","repositories":["github.com/a/b"],"owners":["o"],"env":{"__proto__":{"value":"x"}},"git":{"httpsToken":"__proto__"}}]}';
  const cfg = join(dir, 'cfg', 'mercury');
  mkdirSync(cfg, { recursive: true });
  const path = join(cfg, 'credential-profiles.json');
  writeFileSync(path, raw);
  chmodSync(path, 0o600);
  const { profiles } = loadCredentialProfiles(envWith(dir));
  assert.equal(profiles[0]!.env['__proto__']?.value, 'x');
  assert.equal(({} as Record<string, unknown>).__proto__, before, 'Object.prototype untouched');
});

test('git.httpsToken error never echoes the supplied value (schema failures respect never-print)', () => {
  const dir = tempDir('cp2-tokenleak-');
  const bad = { profiles: [{ name: 'n', repositories: ['github.com/a/b'], owners: ['o'],
    env: {}, git: { httpsToken: 'ghp_ABCDEF0123456789abcdef' } }] };
  try {
    loadCredentialProfiles(writeProfiles(dir, bad));
    assert.fail('expected a refusal');
  } catch (err) {
    const message = (err as Error).message;
    assert.match(message, /does not name an entry/);
    assert.ok(!message.includes('ghp_ABCDEF'), 'the supplied value must not appear in the error');
  }
});

test('a credential-bearing repository URL is never echoed in normalization errors (review round 4)', () => {
  const dir = tempDir('cp2-credurl-');
  const secret = 'ghp_SUPERSECRET0123456789';
  const bad = { profiles: [{ name: 'n', repositories: [`https://user:${secret}@github.com/a/b/c/d`], owners: ['o'], env: {} }] };
  try {
    loadCredentialProfiles(writeProfiles(dir, bad));
    assert.fail('expected a refusal');
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes(secret), 'the token must not appear in the error');
    assert.match(message, /repositories entry must be/, 'shape errors name the expectation, not the input');
  }
  // The unsupported-scheme error still quotes the input - userinfo redacted in place:
  try {
    normalizeRepositoryId(`ftp://user:${secret}@example.org/a/b`);
    assert.fail('expected a refusal');
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes(secret), 'the token must not appear in the scheme error');
    assert.match(message, /\[REDACTED\]/, 'userinfo is redacted in place');
  }
  // Username-only credential (no colon) is redacted too (round 5):
  try {
    normalizeRepositoryId(`ftp://${secret}@example.org/a/b`);
    assert.fail('expected a refusal');
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes(secret), 'a bare-token username must not appear');
    assert.match(message, /\[REDACTED\]/);
  }
  // Even the 'does not look like' path redacts:
  try {
    normalizeRepositoryId(`git@github.com:a/${secret}/x`);
    assert.fail('expected a refusal');
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes(secret), 'SSH-form secrets are redacted too');
  }
});
// #841 review round 4: SCP has no port; HTTPS :443 is the default port.
test('SCP numeric owner is an owner, not a port; HTTPS :443 normalizes like the portless URL; both owner outcomes (#841 r4)', () => {
  // SCP: '22' is the repository owner.
  assert.equal(normalizeRepositoryId('git@github.com:22/repo.git'), 'github.com/22/repo');
  assert.equal(normalizeRepositoryId('git@github.com:1234/tools'), 'github.com/1234/tools');
  // SSH URI keeps the round-3 behaviour: default port stripped, non-default refused.
  assert.equal(normalizeRepositoryId('ssh://git@github.com:22/aywengo/mercury.git'), 'github.com/aywengo/mercury');
  assert.throws(() => normalizeRepositoryId('ssh://git@github.com:2222/aywengo/mercury.git'));
  // HTTPS: :443 is the same endpoint; another port is not silently rewritten.
  assert.equal(normalizeRepositoryId('https://github.com:443/aywengo/mercury.git'), 'github.com/aywengo/mercury');
  assert.throws(() => normalizeRepositoryId('https://github.com:8443/aywengo/mercury.git'));

  const numeric = [{
    name: 'numeric', repositories: ['github.com/22/repo'], owners: ['bot-a'],
    env: { GH_TOKEN: { value: 'x' } }, sandbox: false,
  }];
  assert.deepEqual(resolveProfile(numeric, 'bot-a', [{ url: 'git@github.com:22/repo.git' }]), { outcome: 'profile', name: 'numeric' });
  assert.equal(resolveProfile(numeric, 'mallory', [{ url: 'git@github.com:22/repo.git' }]).outcome, 'refused',
    'a disallowed owner is refused, not resolved to none');

  const https = [{
    name: 'nightly', repositories: ['github.com/aywengo/mercury'], owners: ['bot-nightly'],
    env: { GH_TOKEN: { file: '/run/secrets/nightly.pat' } }, sandbox: false,
  }];
  assert.deepEqual(resolveProfile(https, 'bot-nightly', [{ url: 'https://github.com:443/aywengo/mercury.git' }]), { outcome: 'profile', name: 'nightly' });
  assert.equal(resolveProfile(https, 'mallory', [{ url: 'https://github.com:443/aywengo/mercury.git' }]).outcome, 'refused',
    'the :443 spelling cannot bypass the owner restriction');
});

// ---------------------------------------------------------------------------
// CP-3 (issue #807): resolveProfile — the pure §5.3 table
// ---------------------------------------------------------------------------

// Copilot review round 3 on #841: an explicit DEFAULT SSH port must not change the id.
test('ssh:// with explicit default port :22 normalizes like the portless form, both owner outcomes (review round 3 on #841)', () => {
  // Normalization parity.
  assert.equal(normalizeRepositoryId('ssh://git@github.com:22/aywengo/mercury.git'), 'github.com/aywengo/mercury');
  // SCP has no port field (#841 review round 4): ':22/' there is an OWNER segment, so this is
  // a malformed three-segment path, never the portless id.
  assert.throws(() => normalizeRepositoryId('git@github.com:22/aywengo/mercury.git'));
  // A NON-default port is a different endpoint: it must not silently rewrite to the portless id.
  assert.throws(() => normalizeRepositoryId('ssh://git@github.com:2222/aywengo/mercury.git'));

  const profiles = [{
    name: 'nightly', repositories: ['github.com/aywengo/mercury'], owners: ['bot-nightly'],
    env: { GH_TOKEN: { file: '/run/secrets/nightly.pat' } }, sandbox: false,
  }];
  const allowed = resolveProfile(profiles, 'bot-nightly', [{ url: 'ssh://git@github.com:22/aywengo/mercury.git' }]);
  assert.deepEqual(allowed, { outcome: 'profile', name: 'nightly' });
  const denied = resolveProfile(profiles, 'mallory', [{ url: 'ssh://git@github.com:22/aywengo/mercury.git' }]);
  assert.equal(denied.outcome, 'refused');
  if (denied.outcome === 'refused') assert.equal(denied.reason, 'owner-not-allowed');
});

test('wildcard owner patterns match exact repository ids, both owner outcomes (review round 1 on #841)', () => {
  const wildcard = [P('nightly', ['github.com/aywengo/*'], ['bot-nightly'])];
  // Allowed owner: the wildcard profile resolves, exactly like an exact claim would.
  assert.deepEqual(resolveProfile(wildcard, 'bot-nightly', [U('https://GitHub.com/Aywengo/Mercury.git')]),
    { outcome: 'profile', name: 'nightly' });
  // Same wildcard, a DIFFERENT repository under the same owner: still claimed.
  assert.deepEqual(resolveProfile(wildcard, 'bot-nightly', [U('git@github.com:aywengo/other.git')]),
    { outcome: 'profile', name: 'nightly' });
  // Disallowed owner: the wildcard's owner restriction is NOT bypassed by the wildcard.
  const denied = resolveProfile(wildcard, 'mallory', [U('github.com/aywengo/mercury')]);
  assert.equal(denied.outcome, 'refused');
  assert.equal((denied as { reason: string }).reason, 'owner-not-allowed');
  assert.deepEqual((denied as { profiles: string[] }).profiles, ['nightly']);
  // A repository under a DIFFERENT owner does not match the wildcard.
  assert.deepEqual(resolveProfile(wildcard, 'bot-nightly', [U('github.com/other/repo')]), { outcome: 'none' });
  // The wildcard id itself (a Run url of 'host/owner/*') is a pattern shape that normalizes
  // deterministically, so exact equality against the profile's own entry matches — the same
  // answer on both parity sides.
  assert.deepEqual(resolveProfile(wildcard, 'mallory', [U('github.com/aywengo/*')]),
    { outcome: 'refused', reason: 'owner-not-allowed', profiles: ['nightly'], message: (resolveProfile(wildcard, 'mallory', [U('github.com/aywengo/*')]) as { message: string }).message });
});

test('standard SSH URI form (ssh://git@host/path) normalizes like the SCP form (review round 1 on #841)', () => {
  assert.equal(normalizeRepositoryId('ssh://git@github.com/aywengo/mercury.git'), 'github.com/aywengo/mercury');
  assert.equal(normalizeRepositoryId('ssh://git@GitHub.com/Aywengo/Mercury/'), 'github.com/aywengo/mercury');
  // Resolution over the URI form finds the same profile the SCP form finds.
  assert.deepEqual(resolveProfile(TWO, 'bot-nightly', [U('ssh://git@github.com/aywengo/mercury.git')]),
    { outcome: 'profile', name: 'nightly' });
  // A user:password SSH URI still refuses (credential rejection preserved) and never echoes it.
  const secret = 'ghp_SUPERSECRET0123456789';
  try {
    normalizeRepositoryId(`ssh://user:${secret}@github.com/a/b`);
    assert.fail('expected a refusal');
  } catch (err) {
    assert.ok(!(err as Error).message.includes(secret));
  }
});

test('an unnormalizable repository url has no id: skipped identically on both sides (review round 1 on #841)', () => {
  // A redacted or malformed url used to throw; it must resolve to none so creation and the
  // claim-time re-read (which resolve the SAME stored bytes) can never disagree about it.
  assert.deepEqual(resolveProfile(TWO, 'bot-nightly', [U('https://github.com/aywengo/[REDACTED].git')]),
    { outcome: 'none' });
  assert.deepEqual(resolveProfile(TWO, 'bot-nightly', [U('ftp://github.com/a/b')]), { outcome: 'none' });
});

const P = (name: string, repositories: string[], owners: string[]) =>
  ({ name, repositories, owners, env: {}, sandbox: false });
const U = (url: string) => ({ url });
const TWO = [P('nightly', ['github.com/aywengo/mercury'], ['bot-nightly', 'Aywengo']), P('docs', ['github.com/aywengo/docs'], ['aywengo'])];

test('resolution table: all four §5.3 outcomes, SSH/HTTPS/.git/case variants, mixed repositories (§5.3)', () => {
  // Case 1: no id matches any profile -> none. Also: an EMPTY profile list (no file) is none
  // without ever normalizing a repository — a host without profiles must not start refusing
  // repository shapes it accepted before CP-3.
  assert.deepEqual(resolveProfile([], 'alice', [U('not a repository shape')]), { outcome: 'none' });
  assert.deepEqual(resolveProfile(TWO, 'alice', [U('github.com/other/repo')]), { outcome: 'none' });
  // No id at all (localPath-only or empty contexts) matches nothing (§5.3: localPath has no id).
  assert.deepEqual(resolveProfile(TWO, 'alice', [{ localPath: '/srv/repo' }, {}]), { outcome: 'none' });

  // Case 2: every matched id matches exactly one profile and the owner is in its owners;
  // unmatched ids alongside are allowed (a public dependency checkout).
  assert.deepEqual(resolveProfile(TWO, 'bot-nightly', [U('https://GitHub.com/Aywengo/Mercury.git')]),
    { outcome: 'profile', name: 'nightly' });
  // SSH form, .git suffix and case fold to the same id (§5.2):
  assert.deepEqual(resolveProfile(TWO, 'bot-nightly', [U('git@github.com:aywengo/mercury.git')]),
    { outcome: 'profile', name: 'nightly' });
  // Unmatched id alongside a matched one is fine:
  assert.deepEqual(
    resolveProfile(TWO, 'bot-nightly', [U('github.com/aywengo/mercury'), U('github.com/public/dep')]),
    { outcome: 'profile', name: 'nightly' },
  );
  // localPath alongside a matched one is fine too:
  assert.deepEqual(
    resolveProfile(TWO, 'bot-nightly', [{ localPath: '/srv/dep' }, U('github.com/aywengo/mercury')]),
    { outcome: 'profile', name: 'nightly' },
  );
  // Owner match is case-insensitive (GitHub logins are); the profile's owner list is stored as written.
  assert.deepEqual(resolveProfile(TWO, 'BOT-NIGHTLY', [U('github.com/aywengo/mercury')]),
    { outcome: 'profile', name: 'nightly' });

  // Case 3: the ids match two different profiles -> refused, multiple-profiles.
  const multi = resolveProfile(TWO, 'aywengo', [U('github.com/aywengo/mercury'), U('github.com/aywengo/docs')]);
  assert.equal(multi.outcome, 'refused');
  assert.equal((multi as { reason: string }).reason, 'multiple-profiles');
  assert.deepEqual((multi as { profiles: string[] }).profiles.sort(), ['docs', 'nightly']);

  // Case 4: an id matches a profile whose owners lack the Run's owner -> refused, owner-not-allowed.
  const denied = resolveProfile(TWO, 'mallory', [U('github.com/aywengo/docs')]);
  assert.equal(denied.outcome, 'refused');
  assert.equal((denied as { reason: string }).reason, 'owner-not-allowed');
  assert.deepEqual((denied as { profiles: string[] }).profiles, ['docs']);
  assert.match((denied as { message: string }).message, /credential profile 'docs' does not allow owner 'mallory'/);
});

test('resolution errors never quote a credential-bearing repository URL (never-print-values, §5.1)', () => {
  const secret = 'ghp_SUPERSECRET0123456789';
  const profiles = [P('n', ['github.com/a/b'], ['o'])];
  // A MATCHED id carries no authority component by construction (normalizeRepositoryId output),
  // so a refusal message built from it cannot leak a URL credential. Cover it end to end:
  const denied = resolveProfile(profiles, 'other', [U('github.com/a/b')]);
  assert.equal(denied.outcome, 'refused');
  assert.ok(!JSON.stringify(denied).includes(secret));
  // A URL whose userinfo carries a credential cannot normalize to an id at all: resolveProfile
  // throws (a Run that cannot state its repository id is never resolved by guessing), and the
  // thrown error redacts the userinfo in place.
  try {
    resolveProfile(profiles, 'other', [U(`https://user:${secret}@github.com/a/b`)] as never);
    assert.fail('expected a throw');
  } catch (err) {
    // Shape errors deliberately never quote the input at all (the operator has the file); the
    // requirement here is only that the secret cannot appear.
    assert.ok(!(err as Error).message.includes(secret), 'userinfo must not reach the error');
  }
});

// ---------------------------------------------------------------------------
// CP-3: creation-time resolution through RunService
// ---------------------------------------------------------------------------

/** A loaded profile set that ignores the filesystem entirely (injected, per-decision reads). */
function profilesDeps(profiles: unknown[]): { credentialProfiles: () => { profiles: unknown[] } } {
  return { credentialProfiles: () => ({ profiles }) as never };
}

const CP = { profiles: [{
  name: 'nightly',
  repositories: ['github.com/aywengo/mercury'],
  owners: ['bot-nightly'],
  env: { GH_TOKEN: { file: '/run/secrets/nightly.pat' } },
}] };

test('creation: a disallowed owner is refused BEFORE anything is stored (§5.4)', () => {
  const env = makeEnv({ workerEnabled: false, ...profilesDeps(CP.profiles) } as never);
  try {
    assert.throws(
      () => env.runService.create({
        ownerId: 'mallory',
        task: 'x',
        agent: 'fake',
        repository: { url: 'https://github.com/aywengo/mercury.git' },
      }),
      (err: unknown) => err instanceof ForbiddenError
        && /credential profile 'nightly' does not allow owner 'mallory'/.test(err.message)
        && !/GH_TOKEN|secrets|\.pat/.test(err.message),
    );
    const rows = (env.db.prepare('SELECT id FROM runs').all() as { id: string }[]);
    assert.equal(rows.length, 0, 'a refused Run must leave no row');
  } finally {
    env.close();
  }
});

test('creation: two profiles matched -> refused (multiple-profiles), one Run one identity', () => {
  const both = { profiles: [
    ...CP.profiles,
    { name: 'mirror', repositories: ['github.com/aywengo/docs'], owners: ['bot-nightly'], env: {} },
  ] };
  const env = makeEnv({ workerEnabled: false, ...profilesDeps(both.profiles) } as never);
  try {
    assert.throws(
      () => env.runService.create({
        ownerId: 'bot-nightly',
        task: 'x',
        repository: { url: 'github.com/aywengo/mercury' },
        repositories: [{ url: 'github.com/aywengo/docs' }],
      }),
      (err: unknown) => err instanceof ForbiddenError && /two different credential profiles/.test(err.message),
    );
  } finally {
    env.close();
  }
});

test('creation: a matched Run stores the profile name; no-profile Runs stay byte-identical (acceptance 3)', () => {
  const env = makeEnv({ workerEnabled: false, ...profilesDeps(CP.profiles) } as never);
  try {
    const run = env.runService.create({
      ownerId: 'bot-nightly',
      task: 'x',
      agent: 'fake',
      repository: { url: 'https://github.com/aywengo/mercury.git' },
    });
    assert.equal(run.credentialProfile, 'nightly');
    const row = env.db.prepare('SELECT credential_profile FROM runs WHERE id = ?').get(run.id) as { credential_profile: string | null };
    assert.equal(row.credential_profile, 'nightly');
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('run.credential_profile_resolved'), 'the resolved identity is an event');
    const payload = (env.events.list(run.id).find((e) => e.type === 'run.credential_profile_resolved')!.payload) as { profile?: string };
    assert.equal(payload.profile, 'nightly');

    // An allowed owner whose repositories match NOTHING resolves to no profile: null, no event.
    const plain = env.runService.create({ ownerId: 'bot-nightly', task: 'y', agent: 'fake', repository: { localPath: '/tmp/whatever' } });
    assert.equal(plain.credentialProfile, null);
    const plainTypes = env.events.list(plain.id).map((e) => e.type);
    assert.ok(!plainTypes.includes('run.credential_profile_resolved'), 'the no-profile case emits no event');
    const plainRow = env.db.prepare('SELECT credential_profile FROM runs WHERE id = ?').get(plain.id) as { credential_profile: string | null };
    assert.equal(plainRow.credential_profile, null);
  } finally {
    env.close();
  }
});

test('no profiles wired (deps absent): every Run resolves to null and nothing normalizes', () => {
  // makeEnv without credentialProfiles: the pre-CP-3 shape. A repository URL that
  // resolveProfile would throw on must sail through — profiles are not wired, so nothing
  // normalizes: behavior before CP-3 is unchanged (acceptance 3).
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', repository: { url: 'https://github.com/aywengo/mercury' } });
    assert.equal(run.credentialProfile, null);
  } finally {
    env.close();
  }
});

test('creation: an invalid profile file fails creation with a clear error, never "no profile" (§9, acceptance 6)', () => {
  const dir = tempDir('cp3-badfile-');
  const env = makeEnv({
    workerEnabled: false,
    // The real loader over a file that exists but is group-readable.
    credentialProfiles: () => loadCredentialProfiles({ XDG_CONFIG_HOME: join(dir, 'cfg') } as never),
  } as never);
  try {
    const cfg = join(dir, 'cfg', 'mercury');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'credential-profiles.json'), JSON.stringify(CP));
    chmodSync(join(cfg, 'credential-profiles.json'), 0o644);
    assert.throws(
      () => env.runService.create({ ownerId: 'bot-nightly', task: 'x', repository: { url: 'github.com/aywengo/mercury' } }),
      /readable by group or others/,
    );
  } finally {
    env.close();
  }
});

test('a resolved Run stores no profile contents: the row and events carry the name only (§5.4)', () => {
  const env = makeEnv({ workerEnabled: false, ...profilesDeps(CP.profiles) } as never);
  try {
    const run = env.runService.create({
      ownerId: 'bot-nightly', task: 'x', agent: 'fake',
      repository: { url: 'github.com/aywengo/mercury' },
    });
    const rowJson = JSON.stringify(env.db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id));
    assert.ok(!rowJson.includes('GH_TOKEN'), 'the env NAME never reaches the row either');
    assert.ok(!rowJson.includes('.pat'), 'no file path from the profile');
    for (const e of env.events.list(run.id)) {
      const text = JSON.stringify(e.payload);
      assert.ok(!text.includes('GH_TOKEN'), `event ${e.type} carries no profile contents`);
      assert.ok(!text.includes('/run/secrets'), `event ${e.type} carries no profile file path`);
    }
  } finally {
    env.close();
  }
});

// ---------------------------------------------------------------------------
// CP-3: claim-time parity (§5.4, acceptance 4) and retry parity (acceptance 5)
// ---------------------------------------------------------------------------

test('claim-time parity: editing the file between creation and claim fails the Run (acceptance 4)', async () => {
  // The real loader against a real file the test rewrites between create() and claim.
  const dir = tempDir('cp3-parity-');
  const cfg = join(dir, 'cfg', 'mercury');
  mkdirSync(cfg, { recursive: true });
  const filePath = join(cfg, 'credential-profiles.json');
  const write = (owners: string[]): void => {
    writeFileSync(filePath, JSON.stringify({ profiles: [{ ...CP.profiles[0], owners }] }));
    chmodSync(filePath, 0o600);
  };
  write(['bot-nightly']);
  const env = makeEnv({
    credentialProfiles: () => loadCredentialProfiles({ XDG_CONFIG_HOME: join(dir, 'cfg') } as never),
  } as never);
  try {
    const run = env.runService.create({
      ownerId: 'bot-nightly', task: 'x', agent: 'fake',
      repository: { url: 'https://github.com/aywengo/mercury.git' },
    });
    assert.equal(run.credentialProfile, 'nightly');
    // The operator drops the owner from the profile before the claim.
    write(['someone-else']);
    env.worker.start();
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 10_000);
    const row = env.runs.get(run.id)!;
    assert.equal(row.status, 'FAILED');
    assert.match(row.error ?? '', /credential profile changed since creation/);
    assert.equal(row.errorKind, 'infrastructure');
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('run.credential_profile_changed'), 'the parity refusal is an event');
    assert.ok(!types.includes('run.started'), 'the Run never starts under the changed identity');
    const failed = env.events.list(run.id).find((e) => e.type === 'run.failed');
    assert.equal((failed!.payload as { kind?: string }).kind, 'infrastructure');
  } finally {
    env.worker.stop();
    env.close();
  }
});

test('retry: a profile that drops the owner refuses the retry, clears the intent and records why (issue #987)', () => {
  // The refusal #807 adds to create() is a DECIDED outcome, not an unexpected failure: without it
  // in the refused set, a retry the operator will never be allowed to make stays recorded and
  // recovery re-attempts it on every sweep while the chain keeps reporting itself as pending.
  const profiles: { name: string; repositories: string[]; owners: string[]; env: Record<string, unknown> }[] = [
    { ...CP.profiles[0]!, owners: ['bot-nightly'] },
  ];
  const env = makeEnv({ workerEnabled: false, credentialProfiles: () => ({ profiles }) as never } as never);
  try {
    const run = env.runService.create({
      ownerId: 'bot-nightly', task: 'x', agent: 'fake',
      repository: { url: 'https://github.com/aywengo/mercury.git' },
    });
    assert.equal(run.credentialProfile, 'nightly');
    env.runs.transition(run.id, 'STARTING');
    const dueAt = new Date(Date.now() + 30_000).toISOString();
    env.runs.transition(run.id, 'FAILED', { completedAt: new Date().toISOString(), retryDueAt: dueAt });

    // The operator drops the owner between the failure and the retry.
    profiles[0]!.owners = ['someone-else'];
    assert.throws(
      () => env.runService.retry(run.id, 'bot-nightly', true, { auto: true }),
      (err: unknown) => err instanceof ForbiddenError && /does not allow owner/.test(err.message),
    );

    assert.equal(env.runs.get(run.id)!.retryDueAt, null, 'a decided refusal must end the chain');
    const refused = env.events.list(run.id).filter((e) => e.type === 'run.retry_refused');
    assert.equal(refused.length, 1);
    assert.match(String((refused[0]!.payload as { reason: string }).reason), /does not allow owner/);
    assert.equal(
      env.runService.list({ ownerId: 'bot-nightly', isAdmin: true, limit: 20 }).runs.some((r) => r.retryOf === run.id),
      false,
      'the refused retry must create nothing',
    );
  } finally {
    env.close();
  }
});

test('claim-time parity: an unreadable file persists only the generic reason, detail stays in the log (review round 1 on #841)', async () => {
  const dir = tempDir('cp3-parity-unreadable-');
  const cfg = join(dir, 'cfg', 'mercury');
  mkdirSync(cfg, { recursive: true });
  const filePath = join(cfg, 'credential-profiles.json');
  writeFileSync(filePath, JSON.stringify(CP));
  chmodSync(filePath, 0o600);
  const logs: string[] = [];
  const env = makeEnv({
    credentialProfiles: () => loadCredentialProfiles({ XDG_CONFIG_HOME: join(dir, 'cfg') } as never),
    logCapture: (_l: string, _m: string, f: Record<string, unknown>) => logs.push(JSON.stringify(f)),
  } as never);
  try {
    const run = env.runService.create({
      ownerId: 'bot-nightly', task: 'x', agent: 'fake',
      repository: { url: 'https://github.com/aywengo/mercury.git' },
    });
    assert.equal(run.credentialProfile, 'nightly');
    // The file becomes world-readable before the claim: the loader refusal names the absolute
    // path, which must reach the SERVER log but never run.error or the events.
    chmodSync(filePath, 0o644);
    env.worker.start();
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 10_000);
    const row = env.runs.get(run.id)!;
    assert.equal(row.status, 'FAILED');
    assert.match(row.error ?? '', /credential profile changed since creation/);
    assert.ok(!row.error!.includes(dir), 'the absolute file path must not reach run.error');
    const errEvents = env.events.list(run.id).filter((e) => e.type === 'error');
    for (const e of errEvents) assert.ok(!JSON.stringify(e.payload).includes(dir));
    assert.ok(logs.some((l) => l.includes(dir)), 'the detailed diagnostic stays in the server log');
  } finally {
    env.worker.stop();
    env.close();
  }
});

test('claim-time parity is silent when the file did not change (the mutation check, acceptance 4)', async () => {
  const dir = tempDir('cp3-parity-ok-');
  const cfg = join(dir, 'cfg', 'mercury');
  const repo = makeGitRepo(join(dir, 'repo')); // the workspace needs a real local git repo
  mkdirSync(cfg, { recursive: true });
  // CP-4: the profile's file: source is READ at drive time, so this Run-complete path needs a
  // source that exists. The shared CP fixture's `/run/secrets/...` path stays for the tests that
  // only LOAD the file; this test points its own profile at a real one.
  const tokenFile = join(dir, 'nightly.pat');
  writeFileSync(tokenFile, 'ghp_parityok0123456789abcdefgh');
  writeFileSync(join(cfg, 'credential-profiles.json'), JSON.stringify({
    profiles: [{ ...CP.profiles[0], env: { GH_TOKEN: { file: tokenFile } } }],
  }));
  chmodSync(join(cfg, 'credential-profiles.json'), 0o600);
  const env = makeEnv({
    credentialProfiles: () => loadCredentialProfiles({ XDG_CONFIG_HOME: join(dir, 'cfg') } as never),
  } as never);
  try {
    const run = env.runService.create({
      ownerId: 'bot-nightly', task: 'x', agent: 'fake',
      // localPath (the real local git repo) drives the workspace — no network; url is the
      // identity that resolution reads and normalizes to the profile's repository id. A
      // macOS temp path cannot itself be a repository id (host regex allows no '_'), which is
      // exactly why the identity rides on url and the checkout source on localPath.
      repository: { url: 'https://github.com/aywengo/mercury.git', localPath: repo },
    });
    env.worker.start();
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('run.started'), 'an unchanged file must not block the claim');
    assert.ok(!types.includes('run.credential_profile_changed'));
  } finally {
    env.worker.stop();
    env.close();
  }
});

test('retry parity: a changed profile refuses the retry (acceptance 5)', async () => {
  const dir = tempDir('cp3-retry-');
  const repo = makeGitRepo(join(dir, 'repo')); // the workspace needs a real local git repo
  const env = makeEnv({ workerEnabled: false, ...profilesDeps([CP.profiles[0]]) } as never);
  try {
    const original = env.runService.create({
      ownerId: 'bot-nightly', task: 'x', agent: 'fake',
      // Same split as the parity-ok test: localPath drives the workspace, url is the identity.
      repository: { url: 'https://github.com/aywengo/mercury.git', localPath: repo },
      constraints: { maxDurationMs: 60_000, maxRetries: 2 },
    });
    // Cancel the QUEUED Run so retry() is reachable (a terminal state), with the profile
    // still intact — the parity refusal below is caused ONLY by the re-bound profile.
    env.runService.cancel(original.id, 'bot-nightly', true);
    // The profile's owners no longer include the Run's owner.
    const rebound = { profiles: [{ ...CP.profiles[0], owners: ['someone-else'] }] };
    (env.runService as unknown as { deps: { credentialProfiles: () => unknown } }).deps.credentialProfiles = () => rebound;
    // The retry re-resolves inside create() against the owner-not-allowed refusal — a refusal
    // is also a parity refusal: the retry is never created and the parent's identity is never
    // silently replaced.
    assert.throws(
      () => env.runService.retry(original.id, 'bot-nightly', true),
      (err: unknown) => err instanceof ForbiddenError
        && /does not allow owner 'bot-nightly'/.test(err.message),
    );
    // And when the profile releases the repository entirely (re-bound away), the fresh
    // resolution is "none" while the parent was created under 'nightly' — the §5.4 reason.
    const released = { profiles: [] };
    (env.runService as unknown as { deps: { credentialProfiles: () => unknown } }).deps.credentialProfiles = () => released;
    assert.throws(
      () => env.runService.retry(original.id, 'bot-nightly', true),
      (err: unknown) => err instanceof Error && /credential profile changed since creation/.test(err.message),
    );
  } finally {
    env.close();
  }
});

test('retry parity has no window between the parity read and the persisted value (review round 1 on #841)', async () => {
  // A loader that returns profile 'a' on the parity read and 'b' on create()'s read used to
  // slip through a guard-then-create pair: the guard compared against 'a' and create() stored
  // 'b' (or none). The expectation now rides INTO create(), which compares against the SAME
  // read it persists from — the divergent loader refuses the retry outright.
  const dir = tempDir('cp3-retry-race-');
  const repo = makeGitRepo(join(dir, 'repo'));
  const A = [P('a', ['github.com/aywengo/mercury'], ['bot-nightly'])];
  const B = [P('b', ['github.com/aywengo/mercury'], ['bot-nightly'])];
  let call = 0;
  const env = makeEnv({
    workerEnabled: false,
    credentialProfiles: () => (call++ === 0 ? { profiles: A } : { profiles: B }) as never,
  } as never);
  try {
    const original = env.runService.create({
      ownerId: 'bot-nightly', task: 'x', agent: 'fake',
      repository: { url: 'https://github.com/aywengo/mercury.git', localPath: repo },
      constraints: { maxDurationMs: 60_000, maxRetries: 2 },
    });
    assert.equal(original.credentialProfile, 'a');
    env.runService.cancel(original.id, 'bot-nightly', true);
    call = 1; // the retry's parity read inside create() sees 'b', not 'a'
    assert.throws(
      () => env.runService.retry(original.id, 'bot-nightly', true),
      (err: unknown) => err instanceof Error && /credential profile changed since creation/.test(err.message),
    );
    // Nothing was created: no retry Run row exists beyond the original.
    const rows = env.db.prepare('SELECT id FROM runs').all() as { id: string }[];
    assert.equal(rows.length, 1, 'a divergent read must not persist a Run under a changed identity');
  } finally {
    env.close();
  }
});

test('a redaction that mangles the repository url resolves identically at creation and claim (review round 1 on #841)', async () => {
  // With a redactor that rewrites part of the URL, creation must resolve the REDACTED bytes it
  // stores (not the raw caller bytes): otherwise the stored row and the claim-time re-read
  // disagree and an unchanged file looks like a parity violation. The mangled url has no id on
  // either side, so the Run consistently carries no profile.
  const dir = tempDir('cp3-redactor-');
  const repo = makeGitRepo(join(dir, 'repo'));
  const env = makeEnv({
    workerEnabled: false,
    ...profilesDeps([CP.profiles[0]]),
    redactor: createRedactor(['mercury']), // 'mercury' is a secret word on this host
  } as never);
  try {
    const run = env.runService.create({
      ownerId: 'bot-nightly', task: 'x', agent: 'fake',
      repository: { url: 'https://github.com/aywengo/mercury.git', localPath: repo },
    });
    const stored = env.runs.get(run.id)!;
    assert.ok((stored.repository.url ?? '').includes('[REDACTED]'), 'the stored url is the redacted one');
    assert.equal(stored.credentialProfile, null, 'the mangled id matches nothing, consistently');
    // The claim-time re-read over the SAME stored bytes agrees — no parity refusal.
    const parity = (env.worker as unknown as {
      checkCredentialProfileParity(run: unknown): { ok: boolean };
    }).checkCredentialProfileParity(stored);
    assert.equal(parity.ok, true);
  } finally {
    env.close();
  }
});

// ---------------------------------------------------------------------------
// CP-3: the `host credentials resolve` surface (§10)
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function cli(args: string[], envExtra: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...envExtra },
    });
    let stdout = ''; let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('error', rej);
    child.on('close', (code) => { clearTimeout(killer); res({ code, stdout, stderr }); });
  });
}

test('host credentials resolve prints the profile name or the refusal reason, never values (§10)', async () => {
  const dir = tempDir('cp3-resolve-');
  const cfg = join(dir, 'cfg', 'mercury');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'credential-profiles.json'), JSON.stringify({
    profiles: [{
      name: 'nightly', repositories: ['github.com/aywengo/mercury'], owners: ['bot-nightly'],
      env: { GH_TOKEN: { file: '/run/secrets/nightly.pat' }, INLINE: { value: 'super-secret-value' } },
    }],
  }));
  chmodSync(join(cfg, 'credential-profiles.json'), 0o600);
  const envVar = { XDG_CONFIG_HOME: join(dir, 'cfg') };

  const hit = await cli(['host', 'credentials', 'resolve', '--owner', 'bot-nightly', '--repo', 'https://github.com/aywengo/mercury.git'], envVar);
  assert.equal(hit.code, 0);
  assert.equal(hit.stdout, 'profile nightly\n');

  const none = await cli(['host', 'credentials', 'resolve', '--owner', 'bot-nightly', '--repo', 'github.com/other/repo'], envVar);
  assert.equal(none.code, 0);
  assert.equal(none.stdout, 'none\n');

  const denied = await cli(['host', 'credentials', 'resolve', '--owner', 'mallory', '--repo', 'github.com/aywengo/mercury'], envVar);
  assert.equal(denied.code, 1);
  assert.match(denied.stdout, /refused: credential profile 'nightly' does not allow owner 'mallory'/);
  assert.ok(!denied.stdout.includes('super-secret-value'), 'values never reach the surface');
  assert.ok(!denied.stdout.includes('GH_TOKEN') && !denied.stdout.includes('.pat'), 'env names and file paths stay off the surface');

  const usage = await cli(['host', 'credentials', 'resolve', '--owner', 'x'], envVar);
  assert.equal(usage.code, 2, 'a missing --repo is a usage error');
  assert.ok(usage.stderr.includes('usage:'), 'usage goes to stderr, stdout stays parseable');
});


// Copilot review round 2 on #841: CLI diagnostics must never echo credential-bearing input.
// A token in the userinfo of a --repo/--repos value must not appear on stdout or stderr through
// the normalization-failure diagnostic or the unknown-argument echo.
test('host credentials resolve diagnostics never echo credentials embedded in arguments', async () => {
  const token = 'ghp_subprocess-secret-token-1234';
  const url = `https://user:${token}@github.com/a/b`;
  const envVar = { XDG_CONFIG_HOME: '/nonexistent-mercury-cp3' };

  // The normalization failure diagnostic.
  const bad = await cli(['host', 'credentials', 'resolve', '--owner', 'o', '--repo', url], envVar);
  assert.equal(bad.code, 1);
  assert.ok(!bad.stdout.includes(token), 'normalization failure must not leak the token on stdout');
  assert.ok(!bad.stderr.includes(token), 'normalization failure must not leak the token on stderr');
  assert.ok(bad.stderr.includes('[REDACTED]'), 'the redacted form identifies the bad value');

  // The unknown-argument diagnostic: a --repos typo (plural) is echoed verbatim.
  const typo = await cli(['host', 'credentials', 'resolve', '--owner', 'o', `--repos=${url}`], envVar);
  assert.equal(typo.code, 2);
  assert.ok(!typo.stdout.includes(token), 'unknown-argument echo must not leak the token on stdout');
  assert.ok(!typo.stderr.includes(token), 'unknown-argument echo must not leak the token on stderr');
  assert.ok(typo.stderr.includes('[REDACTED]'), 'the redacted form identifies the bad flag');
});


test('host credentials resolve: a broken file is a refusal, never "none" (§9)', async () => {
  const dir = tempDir('cp3-resolve-bad-');
  const cfg = join(dir, 'cfg', 'mercury');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'credential-profiles.json'), '{"profiles": [ broken');
  chmodSync(join(cfg, 'credential-profiles.json'), 0o600);
  const r = await cli(['host', 'credentials', 'resolve', '--owner', 'o', '--repo', 'github.com/a/b'], { XDG_CONFIG_HOME: join(dir, 'cfg') });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /refused: .*malformed JSON/);
});



// ---------------------------------------------------------------------------
// CP-4 (issue #897, design sections 6.1, 6.2, 8, 9): the local Run environment
// ---------------------------------------------------------------------------


/** A minimal valid LocalAgentConfig for validator tests (CP-4 acceptance 5). */
function jsonlConfigLite(): import('../src/adapters/localAgentAdapter.ts').LocalAgentConfig {
  return {
    id: 'lite',
    description: 'minimal',
    command: '/bin/true',
    taskInput: { mode: 'arg', flag: '--task' },
    output: { format: 'jsonl', stream: true, eventPath: 'type' },
    eventMap: { started: 'step.started' },
    cancel: { signal: 'SIGTERM', graceMs: 200 },
  };
}

const MOCK_RPC = join(import.meta.dirname, 'fixtures', 'mock-prime-agent-rpc.mjs');


import { buildRunEnvironment, CredentialSourceMissingError, NO_SSH_COMMAND, renderGitconfig } from '../src/worker/runEnvironment.ts';
import { isStrippedEnvName, STRIPPED_ENV_PREFIXES } from '../src/config.ts';
import { validateLocalAgentConfig } from '../src/adapters/localAgentAdapter.ts';
import { validateRpcAgentConfig } from '../src/adapters/rpcAgentAdapter.ts';
import { execFileSync } from 'node:child_process';

const PROFILE_WITH_GIT = {
  profiles: [{
    name: 'nightly',
    repositories: ['github.com/aywengo/mercury'],
    owners: ['bot-nightly'],
    env: { GH_TOKEN: { value: 'ghp_cP4testtokenvalue0123456789' } },
    git: { httpsToken: 'GH_TOKEN', authorName: 'mercury-nightly', authorEmail: 'nightly@example.com' },
    sandbox: false,
  }],
};

test('isStrippedEnvName covers the four layer-1 prefixes and nothing else', () => {
  for (const name of ['GH_TOKEN', 'GITHUB_ACTIONS', 'GIT_CONFIG_GLOBAL', 'MERCURY_RUN_ID']) {
    assert.ok(isStrippedEnvName(name), name);
  }
  for (const name of ['PATH', 'HOME', 'SHELL', 'LANG', 'GITHUBISH', 'VIRTUAL GH'.replace(' ', '')]) {
    assert.equal(isStrippedEnvName(name), false, name);
  }
  assert.deepEqual([...STRIPPED_ENV_PREFIXES], ['GH_', 'GITHUB_', 'GIT_', 'MERCURY_']);
});

test('buildRunEnvironment: four layers — strip, isolation, profile env, GIT_AUTHOR/COMMITTER (§6.1, §6.2)', () => {
  const dir = tempDir('cp4-env-');
  const profile = PROFILE_WITH_GIT.profiles[0];
  const built = buildRunEnvironment({
    workerEnv: {
      PATH: '/usr/bin:/bin', HOME: '/home/op', LANG: 'en_US.UTF-8',
      GH_TOKEN: 'worker-secret', GITHUB_TOKEN: 'worker-secret', GIT_AUTHOR_NAME: 'worker', MERCURY_SECRETS: 'x',
    } as never,
    runDir: dir,
    profile,
  });
  // Layer 1: worker env minus stripped names; ordinary names pass through.
  assert.equal(built.env.PATH, '/usr/bin:/bin');
  assert.equal(built.env.HOME, '/home/op');
  assert.equal(built.env.LANG, 'en_US.UTF-8');
  // (GH_TOKEN is then set again by layer 3; assert the strip via a name the profile does NOT set.)
  assert.equal(built.env.GITHUB_TOKEN, undefined);
  assert.equal(built.env.MERCURY_SECRETS, undefined);
  assert.equal(built.env.GH_WORKER_ONLY, undefined);
  // Layer 2: host-config isolation into the run dir.
  assert.equal(built.env.GIT_CONFIG_GLOBAL, join(dir, 'gitconfig'));
  assert.equal(built.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(built.env.GH_CONFIG_DIR, join(dir, 'gh'));
  assert.ok(existsSync(built.env.GIT_CONFIG_GLOBAL), 'the gitconfig file must exist');
  // Layer 3: exactly the profile's variables.
  assert.equal(built.env.GH_TOKEN, 'ghp_cP4testtokenvalue0123456789');
  // Section 6.2: author/committer variables for tools that bypass config.
  assert.equal(built.env.GIT_AUTHOR_NAME, 'mercury-nightly');
  assert.equal(built.env.GIT_AUTHOR_EMAIL, 'nightly@example.com');
  assert.equal(built.env.GIT_COMMITTER_NAME, 'mercury-nightly');
  assert.equal(built.env.GIT_COMMITTER_EMAIL, 'nightly@example.com');
  // The generated gitconfig carries the identity and the helper; the token appears only by NAME.
  const gitconfig = readFileSync(built.gitconfigPath!, 'utf8');
  assert.match(gitconfig, /name = "mercury-nightly"/);
  assert.match(gitconfig, /email = "nightly@example.com"/);
  assert.match(gitconfig, /credential "https:\/\/github\.com"/);
  assert.match(gitconfig, /\$GH_TOKEN/);
  assert.ok(!gitconfig.includes('ghp_'), 'the token value must never appear in the gitconfig');
  // Section 8: the injected values join the exact-value redaction set.
  const redactor = createRedactor([]);
  redactor.register?.(built.secrets);
  assert.equal(redactor.redact('token ghp_cP4testtokenvalue0123456789 leaked'), 'token [REDACTED] leaked');
});

test('acceptance 2: a no-profile Run cannot reach the host gitconfig credential helper', () => {
  const dir = tempDir('cp4-noprofile-');
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'git'), { recursive: true });
  // A host gitconfig whose credential helper would answer with a sentinel.
  // The sentinel helper: a shell function git execs. Quotes must survive JSON-free YAML-free
  // gitconfig parsing: git passes the value to 'sh -c' after stripping ONE level of double quotes.
  const helperScript = join(home, 'helper.sh');
  writeFileSync(helperScript, '#!/bin/sh\ncat ' + JSON.stringify(join(dir, 'sentinel.out')) + '\n');
  chmodSync(helperScript, 0o755);
  writeFileSync(join(dir, 'sentinel.out'), 'username=sentinel-user\npassword=SENTINEL-SECRET\n');
  writeFileSync(join(home, '.gitconfig'), [
    '[credential]',
    `    helper = ${helperScript}`,
  ].join('\n'));
  const built = buildRunEnvironment({ workerEnv: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } as never, runDir: dir, profile: null });
  // The empty gitconfig must EXIST: GIT_CONFIG_GLOBAL at an absent path is ignored by git.
  assert.equal(readFileSync(built.gitconfigPath!, 'utf8'), '');
  // A credential fill through the Run's environment gets nothing from the host helper. With no
  // helper configured, `git credential fill` echoes the query with EMPTY username and password
  // (measured on git 2.49 locally and on the CI runner); a non-empty answer would mean the host
  // gitconfig leaked in. With nothing to answer and GIT_TERMINAL_PROMPT=0 the fill may also FAIL
  // ("could not read Username") — an askpass helper does not exist on every runner (/bin/true is
  // absent on some macOS/runner combos), and a failed fill is just as isolated. Either way the
  // sentinel must never appear.
  let out = '';
  let failed = false;
  try {
    out = execFileSync('git', ['credential', 'fill'], {
      env: { ...built.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' },
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    });
  } catch (err) {
    failed = true;
    out = String((err as { stdout?: string }).stdout ?? '');
  }
  assert.ok(failed || out.trim() !== '', 'an empty answer from nothing at all is not expected here');
  assert.ok(!out.includes('SENTINEL-SECRET'), `the host helper must not answer (got: ${out.slice(0, 200)})`);
  assert.ok(!out.includes('sentinel-user'), 'the host helper username must not answer');
  if (!failed) {
    const got = Object.fromEntries(out.trim().split('\n').map((l) => l.split('=') as [string, string]));
    assert.equal(got.username ?? '', '', `no username may come back (got: ${out.slice(0, 120)})`);
    assert.equal(got.password ?? '', '', `no password may come back (got: ${out.slice(0, 120)})`);
  }
  // The host user still gets the sentinel from their own environment (the control half).
  const hostOut = execFileSync('git', ['credential', 'fill'], {
    env: { HOME: home, PATH: built.env.PATH ?? '', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' },
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  assert.ok(hostOut.includes('SENTINEL-SECRET'), 'control: the host env still reaches the helper');
});

test('acceptance 3: a commit in a profile Run carries the profile author and committer', () => {
  const dir = tempDir('cp4-commit-');
  const repo = makeGitRepo(join(dir, 'repo'));
  const profile = PROFILE_WITH_GIT.profiles[0];
  const built = buildRunEnvironment({ workerEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir } as never, runDir: dir, profile });
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'cp4'], { env: { ...built.env } });
  const author = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%an <%ae>'], { encoding: 'utf8' }).trim();
  const committer = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%cn <%ce>'], { encoding: 'utf8' }).trim();
  assert.equal(author, 'mercury-nightly <nightly@example.com>');
  assert.equal(committer, 'mercury-nightly <nightly@example.com>');
});

test('the generated gitconfig helper answers x-access-token + token from the env var (§6.2)', () => {
  const dir = tempDir('cp4-helper-');
  const profile = PROFILE_WITH_GIT.profiles[0];
  const built = buildRunEnvironment({ workerEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' } as never, runDir: dir, profile });
  const out = execFileSync('git', ['credential', 'fill'], {
    env: { ...built.env },
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  assert.match(out, /username=x-access-token/);
  assert.match(out, /password=ghp_cP4testtokenvalue0123456789/);
});

test('acceptance 4: a file: secret missing or empty at drive time fails with the §9 message', () => {
  const dir = tempDir('cp4-missing-');
  const profile = {
    name: 'nightly',
    repositories: ['github.com/aywengo/mercury'],
    owners: ['bot-nightly'],
    env: { GH_TOKEN: { file: join(dir, 'absent.pat') } },
    sandbox: false,
  };
  assert.throws(
    () => buildRunEnvironment({ workerEnv: {}, runDir: dir, profile }),
    (err: unknown) => err instanceof CredentialSourceMissingError
      && err.message === "credential profile 'nightly': env GH_TOKEN source missing",
  );
  // An EMPTY file is the same refusal.
  const emptyFile = join(dir, 'empty.pat');
  writeFileSync(emptyFile, '\n');
  assert.throws(
    () => buildRunEnvironment({
      workerEnv: {}, runDir: dir,
      profile: { ...profile, env: { GH_TOKEN: { file: emptyFile } } },
    }),
    (err: unknown) => err instanceof CredentialSourceMissingError,
  );
  // A file with only a trailing newline after real content is fine (file hygiene, not content).
  const tokenFile = join(dir, 'real.pat');
  writeFileSync(tokenFile, 'ghp_realvalue0123456789abcdefgh\n');
  const built = buildRunEnvironment({
    workerEnv: {}, runDir: dir,
    profile: { ...profile, env: { GH_TOKEN: { file: tokenFile } } },
  });
  assert.equal(built.env.GH_TOKEN, 'ghp_realvalue0123456789abcdefgh');
});

test('acceptance 5: adapter config.env naming a stripped variable is refused at load', () => {
  const base = jsonlConfigLite();
  assert.throws(
    () => validateLocalAgentConfig({ ...base, env: { GH_TOKEN: 'x' } } as never),
    /env 'GH_TOKEN' is reserved/,
  );
  assert.throws(
    () => validateLocalAgentConfig({ ...base, env: { MERCURY_DB_PATH: 'x' } } as never),
    /env 'MERCURY_DB_PATH' is reserved/,
  );
  // A non-stripped env name still loads.
  validateLocalAgentConfig({ ...base, env: { AGENT_EXTRA: 'x' } } as never);
});

test('acceptance 5 (rpc): RpcAgentConfig env naming a stripped variable is refused at load', () => {
  assert.throws(
    () => validateRpcAgentConfig({ id: 'rpc1', command: 'x', env: { GITHUB_TOKEN: 'x' } } as never),
    /env 'GITHUB_TOKEN' is reserved/,
  );
});

test('worker: a profile Run drives the agent on the layered environment (acceptance 1, probe)', async () => {
  const dir = tempDir('cp4-probe-');
  const cfg = join(dir, 'cfg', 'mercury');
  mkdirSync(cfg, { recursive: true });
  const tokenFile = join(dir, 'nightly.pat');
  writeFileSync(tokenFile, 'ghp_probevalue0123456789abcdefgh');
  writeFileSync(join(cfg, 'credential-profiles.json'), JSON.stringify({
    profiles: [{
      name: 'nightly',
      repositories: ['github.com/aywengo/mercury'],
      owners: ['bot-nightly'],
      env: { GH_TOKEN: { file: tokenFile } },
      git: { httpsToken: 'GH_TOKEN', authorName: 'mercury-nightly', authorEmail: 'nightly@example.com' },
      sandbox: false,
    }],
  }));
  chmodSync(join(cfg, 'credential-profiles.json'), 0o600);
  const repo = makeGitRepo(join(dir, 'repo'));
  const envFile = tempFile('cp4-probe-env', 'json');
  process.env.MOCK_RPC_MODE = 'happy';
  process.env.MOCK_RPC_ENV_FILE = envFile;
  process.env.MOCK_RPC_ENV_ALL = '1';
  process.env.GH_TOKEN = 'worker-ambient-token-should-not-pass';
  const loader = () => loadCredentialProfiles({ XDG_CONFIG_HOME: join(dir, 'cfg') } as never);
  const env = makeEnv({
    workspaceMode: 'copy',
    repoDir: repo,
    primeagent: { cmd: MOCK_RPC },
    credentialProfiles: loader,
  } as never);
  try {
    const run = env.runService.create({
      ownerId: 'bot-nightly', task: 'x', agent: 'primeagent',
      repository: { url: 'https://github.com/aywengo/mercury.git', localPath: repo },
    });
    assert.equal(run.credentialProfile, 'nightly');
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);
    const spawnedEnv = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>;
    // No GH_/GITHUB_/GIT_/MERCURY_ name from the worker survives — the mutation check: with the
    // old `{ ...process.env }` spawn base, the ambient GH_TOKEN appears here and fails this test.
    for (const [k, v] of Object.entries(spawnedEnv)) {
      if (['MERCURY_RUN_ID', 'MERCURY_TRACE_ID', 'MERCURY_WORKER_ID'].includes(k)) continue; // adapter trace context
      if (['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GH_CONFIG_DIR', 'GIT_SSH_COMMAND'].includes(k)) continue; // layer 2 isolation (§6.1)
      if (k === 'GH_TOKEN') continue; // layer 3: the profile's own variable, asserted below
      if (k.startsWith('GIT_AUTHOR_') || k.startsWith('GIT_COMMITTER_')) continue; // layer 3 identity (§6.2)
      assert.ok(!isStrippedEnvName(k), `${k} must be stripped from the spawned environment`);
      assert.ok(!String(v).includes('worker-ambient-token'), `${k} must not carry the worker ambient token`);
    }
    assert.ok(!('GH_TOKEN' in spawnedEnv) || spawnedEnv.GH_TOKEN !== 'worker-ambient-token-should-not-pass');
    // Exactly the profile's variables: the injected token is present with the file's value.
    assert.equal(spawnedEnv.GH_TOKEN, 'ghp_probevalue0123456789abcdefgh');
    assert.equal(spawnedEnv.GIT_AUTHOR_NAME, 'mercury-nightly');
    assert.equal(spawnedEnv.GIT_COMMITTER_EMAIL, 'nightly@example.com');
    // Isolation layer landed in the run dir.
    // Isolation layer lives OUTSIDE the workspace and is removed when the Run ends (#977 review).
    const ws = env.runs.get(run.id)!.workspacePath!;
    assert.ok(spawnedEnv.GIT_CONFIG_GLOBAL, 'GIT_CONFIG_GLOBAL is set');
    assert.ok(!spawnedEnv.GIT_CONFIG_GLOBAL.startsWith(ws), 'the generated gitconfig is not inside the workspace');
    assert.ok(!spawnedEnv.GH_CONFIG_DIR.startsWith(ws), 'GH_CONFIG_DIR is not inside the workspace');
    assert.ok(!existsSync(join(ws, 'gitconfig')) && !existsSync(join(ws, 'gh')), 'nothing generated lands in the worktree');
    // Removal happens in the worker's finally, just after the COMPLETED transition: wait for it.
    await waitFor(() => !existsSync(spawnedEnv.GIT_CONFIG_GLOBAL), 5_000);
    assert.equal(spawnedEnv.GIT_SSH_COMMAND, NO_SSH_COMMAND);
    assert.equal(spawnedEnv.GIT_CONFIG_NOSYSTEM, '1');
    assert.ok(spawnedEnv.GH_CONFIG_DIR && spawnedEnv.GH_CONFIG_DIR.includes('gh'));
    // Ordinary environment still flows.
    assert.ok(spawnedEnv.PATH, 'PATH passes through');
    // The environment-built event names the profile, never a value.
    const envEvent = env.events.list(run.id).find((e) => e.type === 'run.credential_profile_env_built');
    assert.ok(envEvent, 'the env build is an event');
    assert.equal((envEvent!.payload as { profile?: string }).profile, 'nightly');
    assert.ok(!JSON.stringify(envEvent!.payload).includes('ghp_'), 'no token value in the event');
  } finally {
    env.close();
    delete process.env.MOCK_RPC_MODE;
    delete process.env.MOCK_RPC_ENV_FILE;
    delete process.env.MOCK_RPC_ENV_ALL;
    delete process.env.GH_TOKEN;
  }
});

test('worker: a no-profile Run is isolated too (empty gitconfig, no host gitconfig leak)', async () => {
  const dir = tempDir('cp4-run-noprofile-');
  const repo = makeGitRepo(join(dir, 'repo'));
  const envFile = tempFile('cp4-noprofile-env', 'json');
  process.env.MOCK_RPC_MODE = 'happy';
  process.env.MOCK_RPC_ENV_FILE = envFile;
  process.env.MOCK_RPC_ENV_ALL = '1';
  process.env.GH_TOKEN = 'worker-ambient-token-should-not-pass-2';
  const env = makeEnv({
    workspaceMode: 'copy',
    repoDir: repo,
    primeagent: { cmd: MOCK_RPC },
  } as never);
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'primeagent', repository: { localPath: repo, baseBranch: 'main' },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000);
    const spawnedEnv = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>;
    for (const [k, v] of Object.entries(spawnedEnv)) {
      if (['MERCURY_RUN_ID', 'MERCURY_TRACE_ID', 'MERCURY_WORKER_ID'].includes(k)) continue;
      if (['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GH_CONFIG_DIR', 'GIT_SSH_COMMAND'].includes(k)) continue; // layer 2
      assert.ok(!isStrippedEnvName(k), `${k} must be stripped even without profiles`);
      assert.ok(!String(v).includes('worker-ambient-token'), `${k} must not carry the worker ambient token`);
    }
    // Isolation layer lives OUTSIDE the workspace and is removed when the Run ends (#977 review).
    const ws = env.runs.get(run.id)!.workspacePath!;
    assert.ok(spawnedEnv.GIT_CONFIG_GLOBAL, 'GIT_CONFIG_GLOBAL is set');
    assert.ok(!spawnedEnv.GIT_CONFIG_GLOBAL.startsWith(ws), 'the generated gitconfig is not inside the workspace');
    assert.ok(!spawnedEnv.GH_CONFIG_DIR.startsWith(ws), 'GH_CONFIG_DIR is not inside the workspace');
    assert.ok(!existsSync(join(ws, 'gitconfig')) && !existsSync(join(ws, 'gh')), 'nothing generated lands in the worktree');
    // Removal happens in the worker's finally, just after the COMPLETED transition: wait for it.
    await waitFor(() => !existsSync(spawnedEnv.GIT_CONFIG_GLOBAL), 5_000);
    assert.equal(spawnedEnv.GIT_SSH_COMMAND, NO_SSH_COMMAND);
  } finally {
    env.close();
    delete process.env.MOCK_RPC_MODE;
    delete process.env.MOCK_RPC_ENV_FILE;
    delete process.env.MOCK_RPC_ENV_ALL;
    delete process.env.GH_TOKEN;
  }
});

test('worker: a file: source missing at drive time fails the Run with the §9 message (acceptance 4, wired)', async () => {
  const dir = tempDir('cp4-run-missing-');
  const cfg = join(dir, 'cfg', 'mercury');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'credential-profiles.json'), JSON.stringify({
    profiles: [{
      name: 'nightly',
      repositories: ['github.com/aywengo/mercury'],
      owners: ['bot-nightly'],
      env: { GH_TOKEN: { file: join(dir, 'absent.pat') } },
    }],
  }));
  chmodSync(join(cfg, 'credential-profiles.json'), 0o600);
  const repo = makeGitRepo(join(dir, 'repo'));
  const env = makeEnv({
    workspaceMode: 'copy',
    repoDir: repo,
    credentialProfiles: () => loadCredentialProfiles({ XDG_CONFIG_HOME: join(dir, 'cfg') } as never),
  } as never);
  try {
    const run = env.runService.create({
      ownerId: 'bot-nightly', task: 'x', agent: 'fake',
      repository: { url: 'https://github.com/aywengo/mercury.git', localPath: repo },
    });
    env.worker.start();
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 10_000);
    const row = env.runs.get(run.id)!;
    assert.equal(row.status, 'FAILED');
    assert.match(row.error ?? '', /credential profile 'nightly': env GH_TOKEN source missing/);
  } finally {
    env.worker.stop();
    env.close();
  }
});

test('CP-4 review (#977): no Run gets the host ssh agent or keys; values are quoted; names and author fields are validated', () => {
  const dir = tempDir('cp4-r1-');
  // ssh: stripped agent socket, a no-identity GIT_SSH_COMMAND, for no-profile and profile Runs alike.
  const none = buildRunEnvironment({ workerEnv: { PATH: '/usr/bin:/bin', SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_SSH_COMMAND: 'ssh -i ~/.ssh/host' } as never, runDir: dir, profile: null });
  assert.equal(none.env.SSH_AUTH_SOCK, undefined, 'the agent socket is stripped');
  assert.equal(none.env.GIT_SSH_COMMAND, NO_SSH_COMMAND);
  assert.match(NO_SSH_COMMAND, /IdentityAgent=none/);
  assert.match(NO_SSH_COMMAND, /-F \/dev\/null/);

  // gitconfig values are quoted and escaped; a quote or backslash cannot break out.
  const text = renderGitconfig({
    name: 'p', repositories: ['github.com/o/r'], owners: [], env: {}, sandbox: false,
    git: { authorName: 'Roman "R" \\ Melnyk', authorEmail: 'r@example.com' },
  } as never);
  assert.match(text, /\tname = "Roman \\"R\\" \\\\ Melnyk"/);
  assert.match(text, /\temail = "r@example\.com"/);

  // load-time validation
  const cfg = join(dir, 'cfg', 'mercury');
  mkdirSync(cfg, { recursive: true });
  const write = (profile: object) => {
    writeFileSync(join(cfg, 'credential-profiles.json'), JSON.stringify({ profiles: [profile] }));
    chmodSync(join(cfg, 'credential-profiles.json'), 0o600);
  };
  const base = { name: 'p', repositories: ['github.com/o/r'], owners: ['a'], sandbox: false };
  write({ ...base, env: { 'X"; curl evil | sh; "': { value: 'v' } } });
  assert.throws(() => loadCredentialProfiles({ XDG_CONFIG_HOME: join(dir, 'cfg') } as never), /must match \[A-Za-z_\]/);
  write({ ...base, env: { GH_TOKEN: { value: 'v' } }, git: { authorName: 'evil\n[credential]\n\thelper = !sh' } });
  assert.throws(() => loadCredentialProfiles({ XDG_CONFIG_HOME: join(dir, 'cfg') } as never), /authorName must not contain control characters/);
  write({ ...base, env: { GH_TOKEN: { value: 'v' } }, git: { authorEmail: 'a@b.c\r\n' } });
  assert.throws(() => loadCredentialProfiles({ XDG_CONFIG_HOME: join(dir, 'cfg') } as never), /authorEmail must not contain control characters/);
});

test('CP-4 review (#977): only secret profile values are redacted, once; config values like GH_HOST are not', () => {
  const dir = tempDir('cp4-redact-');
  const tokenFile = join(dir, 'pat');
  writeFileSync(tokenFile, 'ghp_secretvalue0123456789abcdef');
  const profile = {
    name: 'p', repositories: ['github.com/o/r'], owners: ['a'], sandbox: false,
    env: { GH_TOKEN: { file: tokenFile }, GH_HOST: { value: 'github.com' }, NPM_TOKEN: { value: 'npm_literal_secret_123' } },
    git: { httpsToken: 'GH_TOKEN' },
  } as never;
  const built = buildRunEnvironment({ workerEnv: { PATH: '/usr/bin:/bin' } as never, runDir: dir, profile });
  assert.ok(built.secrets.includes('ghp_secretvalue0123456789abcdef'), 'file: sources are secrets');
  assert.ok(built.secrets.includes('npm_literal_secret_123'), 'a value: whose name says TOKEN is a secret');
  assert.ok(!built.secrets.includes('github.com'), 'GH_HOST is configuration, never a redaction pattern');

  // The shared redactor: a repository URL survives a profiled Run, and re-registering adds nothing.
  const r = createRedactor([]);
  r.register!(built.secrets);
  assert.equal(r.redact('https://github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.ok(!r.redact('token ghp_secretvalue0123456789abcdef').includes('ghp_secretvalue'));
  const before = r.redact('x');
  for (let i = 0; i < 50; i++) r.register!(built.secrets); // a long-lived worker, 50 Runs
  assert.equal(r.redact('x'), before);
});

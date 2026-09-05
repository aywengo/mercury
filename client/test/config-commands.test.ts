// `config profiles` / `config current` (§9, §16 Milestone 4).
//
// No server is started anywhere in this file. That is the point: these commands must answer on a
// machine with no reachable Mercury, which is when an operator reaches for them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin.ts', import.meta.url));
const SECRET = 'SECRET-TOKEN-DO-NOT-PRINT';

/** A config directory laid out the way configDir() expects, with a credentials file holding a secret. */
function makeConfig(profiles: Record<string, unknown>, current = 'prod'): string {
  const root = mkdtempSync(join(tmpdir(), 'mercuryctl-config-'));
  const dir = join(root, 'mercury');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ currentProfile: current, profiles }));
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ 'prod-token': SECRET, 'dev-token': SECRET }));
  chmodSync(join(dir, 'credentials.json'), 0o600);
  return root;
}

function cli(xdgRoot: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', BIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    // No MERCURY_CLIENT_URL or TOKEN by default: a config command that needed either would fail here
    // rather than quietly inheriting a working environment.
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgRoot,
      // Cleared rather than deleted so a developer's own environment cannot make a test pass or fail.
      MERCURY_CLIENT_URL: '',
      MERCURY_CLIENT_TOKEN: '',
      ...env,
    },
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const TWO = {
  prod: { url: 'https://prod.example.com:3000', credential: 'prod-token', timeoutMs: 15000 },
  dev: { url: 'http://127.0.0.1:3000', credential: 'dev-token' },
};

test('config profiles lists every profile and marks the current one', () => {
  const root = makeConfig(TWO);
  const r = cli(root, ['config', 'profiles']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /prod/);
  assert.match(r.out, /dev/);
  assert.match(r.out, /https:\/\/prod\.example\.com:3000/);
  // Exactly one current marker.
  assert.equal((r.out.match(/^\*/gm) ?? []).length, 1, `expected one current marker:\n${r.out}`);
});

test('a broken profile is reported inline instead of failing the listing', () => {
  // One stale profile in a five-profile file is the normal state of a real configuration, and this is
  // the command used to find it. Aborting the listing would hide the four good ones.
  const root = makeConfig({ ...TWO, broken: { url: 'not a url at all' } });
  const r = cli(root, ['config', 'profiles']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /broken/);
  assert.match(r.out, /invalid endpoint URL/i);
  assert.match(r.out, /prod/, 'the good profiles disappeared behind the bad one');
});

test('config current names the layer each value came from', () => {
  const root = makeConfig(TWO);
  const r = cli(root, ['config', 'current']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /profile\s+prod\s+\(profile\)/);
  assert.match(r.out, /timeout\s+15000ms\s+\(profile\)/);
  assert.match(r.out, /\(default\)/, 'a value nobody set must be labelled default');
});

test('a flag beats the environment and the profile, and says so', () => {
  const root = makeConfig(TWO);
  const r = cli(root, ['config', 'current', '--url', 'https://flag.example.com', '--json']);
  assert.equal(r.code, 0, r.err);
  const view = JSON.parse(r.out);
  assert.equal(view.url, 'https://flag.example.com');
  assert.equal(view.sources.url, 'flag', 'the report must say the flag won');
});

test('the environment beats the profile file', () => {
  const root = makeConfig(TWO);
  const r = cli(root, ['config', 'current', '--json'], { MERCURY_CLIENT_URL: 'https://env.example.com' });
  assert.equal(r.code, 0, r.err);
  const view = JSON.parse(r.out);
  assert.equal(view.url, 'https://env.example.com');
  assert.equal(view.sources.url, 'env');
});

test('the profile file beats the built-in default', () => {
  const root = makeConfig(TWO);
  const view = JSON.parse(cli(root, ['config', 'current', '--json']).out);
  assert.equal(view.sources.profileName, 'profile', 'currentProfile should be the source, not a default');
  assert.equal(view.profileName, 'prod');
});

test('no command prints the credential value, in any mode', () => {
  const root = makeConfig(TWO);
  const cases: Array<[string[], Record<string, string>]> = [
    [['config', 'profiles'], {}],
    [['config', 'profiles', '--json'], {}],
    [['config', 'current'], {}],
    [['config', 'current', '--json'], {}],
    [['config', 'current'], { MERCURY_CLIENT_TOKEN: SECRET }],
    [['config', 'current', '--json'], { MERCURY_CLIENT_TOKEN: SECRET }],
  ];
  for (const [args, env] of cases) {
    const r = cli(root, args, env);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    assert.ok(!r.all.includes(SECRET), `${args.join(' ')} leaked the credential`);
    assert.ok(!/bearer/i.test(r.all), `${args.join(' ')} mentioned a bearer token`);
  }
});

test('the credential NAME and its origin are reported, which is what makes it usable', () => {
  // Suppressing the value is easy; suppressing it so completely that the operator cannot tell whether a
  // credential was found at all just moves the confusion somewhere worse.
  const root = makeConfig(TWO);
  const view = JSON.parse(cli(root, ['config', 'current', '--json']).out);
  assert.equal(view.credential, 'prod-token');
  assert.equal(view.credentialOrigin, 'file');
});

test('an environment credential is reported as such', () => {
  const root = makeConfig(TWO);
  const view = JSON.parse(cli(root, ['config', 'current', '--json'], { MERCURY_CLIENT_TOKEN: SECRET }).out);
  assert.equal(view.credentialOrigin, 'env');
});

test('a missing credential is reported, not fatal', () => {
  // The operator debugging a bad token is exactly the reader of this command.
  const root = makeConfig({ solo: { url: 'http://127.0.0.1:3000', credential: 'absent-name' } }, 'solo');
  const r = cli(root, ['config', 'current', '--json']);
  assert.equal(r.code, 0, r.err);
  const view = JSON.parse(r.out);
  assert.equal(view.credential, 'absent-name');
  assert.equal(view.credentialOrigin, null, 'a credential that cannot be resolved must not claim an origin');
});

test('config commands work with no config file at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'mercuryctl-nocfg-'));
  const r = cli(root, ['config', 'profiles']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /no config file/i);
});

test('config current still needs an endpoint, and says which knob to turn', () => {
  const root = mkdtempSync(join(tmpdir(), 'mercuryctl-nocfg2-'));
  const r = cli(root, ['config', 'current']);
  assert.equal(r.code, 2, 'an unresolvable endpoint is a configuration error, exit 2');
  assert.match(r.err, /--url|MERCURY_CLIENT_URL|profile/);
});

test('--json emits exactly one value for both commands', () => {
  const root = makeConfig(TWO);
  for (const args of [['config', 'profiles'], ['config', 'current']]) {
    const r = cli(root, [...args, '--json']);
    assert.equal(r.code, 0, r.err);
    const parsed = JSON.parse(r.out);   // throws on a second value or stray text
    assert.equal(typeof parsed, 'object');
  }
});

test('help no longer advertises these as unavailable', () => {
  const root = makeConfig(TWO);
  const r = cli(root, ['--help']);
  assert.equal(r.code, 0, r.err);
  assert.ok(!/\[not in this build\]/.test(r.out), `help still marks something unimplemented:\n${r.out}`);
});
test('a token pasted into the credential field cannot be printed by either config command', () => {
  // The realistic mistake: a tool that asks for the token itself, so the operator pastes one here.
  // Before this was refused, `config current` printed it -- its entire job is echoing configuration.
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const root = makeConfig({ prod: { url: 'https://prod.example.com:3000', credential: token } });
  for (const args of [['config', 'profiles'], ['config', 'current'], ['config', 'current', '--json']]) {
    const r = cli(root, args);
    assert.equal(r.code, 2, `${args.join(' ')} accepted a token as a credential name`);
    assert.ok(!r.all.includes(token), `${args.join(' ')} printed the token`);
    assert.ok(!r.all.includes(token.slice(0, 20)), `${args.join(' ')} printed part of the token`);
    assert.match(r.err, /does not look like a name/);
  }
});

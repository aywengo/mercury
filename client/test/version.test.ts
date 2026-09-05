import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_VERSION, PROGRAM, USER_AGENT } from '../version.ts';
import { EXIT } from '../exitCodes.ts';
import { helpText } from '../cli.ts';

/**
 * `--version` and the compatibility surface.
 *
 * The design (§14, §16 Milestone 4) asks for version output and a small compatibility policy, and
 * names the stable surface precisely: JSON field names and exit semantics require compatibility
 * review, while human output may change freely. These tests pin the parts that are contract, and
 * deliberately do not pin the parts that are not.
 */
const BIN = fileURLToPath(new URL('../bin.ts', import.meta.url));
const TOKEN = 'version-secret-token-DO-NOT-PRINT';
const MANIFEST = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };

/** An empty XDG root: nothing configured at all, which is exactly when --version must still work. */
function emptyConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'mercuryctl-ver-'));
  mkdirSync(join(root, 'mercury'), { recursive: true });
  return root;
}

function cliSync(xdg: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', BIN, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env, XDG_CONFIG_HOME: xdg,
      MERCURY_CLIENT_URL: '', MERCURY_CLIENT_TOKEN: '', ...extra,
    },
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('--version prints the version and does not print the help text', () => {
  // Regression: the bare-invocation help branch used to run first, so `mercuryctl --version` -- the
  // single most likely way this flag is typed -- dumped the whole help page instead. A flag that
  // needs a command after it to work is not a version flag.
  const r = cliSync(emptyConfig(), ['--version']);
  assert.equal(r.code, 0, r.all);
  assert.equal(r.out.trim(), `${PROGRAM} ${CLIENT_VERSION}`);
  assert.ok(!r.out.includes('USAGE'), '--version printed the help page');
});

test('-V is the same flag, and --version works with nothing configured at all', () => {
  // No URL, no credential, no config file. --version is what an operator reaches for on a machine
  // where setup has not happened yet, and it is what a support request asks them to paste.
  const short = cliSync(emptyConfig(), ['-V']);
  assert.equal(short.code, 0, short.all);
  assert.equal(short.out.trim(), `${PROGRAM} ${CLIENT_VERSION}`);
});

test('--version --json emits exactly one JSON value', () => {
  const r = cliSync(emptyConfig(), ['--version', '--json']);
  assert.equal(r.code, 0, r.all);
  const trimmed = r.out.trim();
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  assert.equal(parsed.name, PROGRAM);
  assert.equal(parsed.version, CLIENT_VERSION);
  assert.equal(typeof parsed.node, 'string');
  // One value, not a stream: a script must be able to pipe this to jq without choosing a line.
  assert.equal(trimmed.split('\n').length, 1, r.out);
});

test('--version never prints a configured credential', () => {
  const root = mkdtempSync(join(tmpdir(), 'mercuryctl-ver-cred-'));
  const dir = join(root, 'mercury');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    currentProfile: 'p', profiles: { p: { url: 'http://127.0.0.1:9/api', credential: 'c1' } },
  }));
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ c1: TOKEN }));
  chmodSync(join(dir, 'credentials.json'), 0o600);
  for (const args of [['--version'], ['--version', '--json'], ['--version', 'runs', 'list']]) {
    const r = cliSync(root, args);
    assert.equal(r.code, 0, r.all);
    assert.ok(!r.all.includes(TOKEN), `${args.join(' ')} leaked the token`);
  }
});

test('the version has exactly one source, so the User-Agent cannot drift from the manifest', () => {
  // The drift this replaces: package.json said 0.1.0 while USER_AGENT said 0.1, and nothing failed
  // because the two strings are never compared. A server log would record a version no artifact had.
  assert.equal(CLIENT_VERSION, MANIFEST.version, 'client version does not match package.json');
  assert.equal(USER_AGENT, `${PROGRAM}/${CLIENT_VERSION}`);
  assert.match(CLIENT_VERSION, /^\d+\.\d+\.\d+/, 'version must be semver for scripts to parse it');
  // Non-secret (§14): the identity sent on every request must not carry host or operator detail.
  assert.ok(!USER_AGENT.includes(tmpdir()), USER_AGENT);
  assert.ok(!/[A-Z0-9]{20,}/.test(USER_AGENT), `User-Agent looks like it carries a secret: ${USER_AGENT}`);
});

test('the exit-code table in --help matches the constants automation actually receives', () => {
  // Exit semantics are the compatibility surface (§10.2): scripts branch on these numbers. The help
  // text is a second copy of them, and a second copy is how a documented code ends up wrong.
  const help = helpText();
  const block = help.slice(help.indexOf('EXIT CODES'));
  const documented = new Map<string, number>();
  for (const line of block.split('\n')) {
    const m = line.match(/^\s{2}(\d+)\s\s+(.*)$/);
    if (m) documented.set(m[2].toLowerCase(), Number(m[1]));
  }
  assert.ok(documented.size >= Object.keys(EXIT).length,
    `help documents ${documented.size} codes but the CLI defines ${Object.keys(EXIT).length}`);
  const values = new Set(Object.values(EXIT) as number[]);
  // 130 is the one documented code the CLI does not return from a code path: it is 128+SIGINT, applied
  // by the shell after the process dies. Naming it here means adding another externally-sourced code
  // forces a decision instead of quietly widening a set.
  const externallySourced = new Set([130]);
  for (const [, code] of documented) {
    assert.ok(values.has(code) || externallySourced.has(code),
      `help advertises exit code ${code}, which the CLI never returns`);
  }
  for (const code of values) {
    assert.ok([...documented.values()].includes(code), `exit code ${code} is returned but undocumented`);
  }
  for (const code of externallySourced) {
    assert.ok([...documented.values()].includes(code), `exit code ${code} is documented nowhere`);
  }
});

test('--help lists --version, and SIGINT still maps to 130', () => {
  // 130 is the one code that comes from outside the EXIT table; it is in the help text and must stay.
  const help = helpText();
  assert.match(help, /--version/);
  assert.match(help, /130\s+interrupted/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Subprocess tests (docs/cli-tui-design.md §15.3).
//
// The parser is unit-testable, but the CONTRACT -- stdout vs stderr separation, exit codes, help
// working with no network -- only exists once the thing is spawned. These run the real entry point.

const BIN = join(import.meta.dirname, '..', 'bin.ts');

function run(args: string[], env: Record<string, string> = {}) {
  // --no-warnings suppresses Node's own type-stripping notice. Without it the "stderr is clean"
  // assertion below would be about Node's banner rather than about what this CLI writes, and would
  // break whenever Node changes its warning text.
  const r = spawnSync(process.execPath, ['--no-warnings', BIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('--help works with no endpoint configured and no network', () => {
  // §16 M0: help must not require a reachable server. Strip every endpoint source so a stray
  // profile on the test machine cannot make this pass for the wrong reason.
  const r = run(['--help'], { MERCURY_CLIENT_URL: '', MERCURY_CLIENT_TOKEN: '' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /USAGE/);
  assert.match(r.stdout, /EXIT CODES/);
  // Help is requested data, so it goes to stdout; stderr stays clean for pipelines.
  assert.equal(r.stderr.trim(), '', 'help must not write to stderr');
});

test('no arguments prints help rather than an error', () => {
  const r = run([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /mercuryctl/);
});

test('a command not built yet fails with exit 2 and says so on stderr', () => {
  const r = run(['runs', 'list']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not available in this build/);
  // Data goes to stdout only; a half-written stdout would corrupt `--json | jq`.
  assert.equal(r.stdout, '');
});

test('an unknown option is exit 2', () => {
  assert.equal(run(['--definitely-not-a-flag']).code, 2);
});

test('--timeout accepts s/m/ms suffixes and rejects nonsense', () => {
  // The value is consumed by the parser, so a valid one must get past parsing and reach the
  // not-built-yet branch, while an invalid one must be a usage error.
  for (const value of ['30s', '2m', '1500ms', '500']) {
    assert.equal(run(['--timeout', value, 'runs', 'list']).code, 2, value);
  }
  const bad = run(['--timeout', 'soon', 'runs', 'list']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /positive duration/);
});

test('--timeout with no value is a usage error, not a crash', () => {
  const r = run(['--timeout']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /requires a value/);
});

// ---------------------------------------------------------------------------
// Credential handling in argv (§13). These are the tests that matter most here:
// a token that reaches stderr ends up in CI logs and terminal scrollback, which
// means a revoked credential and an operator who never learns why.
// ---------------------------------------------------------------------------

const SECRET = 'tok-SUPERSECRET-must-never-appear';

for (const argv of [
  ['runs', 'list', '--token', SECRET],
  [`--token=${SECRET}`, 'runs', 'list'],
  ['runs', 'list', `--token=${SECRET}`],
  ['runs', 'list', `--api-token=${SECRET}`],
  ['runs', 'list', `--bearer=${SECRET}`],
]) {
  test(`${argv.join(' ').replace(SECRET, '<secret>')} is refused without echoing the value`, () => {
    const r = run(argv);
    assert.equal(r.code, 2);
    const combined = r.stdout + r.stderr;
    assert.ok(!combined.includes(SECRET), `the credential leaked into output: ${combined}`);
    // And the operator is told what to do instead, not just told no.
    assert.match(combined, /MERCURY_CLIENT_TOKEN|credentials file/);
  });
}

test('an arbitrary unknown command flag never echoes its value', () => {
  // Generalises the credential rule to flags this parser has never heard of: --password, --auth,
  // or anything added later that happens to carry a secret.
  const r = run(['runs', 'list', `--password=${SECRET}`]);
  assert.equal(r.code, 2);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET), 'value leaked from an unknown flag');
});

test('unknown flags BEFORE the command are rejected, after it they are the command\u0027s problem', () => {
  // The scope split has a consequence worth pinning: a flag after the command name is stored raw,
  // so the top-level parser does NOT reject a typo like `--stat` for `--status`. That is deliberate
  // -- the command owns its grammar -- but it means every command MUST validate its own flags, or a
  // mistyped option is silently ignored and the operator believes they set something. Each command
  // milestone carries that obligation; this test records where the boundary sits.
  const before = run(['--definitely-not-global', 'runs', 'list']);
  assert.equal(before.code, 2);
  assert.match(before.stderr, /unknown option/);

  const after = run(['runs', 'list', '--definitely-not-a-command-flag']);
  assert.equal(after.code, 2);
  assert.match(after.stderr, /not available in this build/);
});

// ---------------------------------------------------------------------------
// Command-scope parsing. Found in review: the first implementation folded every
// non-flag token into the command path and rejected every unrecognised flag, so
// `runs show <id>` lost the id and `runs create --task` could not be expressed
// at all. Both are structural, not cosmetic -- M1 and M2 cannot be built on top.
// ---------------------------------------------------------------------------

test('a run id after a two-word command is a positional, not part of the command', () => {
  const r = run(['runs', 'show', 'run-123']);
  // The message must name the COMMAND, not swallow the id into it.
  assert.match(r.stderr, /"runs show" is not available/);
  assert.ok(!r.stderr.includes('run-123'), 'the run id was folded into the command path');
});

test('command-specific flags reach the command instead of being rejected', () => {
  const r = run(['runs', 'create', '--task', 'fix the bug', '--repo', 'https://example/r.git']);
  assert.match(r.stderr, /"runs create" is not available/);
  assert.ok(!r.stderr.includes('unknown option'), 'command flags must not be rejected by the global parser');
});

test('global options still work before the command', () => {
  const r = run(['--json', 'runs', 'list']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /"runs list" is not available/);
});

test('global options also work after the command, the way people type them', () => {
  const r = run(['runs', 'list', '--json']);
  assert.match(r.stderr, /"runs list" is not available/);
});

test('a typo in a GLOBAL option is still caught before the command', () => {
  // The scope split must not turn pre-command typos into silently-ignored command flags.
  const r = run(['--porfile', 'lab', 'runs', 'list']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown option "--porfile"/);
});

test('a credential flag is refused in command scope too', () => {
  // The most likely placement by far: `mercuryctl runs list --token=...`.
  const r = run(['runs', 'list', `--token=${SECRET}`]);
  assert.equal(r.code, 2);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  assert.match(r.stderr, /MERCURY_CLIENT_TOKEN|credentials file/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_SUMMARIES, IMPLEMENTED } from '../cli.ts';
import { SUPPORTED_SHELLS } from '../commands/completion.ts';

/**
 * Shell completion (docs/cli-tui-design.md §16 Milestone 4).
 *
 * The acceptance criterion is that completion works offline, and the interesting failure is not a
 * crash -- it is a script that installs cleanly and then completes the wrong things, because nobody
 * looks at a completion script once it has stopped erroring. So the bash case is not only syntax
 * checked but EXECUTED: the generated function is called with synthetic COMP_WORDS and the answers
 * are asserted. A syntax check alone passed a version of this script that offered all eight `runs`
 * subcommands no matter what the operator had typed.
 */
const BIN = fileURLToPath(new URL('../bin.ts', import.meta.url));
const TOKEN = 'completion-secret-token-DO-NOT-PRINT';

function cli(args: string[], xdg: string, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', BIN, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, XDG_CONFIG_HOME: xdg, MERCURY_URL_PLACEHOLDER: '', ...extra },
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Nothing configured at all: no config file, no endpoint, no credential. */
function emptyXdg(): string {
  const root = mkdtempSync(join(tmpdir(), 'mercuryctl-comp-'));
  mkdirSync(join(root, 'mercury'), { recursive: true });
  return root;
}

test('every supported shell produces a script, offline and with no credential', () => {
  for (const shell of SUPPORTED_SHELLS) {
    const r = cli(['completion', shell], emptyXdg());
    assert.equal(r.code, 0, `${shell}: ${r.all}`);
    assert.ok(r.out.length > 200, `${shell} script is suspiciously short (${r.out.length} bytes)`);
    assert.match(r.out, /mercuryctl/, `${shell} script does not name the program`);
    assert.ok(r.out.startsWith('#') || r.out.startsWith('complete') || r.out.startsWith('_'),
      `${shell} script does not start with a comment or a command`);
  }
});

test('an unsupported shell is refused by name, and the supported ones are listed', () => {
  // An empty script installed into a completion directory fails invisibly; the operator blames the
  // shell. Refusing loudly is the only way this is noticed at setup time rather than a month later.
  const r = cli(['completion', 'powershell'], emptyXdg());
  assert.equal(r.code, 2, r.all);
  assert.match(r.err, /powershell/);
  for (const shell of SUPPORTED_SHELLS) assert.match(r.err, new RegExp(shell), r.err);
});

test('completion with no shell name is a usage error, not an empty script', () => {
  const r = cli(['completion'], emptyXdg());
  assert.equal(r.code, 2, r.all);
  assert.match(r.err, /bash, zsh or fish/, r.err);
  assert.equal(r.out, '', `expected no stdout, got ${JSON.stringify(r.out.slice(0, 80))}`);
});

test('a second shell name is refused rather than silently ignored', () => {
  const r = cli(['completion', 'bash', 'zsh'], emptyXdg());
  assert.equal(r.code, 2, r.all);
  assert.match(r.err, /one shell name/, r.err);
});

test('completion never prints a configured credential', () => {
  const root = mkdtempSync(join(tmpdir(), 'mercuryctl-comp-cred-'));
  const dir = join(root, 'mercury');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    currentProfile: 'p', profiles: { p: { url: 'http://127.0.0.1:9', credential: 'c1' } },
  }));
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ c1: TOKEN }));
  chmodSync(join(dir, 'credentials.json'), 0o600);
  for (const shell of SUPPORTED_SHELLS) {
    const r = cli(['completion', shell], root);
    assert.equal(r.code, 0, r.all);
    assert.ok(!r.all.includes(TOKEN), `${shell} completion leaked the token`);
  }
});

test('the generated scripts cover exactly the implemented commands, for every shell', () => {
  // The scripts are generated from the command table, so this is a guard on the generator rather than
  // on a hand-written file. Both directions matter: a missing command is invisible, an extra one is a
  // dead end, and the second is what a stale hand-written completion file always ends up being.
  for (const shell of SUPPORTED_SHELLS) {
    const script = cli(['completion', shell], emptyXdg()).out;
    for (const command of IMPLEMENTED) {
      const parts = command.split(' ');
      for (const part of parts) {
        assert.ok(script.includes(part), `${shell} completion omits ${JSON.stringify(command)} part ${part}`);
      }
    }
    // `frobnicate` is the command that will never exist; if it appears, the generator is inventing.
    assert.ok(!script.includes('frobnicate'), `${shell} completion advertises a command that does not exist`);
    // And every two-word command in the table must be reachable through the tree the generator built.
    for (const [name] of COMMAND_SUMMARIES) {
      const sub = name.split(' ')[1];
      if (!sub) continue;
      assert.ok(script.includes(sub), `${shell} completion omits subcommand ${JSON.stringify(sub)}`);
    }
  }
});

test('the generated bash function completes the right things when actually run', () => {
  // This is the test that earns its keep. `bash -n` accepted a version of the script whose subcommand
  // branch ignored the word being completed, so `runs w` offered all eight subcommands; a script can
  // be syntactically perfect and useless. Driving the function with COMP_WORDS is the only way to see
  // what an operator would actually get.
  const script = cli(['completion', 'bash'], emptyXdg()).out;
  const driver = [
    script,
    'run_case() {',
    '  COMP_WORDS=("$@"); COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))',
    '  COMPREPLY=(); _mercuryctl_completion',
    '  printf "%s\\n" "${COMPREPLY[*]}"',
    '}',
    'run_case mercuryctl ""',
    'run_case mercuryctl runs w',
    'run_case mercuryctl runs list ""',
    'run_case mercuryctl --',
    'run_case mercuryctl conf',
  ].join('\n');
  const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', driver], {
    encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(r.status, 0, `bash rejected the generated script: ${r.stderr}`);
  const lines = r.stdout.split('\n');
  const groups = lines[0]!.split(' ').filter(Boolean).sort();
  assert.deepEqual(groups, ['agents', 'completion', 'config', 'runs'], 'top-level groups');
  assert.equal(lines[1]!.trim(), 'watch', '`runs w` must complete to watch alone');
  assert.equal(lines[2]!.trim(), '', 'a completed command must not re-offer subcommands');
  const flags = lines[3]!.split(' ').filter(Boolean);
  assert.ok(flags.includes('--json') && flags.includes('--profile'), `global flags missing: ${lines[3]}`);
  assert.equal(lines[4]!.trim(), 'config', '`conf` must complete to config');
});

test('bash and zsh both accept the script they are given', () => {
  // Syntax check with the real interpreter. Not sufficient on its own -- see the test above -- but it
  // catches quoting damage that the functional test would not notice because bash is forgiving.
  for (const [shell, exe] of [['bash', '/bin/bash'], ['zsh', '/bin/zsh']] as const) {
    const script = cli(['completion', shell], emptyXdg()).out;
    const r = spawnSync(exe, ['-n', '/dev/stdin'], { encoding: 'utf8', timeout: 60_000, input: script });
    if (r.error) continue;   // interpreter absent on this host; the functional test above still covers bash
    assert.equal(r.status, 0, `${shell} -n failed: ${r.stderr}`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { COMMAND_FLAGS, COMMAND_SUMMARIES, IMPLEMENTED } from '../cli.ts';
import { EXIT } from '../exitCodes.ts';

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

/**
 * A command this build does not implement, used to test the dispatcher's "not available yet" path and
 * the parser's command-path handling without needing a server.
 *
 * This replaced a list DERIVED from IMPLEMENTED. Every milestone that implemented a command removed one
 * entry, and by M4 the list was empty: seven tests then failed at once, which is the outcome the
 * derivation was built to make loud rather than silent. Two different properties were tangled together
 * there -- "this command is not built" and "the parser splits the command path from its arguments" -- and
 * only the first genuinely needs an unimplemented command. The parser tests now use a command that will
 * never exist, so no future milestone can invalidate them, and the "not built yet" path is covered
 * separately by removing a command from IMPLEMENTED in-process.
 */
const UNIMPLEMENTED = ['runs', 'frobnicate'];
const UNIMPLEMENTED_PATH = UNIMPLEMENTED.join(' ');

test('the "not available in this build" path still works when nothing is left unimplemented', async () => {
  // Every command in the design is now built, so the dispatcher's stub branch has no natural subject.
  // Removing one from the same set the dispatcher consults keeps the branch covered permanently, instead
  // of leaving it to rot until the next unimplemented command arrives.
  const { run: runCli, IMPLEMENTED: set } = await import('../cli.ts');
  const victim = 'runs watch';
  // Split into argv tokens. Passing 'runs watch' as ONE element makes the parser see a single argument
  // containing a space, and the assertion then fails on a message that is correct for the input it was
  // actually given.
  assert.ok(set.has(victim), 'precondition: the command must be implemented for removal to mean anything');
  const chunks: { out: string; err: string } = { out: '', err: '' };
  set.delete(victim);
  try {
    const code = await runCli([...victim.split(' '), 'run-123'], {
      stdout: (s: string) => { chunks.out += s; },
      stderr: (s: string) => { chunks.err += s; },
      isTty: false,
      stdinIsTty: false,
      readLine: async () => '',
    } as never);
    assert.equal(code, 2);
    assert.match(chunks.err, new RegExp(`"${victim}" is not available`));
    assert.equal(chunks.out, '', 'a stub answer must not write to stdout');
  } finally {
    set.add(victim);
  }
  assert.ok(set.has(victim), 'the command was not restored; later tests would silently lose it');
});

test('a stray positional on a command that takes none is refused, not ignored', async () => {
  // `runs list <id>` used to list every Run: the operator asked about one and received an answer that
  // looked normal. Same for the config commands.
  for (const args of [
    ['runs', 'list', 'run-123'], ['agents', 'list', 'x'], ['config', 'current', 'x'],
    // create is configured entirely by flags, so a bare word after it has nowhere to go. It was
    // missing from the first version of the set.
    ['runs', 'create', 'stray-word'],
  ]) {
    const r = run(args, { MERCURY_CLIENT_URL: 'http://127.0.0.1:1', MERCURY_CLIENT_TOKEN: 'tok' });
    assert.equal(r.code, 2, `${args.join(' ')} accepted a stray argument`);
    assert.match(r.stderr, /takes no arguments/);
  }
});

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
  // Derived from IMPLEMENTED, so implementing a command cannot quietly turn this into a test about
  // endpoint configuration. The guard test above fails if the stub list ever becomes empty.
  // the stub path after each milestone adds commands; using an implemented one would silently test
  // the network path instead.
  const r = run(UNIMPLEMENTED);
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

  const after = run([...UNIMPLEMENTED, '--definitely-not-a-command-flag']);
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
  // A stub command reveals the parsed command path without needing a server, so this tests positional
  // parsing rather than any endpoint. `runs show <id>` is covered against a live server in the contract
  // suite.
  const r = run([...UNIMPLEMENTED, 'run-123']);
  // The message must name the COMMAND, not swallow the id into it.
  assert.match(r.stderr, new RegExp(`"${UNIMPLEMENTED_PATH}" is not available`));
  assert.ok(!r.stderr.includes('run-123'), 'the run id was folded into the command path');
});

test('command-specific flags reach the command instead of being rejected', () => {
  // Uses a command that is still a stub, derived from the dispatcher rather than hardcoded. This test
  // has gone stale three times now by naming a command that a later milestone implemented; deriving it
  // means the next milestone cannot silently turn a parser test into an endpoint-configuration test.
  const stub = UNIMPLEMENTED;
  const r = run([...stub, '--task', 'fix the bug', '--repo', 'https://example/r.git']);
  assert.match(r.stderr, new RegExp(`"${stub.join(' ')}" is not available`));
  assert.ok(!r.stderr.includes('unknown option'), 'command flags must not be rejected by the global parser');
});

test('global options still work before the command', () => {
  const r = run(['--json', ...UNIMPLEMENTED]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, new RegExp(`"${UNIMPLEMENTED_PATH}" is not available`));
});

test('global options also work after the command, the way people type them', () => {
  const r = run([...UNIMPLEMENTED, '--json']);
  assert.match(r.stderr, new RegExp(`"${UNIMPLEMENTED_PATH}" is not available`));
});

test('help and the dispatcher agree about every command, in both directions', async () => {
  // --help is the discovery surface. A command listed there that then answers "not available in this
  // build" makes the operator's first encounter a dead end; a working command that is omitted is
  // invisible. Both come from help and the dispatcher drifting apart.
  //
  // The check is written against COMMAND_SUMMARIES and IMPLEMENTED -- the two lists the CLI itself
  // uses. An earlier version kept a third hand-written list of three commands inside this test, which
  // is precisely the drift it claimed to guard against, and it also required at least one command to
  // still be unimplemented: a property that stops being true the moment the design is finished.
  const help = run(['--help']);
  assert.equal(help.code, 0, help.stderr);
  const built = IMPLEMENTED;   // same module instance the dispatcher uses
  for (const [name] of COMMAND_SUMMARIES) {
    const line = help.stdout.split('\n').find((l) => l.trim().startsWith(name));
    assert.ok(line, `${JSON.stringify(name)} is in the command table but missing from --help`);
    const markedUnavailable = line.includes('not in this build');
    if (built.has(name)) {
      assert.ok(!markedUnavailable, `${name} is implemented but --help marks it unavailable`);
    } else {
      assert.ok(markedUnavailable, `${name} is not implemented but --help presents it as working`);
    }
  }
  // Nothing may be listed in help that the command table does not know about.
  for (const line of help.stdout.split('\n')) {
    const m = line.trim().match(/^(?:\*\s+)?((?:agents|runs|config)\s+\S+)/);
    if (!m) continue;
    const known = COMMAND_SUMMARIES.some(([name]) => name === m[1]);
    assert.ok(known, `--help advertises ${JSON.stringify(m[1])}, which is not in the command table`);
  }
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
test('the design document lists exactly the commands the CLI implements', () => {
  // §6 is the command surface an operator reads as complete. It drifted twice in one
  // session -- `completion` shipped without appearing there, and the global-options block
  // omitted --yes/--help/--version -- so the comparison is made mechanically rather than
  // left to whoever notices. A design doc that quietly falls behind its implementation is
  // worse than no doc, because it is read with the confidence of a spec.
  const doc = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'cli-tui-design.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## 6. User-facing command model'), doc.indexOf('## 7. '));
  assert.ok(section.length > 500 && section.startsWith('## 6.'), 'could not locate §6; the guard is not reading anything');

  const block = section.match(/```text\n([\s\S]*?)```/);
  assert.ok(block, '§6 has no grammar block; the guard is vacuous');
  const documented = new Set(
    block[1].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('mercuryctl '))
      .map((l) => l.replace(/^mercuryctl\s+/, '').replace(/\s+<.*$/, '')),
  );
  assert.ok(documented.size >= 10, `only ${documented.size} commands parsed from §6; the extraction is broken`);

  const implemented = new Set(COMMAND_SUMMARIES.map(([c]) => c));
  const missing = [...implemented].filter((c) => !documented.has(c));
  const phantom = [...documented].filter((c) => !implemented.has(c));
  assert.deepEqual(missing, [], `implemented but absent from §6: ${missing.join(', ')}`);
  assert.deepEqual(phantom, [], `§6 advertises commands that do not exist: ${phantom.join(', ')}`);

  // Global options, same reasoning: the block is what an operator copies from.
  const optBlock = section.match(/--profile[\s\S]*?```/);
  assert.ok(optBlock, '§6 has no global-options block; the guard is vacuous');
  for (const flag of ['--json', '--no-color', '--timeout', '--yes', '--help', '--version', '--profile', '--url']) {
    assert.ok(optBlock[0].includes(flag), `§6 omits global option ${flag}`);
  }
  // The absence is the point of §6, so assert it rather than trust it.
  assert.ok(!/^--token/m.test(optBlock[0]), '§6 lists a --token option, which the design forbids');
});
// Command-scope flags: unknown ones must be refused, and every declared one must still work.
//
// The parser stores command-scope flags raw so each command owns its grammar, and nothing then checked
// them -- so `runs events <id> --folw` printed history, exited 0, and left the operator believing they
// were watching live. A test in only one direction is not enough: too strict a table breaks working
// commands, too permissive one keeps the silent-accept bug. Both directions are asserted.

const FLAG_CASES: Record<string, string[]> = {
  'runs list': ['--limit', '2', '--status', 'QUEUED', '--cursor', 'abc'],
  'runs create': ['--task', 't', '--repo', 'https://example.com/x.git', '--agent', 'fake',
                  '--skills', 'a,b', '--idempotency-key', 'k-1'],
  'runs events': ['run_abc', '--after', '1', '--limit', '5', '--follow'],
  'runs watch': ['run_abc', '--after', '1'],
  'runs input': ['run_abc', '--value', 'hello'],
  'agents list': [],
  'runs show': ['run_abc'],
  'runs cancel': ['run_abc', '--yes'],
  'runs retry': ['run_abc', '--yes'],
  'config profiles': [],
  'config current': [],
};

test('every flag a command declares is accepted, not just known to the table', () => {
  // Pointed at a closed port on purpose. Exit 7 means the flag was accepted and the command went on to
  // try the network; exit 2 would mean the table is too strict and a working invocation now fails.
  for (const [command, args] of Object.entries(FLAG_CASES)) {
    // A credential is supplied so the run reaches the network. Without one the CLI exits 2 at
    // credential resolution, which is indistinguishable from a flag rejection by exit code alone.
    // The command is split into argv tokens: 'runs events' is a two-token path, not one argument.
    const r = run([...command.split(' '), ...args], { MERCURY_CLIENT_URL: 'http://127.0.0.1:1', MERCURY_CLIENT_TOKEN: 'tok' });
    assert.notEqual(r.code, EXIT.USAGE,
      `${command} ${args.join(' ')} was rejected as a usage error; COMMAND_FLAGS is too strict: ${r.stderr}`);
  }
});

test('a mistyped flag is refused with exit 2, names the flag, and lists what is accepted', () => {
  const cases: Array<[string[], string]> = [
    [['runs', 'list', '--stat', 'QUEUED'], '--stat'],
    [['runs', 'list', '--limt', '5'], '--limt'],
    [['runs', 'events', 'run_abc', '--folw'], '--folw'],
    [['runs', 'create', '--task', 'x', '--repo', 'https://e/x.git', '--agnet', 'hermes'], '--agnet'],
    [['runs', 'show', 'run_abc', '--jsonn'], '--jsonn'],
    [['agents', 'list', '--limit', '5'], '--limit'],
    [['runs', 'cancel', 'run_abc', '--yes', '--forc'], '--forc'],
  ];
  for (const [args, flag] of cases) {
    const r = run([...args], { MERCURY_CLIENT_URL: 'http://127.0.0.1:1', MERCURY_CLIENT_TOKEN: 'tok' });
    assert.equal(r.code, EXIT.USAGE, `${args.join(' ')} exited ${r.code}, expected 2: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(flag.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')),
      `${args.join(' ')} did not name the offending flag: ${r.stderr}`);
    // Silent acceptance is the bug; an error that does not say what to type instead is only half a fix.
    assert.match(r.stderr, /accepts|takes no flags/, `${args.join(' ')} gave no guidance: ${r.stderr}`);
    assert.ok(!/hermes|QUEUED/.test(r.stderr),
      `${args.join(' ')} echoed a flag VALUE back to stderr: ${r.stderr}`);
  }
});

test('every command declares its flags, so a new one cannot inherit the permissive default', () => {
  const declared = Object.keys(COMMAND_FLAGS).sort();
  const commands = COMMAND_SUMMARIES.map(([c]) => c).sort();
  assert.deepEqual(declared, commands,
    'COMMAND_FLAGS and COMMAND_SUMMARIES disagree; every command must declare its grammar');
});

test('globals still work after the command, and are not caught by the unknown-flag guard', () => {
  // A real profile on disk, so --profile is proven to pass the guard AND resolve. Pointing it at a
  // name that does not exist would exit 2 for the right reason and prove nothing about the guard.
  const home = mkdtempSync(join(tmpdir(), 'mercuryctl-globals-'));
  mkdirSync(join(home, 'mercury'), { recursive: true });
  writeFileSync(join(home, 'mercury', 'config.json'),
    JSON.stringify({ currentProfile: 'ci', profiles: { ci: { url: 'http://127.0.0.1:1', credential: 'ci-cred' } } }));
  writeFileSync(join(home, 'mercury', 'ci-cred'), 'tok\n');
  chmodSync(join(home, 'mercury', 'ci-cred'), 0o600);

  for (const args of [['runs', 'list', '--json'], ['runs', 'list', '--no-color'],
                      ['runs', 'list', '--timeout', '5s'], ['runs', 'list', '--profile', 'ci'],
                      ['runs', 'cancel', 'run_abc', '--yes'], ['runs', 'list', '--url', 'http://127.0.0.1:1']]) {
    const r = run([...args], {
      MERCURY_CLIENT_URL: 'http://127.0.0.1:1', MERCURY_CLIENT_TOKEN: 'tok', XDG_CONFIG_HOME: home,
    });
    assert.notEqual(r.code, EXIT.USAGE, `${args.join(' ')} rejected a global: ${r.stderr}`);
  }
});

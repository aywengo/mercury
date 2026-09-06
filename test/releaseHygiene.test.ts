import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { HOST_PRODUCT, HOST_VERSION } from '../src/version.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const pkg = JSON.parse(read('package.json')) as {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  bin?: Record<string, string>;
  files?: string[];
};

function latestChangelogVersion(text: string): string | undefined {
  // The optional prerelease group matters: with only \d+.\d+.\d+ the parser returns undefined for
  // `## [0.1.0-rc1]`, so the guard comparing CHANGELOG to package.json silently loses its counterpart
  // and fails with "latest version undefined" rather than a useful diff.
  return [...text.matchAll(/^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/gm)].map((m) => m[1])[0];
}

function spawnCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], {
      cwd: ROOT,
      // Default is exactly the previous behaviour; the override exists so one test can prove --help
      // does not depend on a usable configuration.
      env: { ...process.env, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('LICENSE is MIT with the project copyright', () => {
  const license = read('LICENSE');
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Roman Melnyk/);
});

test('community files exist with the expected headings', () => {
  assert.match(read('CONTRIBUTING.md'), /^# Contributing to Mercury/m);
  assert.match(read('SECURITY.md'), /https:\/\/github\.com\/aywengo\/mercury\/security\/advisories/);
  assert.match(read('CODE_OF_CONDUCT.md'), /Contributor Covenant/);
});

test('root package.json is the public host package', () => {
  assert.equal(pkg.name, '@aywengo/mercury');
  assert.equal(pkg.private, false);
  assert.equal(pkg.license, 'MIT');
  // Was 'src/cli.ts', which is unrunnable once installed: Node refuses to strip types under
  // node_modules, so the published `mercury` command exited 1 before printing anything (issue #243).
  // The server is compiled to dist/ by `prepare` like the client. Existence is not asserted here because
  // the core suite runs without a build; client/test/packaging.test.ts builds and runs the artifact.
  assert.equal(pkg.bin?.mercury, 'dist/src/cli.js');
  assert.ok(!pkg.bin!.mercury.endsWith('.ts'), 'a bin target in TypeScript cannot run once installed');
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'files whitelist must be present');
  for (const entry of pkg.files!) {
    assert.notEqual(entry, 'test/');
    assert.notEqual(entry, 'fleet/');
    assert.ok(!entry.startsWith('test/'), `files must not ship tests, got ${entry}`);
    assert.ok(!entry.startsWith('fleet/'), `files must not ship Fleet, got ${entry}`);
  }
});

test('HOST_VERSION equals package.json and the host changelog', () => {
  assert.equal(HOST_VERSION, pkg.version);
  assert.equal(HOST_PRODUCT, 'host');
  const heading = latestChangelogVersion(read('CHANGELOG.md'));
  assert.equal(heading, pkg.version, `CHANGELOG.md latest version ${heading} != ${pkg.version}`);
  assert.ok(existsSync(join(ROOT, 'docs', 'releases', 'host', `${pkg.version}.md`)),
    `docs/releases/host/${pkg.version}.md must exist`);
});

test('the CLI has no release stream of its own', () => {
  // The cli-* tag was removed: it created a GitHub Release and published no artifact, because the CLI
  // ships inside @aywengo/mercury. This test used to assert the opposite -- that docs/releases/cli/
  // existed and carried notes for the current version -- because a cli tag needed them. Inverting it is
  // the point: if the directory comes back, someone has re-introduced a taggable CLI stream, and the
  // host notes are no longer the single place a CLI change is described.
  assert.ok(!existsSync(join(ROOT, 'docs', 'releases', 'cli')),
    'docs/releases/cli/ must not exist; the CLI ships in the host release and is described there');
  const doc = read('docs/releasing.md');
  assert.match(doc, /no tag,\n?and no notes file of its own|no version of its own, no tag/,
    'releasing.md must say the CLI has no tag and no notes file of its own');
  assert.match(doc, /described in the host release notes/,
    'releasing.md must say where a CLI change is described');
});

test('host release notes do not deny that the CLI ships in them', () => {
  // the host release notes (docs/releases/host/0.1.0.md, since renamed to 0.1.0-rc1.md) listed
  // `mercuryctl` under "Not in this release" while package.json
  // `bin` carried it and `dist/` is published. The two notes files contradicted each other: the CLI one
  // announced a first release of the client, the host one said the client was absent. Nothing had been
  // tagged, so the false one is corrected rather than left as published history.
  const notes = read(`docs/releases/host/${pkg.version}.md`);
  const notIn = notes.slice(notes.indexOf('## Not in this release'));
  assert.ok(!/`mercuryctl`/.test(notIn.split('\n').find((l) => l.trim() !== '' && !l.startsWith('#')) || ''),
    'host notes still list mercuryctl as not in this release, but package.json bin ships it');
  assert.match(notes, /## The CLI/, 'host notes must describe the CLI, since it ships in this package');
  assert.match(notes, /mercuryctl --version/, 'host notes must show how to run the client that ships here');
  // The stale gap note from the old CLI notes file must not have been carried over by the merge: #243
  // fixed bin.mercury, so a doc that still says it cannot run is now false.
  assert.ok(!/bin\.mercury`? still points at a TypeScript file/i.test(notes),
    'host notes repeat a gap that #243 closed');
});

test('mercury --version prints mercury-host <version> and does not start a server', async () => {
  const r = await spawnCli(['--version']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `mercury-host ${HOST_VERSION}\n`);
  assert.doesNotMatch(r.stdout, /fleet/);
});

test('releasing.md does not describe the CLI as future or reserved', () => {
  // #245: docs/releasing.md gained a correct "## The CLI" section in #242 but kept the opening line and
  // product table written before mercuryctl existed, so the same page said the CLI both exists and does
  // not. These are steps an operator follows while cutting a release, so a stale one causes a wrong action.
  const doc = read('docs/releasing.md');
  const stale: RegExp[] = [
    /future\s+`?mercuryctl`?/i,
    /`cli-vX\.Y\.Z`\s+reserved/,
    /reserved until [`']?mercuryctl/i,
    /\|\s*none yet\s*\|/,
  ];
  for (const pattern of stale) {
    assert.ok(!pattern.test(doc), `releasing.md still claims the CLI does not exist: ${pattern}`);
  }
});

test('the product table has no CLI row, because there is no CLI tag', () => {
  // The table is the thing an operator reads while cutting a release. A CLI row naming a `cli-vX.Y.Z`
  // tag would tell them to push a tag the workflow now refuses.
  const doc = read('docs/releasing.md');
  const row = doc.split('\n').find((l) => /^\|\s*CLI\s*\|/.test(l));
  assert.ok(row === undefined, `the product table still has a CLI row: ${row}`);
  assert.ok(!/\|\s*`cli-vX\.Y\.Z`\s*\|/.test(doc), 'a table cell still offers a cli tag pattern');
  // Both directions: dropping the CLI row must not have dropped a product that still releases.
  for (const product of ['Host', 'Fleet']) {
    assert.ok(doc.split('\n').some((l) => new RegExp(`^\\|\\s*${product}\\s*\\|`).test(l)),
      `the product table lost its ${product} row`);
  }
});

test('releasing.md never instructs an operator to push a cli tag', () => {
  // Historical mentions are fine and wanted -- the doc explains why the tag was removed. An INSTRUCTION
  // is not. So: every line that both mentions a cli tag and reads as an instruction is a failure, and
  // the procedure steps are checked as a block because that is the part an operator follows in order.
  const doc = read('docs/releasing.md');
  const procedure = doc.slice(doc.indexOf('## Cut a release'), doc.indexOf('## The CLI'));
  assert.ok(procedure.length > 200, 'could not locate the release procedure block');
  assert.ok(!/cli-v|cli-\*/.test(procedure),
    'the release procedure still mentions a cli tag; it must describe host and Fleet tags only');
  assert.match(procedure, /nothing to bump and no tag to push/,
    'step 1 must tell a CLI-change author there is nothing to bump and no tag to push');
  assert.match(procedure, /goes out with the next host release/,
    'step 1 must say when a CLI change actually reaches users');
});

test('step 6 names the two products that publish and promises no third', () => {
  const doc = read('docs/releasing.md');
  const start = doc.indexOf('6. [');
  assert.ok(start >= 0, 'the release procedure must keep its numbered step 6');
  const step6 = doc.slice(start, doc.indexOf('The `NPM_TOKEN`', start) > start
    ? doc.indexOf('The `NPM_TOKEN`', start) : start + 900);
  assert.match(step6, /host/, 'step 6 must name the products that publish');
  assert.match(step6, /fleet/);
  assert.ok(!/cli/i.test(step6),
    'step 6 still describes a cli tag; there is no cli tag, so this promises a release that cannot happen');
});

test('release.yml admits exactly host and fleet, and fails closed on anything else', () => {
  const wf = read('.github/workflows/release.yml');
  assert.ok(!/\(host\|fleet\|cli\)/.test(wf), 'the tag regex still admits cli');
  assert.match(wf, /\^\(host\|fleet\)-v/, 'the tag regex must admit host and fleet');
  // Fail-closed matters: with the cli branch deleted, an unmatched product must not reach
  // `gh release create` with an unset title.
  assert.match(wf, /has no release branch/, 'the else branch must refuse rather than fall through');
  assert.ok(!/reserved until [`']?mercuryctl exists/i.test(wf),
    'release.yml still prints that the CLI does not exist');
});

// ---------------------------------------------------------------------------
// `mercury --help` (issue #254)
//
// Asking for help is not an error, but the server CLI had no --help branch at all: it fell through to
// the shared unknown-command path, so `mercury --help` printed usage to stderr and exited 1. That makes
// `mercury --help > usage.txt` capture nothing and `mercury --help && ...` stop, and it makes the two
// commands in this package disagree, because mercuryctl --help exits 0 on stdout.
// ---------------------------------------------------------------------------

const stripWarnings = (s: string): string =>
  s.split('\n').filter((l) => l !== '' && !/ExperimentalWarning|trace-warnings/.test(l)).join('\n');

test('mercury --help exits 0 and writes the command list to stdout', async () => {
  const r = await spawnCli(['--help']);
  assert.equal(r.code, 0, `--help must not be an error: ${r.stderr}`);
  assert.equal(stripWarnings(r.stderr), '', `--help must not write to stderr: ${r.stderr}`);
  assert.ok(r.stdout.length > 100, `--help produced almost nothing: ${JSON.stringify(r.stdout)}`);
  // Every command the CLI actually accepts has to appear, or the help text is a subset that an operator
  // will treat as the whole surface.
  for (const c of ['dev', 'server', 'worker', 'gc', 'migrate', 'redact-events']) {
    assert.match(r.stdout, new RegExp(`^\\s+${c}\\b`, 'm'), `--help omits the ${c} command`);
  }
  assert.match(r.stdout, /--help/, 'usage must document --help itself');
});

test('mercury -h matches --help byte for byte', async () => {
  const long = await spawnCli(['--help']);
  const short = await spawnCli(['-h']);
  assert.equal(short.code, 0, short.stderr);
  assert.equal(short.stdout, long.stdout, '-h and --help must not diverge');
});

test('an unknown command is still an error, so help and nonsense stay distinguishable', async () => {
  const r = await spawnCli(['definitely-not-a-command']);
  assert.equal(r.code, 1, 'an unknown command must still fail');
  assert.equal(r.stdout, '', `usage for an error must not pollute stdout: ${JSON.stringify(r.stdout)}`);
  assert.match(r.stderr, /usage: mercury/);
  // Same text, different stream and exit code -- the two paths share one source and must not drift.
  const help = await spawnCli(['--help']);
  assert.equal(stripWarnings(r.stderr), stripWarnings(help.stdout));
});

test('mercury --help works with an unusable database, unlike a real subcommand', async () => {
  // Help is handled before loadConfig(), because the person reading help may be reading it precisely
  // because their configuration is wrong. A help path that needs config is a help path that fails on
  // the only machine that called it.
  const r = await spawnCli(['--help'], { MERCURY_DB: '/dev/null/not-a-real-path/mercury.db' });
  assert.equal(r.code, 0, `help must not depend on config: ${r.stderr}`);
  assert.ok(r.stdout.length > 100);
});

test('both commands in this package answer --help the same way', async () => {
  // The parity claim. Without it the two CLIs can drift back apart silently, since each file's own
  // tests would still pass.
  const server = await spawnCli(['--help']);
  assert.equal(server.code, 0, `mercury --help: ${server.stderr}`);
  // From SOURCE, not from dist/. This file is in the core suite, which runs with no build step; the
  // first version of this test spawned dist/client/bin.js, passed locally because a build had happened
  // to run in that checkout, and failed on CI where it had not. Same rule as spawnCli() above: the
  // core suite may only depend on state it creates itself.
  const client = spawnSync(process.execPath, [join(ROOT, 'client', 'bin.ts'), '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, XDG_CONFIG_HOME: join(ROOT, 'no-such-config-dir') },
  });
  assert.equal(client.status, 0, `mercuryctl --help: ${client.stderr}`);
  assert.equal(server.code, client.status, 'mercury and mercuryctl must agree on the --help exit code');
});

test('releasing.md does not call the CLI an independent release stream', () => {
  // The invariant outlives the reason it was written. It was added when the doc called Host, Fleet and
  // the CLI independent streams while the CLI shared the host version; the tag has since been deleted
  // entirely, so the CLI is not a stream at all. Either way the doc must never group it with the
  // products that have tags of their own.
  const doc = read('docs/releasing.md');
  // Assert on the SENTENCE, not on a spelling. An earlier version of this guard matched
  // "CLI are **independent SemVer streams" and SURVIVED the exact regression it was written against,
  // because the real sentence reads "CLI are released as **independent SemVer streams". Taking the
  // sentence that makes the claim survives any rewording of the predicate.
  const independence = doc.split(/(?<=[.!?])\s+/).filter((s) => /independent\s+SemVer\s+streams/i.test(s));
  assert.ok(independence.length > 0, 'releasing.md no longer mentions independent SemVer streams at all');
  for (const sentence of independence) {
    assert.ok(!/\bCLI\b|mercuryctl/i.test(sentence),
      `the independence claim includes the CLI, which has no tag of its own: ${sentence.trim()}`);
  }
  // \s+ not a space: markdown wraps this file at ~78 columns, so a literal space in the pattern matches
  // only the one line length the sentence happened to have when it was written.
  assert.match(doc, /has \*\*no tag and no version of its\s+own\*\*/,
    'releasing.md must state plainly that the CLI has no tag and no version of its own');
  assert.match(doc, /ships inside\s+`@aywengo\/mercury`/,
    'releasing.md must say the CLI ships inside the host package');
});

test('every relative markdown link in the repo resolves to a real file', () => {
  // Renaming docs/releases/{host,fleet}/0.1.0.md to 0.1.0-rc1.md silently broke two links in
  // docs/README.md. Nothing failed: no test had ever opened a markdown link and checked that its
  // target exists, so a rename could strand links across the whole doc set unnoticed. This is the
  // general guard, not a rule about release notes -- any rename that strands a link fails here.
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage']);
  const broken: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const text = readFileSync(full, 'utf8');
      for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:|#|\/)/.test(target)) continue;
        const path = target.split('#')[0];
        if (path === '') continue;
        if (!existsSync(join(dir, path))) broken.push(`${relative(full, ROOT)} -> ${target}`);
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(broken, [], `markdown links point at files that do not exist:\n  ${broken.join('\n  ')}`);
});

test('docs/status.md does not deny that the operator CLI is implemented', () => {
  // Fourth instance of one claim. "mercuryctl does not exist" was removed from releasing.md (#251),
  // from releasing.md again (#259) and from CHANGELOG.md (#261); docs/status.md still carried it under
  // "Designed but not implemented" -- "Neither surface is implemented" -- while package.json `bin` ships
  // the client. It matters more than the others because docs/README.md presents status.md as "Current
  // status and limitations" and instructs readers to prefer it over older references, and both the
  // changelog and the release notes point here for limitations.
  //
  // Asserted structurally rather than on one spelling: the unimplemented section must not name the
  // client at all. Rewording "Neither surface is implemented" to anything else still fails, because the
  // claim's location is what makes it false. The TUI stays in that section -- it genuinely is unbuilt --
  // and its prose says "terminal UI" and "a TUI over the CLI", neither of which names the client.
  const doc = read('docs/status.md');
  const start = doc.indexOf('## Designed but not implemented');
  assert.ok(start >= 0, 'docs/status.md lost its "Designed but not implemented" section');
  const next = doc.indexOf('\n## ', start + 10);
  const section = doc.slice(start, next > start ? next : undefined);
  assert.ok(section.length > 100, 'could not bound the unimplemented section');
  for (const forbidden of [/mercuryctl/i, /Operator\s+CLI/i]) {
    assert.ok(!forbidden.test(section),
      `docs/status.md still lists the operator client as unimplemented (matched ${forbidden} in that section)`);
  }
  // And the affirmative half: the doc must actually say the client ships, or removing the denial would
  // leave a reader no better informed than before.
  assert.match(doc, /`mercuryctl` is implemented and ships in the host package/,
    'docs/status.md must state that mercuryctl is implemented and ships');
  assert.match(doc, /### Operator TUI/,
    'docs/status.md must keep the TUI listed as designed-but-unbuilt; that part is still true');
});

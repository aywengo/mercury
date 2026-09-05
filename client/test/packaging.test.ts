// Packaging guard (docs/cli-tui-design.md §12, M4 territory pulled forward).
//
// Found in review: `bin.mercuryctl` was added pointing at client/bin.ts while `files` remained an
// allowlist that named only src/ and friends. npm always ships files named by `bin`, so the tarball
// contained client/bin.ts and NOTHING ELSE from client/ -- an installed mercuryctl that dies on its
// first import. The failure only appears after `npm install`, which no test in this repo does, so the
// invariant is asserted against package.json directly instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('every bin entry exists in the repository', () => {
  for (const [name, target] of Object.entries<string>(pkg.bin ?? {})) {
    assert.ok(existsSync(join(ROOT, target)), `bin ${JSON.stringify(name)} -> ${target} does not exist`);
  }
});

test('every bin entry is covered by the published files allowlist', () => {
  const files: string[] | undefined = pkg.files;
  // No allowlist means npm ships everything except its own ignores, which is safe by construction.
  if (!files) return;
  for (const [name, target] of Object.entries<string>(pkg.bin ?? {})) {
    const dir = dirname(target);
    // A bin target is reachable if `files` names its directory (or '.'), or names an ancestor of it.
    // Checking the directory rather than the single file matters: bin.ts imports its siblings, and an
    // allowlist that shipped only the entry point produced exactly the broken install described above.
    // Coverage means the DIRECTORY (or an ancestor of it) is published. Naming only the entry point is
    // deliberately NOT coverage: that is precisely the state that shipped, where npm auto-included
    // client/bin.ts and nothing else it imports. An allowlist entry pointing at a file inside the
    // directory must not be mistaken for publishing the directory.
    const covered = files.some((entry) => {
      const e = entry.replace(/\/+$/, '');
      if (e === '' || e === '.') return true;
      return dir === e || dir.startsWith(e + sep);
    });
    assert.ok(
      covered,
      `bin ${JSON.stringify(name)} -> ${target} lives in ${JSON.stringify(dir)}, which "files" ` +
        `(${JSON.stringify(files)}) does not include. npm would ship the entry point alone and the ` +
        `installed command would fail on its first import.`,
    );
  }
});

test('the published file list does not silently drop a client source directory', () => {
  // The specific regression, stated directly, so a future edit to "files" that removes client/ fails
  // with a message about mercuryctl rather than a generic allowlist mismatch.
  const files: string[] | undefined = pkg.files;
  if (!files) return;
  const clientSources = new Set<string>();
  // Enumerate the real tree rather than trusting a hardcoded list, so adding a subdirectory under
  // client/ is automatically covered.
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) collect(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        clientSources.add(relative(ROOT, full).split(sep)[1] ?? '');
      }
    }
  };
  collect(join(ROOT, 'client'));
  clientSources.delete('test');
  assert.ok(clientSources.size > 0, 'no client sources found; this assertion would be vacuous');
  const included = files.some((entry) => entry.replace(/\/+$/, '') === 'client');
  assert.ok(
    included,
    `"files" does not include client/, so these would not be published: ${[...clientSources].join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// The artifact, not the source tree.
//
// Everything above checks package.json against the repository. None of it can see the defect this
// section exists for: `bin.mercuryctl` used to point at client/bin.ts, which runs perfectly from a
// checkout and fails immediately once installed, because Node refuses to strip types from anything
// under node_modules. The only way to see it is to install.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';

/**
 * Build the client before inspecting the artifact.
 *
 * `bin` points into dist/, which is gitignored, so a clean checkout has nothing to check until the
 * build has run. Building here rather than skipping when absent also proves the build itself works --
 * a packaging test that quietly passed on an unbuilt tree would be worse than no test.
 */
function buildClient(): void {
  const r = spawnSync('npm', ['run', 'build:client'], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  assert.equal(r.status, 0, `npm run build:client failed:\n${r.stdout}\n${r.stderr}`);
}

buildClient();

/** Bins that are still TypeScript. Each entry is a known defect, not an exemption. */
const KNOWN_TYPESCRIPT_BINS = new Map<string, string>([
  ['mercury', 'https://github.com/aywengo/mercury/issues/243'],
]);

test('every bin that is not a tracked defect is plain JavaScript', () => {
  // Node will not strip types under node_modules, so a .ts bin target is an executable that cannot
  // execute once installed. Asserting the exception list is accurate in BOTH directions means fixing
  // one of these requires deleting its entry, so the list cannot quietly rot into a permanent excuse.
  for (const [name, target] of Object.entries<string>(pkg.bin ?? {})) {
    const isTs = target.endsWith('.ts');
    const tracked = KNOWN_TYPESCRIPT_BINS.get(name);
    if (isTs) {
      assert.ok(tracked, `bin ${JSON.stringify(name)} -> ${target} is TypeScript and cannot run once installed`);
      continue;
    }
    assert.ok(!tracked,
      `bin ${JSON.stringify(name)} is now JavaScript, so ${tracked} is fixed: remove it from KNOWN_TYPESCRIPT_BINS`);
    assert.ok(existsSync(join(ROOT, target)), `bin ${JSON.stringify(name)} -> ${target} does not exist after build`);
  }
});

/** The published file list, from npm itself rather than from a re-implementation of its rules. */
function packagedFiles(): string[] {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  assert.equal(r.status, 0, `npm pack --dry-run failed: ${r.stdout}${r.stderr}`);
  const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))) as Array<{ files: Array<{ path: string }> }>;
  return payload[0]!.files.map((f) => f.path);
}

test('packaging contains no credential and no local profile', () => {
  // The M4 acceptance criterion. A config file or credentials file that leaked into the tarball would
  // be published to anyone who can read the registry entry, and nothing in the test suite would notice
  // because the client reads those paths from the user's home directory, not from the package.
  const files = packagedFiles();
  assert.ok(files.length > 50, `only ${files.length} files packaged; the file list itself looks broken`);

  for (const path of files) {
    const base = path.split('/').pop() ?? path;
    assert.ok(!/^credentials\.json$/i.test(base), `credentials file would be published: ${path}`);
    assert.ok(!/^\.env(\.|$)/.test(base), `dot-env file would be published: ${path}`);
    assert.ok(!/\.(pem|key|p12|pfx)$/i.test(base), `private key material would be published: ${path}`);
    assert.ok(!path.includes('/test/'), `test files are published (${path}); they carry fixture secrets`);
  }

  // Content scan. Placeholders and fixtures are expected in documentation, so the patterns are the
  // ones that mean a real credential: fixed-length provider keys, private key blocks, and JWTs.
  const dangerous: Array<[RegExp, string]> = [
    [/gh[pousr]_[A-Za-z0-9]{16,}/, 'GitHub token'],
    [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    [/eyJ[A-Za-z0-9_-]{16,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, 'JWT'],
    [/xox[baprs]-[A-Za-z0-9-]{16,}/, 'Slack token'],
  ];
  const offenders: string[] = [];
  for (const path of files) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, path), 'utf8');
    } catch {
      continue;
    }
    for (const [pattern, label] of dangerous) {
      if (pattern.test(text)) offenders.push(`${path}: ${label}`);
    }
  }
  assert.deepEqual(offenders, [], `credential-shaped content is published:\n${offenders.join('\n')}`);
});

test('clean-install smoke test: the published artifact runs from inside node_modules', () => {
  // THE regression test for the defect that made mercuryctl unrunnable once installed. Nothing else in
  // the suite can see it: from a checkout, `node client/bin.ts` works, and the failure appears only
  // when the file lives under node_modules, where Node refuses to strip types. So this packs the real
  // tarball, unpacks it under a path containing node_modules, and runs the binary there.
  //
  // It exercises the offline surface only -- version, help, completion, config -- which is also the
  // acceptance criterion "the client installs without server or worker runtime configuration". If the
  // artifact needed a server or a database to print its own version, that would be the bug.
  const tmp = mkdtempSync(join(tmpdir(), 'mercuryctl-install-'));
  try {
    const packed = spawnSync('npm', ['pack', '--pack-destination', tmp], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    assert.equal(packed.status, 0, `npm pack failed: ${packed.stdout}${packed.stderr}`);
    const tarball = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    assert.ok(tarball, `npm pack produced no tarball in ${tmp}`);

    // The path is the point: a package directory that is not under node_modules would not reproduce
    // the restriction, and the test would pass against the broken artifact.
    const dest = join(tmp, 'consumer', 'node_modules', '@aywengo', 'mercury');
    mkdirSync(dest, { recursive: true });
    const extracted = spawnSync('tar', ['-xzf', join(tmp, tarball), '-C', dest], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(extracted.status, 0, `tar failed: ${extracted.stderr}`);

    const pkgDir = join(dest, 'package');
    const binPath = join(pkgDir, pkg.bin.mercuryctl);
    assert.ok(existsSync(binPath), `installed artifact is missing its bin target: ${pkg.bin.mercuryctl}`);

    const env = {
      ...process.env,
      XDG_CONFIG_HOME: join(tmp, 'no-such-home'),
      MERCURY_CLIENT_URL: '', MERCURY_CLIENT_TOKEN: '',
    };
    const version = spawnSync(process.execPath, [binPath, '--version'], { encoding: 'utf8', timeout: 120_000, env });
    assert.equal(version.status, 0, `installed --version failed:\n${version.stdout}\n${version.stderr}`);
    assert.ok(!/ERR_UNSUPPORTED|SyntaxError|Cannot find (module|package)/.test(version.stderr),
      `installed binary errored: ${version.stderr}`);
    assert.equal(version.stdout.trim(), `mercuryctl ${pkg.version}`,
      'the installed binary reports a version other than the manifest it shipped with');

    for (const args of [['--help'], ['completion', 'bash'], ['config', 'profiles']]) {
      const r = spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8', timeout: 120_000, env });
      assert.equal(r.status, 0, `installed ${args.join(' ')} failed: ${r.stderr}`);
      assert.ok(r.stdout.length > 20, `installed ${args.join(' ')} produced almost no output`);
    }

    // The shebang path, not just `node <file>`: this is what a shell executes when the operator types
    // the command. npm sets the executable bit on install, so the artifact must carry a usable shebang.
    chmodSync(binPath, 0o755);
    const direct = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 120_000, env });
    assert.equal(direct.status, 0, `shebang execution failed: ${direct.stderr}`);
    assert.equal(direct.stdout.trim(), `mercuryctl ${pkg.version}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

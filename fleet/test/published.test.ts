import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FLEET_VERSION } from '../version.ts';

// The published artifact, not the source tree.
//
// `npm run test:fleet` runs the suite from source with `node --test`, where Node strips types on the
// fly. A package whose `bin` points at a `.ts` file therefore passes every one of those tests and is
// still dead on arrival: Node refuses to strip types under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) on every version that can strip types at all. Fleet
// shipped `bin: {"fleet": "cli.ts"}` that way -- `npm install` succeeded and `fleet --version` did not
// -- and nothing in the suite could have noticed, because nothing installed the package.
//
// So this file packs it, installs it into a throwaway prefix, and runs the binary the way a user
// would. That is the only check that distinguishes "the sources work" from "the release works".

const FLEET_DIR = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(FLEET_DIR, '..');   // the LICENSE the release workflow copies in lives here

const pkg = JSON.parse(readFileSync(join(FLEET_DIR, 'package.json'), 'utf8')) as {
  name: string;
  bin: Record<string, string> | string;
  files?: string[];
};

function npm(args: string[], cwd: string) {
  // Bounded: a hung pack/install must leave a result behind rather than hang the suite.
  return spawnSync('npm', args, { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
}

function run(bin: string, args: string[], cwd: string) {
  return spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('the published bin points at compiled JavaScript, never at TypeScript', () => {
  // The exact shape of the defect. A `.ts` entry point installs cleanly and fails on first use, so
  // the manifest is checked before anything is built or installed.
  const entries = typeof pkg.bin === 'string' ? { fleet: pkg.bin } : pkg.bin;
  assert.ok(Object.keys(entries).length > 0, 'the package must declare a bin entry');
  for (const [name, target] of Object.entries(entries)) {
    assert.ok(target.endsWith('.js'),
      `bin["${name}"] points at ${target}; Node cannot execute TypeScript under node_modules`);
    assert.ok(!target.startsWith('src/'), `bin["${name}"] points into sources: ${target}`);
  }
});

test('the package ships dist and not its own sources', () => {
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('dist/'),
    'files must ship dist/, otherwise the tarball carries no runnable code');
});

test('the installed package runs: --version, --help and a real registry command', () => {
  // Pack, install, execute. `prepare` builds dist/ during pack, so this also proves the publish
  // path builds -- a build wired only into a CI job would let `npm publish` ship an empty tarball.
  // The release workflow copies the repo LICENSE into the package before publishing, because
  // `files` lists LICENSE but the file lives at the repo root. Mirror that here so this test packs
  // what the release would pack, and so a missing licence is caught rather than shipped: a package
  // declaring `"license": "MIT"` with no LICENSE file is a real, if quiet, packaging defect.
  const licenseInPackage = join(FLEET_DIR, 'LICENSE');
  const copiedLicense = !existsSync(licenseInPackage);
  if (copiedLicense) copyFileSync(join(REPO_ROOT, 'LICENSE'), licenseInPackage);

  const packed = npm(['pack', '--silent'], FLEET_DIR);
  assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr?.slice(-400)}`);
  const tarball = readdirSync(FLEET_DIR).filter((f) => f.endsWith('.tgz')).sort();
  assert.ok(tarball.length > 0, 'npm pack produced no tarball');
  const tgz = join(FLEET_DIR, tarball[tarball.length - 1]);

  const prefix = mkdtempSync(join(tmpdir(), 'fleet-install-'));
  try {
    writeFileSync(join(prefix, 'package.json'), '{"name":"fleet-install-probe","private":true}');
    const installed = npm(['install', '--silent', '--no-audit', '--no-fund', '--no-save', tgz], prefix);
    assert.equal(installed.status, 0, `install failed: ${installed.stderr?.slice(-400)}`);

    const pkgDir = join(prefix, 'node_modules', '@aywengo', 'mercury-fleet');
    assert.ok(existsSync(pkgDir), 'the package did not install');

    // No raw TypeScript may reach a consumer.
    const shippedTs = readdirSync(pkgDir).filter((f) => f.endsWith('.ts'));
    assert.deepEqual(shippedTs, [], `the package shipped raw TypeScript sources: ${shippedTs.join(', ')}`);
    assert.ok(existsSync(join(pkgDir, 'dist', 'cli.js')), 'dist/cli.js is missing from the installed package');
    assert.ok(existsSync(join(pkgDir, 'LICENSE')),
      'the package declares "license": "MIT" but ships no LICENSE');

    const bin = join(prefix, 'node_modules', '.bin', 'fleet');
    assert.ok(existsSync(bin), 'the fleet bin link is missing');

    // This is the assertion the old suite could not make: the binary runs from node_modules.
    const version = run(bin, ['--version'], prefix);
    assert.equal(version.status, 0,
      `installed fleet --version exited ${version.status}: ${(version.stdout + version.stderr).slice(-500)}`);
    assert.match(version.stdout, new RegExp(`mercury-fleet ${FLEET_VERSION.replace(/\./g, '\\.')}`),
      `--version printed ${JSON.stringify(version.stdout)}`);

    const help = run(bin, ['--help'], prefix);
    assert.equal(help.status, 0, `installed fleet --help exited ${help.status}`);
    assert.match(help.stdout, /fleet hosts add/);

    // A command that touches the database, not just a banner: proves the compiled module graph
    // resolves at runtime, which is where a bad import specifier would surface.
    const dbFile = join(prefix, 'hosts.json');
    const list = run(bin, ['hosts', 'list', '--json', '--path', dbFile], prefix);
    assert.equal(list.status, 0,
      `installed fleet hosts list exited ${list.status}: ${(list.stdout + list.stderr).slice(-500)}`);
    assert.deepEqual(JSON.parse(list.stdout), { hosts: [] });
  } finally {
    rmSync(prefix, { recursive: true, force: true });
    for (const f of readdirSync(FLEET_DIR).filter((x) => x.endsWith('.tgz'))) rmSync(join(FLEET_DIR, f), { force: true });
    // Leave the tree as found: the copy exists only to mirror the release path.
    if (copiedLicense) rmSync(licenseInPackage, { force: true });
  }
});

// The Homebrew bundle is a second distribution artifact built from the same tree as the npm
// tarball, so it needs its own guard. client/test/packaging.test.ts covers the tarball; nothing
// there would notice the bundle shipping without node_modules (which makes `brew install`
// produce a command that cannot resolve express) or shipping devDependencies.
//
// The staged file list is derived from package.json "files", so these tests also fail if that
// derivation stops covering a bin target.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { tempDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// The bundler refuses to run without dist/, and it is right to: shipping a bundle without the
// compiled entry points is the failure that made #243 unrunnable once installed. That makes this
// file depend on a build it does not itself produce, so on a checkout where `npm ci` has not run
// the four tests below fail while CI -- which always installs -- stays green. Build it here rather
// than assume the caller did.
function ensureBuilt(): void {
  if (existsSync(join(ROOT, 'dist', 'src', 'cli.js')) && existsSync(join(ROOT, 'dist', 'client', 'bin.js'))) return;
  const build = spawnSync('npm', ['run', 'prepare'], { cwd: ROOT, encoding: 'utf8', timeout: 900_000 });
  assert.equal(build.status, 0, `preparing dist/ for the bundle tests failed: ${build.stdout}\n${build.stderr}`);
}
ensureBuilt();

function buildBundle(): { reportedSha: string; actualSha: string; tarballExists: boolean; names: string[] } {
  const out = tempDir('mercury-bundle-');
  try {
    const r = spawnSync(process.execPath, ['scripts/build-bundle.mjs', '--out', out],
      { cwd: ROOT, encoding: 'utf8', timeout: 1_200_000 });
    assert.equal(r.status, 0, `build-bundle.mjs failed: ${r.stdout}\n${r.stderr}`);
    const meta = JSON.parse(r.stdout.trim().split('\n').pop()!);
    const list = spawnSync('tar', ['-tzf', meta.tarball], { encoding: 'utf8', timeout: 300_000 });
    assert.equal(list.status, 0, `tar -tzf failed: ${list.stderr}`);
    // Read the bytes here: the temp dir is removed in `finally`, so a caller cannot open the
    // tarball afterwards. An earlier version of this helper returned the path and the sha256
    // test then failed on a file the helper itself had deleted.
    const exists = existsSync(meta.tarball);
    const actual = exists ? createHash('sha256').update(readFileSync(meta.tarball)).digest('hex') : '';
    return {
      reportedSha: meta.sha256,
      actualSha: actual,
      tarballExists: exists,
      names: list.stdout.split('\n').filter((l) => l.trim() && !l.endsWith('/')),
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test('the bundle ships every bin target and a package.json to describe them', () => {
  const { names } = buildBundle();
  assert.ok(names.some((n) => n.endsWith('package.json')), 'bundle has no package.json');
  for (const [name, target] of Object.entries<string>(pkg.bin ?? {})) {
    assert.ok(names.some((n) => n.endsWith(target)),
      `bundle is missing bin ${JSON.stringify(name)} -> ${target}; brew install would link nothing`);
  }
});

/**
 * Every package reachable from a PRODUCTION dependency's own tree, by name.
 *
 * The devDependency check below needs this because "a devDependency is in the bundle" is not by
 * itself evidence that --omit=dev stopped working: a production dependency may legitimately pull
 * one in. `@a2a-js/sdk` does exactly that -- it declares `@grpc/grpc-js` as an OPTIONAL peer for its
 * gRPC binding, npm resolves that peer from the lockfile (where the `testcontainers` devDependency
 * already put it) and installs its tree, and `protobufjs` in that tree requires `@types/node`.
 * Without this walk the guard would have to be deleted or allowlisted by hand.
 *
 * Walks `dependencies` AND `peerDependencies`, but only into entries the lockfile actually has:
 * npm resolves an optional peer from what is already in the tree, so a peer that is not in the
 * lockfile is not installed and must not make its own tree "reachable".
 */
function productionReachable(): Set<string> {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }>;
  };
  const reachable = new Set<string>();
  const queue: string[] = [...Object.keys(pkg.dependencies ?? {})];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry) continue;
    queue.push(...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.peerDependencies ?? {}));
  }
  return reachable;
}

test('the bundle vendors production dependencies but no devDependencies', () => {
  const { names } = buildBundle();
  assert.ok(names.some((n) => n.includes('/node_modules/')),
    'bundle ships no node_modules, so `brew install` yields a command that cannot resolve express');
  for (const prod of Object.keys(pkg.dependencies ?? {})) {
    assert.ok(names.some((n) => n.includes(`/node_modules/${prod}/`)),
      `production dependency ${prod} is not vendored`);
  }
  // A devDependency in the bundle means --omit=dev stopped working; typescript is the largest
  // one, so it is both the likely symptom and the expensive one. A devDependency a production
  // dependency's own tree requires is not that: it is a transitive production dependency that
  // happens to share a name with one of ours.
  const requiredByProd = productionReachable();
  // Guard the guard, both ways: a walk that reaches nothing would silently exempt every
  // devDependency, and one that reaches everything would never fail.
  assert.ok(requiredByProd.has('jose'), "the production walk must descend into a production dependency's own tree (jose is @a2a-js/sdk's runtime dependency)");
  assert.ok(!requiredByProd.has('typescript'), 'the production walk must not reach a dev-only tool, or it is walking everything');
  for (const dev of Object.keys(pkg.devDependencies ?? {})) {
    if (requiredByProd.has(dev)) continue;
    assert.ok(!names.some((n) => n.includes(`/node_modules/${dev}/`)),
      `devDependency ${dev} leaked into the bundle`);
  }
});

test('the bundle carries no test tree and no credentials', () => {
  const { names } = buildBundle();
  assert.ok(!names.some((n) => n.includes('client/test/')),
    'the client test tree leaked into the bundle (package.json "files" negation not honoured)');
  assert.ok(!names.some((n) => /(^|\/)credentials\.json$/i.test(n.split('/').pop() ?? '')),
    'a credentials file would be published with the bundle');
});

test('the reported sha256 is the sha256 of the artifact the formula will pin', () => {
  // The formula pins this digest. If the script ever printed a hash of something other than the
  // bytes it wrote, every `brew install` would fail checksum verification against a real artifact.
  const { reportedSha, actualSha, tarballExists } = buildBundle();
  assert.ok(tarballExists, 'build-bundle.mjs reported a tarball path that does not exist');
  assert.match(reportedSha, /^[0-9a-f]{64}$/, `reported sha256 is not a hex digest: ${reportedSha}`);
  assert.equal(reportedSha, actualSha, 'reported sha256 does not match the tarball bytes');
});

test('the bundle build refuses when package.json "files" names a path that does not exist', () => {
  // The guard matters because "files" is the single source of truth for what ships. If an entry is
  // renamed or deleted and the build silently stages what it found, the bundle is incomplete and
  // the breakage surfaces only after install -- the exact failure class as the original bin/files
  // bug. Asserted on a fixture root because in a real checkout every entry exists and the guard
  // would never fire.
  const root = tempDir('mercury-bundle-fixture-');
  const out = tempDir('mercury-bundle-fixture-out-');
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture', version: '1.2.3', bin: { fixture: 'dist/main.js' }, files: ['dist/', 'gone/'],
    }));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-bundle.mjs'), '--root', root, '--out', out],
      { encoding: 'utf8', timeout: 300_000 });
    assert.notEqual(r.status, 0, 'the build accepted a "files" entry that does not exist');
    assert.match(r.stderr, /gone\//, `expected the missing path to be named, got: ${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

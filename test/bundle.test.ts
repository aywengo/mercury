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

test('the bundle vendors production dependencies but no devDependencies', () => {
  const { names } = buildBundle();
  assert.ok(names.some((n) => n.includes('/node_modules/')),
    'bundle ships no node_modules, so `brew install` yields a command that cannot resolve express');
  for (const prod of Object.keys(pkg.dependencies ?? {})) {
    assert.ok(names.some((n) => n.includes(`/node_modules/${prod}/`)),
      `production dependency ${prod} is not vendored`);
  }
  // A devDependency in the bundle means --omit=dev stopped working; typescript is the largest
  // one, so it is both the likely symptom and the expensive one.
  for (const dev of Object.keys(pkg.devDependencies ?? {})) {
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

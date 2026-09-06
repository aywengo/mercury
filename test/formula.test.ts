// The Homebrew formula is generated at release time rather than hand-maintained, so these tests
// exercise the generator. A formula that does not load breaks every other formula in the tap, not
// just this one, and a wrong sha256 fails at the moment a user tries to install -- both are far
// cheaper to catch here than in the wild.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tempDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const GENERATOR = join(ROOT, 'scripts', 'update-formula.mjs');
const GOOD_SHA = 'a'.repeat(64);

function generate(args: string[]): { status: number | null; stdout: string; stderr: string; path: string } {
  const dir = tempDir('formula-');
  const path = join(dir, 'Formula', 'mercury-ai.rb');
  const r = spawnSync(process.execPath, [GENERATOR, '--formula', path, ...args],
    { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, path };
}

test('the generated formula names its class the way Homebrew derives it from the filename', () => {
  // Homebrew maps Formula/mercury-ai.rb to class MercuryAi. A mismatch is a load error that takes
  // down the whole tap, so the generator derives it rather than hard-coding it.
  const g = generate(['--version', '1.2.3', '--sha256', GOOD_SHA]);
  assert.equal(g.status, 0, `generator failed: ${g.stderr}`);
  const body = readFileSync(g.path, 'utf8');
  const expected = basename(g.path, '.rb').split(/[-_]/).map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
  assert.match(body, new RegExp(`^class ${expected} < Formula`),
    `expected "class ${expected} < Formula":\n${body.split('\n')[0]}`);
});

test('the url points at the asset the bundler actually produces, under the host tag', () => {
  // scripts/build-bundle.mjs writes mercury-<version>-bundle.tar.gz and the release is tagged
  // host-v<version>. If either name changes, every brew install 404s.
  const g = generate(['--version', '0.1.0-rc1', '--sha256', GOOD_SHA]);
  assert.equal(g.status, 0, g.stderr);
  const body = readFileSync(g.path, 'utf8');
  assert.match(body, /url "https:\/\/github\.com\/aywengo\/mercury\/releases\/download\/host-v0\.1\.0-rc1\/mercury-0\.1\.0-rc1-bundle\.tar\.gz"/);
});

test('a malformed sha256 is refused and nothing is written', () => {
  // Homebrew would reject this at install time with a checksum error that gives no hint the
  // formula was generated wrong. Refusing here is the cheap place to fail.
  for (const bad of ['nothex', 'A'.repeat(64), 'a'.repeat(63), '']) {
    const g = generate(['--version', '1.2.3', '--sha256', bad]);
    assert.notEqual(g.status, 0, `accepted a malformed sha256: ${JSON.stringify(bad)}`);
    assert.match(g.stderr, /sha256/, `expected the refusal to name sha256 for ${JSON.stringify(bad)}: ${g.stderr}`);
    assert.ok(!existsSync(g.path), `wrote a formula despite the bad sha256 ${JSON.stringify(bad)}`);
  }
});

test('an unusable version string is refused', () => {
  for (const bad of ['', ' 1.2.3', '-1.2.3', '1.2.3 /x']) {
    const g = generate(['--version', bad, '--sha256', GOOD_SHA]);
    assert.notEqual(g.status, 0, `accepted version ${JSON.stringify(bad)}`);
    assert.ok(!existsSync(g.path), `wrote a formula despite version ${JSON.stringify(bad)}`);
  }
});

test('the generated formula parses as ruby when ruby is available', () => {
  const g = generate(['--version', '1.2.3', '--sha256', GOOD_SHA]);
  assert.equal(g.status, 0, g.stderr);
  const meta = JSON.parse(g.stdout.trim().split('\n').pop()!);
  if (meta.rubySyntax === 'skipped (no ruby)') return; // CI images without ruby still get every check above
  assert.equal(meta.rubySyntax, 'ok');
  const check = spawnSync('ruby', ['-c', g.path], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(check.status, 0, `ruby -c failed:\n${check.stdout}\n${check.stderr}`);
});

test('the install block iterates package.json bin, so new commands cannot be forgotten', () => {
  // Hard-coding the command list is how a newly added bin would ship in the bundle but never get
  // linked by brew. Asserting the loop exists keeps that from regressing.
  const g = generate(['--version', '1.2.3', '--sha256', GOOD_SHA]);
  const body = readFileSync(g.path, 'utf8');
  assert.match(body, /pkg\.fetch\("bin"\)\.each/);
  // And the chmod that a real install proved necessary: entry points are mode 644 and
  // write_env_script execs them directly, so without this every command exits 126.
  assert.match(body, /target\.chmod 0755/);
});

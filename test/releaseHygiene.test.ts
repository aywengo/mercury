import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
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
  return [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])[0];
}

function spawnCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], {
      cwd: ROOT,
      env: { ...process.env },
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
  assert.equal(pkg.bin?.mercury, 'src/cli.ts');
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

test('the CLI release stream exists and agrees with package.json', () => {
  // This was "there is no CLI release stream yet", asserting docs/releases/cli/ stayed empty until
  // mercuryctl existed. mercuryctl exists, so the guard had become a lock on a door that should open --
  // and a `cli-v*` tag would still have failed the release workflow. Replaced rather than deleted, so
  // the directory is now checked for the thing that actually matters: a `cli-vX.Y.Z` tag resolves to
  // docs/releases/cli/X.Y.Z.md, so a version with no notes file must not be able to drift into being
  // taggable.
  const cliDir = join(ROOT, 'docs', 'releases', 'cli');
  assert.ok(existsSync(cliDir), 'docs/releases/cli/ must exist now that mercuryctl is published');
  const notes = join(cliDir, `${pkg.version}.md`);
  assert.ok(existsSync(notes), `docs/releases/cli/${pkg.version}.md must exist for a cli-v${pkg.version} tag`);

  const text = read(`docs/releases/cli/${pkg.version}.md`);
  assert.match(text, new RegExp(`mercuryctl ${pkg.version.replace(/\./g, '\\.')}`),
    'the CLI notes must name the version they describe');
  // The release workflow creates the GitHub release from this file alone, so an empty or stub file would
  // produce a published release with nothing in it.
  assert.ok(text.length > 500, `docs/releases/cli/${pkg.version}.md looks like a stub (${text.length} bytes)`);
  // A test count in a file that is never re-checked starts rotting the moment a test is added, and the
  // release body is generated from this file alone. The CI run for the tag is the record of what passed.
  assert.ok(!/\b\d{3,}\s+tests\b/i.test(text),
    'the CLI notes quote a test count; that number goes stale silently, so state the checks instead');
  // The client ships in the host package, so its version is the package version -- there is no independent
  // CLI version to keep in sync, and the notes must not imply one.
  assert.ok(!/cli-v\d+\.\d+\.\d+/.test(text),
    'the CLI notes name a specific cli-v tag; the version is owned by package.json');
});

test('mercury --version prints mercury-host <version> and does not start a server', async () => {
  const r = await spawnCli(['--version']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `mercury-host ${HOST_VERSION}\n`);
  assert.doesNotMatch(r.stdout, /fleet/);
});

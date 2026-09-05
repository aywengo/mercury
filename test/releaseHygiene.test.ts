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

test('there is no CLI release stream yet', () => {
  const cliDir = join(ROOT, 'docs', 'releases', 'cli');
  if (!existsSync(cliDir)) return;
  assert.equal(readdirSync(cliDir).length, 0, 'docs/releases/cli/ must stay empty until mercuryctl exists');
});

test('mercury --version prints mercury-host <version> and does not start a server', async () => {
  const r = await spawnCli(['--version']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `mercury-host ${HOST_VERSION}\n`);
  assert.doesNotMatch(r.stdout, /fleet/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { FLEET_PRODUCT, FLEET_VERSION } from '../version.ts';

const FLEET_DIR = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(FLEET_DIR, '..');
const CLI = join(FLEET_DIR, 'cli.ts');

const pkg = JSON.parse(readFileSync(join(FLEET_DIR, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};

function latestChangelogVersion(text: string): string | undefined {
  return [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])[0];
}

function fleet(args: string[]): Promise<{ code: number | null; stdout: string; out: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolvePromise({ code, stdout, out: stdout + stderr });
    });
  });
}

test('fleet/package.json is the public Fleet package and has no dependencies', () => {
  assert.equal(pkg.name, '@aywengo/mercury-fleet');
  assert.equal(pkg.version, FLEET_VERSION);
  assert.deepEqual(pkg.dependencies ?? {}, {});
});

test('FLEET_VERSION matches the Fleet changelog and notes file', () => {
  assert.equal(FLEET_PRODUCT, 'fleet');
  const heading = latestChangelogVersion(readFileSync(join(FLEET_DIR, 'CHANGELOG.md'), 'utf8'));
  assert.equal(heading, FLEET_VERSION, `fleet/CHANGELOG.md latest version ${heading} != ${FLEET_VERSION}`);
  assert.ok(existsSync(join(REPO_ROOT, 'docs', 'releases', 'fleet', `${FLEET_VERSION}.md`)),
    `docs/releases/fleet/${FLEET_VERSION}.md must exist`);
});

test('fleet --version prints mercury-fleet <version> only', async () => {
  const r = await fleet(['--version']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout, `mercury-fleet ${FLEET_VERSION}\n`);
  assert.doesNotMatch(r.stdout, /mercury-host/);
});

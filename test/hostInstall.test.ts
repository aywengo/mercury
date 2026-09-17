/**
 * `mercury host install` (docs/host-installer.md M1) — the npx-channel bootstrap.
 *
 * The M1 gate says `--dry-run` prints the exact action list and touches nothing. That is
 * the contract these tests pin: a dry run must not write the install log, and a real run
 * must. The command must also work on a host that is not configured yet, so it must not
 * require a database or config file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { tempDir } from './helpers.ts';

import {
  parseHostInstallArgs,
  buildActionList,
  checkPrereqs,
  nodeMeetsFloor,
  PACKAGE_NAME,
} from '../src/host/install.ts';

const ROOT = resolve(import.meta.dirname, '..');

function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
    });
    let stdout = ''; let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('error', rej);
    child.on('close', (code) => { clearTimeout(killer); res({ code, stdout, stderr }); });
  });
}

// ---------- argument parsing ----------

test('parseHostInstallArgs: defaults are dry-run off, yes off, non-interactive off', () => {
  const o = parseHostInstallArgs([]);
  assert.equal(o.dryRun, false);
  assert.equal(o.yes, false);
  assert.equal(o.nonInteractive, false);
  assert.equal(o.version, undefined);
});

test('parseHostInstallArgs: every flag parses', () => {
  const o = parseHostInstallArgs(['--dry-run', '--yes', '--non-interactive', '--version', '0.1.1']);
  assert.equal(o.dryRun, true);
  assert.equal(o.yes, true);
  assert.equal(o.nonInteractive, true);
  assert.equal(o.version, '0.1.1');
});

test('parseHostInstallArgs: --version without a value is an error', () => {
  assert.throws(() => parseHostInstallArgs(['--version']), /--version needs a value/);
});

test('parseHostInstallArgs: unknown flag is an error', () => {
  assert.throws(() => parseHostInstallArgs(['--bogus']), /unknown flag/);
});

// ---------- prerequisites ----------

test('nodeMeetsFloor: the running Node satisfies the engines floor', () => {
  assert.equal(nodeMeetsFloor(), true, 'tests run on Node >= 22.18.0');
});

test('checkPrereqs: returns node, curl and git in that order', () => {
  const prereqs = checkPrereqs();
  assert.deepEqual(prereqs.map((p) => p.name), ['node', 'curl', 'git']);
  for (const p of prereqs) {
    assert.equal(typeof p.ok, 'boolean');
    assert.equal(typeof p.detail, 'string');
  }
});

// ---------- action list ----------

test('buildActionList: dry-run lists every action including the pinned version', () => {
  const prereqs = checkPrereqs();
  const actions = buildActionList({ dryRun: true, yes: false, nonInteractive: false, version: '0.1.1' }, prereqs);
  assert.ok(actions.some((a) => a.includes(`install ${PACKAGE_NAME}@0.1.1`)), 'pinned version appears in the action list');
  assert.ok(actions.some((a) => a.includes('verify the installed package checksum')));
  assert.ok(actions.some((a) => a.includes('install.log')));
  assert.ok(actions.some((a) => a.includes('mercury host setup')));
});

// ---------- CLI behaviour ----------

test('host install --dry-run prints the action list and touches nothing', async () => {
  const state = tempDir('mercury-install-test-');
  const r = await cli(['host', 'install', '--dry-run'], { XDG_STATE_HOME: state });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mercury host install --dry-run/);
  assert.match(r.stdout, /check node:/);
  assert.match(r.stdout, /All prerequisites met; nothing was touched/);
  // The M1 gate: --dry-run touches nothing, including the install log.
  assert.equal(existsSync(join(state, 'mercury', 'install.log')), false,
    '--dry-run must not write the install log');
});

test('host install writes the structured install log', async () => {
  const state = tempDir('mercury-install-test-');
  const r = await cli(['host', 'install'], { XDG_STATE_HOME: state });
  assert.equal(r.code, 0, r.stderr);
  const logPath = join(state, 'mercury', 'install.log');
  assert.equal(existsSync(logPath), true, 'a real run must write the install log');
  const lines = readFileSync(logPath, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]!);
  assert.equal(first.event, 'host-install');
  assert.equal(first.dryRun, false);
  // One line per action, per the module contract.
  const actions = lines.filter((l) => JSON.parse(l).event === 'action');
  assert.ok(actions.length >= 4, 'the log must record one line per action');
  const last = JSON.parse(lines[lines.length - 1]!);
  assert.equal(last.event, 'install-complete');
});

test('host install with an unknown flag exits 1 with a message', async () => {
  const r = await cli(['host', 'install', '--bogus']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown flag/);
});

test('host install --version without a value exits 1', async () => {
  const r = await cli(['host', 'install', '--version']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--version needs a value/);
});

test('host install works without any config (no mercury.env, no database)', async () => {
  // The command must run on a machine that has never been configured. Run it from an
  // empty temp dir with no MERCURY_* env vars and a clean state dir.
  const state = tempDir('mercury-install-test-');
  const cwd = tempDir('mercury-empty-');
  const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>((res, rej) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'host', 'install', '--dry-run'], {
      cwd,
      env: { PATH: process.env.PATH ?? '', XDG_STATE_HOME: state },
    });
    let stdout = ''; let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('error', rej);
    child.on('close', (code) => { clearTimeout(killer); res({ code, stdout, stderr }); });
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /All prerequisites met/);
});

/**
 * `mercury host status|upgrade|uninstall` (docs/host-installer.md M5) — lifecycle.
 *
 * The M5 gate: install vN → upgrade vN+1 → uninstall leaves nothing but the opted-in
 * data dir; re-running on a configured host changes nothing without confirmation.
 * These tests pin the read-only status, the confirmation requirement, and the
 * uninstall behavior.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { tempDir } from './helpers.ts';
import { hostStatus, printStatus, envFilePath, dataDir } from '../src/host/lifecycle.ts';

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

function configuredEnv(dir: string): string {
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  const envFile = join(cfg, 'mercury', 'mercury.env');
  writeFileSync(envFile, 'MERCURY_ATLAS_HOST_ID=host-a\nMERCURY_DB=/data/mercury.db\nMERCURY_HARNESSES=primeagent,hermes\nMERCURY_PINNED_VERSION=0.1.1\n');
  return envFile;
}

// ---------- status ----------

test('hostStatus: unconfigured host reports configured:false', () => {
  const dir = tempDir('lifecycle-unconfig-');
  const s = hostStatus('linux', { XDG_CONFIG_HOME: join(dir, 'cfg'), HOME: join(dir, 'home') } as NodeJS.ProcessEnv);
  assert.equal(s.configured, false);
  assert.equal(s.harnesses.length, 0);
});

test('hostStatus: configured host reports version, harnesses and data dir', () => {
  const dir = tempDir('lifecycle-config-');
  const envFile = configuredEnv(dir);
  const s = hostStatus('linux', { XDG_CONFIG_HOME: join(dir, 'cfg'), HOME: join(dir, 'home') } as NodeJS.ProcessEnv);
  assert.equal(s.configured, true);
  assert.equal(s.envFile, envFile);
  assert.equal(s.version, '0.1.1');
  assert.deepEqual(s.harnesses, ['primeagent', 'hermes']);
  assert.equal(s.dataDir, '/data');
});

test('dataDir: dirname of MERCURY_DB', () => {
  assert.equal(dataDir({ MERCURY_DB: '/var/lib/mercury/mercury.db' }), '/var/lib/mercury');
});

test('printStatus: unconfigured prints a pointer to host setup', () => {
  const dir = tempDir('lifecycle-print-');
  const out: string[] = [];
  const s = hostStatus('linux', { XDG_CONFIG_HOME: join(dir, 'cfg'), HOME: join(dir, 'home') } as NodeJS.ProcessEnv);
  printStatus(s, { out: (x) => out.push(x) });
  assert.ok(out.join('').includes('mercury host setup'));
});

// ---------- the CLI surface ----------

test('host status is read-only and reports the configured state', async () => {
  const dir = tempDir('lifecycle-cli-');
  configuredEnv(dir);
  const { code, stdout } = await cli(['host', 'status'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    HOME: join(dir, 'home'),
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes('configured: yes'));
  assert.ok(stdout.includes('version:   0.1.1'));
  assert.ok(stdout.includes('harnesses: primeagent, hermes'));
});

test('host upgrade without --yes refuses to proceed', async () => {
  const dir = tempDir('lifecycle-upgrade-');
  configuredEnv(dir);
  const { code, stderr } = await cli(['host', 'upgrade', '--version', '0.2.0'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    HOME: join(dir, 'home'),
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('confirmation required'));
});

test('host upgrade on an unconfigured host fails with a pointer', async () => {
  const dir = tempDir('lifecycle-upgrade-unconfig-');
  const { code, stderr } = await cli(['host', 'upgrade', '--yes'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    HOME: join(dir, 'home'),
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('not configured'));
});

test('host uninstall without --yes refuses to proceed', async () => {
  const dir = tempDir('lifecycle-uninstall-');
  configuredEnv(dir);
  const { code, stderr } = await cli(['host', 'uninstall'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    HOME: join(dir, 'home'),
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('confirmation required'));
});

test('host uninstall rejects an unknown flag', async () => {
  const { code, stderr } = await cli(['host', 'uninstall', '--bogus']);
  assert.equal(code, 1);
  assert.ok(stderr.includes('unknown flag'));
});

test('host status on a configured host changes nothing (M5 gate: re-run is read-only)', async () => {
  const dir = tempDir('lifecycle-readonly-');
  const envFile = configuredEnv(dir);
  const before = await import('node:fs').then((fs) => fs.readFileSync(envFile, 'utf8'));
  const { code } = await cli(['host', 'status'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    HOME: join(dir, 'home'),
  });
  assert.equal(code, 0);
  const after = await import('node:fs').then((fs) => fs.readFileSync(envFile, 'utf8'));
  assert.equal(before, after, 'status must not modify mercury.env');
});

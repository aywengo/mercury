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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { tempDir } from './helpers.ts';
import { hostStatus, printStatus, envFilePath, dataDir, upgradeHost } from '../src/host/lifecycle.ts';

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
  writeFileSync(envFile, `MERCURY_ATLAS_HOST_ID=host-a\nMERCURY_DB=${join(dir, 'data', 'mercury.db')}\nMERCURY_HARNESSES=primeagent,hermes\nMERCURY_PINNED_VERSION=0.1.1\n`);
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
  assert.equal(s.dataDir, join(dir, 'data'));
});

test('dataDir: dirname of MERCURY_DB', () => {
  assert.equal(dataDir({ MERCURY_DB: '/var/lib/mercury/mercury.db' }), '/var/lib/mercury');
  assert.equal(dataDir({ MERCURY_DB: '/var/lib/mercury/state.sqlite' }), '/var/lib/mercury');
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

test('host upgrade without --version refuses (a pin must name a version)', async () => {
  const dir = tempDir('lifecycle-upgrade-noversion-');
  configuredEnv(dir);
  const { code, stderr } = await cli(['host', 'upgrade', '--yes'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    HOME: join(dir, 'home'),
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('--version'));
});

test('hostStatus: service presence is independent of mercury.env', () => {
  const dir = tempDir('lifecycle-service-');
  // No env file, but a systemd unit exists -> service present, configured false.
  const unitDir = join(dir, 'cfg', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'mercury.service'), '[Unit]\n');
  const s = hostStatus('linux', { XDG_CONFIG_HOME: join(dir, 'cfg'), HOME: join(dir, 'home') } as NodeJS.ProcessEnv);
  assert.equal(s.configured, false);
  assert.equal(s.service, 'present');
});

// ---------- upgrade happy path with a fake npm ----------

function fakeBin(dir: string, name: string, script: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), script, { mode: 0o755 });
  return bin;
}

test('host upgrade --yes --version runs npm install and pins the version', async () => {
  const dir = tempDir('lifecycle-upgrade-ok-');
  configuredEnv(dir);
  const calls: string[] = [];
  const bin = fakeBin(dir, 'npm', `#!/bin/sh\necho "$@" >> ${join(dir, 'npm-calls.txt')}\nexit 0\n`);
  const { code, stdout } = await cli(['host', 'upgrade', '--yes', '--version', '0.2.0'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    HOME: join(dir, 'home'),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes('Upgraded to 0.2.0'));
  const envFile = join(dir, 'cfg', 'mercury', 'mercury.env');
  const content = readFileSync(envFile, 'utf8');
  assert.ok(content.includes('MERCURY_PINNED_VERSION=0.2.0'));
  const npmCalls = readFileSync(join(dir, 'npm-calls.txt'), 'utf8');
  assert.ok(npmCalls.includes('install'));
  assert.ok(npmCalls.includes('@aywengo/mercury@0.2.0'));
});

test('host upgrade restarts the service when present (linux platform)', () => {
  const dir = tempDir('lifecycle-upgrade-restart-');
  configuredEnv(dir);
  const unitDir = join(dir, 'cfg', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'mercury.service'), '[Unit]\n');
  const bin = fakeBin(dir, 'npm', `#!/bin/sh\nexit 0\n`);
  const bin2 = fakeBin(dir, 'systemctl', `#!/bin/sh\necho "$@" >> ${join(dir, 'systemctl-calls.txt')}\nexit 0\n`);
  const out: string[] = [];
  const code = upgradeHost('linux', ['--yes', '--version', '0.2.0'], {
    out: (s) => out.push(s),
    err: (s) => out.push(s),
  }, { XDG_CONFIG_HOME: join(dir, 'cfg'), HOME: join(dir, 'home'), PATH: `${bin}:${bin2}:${process.env.PATH ?? ''}` } as NodeJS.ProcessEnv);
  assert.equal(code, 0);
  assert.ok(out.join('').includes('Service restarted'));
  const sc = readFileSync(join(dir, 'systemctl-calls.txt'), 'utf8');
  assert.ok(sc.includes('restart'));
});

// ---------- uninstall data-dir handling ----------

test('host uninstall --yes keeps the data dir by default', async () => {
  const dir = tempDir('lifecycle-uninstall-keep-');
  configuredEnv(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  const bin = fakeBin(dir, 'npm', `#!/bin/sh\nexit 0\n`);
  const { code, stdout } = await cli(['host', 'uninstall', '--yes'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    HOME: join(dir, 'home'),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes('Kept the data dir'));
});

test('host uninstall --yes --remove-data removes the data dir', async () => {
  const dir = tempDir('lifecycle-uninstall-remove-');
  configuredEnv(dir);
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'mercury.db'), 'x');
  const bin = fakeBin(dir, 'npm', `#!/bin/sh\nexit 0\n`);
  const { code, stdout } = await cli(['host', 'uninstall', '--yes', '--remove-data'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    HOME: join(dir, 'home'),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes('Removed the data dir'));
  assert.equal(existsSync(data), false);
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

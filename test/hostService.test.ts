/**
 * `mercury host service` (docs/host-installer.md M4) — the service generation.
 *
 * The M4 service contract: the unit is deterministic (same inputs → same text), loads
 * mercury.env the same way the deploy/ units do, and --dry-run writes nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { tempDir } from './helpers.ts';
import {
  systemdUnit,
  launchdPlist,
  launchdWrapper,
  systemdUnitPath,
  launchdPlistPath,
  launchdWrapperPath,
  envFilePath,
  parseServiceArgs,
  resolveMercuryBin,
  SERVICE_NAME,
  LAUNCHD_LABEL,
} from '../src/host/service.ts';

const ROOT = resolve(import.meta.dirname, '..');

// ---------- unit text ----------

test('systemdUnit: deterministic, loads mercury.env, runs the resolved binary', () => {
  const unit = systemdUnit('/home/u/.local/bin/mercury', '/home/u/.config/mercury/mercury.env');
  assert.ok(unit.includes('EnvironmentFile=/home/u/.config/mercury/mercury.env'));
  assert.ok(unit.includes('ExecStart=/home/u/.local/bin/mercury server'));
  assert.ok(unit.includes('Environment=MERCURY_EMBEDDED_WORKER=true'));
  assert.ok(unit.includes('WantedBy=default.target'));
  // Deterministic: same inputs -> same text.
  assert.equal(unit, systemdUnit('/home/u/.local/bin/mercury', '/home/u/.config/mercury/mercury.env'));
});

test('launchdPlist: deterministic, runs the wrapper, logs to the state dir', () => {
  const plist = launchdPlist('/tmp/state/mercury/run-host.sh', '/tmp/state');
  assert.ok(plist.includes(`<string>${LAUNCHD_LABEL}</string>`));
  assert.ok(plist.includes('<string>/tmp/state/mercury/run-host.sh</string>'));
  assert.ok(plist.includes('<string>/tmp/state/mercury/host.log</string>'));
  assert.ok(plist.includes('<key>RunAtLoad</key>'));
  assert.ok(plist.includes('<key>KeepAlive</key>'));
  assert.equal(plist, launchdPlist('/tmp/state/mercury/run-host.sh', '/tmp/state'));
});

test('launchdWrapper: sources mercury.env and execs the binary', () => {
  const w = launchdWrapper('/home/u/.local/bin/mercury', '/home/u/.config/mercury/mercury.env');
  assert.ok(w.includes('source "/home/u/.config/mercury/mercury.env"'));
  assert.ok(w.includes('exec "/home/u/.local/bin/mercury" server'));
  assert.ok(w.includes('MERCURY_EMBEDDED_WORKER=true'));
});

// ---------- paths ----------

test('paths: env file, unit, plist and wrapper resolve under XDG dirs', () => {
  const env = { XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: '/state' } as NodeJS.ProcessEnv;
  assert.equal(envFilePath(env), '/cfg/mercury/mercury.env');
  assert.equal(systemdUnitPath(env), '/cfg/systemd/user/mercury.service');
  assert.equal(launchdWrapperPath(env), '/state/mercury/run-host.sh');
  // launchd plist is always in ~/Library/LaunchAgents.
  assert.ok(launchdPlistPath(env).endsWith('Library/LaunchAgents/com.mercury.host.plist'));
});

// ---------- args ----------

test('parseServiceArgs: --dry-run parses; unknown flag is an error', () => {
  assert.equal(parseServiceArgs(['--dry-run']).dryRun, true);
  assert.equal(parseServiceArgs([]).dryRun, false);
  assert.throws(() => parseServiceArgs(['--bogus']), /unknown flag/);
});

test('resolveMercuryBin returns an absolute path, never a bare name', () => {
  const bin = resolveMercuryBin();
  assert.ok(bin.includes('/'), `expected an absolute path, got '${bin}'`);
  assert.notEqual(bin, 'mercury');
});

// ---------- the CLI surface ----------

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

test('host service install --dry-run prints the unit and writes nothing', async () => {
  const dir = tempDir('service-dryrun-');
  const { code, stdout } = await cli(['host', 'service', 'install', '--dry-run'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    XDG_STATE_HOME: join(dir, 'state'),
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes('--dry-run'));
  assert.ok(stdout.includes('com.mercury.host') || stdout.includes('mercury.service'));
  // Nothing written.
  assert.ok(!existsSync(join(dir, 'cfg', 'systemd')), 'no systemd unit written');
  assert.ok(!existsSync(join(dir, 'state', 'mercury')), 'no wrapper written');
});

test('host service install without mercury.env fails with a message', async () => {
  const dir = tempDir('service-noenv-');
  const { code, stderr } = await cli(['host', 'service', 'install'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    XDG_STATE_HOME: join(dir, 'state'),
    HOME: join(dir, 'home'),
  });
  assert.equal(code, 1);
  assert.ok(stderr.includes('does not exist'));
});

test('host service rejects an unknown subcommand', async () => {
  const { code, stderr } = await cli(['host', 'service', 'bogus']);
  assert.equal(code, 1);
  assert.ok(stderr.includes('unknown subcommand'));
});

test('host service status rejects extra flags', async () => {
  const { code, stderr } = await cli(['host', 'service', 'status', '--dry-run']);
  assert.equal(code, 1);
  assert.ok(stderr.includes('unknown flag'));
});

test('macOS load is idempotent: print -> bootout (if loaded) -> bootstrap, exit 0 on re-run (#650)', async () => {
  const dir = tempDir('service-launchctl-');
  // A fake launchctl that records its argv and mimics the real exit codes:
  //   print  -> exit 0 when the agent is loaded (env says so), non-zero otherwise
  //   bootout/bootstrap -> exit 0
  const bin = join(dir, 'fakebin');
  mkdirSync(bin, { recursive: true });
  const launchctl = join(bin, 'launchctl');
  writeFileSync(launchctl, `#!/bin/sh
printf '%s\n' "$*" >> "$LAUNCHCTL_LOG"
case "$1" in
  print) [ "$LAUNCHCTL_LOADED" = "1" ] && exit 0 || exit 1 ;;
  bootout|bootstrap) exit 0 ;;
  *) exit 0 ;;
esac
`);
  chmodSync(launchctl, 0o755);
  // A fake `which` so resolveMercuryBin succeeds without the real toolchain.
  writeFileSync(join(bin, 'which'), '#!/bin/sh\necho /fake/mercury\n');
  chmodSync(join(bin, 'which'), 0o755);
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'mercury'), { recursive: true });
  writeFileSync(join(home, '.config', 'mercury', 'mercury.env'), 'MERCURY_PORT=3999\n');
  const env = {
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(dir, 'state'),
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    LAUNCHCTL_LOG: join(dir, 'launchctl.log'),
  };
  // First install: nothing loaded -> no bootout, straight bootstrap.
  let r = await runInstall(env, '0');
  assert.equal(r.code, 0, r.stderr);
  let log = readFileSync(join(dir, 'launchctl.log'), 'utf8');
  assert.ok(log.includes('print gui/'), 'the loaded state is checked first');
  assert.ok(!log.includes('bootout'), 'no bootout when not loaded');
  assert.ok(log.includes('bootstrap gui/'), 'bootstrap loads the agent');
  // Second install with the agent "loaded": print succeeds -> bootout -> bootstrap. Exit 0 (the #650 bug exited 1).
  r = await runInstall(env, '1');
  assert.equal(r.code, 0, `re-run must be idempotent: ${r.stderr}`);
  log = readFileSync(join(dir, 'launchctl.log'), 'utf8');
  assert.ok(log.includes('bootout gui/'), 'bootout runs when the agent is loaded');
  assert.ok(log.includes('bootstrap gui/'), 'bootstrap follows the bootout');
  // And the plist was (re)written in the (temp) home.
  assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'com.mercury.host.plist')));
});

async function runInstall(env: NodeJS.ProcessEnv, loaded: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'host', 'service', 'install'], {
      cwd: ROOT,
      env: { ...env, LAUNCHCTL_LOADED: loaded },
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

test('host service status reports absent when nothing is installed', async () => {
  const dir = tempDir('service-status-');
  const { code, stdout } = await cli(['host', 'service', 'status'], {
    XDG_CONFIG_HOME: join(dir, 'cfg'),
    XDG_STATE_HOME: join(dir, 'state'),
    HOME: join(dir, 'home'),
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes('absent') || stdout.includes('not installed'));
});

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
  systemdWorkerUnit,
  launchdPlist,
  launchdWorkerPlist,
  launchdWrapper,
  launchdWorkerWrapper,
  systemdUnitPath,
  systemdWorkerUnitPath,
  launchdPlistPath,
  launchdWorkerPlistPath,
  launchdWrapperPath,
  launchdWorkerWrapperPath,
  envFilePath,
  parseServiceArgs,
  installService,
  resolveMercuryBin,
  SERVICE_NAME,
  WORKER_SERVICE_NAME,
  LAUNCHD_LABEL,
  LAUNCHD_WORKER_LABEL,
} from '../src/host/service.ts';

const ROOT = resolve(import.meta.dirname, '..');

// ---------- unit text ----------

test('systemdUnit: deterministic, loads mercury.env, runs the resolved binary', () => {
  const unit = systemdUnit('/home/u/.local/bin/mercury', '/home/u/.config/mercury/mercury.env');
  assert.ok(unit.includes('EnvironmentFile=/home/u/.config/mercury/mercury.env'));
  assert.ok(unit.includes('ExecStart=/home/u/.local/bin/mercury server'));
  // A user unit does not read a shell profile, so the harness in ~/.local/bin is invisible
  // unless the unit says so (issue #1074).
  assert.ok(unit.includes('Environment=PATH=/home/u/.local/bin:%h/.local/bin:'), 'the unit sets PATH');
  // `server` does not claim Runs (issue #1071), so a flag claiming otherwise would lie.
  assert.ok(!unit.includes('MERCURY_EMBEDDED_WORKER'));
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
  assert.ok(w.includes('export PATH="/home/u/.local/bin:$HOME/.local/bin:'), 'the wrapper exports PATH');
  assert.ok(!w.includes('MERCURY_EMBEDDED_WORKER'));
});

test('systemdWorkerUnit: a second unit runs `mercury worker`, because `server` never claims Runs (#1071)', () => {
  const unit = systemdWorkerUnit('/home/u/.local/bin/mercury', '/home/u/.config/mercury/mercury.env');
  assert.ok(unit.includes('EnvironmentFile=/home/u/.config/mercury/mercury.env'));
  assert.ok(unit.includes('ExecStart=/home/u/.local/bin/mercury worker'));
  assert.ok(unit.includes('Environment=PATH=/home/u/.local/bin:%h/.local/bin:'), 'the worker unit sets PATH too');
  assert.ok(unit.includes('Restart=on-failure'));
  // The deploy/ unit's graceful-shutdown budget: SIGTERM requeues the in-flight Run (issue #51).
  assert.ok(unit.includes('TimeoutStopSec=45'));
  assert.equal(unit, systemdWorkerUnit('/home/u/.local/bin/mercury', '/home/u/.config/mercury/mercury.env'));
});

test('launchdWorkerPlist and launchdWorkerWrapper: the worker agent has its own label, log and command', () => {
  const plist = launchdWorkerPlist('/tmp/state/mercury/run-worker.sh', '/tmp/state');
  assert.ok(plist.includes(`<string>${LAUNCHD_WORKER_LABEL}</string>`));
  assert.ok(plist.includes('<string>/tmp/state/mercury/run-worker.sh</string>'));
  assert.ok(plist.includes('<string>/tmp/state/mercury/worker.log</string>'));
  const w = launchdWorkerWrapper('/home/u/.local/bin/mercury', '/home/u/.config/mercury/mercury.env');
  assert.ok(w.includes('exec "/home/u/.local/bin/mercury" worker'));
  assert.ok(w.includes('source "/home/u/.config/mercury/mercury.env"'));
  assert.ok(w.includes('export PATH="/home/u/.local/bin:$HOME/.local/bin:'), 'the worker wrapper exports PATH');
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
  // The dry run names the worker too: a host with only the host unit claims nothing (#1071).
  assert.ok(stdout.includes('com.mercury.worker') || stdout.includes('mercury-worker'));
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
  writeFileSync(join(bin, 'launchctl'), `#!/bin/sh
printf '%s\n' "$*" >> "$LAUNCHCTL_LOG"
case "$1" in
  print) [ "$LAUNCHCTL_LOADED" = "1" ] && exit 0 || exit 1 ;;
  bootout|bootstrap) exit 0 ;;
  *) exit 0 ;;
esac
`);
  chmodSync(join(bin, 'launchctl'), 0o755);
  // A fake `which` so resolveMercuryBin succeeds without the real toolchain.
  writeFileSync(join(bin, 'which'), '#!/bin/sh\necho /fake/mercury\n');
  chmodSync(join(bin, 'which'), 0o755);
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'mercury'), { recursive: true });
  writeFileSync(join(home, '.config', 'mercury', 'mercury.env'), 'MERCURY_PORT=3999\n');
  const io = { out: () => {}, err: () => {} };
  const env = {
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(dir, 'state'),
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    LAUNCHCTL_LOG: join(dir, 'launchctl.log'),
  };
  const savedPath = process.env.PATH;
  process.env.PATH = env.PATH;
  const savedLog = process.env.LAUNCHCTL_LOG;
  process.env.LAUNCHCTL_LOG = env.LAUNCHCTL_LOG;
  // launchdPlistPath() reads os.homedir() from the environment at call time — point it
  // at the temp home so the test never writes the real ~/Library.
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // installService is called directly with platform='darwin' — the CLI dispatch passes
    // process.platform, so the in-process call is the unit boundary that owns the choreography.
    // First install: nothing loaded -> no bootout, straight bootstrap. The EXACT call
    // order is pinned (Copilot review on #657): print -> bootstrap, nothing else.
    let code = installService('darwin', io, env as NodeJS.ProcessEnv, false);
    assert.equal(code, 0, 'first install exits 0');
    const firstCalls = readFileSync(join(dir, 'launchctl.log'), 'utf8').trim().split('\n');
    assert.deepEqual(
      firstCalls.map((l) => l.split(' ')[0]),
      ['print', 'bootstrap', 'print', 'bootstrap'],
      'first install: the host agent then the worker agent, print (loaded state) then bootstrap each',
    );
    assert.ok(firstCalls[0]!.includes('print gui/'), 'print targets the gui domain label');
    assert.ok(firstCalls[1]!.startsWith('bootstrap gui/'), 'bootstrap loads the agent');
    assert.ok(firstCalls[2]!.includes(LAUNCHD_WORKER_LABEL), 'the second agent is the worker');
    assert.ok(firstCalls[3]!.endsWith('com.mercury.worker.plist'), 'bootstrap loads the worker plist');
    // Second install with the agent "loaded": print ok -> bootout -> bootstrap. Exit 0 (the #650 bug exited 1).
    process.env.LAUNCHCTL_LOADED = '1';
    code = installService('darwin', io, env as NodeJS.ProcessEnv, false);
    assert.equal(code, 0, `re-run must be idempotent (the #650 bug exited 1 here)`);
    const secondCalls = readFileSync(join(dir, 'launchctl.log'), 'utf8').trim().split('\n').slice(firstCalls.length);
    assert.deepEqual(
      secondCalls.map((l) => l.split(' ')[0]),
      ['print', 'bootout', 'bootstrap', 'print', 'bootout', 'bootstrap'],
      're-run: print -> bootout -> bootstrap for each agent, in that order, nothing else',
    );
    // And both plists were (re)written in the (temp) home.
    assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'com.mercury.host.plist')));
    assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'com.mercury.worker.plist')));
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedLog === undefined) delete process.env.LAUNCHCTL_LOG; else process.env.LAUNCHCTL_LOG = savedLog;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    delete process.env.LAUNCHCTL_LOADED;
  }
});

test('linux install writes and enables BOTH units: the host and the worker (#1071)', async () => {
  // The regression this pins: `mercury host service install` used to write one unit that ran
  // `mercury server` with MERCURY_EMBEDDED_WORKER=true. `server` ignores that flag (only `dev`
  // honours it), so the installed host accepted Runs and claimed none — the smoke Run in
  // `host doctor` stayed QUEUED until it timed out. A fresh host must get a worker unit.
  const dir = tempDir('service-linux-');
  const bin = join(dir, 'fakebin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'which'), '#!/bin/sh\necho /fake/mercury\n');
  chmodSync(join(bin, 'which'), 0o755);
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
exit 0
`);
  chmodSync(join(bin, 'systemctl'), 0o755);
  const cfg = join(dir, 'cfg');
  mkdirSync(join(cfg, 'mercury'), { recursive: true });
  writeFileSync(join(cfg, 'mercury', 'mercury.env'), 'MERCURY_PORT=3999\n');
  const log = join(dir, 'systemctl.log');
  const env = {
    XDG_CONFIG_HOME: cfg,
    XDG_STATE_HOME: join(dir, 'state'),
    HOME: join(dir, 'home'),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    SYSTEMCTL_LOG: log,
  };
  const savedPath = process.env.PATH;
  process.env.PATH = env.PATH;
  const savedLog = process.env.SYSTEMCTL_LOG;
  process.env.SYSTEMCTL_LOG = log;
  try {
    const code = installService('linux', { out: () => {}, err: () => {} }, env as NodeJS.ProcessEnv, false);
    assert.equal(code, 0);
    const units = join(cfg, 'systemd', 'user');
    assert.ok(existsSync(join(units, 'mercury.service')), 'the host unit is written');
    assert.ok(existsSync(join(units, 'mercury-worker.service')), 'the worker unit is written (#1071)');
    assert.ok(readFileSync(join(units, 'mercury-worker.service'), 'utf8').includes(' worker'));
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(calls.includes('--user enable --now mercury.service'), 'the host unit is enabled');
    assert.ok(calls.includes('--user enable --now mercury-worker.service'), 'the worker unit is enabled (#1071)');
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedLog === undefined) delete process.env.SYSTEMCTL_LOG; else process.env.SYSTEMCTL_LOG = savedLog;
  }
});

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

/**
 * `mercury host service` — the M4 service generation (docs/host-installer.md M4).
 *
 * Generates and enables the user-scoped services that run the host. There are two,
 * because `mercury server` never claims Runs (the boundary in AGENTS.md: the web server
 * does not execute agents outside `dev`):
 *
 *   - macOS: launchd agents at `~/Library/LaunchAgents/com.mercury.host.plist` and
 *     `com.mercury.worker.plist`, which run wrapper scripts that source `mercury.env`
 *     (launchd has no EnvironmentFile) and exec `mercury server` and `mercury worker`.
 *   - Linux: systemd user units `mercury.service` and `mercury-worker.service` with an
 *     ABSOLUTE `EnvironmentFile=` path (safer than `%h/...` given `XDG_CONFIG_HOME`
 *     handling — the docstring and systemdUnit() must agree, issue #650), enabled
 *     with `systemctl --user enable --now` (plus a `loginctl enable-linger` hint).
 *
 * The worker unit is not optional: a host whose only unit runs `server` accepts Runs
 * forever and executes none (issue #1071, found by the #929 fresh-host run).
 *
 * Both load `mercury.env` the same way the production units in `deploy/` do
 * (EnvironmentFile), and both run the installed `mercury` binary, never a bare name
 * resolved through PATH at runtime.
 *
 * Three rules this file exists to enforce:
 *
 * 1. **It never requires a configured host to generate.** `--dry-run` prints the unit
 *    without writing or enabling anything.
 * 2. **The unit is deterministic.** Same inputs → same unit text, so tests can pin it
 *    byte-for-byte and a re-run changes nothing.
 * 3. **Enabling is explicit and reversible.** `install` writes + enables; `uninstall`
 *    stops + disables + removes. `status` reports what exists.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** The service name used in unit ids and file names. */
export const SERVICE_NAME = 'mercury';

/** The launchd label (macOS). */
export const LAUNCHD_LABEL = 'com.mercury.host';

/** The worker unit id (systemd). A second unit, because `server` never claims Runs. */
export const WORKER_SERVICE_NAME = 'mercury-worker';

/** The worker launchd label (macOS). */
export const LAUNCHD_WORKER_LABEL = 'com.mercury.worker';

/**
 * Resolve the installed mercury binary: `which mercury`, else the npm global bin.
 * NEVER returns a bare name: the generated unit must not depend on PATH resolution
 * at runtime (review #635). Throws when the binary cannot be resolved.
 */
export function resolveMercuryBin(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const which = execFileSync('which', ['mercury'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (which) return which;
  } catch {
    // fall through to npm prefix
  }
  try {
    const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (prefix) return join(prefix, 'bin', 'mercury');
  } catch {
    // fall through to the throw below
  }
  throw new Error('cannot resolve the mercury binary (which mercury and npm prefix -g both failed); install the package first');
}

/** The env file path the wizard writes (M3). */
export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'mercury', 'mercury.env');
}

/** The systemd user unit path (Linux). */
export function systemdUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'systemd', 'user', `${SERVICE_NAME}.service`);
}

/** The worker systemd user unit path (Linux). */
export function systemdWorkerUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'systemd', 'user', `${WORKER_SERVICE_NAME}.service`);
}

/** The launchd plist path (macOS). */
export function launchdPlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/** The worker launchd plist path (macOS). */
export function launchdWorkerPlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_WORKER_LABEL}.plist`);
}

/** The launchd wrapper script path (macOS): sources mercury.env, execs mercury server. */
export function launchdWrapperPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(base, 'mercury', 'run-host.sh');
}

/** The worker's launchd wrapper script path (macOS): sources mercury.env, execs mercury worker. */
export function launchdWorkerWrapperPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(base, 'mercury', 'run-worker.sh');
}

/**
 * The `PATH` the generated services run with.
 *
 * Neither a systemd user unit nor a launchd agent reads a shell profile, so neither inherits
 * `~/.local/bin` — which is where the npm installer puts `mercury` and where a harness installer
 * puts `prime-agent`. Without it the worker spawns the agent, gets ENOENT, and every Run fails
 * with exit code 127 (issue #1074). The resolved binary's own directory comes first, so the
 * `mercury` the unit starts is the one `which mercury` found.
 *
 * `homeVar` is the platform's home placeholder: `%h` for systemd, `$HOME` for a shell wrapper.
 */
export function servicePath(mercuryBin: string, homeVar: string): string {
  const dirs = [dirname(mercuryBin), `${homeVar}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin'];
  return [...new Set(dirs)].join(':');
}

/** The systemd user unit text. Deterministic for the same inputs. */
export function systemdUnit(mercuryBin: string, envFile: string): string {
  return `[Unit]
Description=Mercury host (durable run orchestration)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
EnvironmentFile=${envFile}
Environment=PATH=${servicePath(mercuryBin, '%h')}
ExecStart=${mercuryBin} server
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;
}

/**
 * The worker unit text. Separate from the host unit because `mercury server` does not
 * claim Runs: `MERCURY_EMBEDDED_WORKER` is honoured only for `dev` (issue #1071).
 * `TimeoutStopSec` matches deploy/mercury-worker.service: SIGTERM stops claiming,
 * signals the in-flight agent and requeues, and needs room for that (issue #51).
 */
export function systemdWorkerUnit(mercuryBin: string, envFile: string): string {
  return `[Unit]
Description=Mercury worker (claims and executes Runs)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
EnvironmentFile=${envFile}
Environment=PATH=${servicePath(mercuryBin, '%h')}
ExecStart=${mercuryBin} worker
Restart=on-failure
RestartSec=5
TimeoutStopSec=45

[Install]
WantedBy=default.target
`;
}

/** The launchd wrapper script text: sources mercury.env, execs mercury server. */
export function launchdWrapper(mercuryBin: string, envFile: string): string {
  return `#!/bin/bash
# Generated by \`mercury host service install\` (docs/host-installer.md M4).
# launchd has no EnvironmentFile, so this wrapper sources mercury.env the same way
# the systemd units in deploy/ load it, then execs the installed mercury binary.
set -a
source "${envFile}"
set +a
# launchd does not read a shell profile, so the user's bin is not on PATH (issue #1074).
export PATH="${servicePath(mercuryBin, '$HOME')}:$PATH"
exec "${mercuryBin}" server
`;
}

/** The worker's launchd wrapper script text. */
export function launchdWorkerWrapper(mercuryBin: string, envFile: string): string {
  return `#!/bin/bash
# Generated by \`mercury host service install\` (docs/host-installer.md M4).
# The worker is a separate process: \`mercury server\` never claims Runs (#1071).
set -a
source "${envFile}"
set +a
# launchd does not read a shell profile, so the user's bin is not on PATH (issue #1074).
export PATH="${servicePath(mercuryBin, '$HOME')}:$PATH"
exec "${mercuryBin}" worker
`;
}

/** The launchd plist text. Deterministic for the same inputs. */
export function launchdPlist(wrapper: string, stateDir: string): string {
  return launchdPlistText(LAUNCHD_LABEL, wrapper, join(stateDir, 'mercury', 'host.log'));
}

/** The worker's plist text: same shape, its own label and log file. */
export function launchdWorkerPlist(wrapper: string, stateDir: string): string {
  return launchdPlistText(LAUNCHD_WORKER_LABEL, wrapper, join(stateDir, 'mercury', 'worker.log'));
}

function launchdPlistText(label: string, wrapper: string, log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${wrapper}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

export interface ServiceOptions {
  dryRun: boolean;
}

export function parseServiceArgs(args: string[]): ServiceOptions {
  const opts: ServiceOptions = { dryRun: false };
  for (const a of args) {
    if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`host service: unknown flag '${a}'. Expected --dry-run`);
  }
  return opts;
}

/** Install the service: write the unit (and wrapper on macOS), enable it. */
export function installService(
  platform: NodeJS.Platform,
  io: { out: (s: string) => void; err: (s: string) => void },
  env: NodeJS.ProcessEnv = process.env,
  dryRun = false,
): number {
  let bin: string;
  try {
    bin = resolveMercuryBin(env);
  } catch (e) {
    io.err(`host service: ${(e as Error).message}\n`);
    return 1;
  }
  const envFile = envFilePath(env);
  if (platform === 'darwin') {
    const wrapper = launchdWrapperPath(env);
    const plist = launchdPlistPath(env);
    const workerWrapper = launchdWorkerWrapperPath(env);
    const workerPlist = launchdWorkerPlistPath(env);
    const stateDir = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
    if (dryRun) {
      io.out('mercury host service install --dry-run (macOS)\n');
      io.out(`  host wrapper:   ${wrapper}\n`);
      io.out(`  host plist:     ${plist}\n`);
      io.out(`  worker wrapper: ${workerWrapper}\n`);
      io.out(`  worker plist:   ${workerPlist}\n`);
      io.out(launchdPlist(wrapper, stateDir) + '\n');
      io.out(launchdWorkerPlist(workerWrapper, stateDir) + '\n');
      return 0;
    }
    if (!existsSync(envFile)) {
      io.err(`host service: ${envFile} does not exist. Run \`mercury host setup\` first (M3).\n`);
      return 1;
    }
    mkdirSync(join(stateDir, 'mercury'), { recursive: true });
    writeFileSync(wrapper, launchdWrapper(bin, envFile), { mode: 0o700 });
    chmodSync(wrapper, 0o700);
    writeFileSync(workerWrapper, launchdWorkerWrapper(bin, envFile), { mode: 0o700 });
    chmodSync(workerWrapper, 0o700);
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plist, launchdPlist(wrapper, stateDir), { mode: 0o644 });
    writeFileSync(workerPlist, launchdWorkerPlist(workerWrapper, stateDir), { mode: 0o644 });
    try {
      // Idempotent load (issue #650): `launchctl load` returns non-zero when the agent
      // is already loaded, which made a plain re-run exit 1. The modern API
      // (bootstrap/bootout, macOS 10.11+) is made idempotent by checking the loaded
      // state first: bootout only when print shows the label, then bootstrap fresh.
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (uid === null) throw new Error('cannot determine uid for launchctl gui domain');
      for (const [label, agentPlist] of [
        [LAUNCHD_LABEL, plist],
        [LAUNCHD_WORKER_LABEL, workerPlist],
      ] as const) {
        const target = `gui/${uid}/${label}`;
        let loaded = true;
        try {
          execFileSync('launchctl', ['print', target], { timeout: 10000, stdio: 'ignore' });
        } catch {
          loaded = false;
        }
        if (loaded) {
          try {
            execFileSync('launchctl', ['bootout', target], { timeout: 10000, stdio: 'ignore' });
          } catch {
            // bootout raced with an unload; bootstrap below decides success
          }
        }
        execFileSync('launchctl', ['bootstrap', `gui/${uid}`, agentPlist], { timeout: 10000 });
      }
      io.out(`Installed and loaded ${LAUNCHD_LABEL} (${plist}) and ${LAUNCHD_WORKER_LABEL} (${workerPlist}).\n`);
    } catch (e) {
      io.err(`host service: launchctl bootstrap failed: ${(e as Error).message}\n`);
      return 1;
    }
    return 0;
  }
  // Linux (systemd user units: host and worker)
  const unitPath = systemdUnitPath(env);
  const workerUnitPath = systemdWorkerUnitPath(env);
  if (dryRun) {
    io.out('mercury host service install --dry-run (systemd user)\n');
    io.out(`  unit:        ${unitPath}\n`);
    io.out(`  worker unit: ${workerUnitPath}\n`);
    io.out(systemdUnit(bin, envFile) + '\n');
    io.out(systemdWorkerUnit(bin, envFile) + '\n');
    return 0;
  }
  if (!existsSync(envFile)) {
    io.err(`host service: ${envFile} does not exist. Run \`mercury host setup\` first (M3).\n`);
    return 1;
  }
  mkdirSync(join(unitPath, '..'), { recursive: true });
  writeFileSync(unitPath, systemdUnit(bin, envFile), { mode: 0o644 });
  writeFileSync(workerUnitPath, systemdWorkerUnit(bin, envFile), { mode: 0o644 });
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { timeout: 10000 });
    for (const unit of [`${SERVICE_NAME}.service`, `${WORKER_SERVICE_NAME}.service`]) {
      execFileSync('systemctl', ['--user', 'enable', '--now', unit], { timeout: 10000 });
    }
    io.out(`Installed and enabled ${SERVICE_NAME}.service and ${WORKER_SERVICE_NAME}.service (${unitPath}).\n`);
    io.out('Hint: run `loginctl enable-linger $USER` so the unit survives logout.\n');
  } catch (e) {
    io.err(`host service: systemctl failed: ${(e as Error).message}\n`);
    return 1;
  }
  return 0;
}

/** Report service status. */
export function serviceStatus(
  platform: NodeJS.Platform,
  io: { out: (s: string) => void; err: (s: string) => void },
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (platform === 'darwin') {
    for (const [label, plist] of [
      [LAUNCHD_LABEL, launchdPlistPath(env)],
      [LAUNCHD_WORKER_LABEL, launchdWorkerPlistPath(env)],
    ] as const) {
      io.out(`launchd agent: ${label} ${plist} ${existsSync(plist) ? '(present)' : '(absent)'}\n`);
      if (existsSync(plist)) {
        try {
          const out = execFileSync('launchctl', ['list', label], { encoding: 'utf8', timeout: 5000 });
          io.out(`  loaded: ${out.trim() ? 'yes' : 'no'}\n`);
        } catch {
          io.out('  loaded: no\n');
        }
      }
    }
    return 0;
  }
  for (const [name, unitPath] of [
    [SERVICE_NAME, systemdUnitPath(env)],
    [WORKER_SERVICE_NAME, systemdWorkerUnitPath(env)],
  ] as const) {
    io.out(`systemd user unit: ${unitPath} ${existsSync(unitPath) ? '(present)' : '(absent)'}\n`);
    if (existsSync(unitPath)) {
      try {
        const out = execFileSync('systemctl', ['--user', 'is-active', `${name}.service`], { encoding: 'utf8', timeout: 5000 });
        io.out(`  active: ${out.trim()}\n`);
      } catch {
        io.out('  active: inactive\n');
      }
    }
  }
  return 0;
}

/** Uninstall the service: stop, disable, remove. */
export function uninstallService(
  platform: NodeJS.Platform,
  io: { out: (s: string) => void; err: (s: string) => void },
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (platform === 'darwin') {
    const agents = [
      [LAUNCHD_LABEL, launchdPlistPath(env), launchdWrapperPath(env)],
      [LAUNCHD_WORKER_LABEL, launchdWorkerPlistPath(env), launchdWorkerWrapperPath(env)],
    ] as const;
    for (const [label, plist, wrapper] of agents) {
      if (existsSync(plist)) {
        try {
          execFileSync('launchctl', ['unload', plist], { timeout: 10000 });
        } catch {
          // not loaded is fine
        }
        try {
          unlinkSync(plist);
        } catch {
          // ignore
        }
      }
      if (existsSync(wrapper)) {
        try {
          unlinkSync(wrapper);
        } catch {
          // ignore
        }
      }
      io.out(`Removed ${label}.\n`);
    }
    return 0;
  }
  let removed = false;
  for (const [name, unitPath] of [
    [SERVICE_NAME, systemdUnitPath(env)],
    [WORKER_SERVICE_NAME, systemdWorkerUnitPath(env)],
  ] as const) {
    if (!existsSync(unitPath)) continue;
    removed = true;
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', `${name}.service`], { timeout: 10000 });
    } catch {
      // not enabled is fine
    }
    try {
      unlinkSync(unitPath);
    } catch {
      // ignore
    }
    io.out(`Removed ${name}.service.\n`);
  }
  if (!removed) io.out(`${SERVICE_NAME}.service is not installed.\n`);
  return 0;
}

/**
 * `mercury host status|upgrade|uninstall` — the M5 lifecycle commands
 * (docs/host-installer.md M5).
 *
 *   - `status`: read mercury.env and report the current host state (installed version,
 *     service, harnesses, data dir) without changing anything.
 *   - `upgrade`: bump the pinned package version, migrate mercury.env if a variable was
 *     renamed, restart the service.
 *   - `uninstall`: remove the package, service and mercury.env; prompt to keep or
 *     remove the data dir.
 *
 * Three rules this file exists to enforce:
 *
 * 1. **Nothing changes without confirmation.** `upgrade` and `uninstall` print what
 *    they will do and require `--yes` or an interactive confirm (design decision 5).
 * 2. **`status` is read-only.** It never writes, never restarts, never touches the
 *    package.
 * 3. **Uninstall leaves nothing but the opted-in data dir.** Package, service unit and
 *    mercury.env are removed; the data dir is kept only when the operator says so.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';


import { loadEnvFile, envFilePath as doctorEnvPath } from './doctor.ts';
import { resolveMercuryBin, systemdUnitPath, launchdPlistPath, launchdWrapperPath, SERVICE_NAME, LAUNCHD_LABEL } from './service.ts';

/** The env file path (same as the wizard and service use). */
export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'mercury', 'mercury.env');
}

/** The data dir: dirname of MERCURY_DB, or the default state dir. */
export function dataDir(vars: Record<string, string>, env: NodeJS.ProcessEnv = process.env): string {
  if (vars.MERCURY_DB) return vars.MERCURY_DB.replace(/\/mercury\.db$/, '');
  const base = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(base, 'mercury');
}

export interface HostStatus {
  configured: boolean;
  envFile: string;
  version: string | null;
  harnesses: string[];
  dataDir: string;
  service: 'present' | 'absent';
}

/** Read the current host state without changing anything. */
export function hostStatus(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): HostStatus {
  const file = envFilePath(env);
  if (!existsSync(file)) {
    return { configured: false, envFile: file, version: null, harnesses: [], dataDir: dataDir({}, env), service: 'absent' };
  }
  const vars = loadEnvFile(file);
  const service = platform === 'darwin'
    ? (existsSync(launchdPlistPath(env)) ? 'present' : 'absent')
    : (existsSync(systemdUnitPath(env)) ? 'present' : 'absent');
  return {
    configured: true,
    envFile: file,
    version: vars.MERCURY_PINNED_VERSION ?? null,
    harnesses: (vars.MERCURY_HARNESSES ?? '').split(',').filter(Boolean),
    dataDir: dataDir(vars, env),
    service,
  };
}

/** Print the current state (the `status` command and the re-run preamble). */
export function printStatus(s: HostStatus, io: { out: (s: string) => void }): void {
  if (!s.configured) {
    io.out(`Not configured (no ${s.envFile}). Run \`mercury host setup\`.\n`);
    return;
  }
  io.out(`configured: yes (${s.envFile})\n`);
  io.out(`version:   ${s.version ?? '(unpinned)'}\n`);
  io.out(`harnesses: ${s.harnesses.join(', ') || '(none)'}\n`);
  io.out(`data dir:  ${s.dataDir}\n`);
  io.out(`service:   ${s.service}\n`);
}

/** Upgrade: bump the pinned version, restart the service. Requires --yes or confirm. */
export function upgradeHost(
  platform: NodeJS.Platform,
  args: string[],
  io: { out: (s: string) => void; err: (s: string) => void },
  env: NodeJS.ProcessEnv = process.env,
): number {
  let version: string | undefined;
  let yes = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--yes' || a === '-y') yes = true;
    else if (a === '--version') {
      const v = args[i + 1];
      if (!v || v.startsWith('--')) {
        io.err('host upgrade: --version needs a value, e.g. --version 0.2.0\n');
        return 1;
      }
      version = v;
      i += 1;
    } else {
      io.err(`host upgrade: unknown flag '${a}'. Expected --yes and --version <v>.\n`);
      return 1;
    }
  }
  const status = hostStatus(platform, env);
  if (!status.configured) {
    io.err(`host upgrade: not configured (no ${status.envFile}). Run \`mercury host setup\` first.\n`);
    return 1;
  }
  const target = version ?? 'latest';
  io.out(`Upgrading mercury to ${target}...\n`);
  if (!yes) {
    io.err('host upgrade: confirmation required. Pass --yes to proceed.\n');
    return 1;
  }
  try {
    execFileSync('npm', ['install', '-g', '@aywengo/mercury@' + target], { timeout: 120000, stdio: 'inherit' });
  } catch (e) {
    io.err(`host upgrade: npm install failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  // Record the pinned version in mercury.env (append or replace).
  const file = status.envFile;
  const vars = loadEnvFile(file);
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => !l.startsWith('MERCURY_PINNED_VERSION='));
  lines.push(`MERCURY_PINNED_VERSION=${target}`);
  writeFileAtomic(file, lines.join('\n') + '\n');
  // Restart the service if present.
  if (status.service === 'present') {
    try {
      if (platform === 'darwin') {
        execFileSync('launchctl', ['kickstart', '-k', `gui/$(id -u)/${LAUNCHD_LABEL}`], { timeout: 10000 });
      } else {
        execFileSync('systemctl', ['--user', 'restart', `${SERVICE_NAME}.service`], { timeout: 10000 });
      }
      io.out('Service restarted.\n');
    } catch (e) {
      io.err(`host upgrade: service restart failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }
  io.out(`Upgraded to ${target}.\n`);
  return 0;
}

/** Uninstall: remove package, service and mercury.env; prompt to keep/remove data dir. */
export function uninstallHost(
  platform: NodeJS.Platform,
  args: string[],
  io: { out: (s: string) => void; err: (s: string) => void },
  env: NodeJS.ProcessEnv = process.env,
): number {
  let yes = false;
  let keepData = false;
  for (const a of args) {
    if (a === '--yes' || a === '-y') yes = true;
    else if (a === '--keep-data') keepData = true;
    else if (a === '--remove-data') keepData = false;
    else {
      io.err(`host uninstall: unknown flag '${a}'. Expected --yes, --keep-data or --remove-data.\n`);
      return 1;
    }
  }
  const status = hostStatus(platform, env);
  if (!yes) {
    io.err('host uninstall: confirmation required. Pass --yes to proceed.\n');
    return 1;
  }
  // Remove the service.
  if (status.service === 'present') {
    try {
      if (platform === 'darwin') {
        execFileSync('launchctl', ['unload', launchdPlistPath(env)], { timeout: 10000 });
        rmSync(launchdPlistPath(env), { force: true });
        rmSync(launchdWrapperPath(env), { force: true });
      } else {
        execFileSync('systemctl', ['--user', 'disable', '--now', `${SERVICE_NAME}.service`], { timeout: 10000 });
        rmSync(systemdUnitPath(env), { force: true });
      }
      io.out('Service removed.\n');
    } catch (e) {
      io.err(`host uninstall: service removal failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }
  // Remove mercury.env.
  if (existsSync(status.envFile)) {
    rmSync(status.envFile, { force: true });
    io.out(`Removed ${status.envFile}.\n`);
  }
  // Remove the package.
  try {
    execFileSync('npm', ['uninstall', '-g', '@aywengo/mercury'], { timeout: 60000, stdio: 'inherit' });
    io.out('Removed the @aywengo/mercury package.\n');
  } catch (e) {
    io.err(`host uninstall: npm uninstall failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  // Data dir: keep or remove.
  if (keepData) {
    io.out(`Kept the data dir: ${status.dataDir}\n`);
  } else {
    if (existsSync(status.dataDir)) {
      rmSync(status.dataDir, { recursive: true, force: true });
      io.out(`Removed the data dir: ${status.dataDir}\n`);
    }
  }
  io.out('Mercury host uninstalled.\n');
  return 0;
}

/** Atomic write helper (temp + rename), same pattern as the wizard. */
function writeFileAtomic(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.mercury.env.tmp-${process.pid}`);
  fsWriteFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

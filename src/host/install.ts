/**
 * `mercury host install` — the npx-channel half of the Host installer bootstrap
 * (docs/host-installer.md M1).
 *
 * The installer design (docs/host-installer.md §1) is thin bash, thick `mercury`:
 * `install.sh` only bootstraps (detect OS/arch, satisfy prerequisites, install the
 * pinned package) and then hands off to `mercury host setup`. This command is the
 * hand-off target for the `npx @aywengo/mercury host install` channel: it performs
 * the same post-bootstrap steps the bash path performs after the package is present.
 *
 * Three rules this file exists to enforce:
 *
 * 1. **It never requires a configured host.** The whole point is to install a host
 *    that is not configured yet, so this command must not read `mercury.env`, open
 *    the database, or call `loadConfig()`. A host whose configuration is the thing
 *    being fixed must still be able to run `host install --dry-run`.
 * 2. **`--dry-run` touches nothing.** It prints the exact action list and exits.
 *    The M1 gate says so, and it is what makes the command safe to run on a machine
 *    that already has a host.
 * 3. **The log is structured and append-only.** One JSON line per action, so a
 *    failed install leaves a readable trail (docs/host-installer.md M1: structured
 *    log to `${XDG_STATE_HOME:-~/.local/state}/mercury/install.log`).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The `engines` floor from package.json. Node below this cannot run Mercury at all. */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 18;

/** The package name as published. Pinned installs resolve a specific version of this. */
export const PACKAGE_NAME = '@aywengo/mercury';

export interface HostInstallOptions {
  /** Print the action list and touch nothing. */
  dryRun: boolean;
  /** Skip confirmation prompts. */
  yes: boolean;
  /** Pin a specific version instead of the latest. */
  version?: string;
  /** No interactive prompts; answers come from env/flags. */
  nonInteractive: boolean;
  /** Forwarded to the `mercury host setup` hand-off (#666): skip the harness-binary
   *  probe validation for machines that will install the harnesses later. */
  force: boolean;
}

export interface PrereqResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Parse `host install` argv into options. Unknown flags are an error. */
export function parseHostInstallArgs(args: string[]): HostInstallOptions {
  const opts: HostInstallOptions = { dryRun: false, yes: false, nonInteractive: false, force: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--non-interactive') opts.nonInteractive = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--version') {
      const v = args[i + 1];
      if (!v || v.startsWith('--')) throw new Error('host install: --version needs a value, e.g. --version 0.1.1');
      opts.version = v;
      i += 1;
    } else {
      throw new Error(`host install: unknown flag '${a}'. Expected --dry-run, --yes, --version <v>, --non-interactive or --force.`);
    }
  }
  return opts;
}

/** Current Node version as [major, minor]. */
export function nodeVersion(): [number, number] {
  const m = /^v?(\d+)\.(\d+)/.exec(process.version);
  if (!m) return [0, 0];
  return [Number(m[1]), Number(m[2])];
}

/** Node >= 22.18.0 (the engines floor, which also guarantees node:sqlite). */
export function nodeMeetsFloor(): boolean {
  const [major, minor] = nodeVersion();
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}

/** Check a command exists on PATH. */
export function commandExists(cmd: string): boolean {
  // `command -v` is POSIX and works in every shell the installer targets.
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
  return r.status === 0;
}

/** The full prerequisite list, in the order the installer checks them. */
export function checkPrereqs(): PrereqResult[] {
  const [major, minor] = nodeVersion();
  const nodeOk = nodeMeetsFloor();
  const curlOk = commandExists('curl');
  const gitOk = commandExists('git');
  return [
    {
      name: 'node',
      ok: nodeOk,
      detail: nodeOk
        ? `${process.version} (>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0)`
        : `${process.version} is too old; Mercury needs >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 (engines floor, also guarantees node:sqlite)`,
    },
    {
      name: 'curl',
      ok: curlOk,
      detail: curlOk ? 'found' : 'missing — needed by install.sh to fetch the pinned package',
    },
    {
      name: 'git',
      ok: gitOk,
      detail: gitOk ? 'found' : 'missing — Mercury workspaces are git worktrees',
    },
  ];
}

/**
 * The exact actions the installer will take, in order. `--dry-run` prints these.
 *
 * This is the npx channel: the package is ALREADY installed (npx fetched it), so the
 * list is prereq checks + verify the running package + log + handoff. The bash channel
 * (install.sh) performs the actual pinned install and checksum verification before it
 * reaches this command; claiming those steps here would make --dry-run lie about what
 * `mercury host install` does (review #629).
 */
export function buildActionList(opts: HostInstallOptions, prereqs: PrereqResult[]): string[] {
  const actions: string[] = [];
  const version = opts.version ?? 'latest';
  for (const p of prereqs) {
    actions.push(p.ok ? `check ${p.name}: ok (${p.detail})` : `check ${p.name}: FAILED (${p.detail})`);
  }
  actions.push(`verify the running ${PACKAGE_NAME}@${version} satisfies the engines floor`);
  actions.push('write ${XDG_STATE_HOME:-~/.local/state}/mercury/install.log');
  actions.push('hand off to `mercury host setup` (M3: configuration wizard)');
  return actions;
}

/** Append one JSON line to the structured install log. */
export function logInstall(stateDir: string | undefined, entry: Record<string, unknown>): void {
  // The log path is ${XDG_STATE_HOME:-~/.local/state}/mercury/install.log: the caller passes
  // the STATE root (XDG_STATE_HOME or its default), and `mercury` is appended here so both
  // channels land in the same file.
  const dir = join(stateDir ?? join(homedir(), '.local', 'state'), 'mercury');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'install.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

/** Run the install command. Returns the process exit code. */
export function runHostInstall(
  args: string[],
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
): number {
  let opts: HostInstallOptions;
  try {
    opts = parseHostInstallArgs(args);
  } catch (e) {
    io.err((e as Error).message + '\n');
    return 1;
  }
  const prereqs = checkPrereqs();
  const actions = buildActionList(opts, prereqs);
  const failed = prereqs.filter((p) => !p.ok);

  if (opts.dryRun) {
    io.out('mercury host install --dry-run\n');
    for (const a of actions) io.out(`  ${a}\n`);
    io.out(failed.length > 0 ? `\n${failed.length} prerequisite(s) FAILED; nothing would be installed.\n` : '\nAll prerequisites met; nothing was touched.\n');
    return failed.length > 0 ? 1 : 0;
  }

  // Real run: log one line per action (the module contract), then report. The actual
  // npm install lives in install.sh (bash); this command verifies and hands off (M1 scope).
  logInstall(process.env.XDG_STATE_HOME, { event: 'host-install', dryRun: false, version: opts.version ?? 'latest' });
  for (const a of actions) {
    logInstall(process.env.XDG_STATE_HOME, { event: 'action', detail: a });
    io.out(`  ${a}\n`);
  }
  if (failed.length > 0) {
    logInstall(process.env.XDG_STATE_HOME, { event: 'install-failed', detail: `${failed.length} prerequisite(s) failed` });
    io.err(`\n${failed.length} prerequisite(s) FAILED. Fix them and re-run.\n`);
    return 1;
  }
  logInstall(process.env.XDG_STATE_HOME, { event: 'install-complete', detail: 'prerequisites met' });
  // Hand-off (issue #666): the docs promise both channels end in `mercury host setup`.
  // The CLI dispatcher (src/cli.ts) execs the wizard in-process with the propagated
  // flags right after this returns 0; record that in the log so the trail is complete.
  const handoffFlags = [opts.nonInteractive ? '--non-interactive' : '', opts.yes ? '--yes' : '', opts.force ? '--force' : ''].filter(Boolean).join(' ');
  logInstall(process.env.XDG_STATE_HOME, { event: 'hand-off', detail: `mercury host setup ${handoffFlags}`.trimEnd() });
  io.out('\nPrerequisites met. Handing off to `mercury host setup` (M3: configuration wizard).\n');
  return 0;
}

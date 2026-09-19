/**
 * `mercury host setup` — the M3 configuration wizard (docs/host-installer.md M3).
 *
 * Prompts: host name, data dir, workspace dir, GC retention, Atlas on/off, per-harness
 * enable. Each answer maps to a documented `MERCURY_*` variable (docs/configuration.md —
 * a CI test pins that every name the wizard emits exists there AND is read by the host's
 * config loader). Writes `${XDG_CONFIG_HOME:-~/.config}/mercury/mercury.env` atomically
 * (temp file, validate, rename, 0600) and prints a redacted summary.
 *
 * Fleet is pull, not push (issue #645): Fleet holds a per-host token and calls the host's
 * API — there is no host-initiated enrollment, so the wizard asks for no Fleet URL and no
 * host token. The host side of Fleet enrollment is an API token Fleet presents (written
 * as MERCURY_ADMIN_TOKEN by `host setup` since #648) plus a bind/port reachable from
 * Fleet.
 *
 * Three rules this file exists to enforce:
 *
 * 1. **Interactive and --non-interactive share one code path.** The M3 gate: an
 *    answers file fed to `--non-interactive` produces a byte-identical `mercury.env`
 *    to the interactive path with the same answers. The wizard collects answers into
 *    one structure, then a single writer renders the file.
 * 2. **Nothing is written until every answer validates.** An invalid answer is rejected
 *    before the temp file is even created. Variable-name coverage against
 *    `docs/configuration.md` is CI-pinned by a test (WIZARD_VARIABLES), not enforced at
 *    runtime — the wizard's own vocabulary is fixed and tested.
 * 3. **Secrets are never printed in output.** They are read from an env var or an
 *    answers file (or an interactive prompt), and the redacted summary shows only their
 *    presence and length. The interactive prompt echoes input like any readline prompt;
 *    a secret is protected by the 0600 env file and the redacted summary, not by a
 *    hidden-input terminal mode.
 */

import { createInterface } from 'node:readline';
import { hostStatus, printStatus } from './lifecycle.ts';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** The wizard's answers, before validation. Every field maps to a MERCURY_* variable. */
export interface HostSetupAnswers {
  hostName: string;
  dataDir: string;
  workspaceDir: string;
  /** GC retention in DAYS (the prompt unit); written as MERCURY_WORKSPACE_RETENTION_MS. */
  retentionDays: number;
  atlasEnabled: boolean;
  atlasUrl: string;
  atlasToken: string;
  atlasProject: string;
  /** Enabled harness ids, e.g. ['primeagent', 'hermes']. */
  harnesses: string[];
}

/** The MERCURY_* names the wizard may emit. The CI test asserts every one of these
 *  exists in docs/configuration.md (design decision 10). */
export const WIZARD_VARIABLES = [
  'MERCURY_ATLAS_HOST_ID',
  'MERCURY_DB',
  'MERCURY_WORKSPACE_BASE',
  'MERCURY_WORKSPACE_RETENTION_MS',
  'MERCURY_ATLAS_URL',
  'MERCURY_ATLAS_TOKEN',
  'MERCURY_ATLAS_PROJECT',
  'MERCURY_HARNESSES',
  'MERCURY_DEFAULT_AGENT',
] as const;

/** Known harness ids the wizard can enable (the shipped adapters, minus fake). */
export const KNOWN_HARNESSES = ['primeagent', 'hermes', 'claude'] as const;

export interface HostSetupOptions {
  nonInteractive: boolean;
  /** Path to a JSON answers file (--non-interactive only). */
  answersFile?: string;
  /** Print what would be written and touch nothing. */
  dryRun: boolean;
  /** Confirm overwriting an existing mercury.env (M5 re-run gate). */
  yes: boolean;
}

export function parseHostSetupArgs(args: string[]): HostSetupOptions {
  const opts: HostSetupOptions = { nonInteractive: false, dryRun: false, yes: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--non-interactive') opts.nonInteractive = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--answers') {
      const v = args[i + 1];
      if (!v || v.startsWith('--')) throw new Error('host setup: --answers needs a file path');
      opts.answersFile = v;
      i += 1;
    } else {
      throw new Error(`host setup: unknown flag '${a}'. Expected --non-interactive, --answers <file>, --yes or --dry-run`);
    }
  }
  // --answers only makes sense with --non-interactive; silently ignoring the file and
  // falling into interactive mode would surprise the caller (review #633).
  if (opts.answersFile && !opts.nonInteractive) {
    throw new Error('host setup: --answers requires --non-interactive');
  }
  return opts;
}

/** Validate one answer. Returns an error message or null. */
export function validateAnswer(key: keyof HostSetupAnswers, value: unknown): string | null {
  switch (key) {
    case 'hostName':
      return typeof value === 'string' && value.trim().length > 0 ? null : 'host name must not be empty';
    case 'dataDir':
    case 'workspaceDir':
      return typeof value === 'string' && value.trim().length > 0 ? null : 'path must not be empty';
    case 'retentionDays':
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? null : 'retention must be a positive number of days';
    case 'atlasEnabled':
      return typeof value === 'boolean' ? null : 'atlasEnabled must be a boolean';
    case 'atlasUrl':
      if (typeof value !== 'string') return 'Atlas URL must be a string';
      if (value.trim() === '') return null;
      return /^https?:\/\//.test(value.trim()) ? null : 'Atlas URL must start with http:// or https://';
    case 'atlasToken':
      return typeof value === 'string' ? null : 'Atlas token must be a string';
    case 'atlasProject':
      return typeof value === 'string' ? null : 'Atlas project must be a string';
    case 'harnesses':
      if (!Array.isArray(value) || value.length === 0) return 'at least one harness must be enabled';
      for (const h of value) {
        if (!KNOWN_HARNESSES.includes(h as (typeof KNOWN_HARNESSES)[number])) {
          return `unknown harness '${h}'; known: ${KNOWN_HARNESSES.join(', ')}`;
        }
      }
      return null;
    default:
      return null;
  }
}

/** Validate the whole answer set. Returns a list of errors (empty = valid). */
export function validateAnswers(a: HostSetupAnswers): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(a) as (keyof HostSetupAnswers)[]) {
    const err = validateAnswer(key, a[key]);
    if (err) errors.push(`${key}: ${err}`);
  }
  // Atlas on requires URL + token + project (mirrors the startup check).
  if (a.atlasEnabled) {
    if (!a.atlasUrl) errors.push('atlasUrl: required when Atlas is on');
    if (!a.atlasToken) errors.push('atlasToken: required when Atlas is on');
    if (!a.atlasProject) errors.push('atlasProject: required when Atlas is on');
  }
  return errors;
}

/** Render the validated answers as mercury.env lines (sorted, one per variable). */
export function renderEnv(a: HostSetupAnswers): string {
  const lines: string[] = [];
  lines.push(`MERCURY_ATLAS_HOST_ID=${a.hostName.trim()}`);
  lines.push(`MERCURY_DB=${join(a.dataDir.trim(), 'mercury.db')}`);
  lines.push(`MERCURY_WORKSPACE_BASE=${a.workspaceDir.trim()}`);
  lines.push(`MERCURY_WORKSPACE_RETENTION_MS=${Math.round(a.retentionDays * 24 * 60 * 60 * 1000)}`);
  if (a.atlasEnabled) {
    lines.push(`MERCURY_ATLAS_URL=${a.atlasUrl.trim()}`);
    lines.push(`MERCURY_ATLAS_TOKEN=${a.atlasToken.trim()}`);
    lines.push(`MERCURY_ATLAS_PROJECT=${a.atlasProject.trim()}`);
  }
  lines.push(`MERCURY_HARNESSES=${a.harnesses.join(',')}`);
  lines.push(`MERCURY_DEFAULT_AGENT=${a.harnesses[0]}`);
  return lines.sort().join('\n') + '\n';
}

/** The env file path: ${XDG_CONFIG_HOME:-~/.config}/mercury/mercury.env. */
export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'mercury', 'mercury.env');
}

/** Write mercury.env atomically: temp file in the same dir, fsync, rename, 0600. */
export function writeEnvFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.mercury.env.tmp-${process.pid}`);
  writeFileSync(tmp, content, { mode: 0o600 });
  // fsync before rename so a crash cannot leave a zero-length or partial mercury.env
  // at the final path (review #633 minor).
  const fd = openSync(tmp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** Redact secrets: show presence and length only (design decision 6). */
export function redactedSummary(a: HostSetupAnswers): string {
  const token = a.atlasToken.trim();
  const atlasLine = a.atlasEnabled
    ? `${a.atlasUrl.trim()} (project ${a.atlasProject.trim()}), MERCURY_ATLAS_TOKEN=${
        token ? `<set, ${token.length} chars>` : '<unset>'
      }`
    : 'off';
  return [
    `host name: ${a.hostName.trim()}`,
    `data dir: ${a.dataDir.trim()}`,
    `workspace dir: ${a.workspaceDir.trim()}`,
    `GC retention: ${a.retentionDays} day(s)`,
    `Atlas: ${atlasLine}`,
    `harnesses: ${a.harnesses.join(', ')}`,
  ].join('\n');
}

/** Default answers from the environment (non-interactive without an answers file). */
export function defaultAnswers(env: NodeJS.ProcessEnv = process.env): HostSetupAnswers {
  const detected = (env.MERCURY_HARNESSES ?? 'primeagent,hermes,claude').split(',').filter(Boolean);
  return {
    hostName: env.MERCURY_ATLAS_HOST_ID?.trim() || hostname(),
    dataDir: env.MERCURY_DB ? dirname(env.MERCURY_DB) : join(homedir(), '.local', 'state', 'mercury'),
    workspaceDir: env.MERCURY_WORKSPACE_BASE?.trim() || join(homedir(), 'mercury-workspaces'),
    retentionDays: 7,
    atlasEnabled: env.MERCURY_ATLAS_URL ? true : false,
    atlasUrl: env.MERCURY_ATLAS_URL?.trim() || '',
    atlasToken: env.MERCURY_ATLAS_TOKEN?.trim() || '',
    atlasProject: env.MERCURY_ATLAS_PROJECT?.trim() || '',
    harnesses: detected.filter((h) => (KNOWN_HARNESSES as readonly string[]).includes(h)),
  };
}

/** Read answers from a JSON file. */
export function readAnswersFile(path: string): HostSetupAnswers {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Partial<HostSetupAnswers>;
  const base = defaultAnswers();
  return {
    hostName: parsed.hostName ?? base.hostName,
    dataDir: parsed.dataDir ?? base.dataDir,
    workspaceDir: parsed.workspaceDir ?? base.workspaceDir,
    retentionDays: parsed.retentionDays ?? base.retentionDays,
    atlasEnabled: parsed.atlasEnabled ?? base.atlasEnabled,
    atlasUrl: parsed.atlasUrl ?? base.atlasUrl,
    atlasToken: parsed.atlasToken ?? base.atlasToken,
    atlasProject: parsed.atlasProject ?? base.atlasProject,
    harnesses: parsed.harnesses ?? base.harnesses,
  };
}

/** Interactive prompts. Returns the answers. */
export async function promptAnswers(io: {
  question: (q: string) => Promise<string>;
}): Promise<HostSetupAnswers> {
  const base = defaultAnswers();
  const q = async (prompt: string, def: string): Promise<string> => {
    const line = await io.question(`${prompt} [${def}] `);
    return line.trim() === '' ? def : line.trim();
  };
  const hostName = await q('Host name', base.hostName);
  const dataDir = await q('Data dir (mercury.db lives here)', base.dataDir);
  const workspaceDir = await q('Workspace dir', base.workspaceDir);
  const retention = await q('GC retention (days)', String(base.retentionDays));
  const atlasOn = (await q('Enable Atlas? (yes/no)', base.atlasEnabled ? 'yes' : 'no')).toLowerCase();
  const atlasEnabled = atlasOn === 'yes' || atlasOn === 'y';
  const atlasUrl = atlasEnabled ? await q('Atlas URL', base.atlasUrl) : '';
  const atlasToken = atlasEnabled ? await q('Atlas token', base.atlasToken) : '';
  const atlasProject = atlasEnabled ? await q('Atlas project', base.atlasProject) : '';
  const harnessesRaw = await q('Harnesses to enable (comma-separated)', base.harnesses.join(','));
  const harnesses = harnessesRaw.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    hostName,
    dataDir,
    workspaceDir,
    // Keep the parsed number as-is (0/NaN included): validateAnswers rejects it, so an
    // invalid input cannot silently fall back to the default and pass (review #633).
    retentionDays: Number.parseFloat(retention),
    atlasEnabled,
    atlasUrl,
    atlasToken,
    atlasProject,
    harnesses,
  };
}

/** Run the wizard. Returns the process exit code. */
export async function runHostSetup(
  args: string[],
  io: {
    out: (s: string) => void;
    err: (s: string) => void;
    question?: (q: string) => Promise<string>;
  } = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let opts: HostSetupOptions;
  try {
    opts = parseHostSetupArgs(args);
  } catch (e) {
    io.err((e as Error).message + '\n');
    return 1;
  }

  let answers: HostSetupAnswers;
  if (opts.nonInteractive) {
    if (opts.answersFile) {
      try {
        answers = readAnswersFile(opts.answersFile);
      } catch (e) {
        io.err(`host setup: cannot read answers file: ${(e as Error).message}\n`);
        return 1;
      }
    } else {
      answers = defaultAnswers();
    }
  } else {
    // Interactive: use the injected question fn (tests) or a real readline on stdin.
    // readline's question() only works on a TTY; with piped stdin it delivers the
    // first line to the first question and hangs on the rest, so for non-TTY stdin we
    // read all lines upfront and answer questions from the buffer.
    let question: (q: string) => Promise<string>;
    if (io.question) {
      question = io.question;
      answers = await promptAnswers({ question });
    } else if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      question = (q) => new Promise<string>((res) => rl.question(q, res));
      answers = await promptAnswers({ question });
      rl.close();
    } else {
      const lines = readFileSync(0, 'utf8').split('\n');
      let i = 0;
      question = async () => lines[i++] ?? '';
      answers = await promptAnswers({ question });
    }
  }

  const errors = validateAnswers(answers);
  if (errors.length > 0) {
    for (const e of errors) io.err(`  invalid: ${e}\n`);
    io.err('\nNothing was written. Fix the answers and re-run.\n');
    return 1;
  }

  const content = renderEnv(answers);
  const path = envFilePath(env);
  const alreadyConfigured = existsSync(path);
  if (opts.dryRun) {
    io.out('mercury host setup --dry-run\n');
    io.out(redactedSummary(answers) + '\n');
    if (alreadyConfigured) {
      io.out(`\n${path} already exists. --dry-run would OVERWRITE it.\n`);
    } else {
      io.out(`\nWould write ${path} (${content.split('\n').length} lines, mode 0600).\n`);
    }
    return 0;
  }

  // Re-run on a configured host: show the diff and require confirmation (M5 gate:
  // re-running changes nothing without confirmation; design decision 5).
  if (alreadyConfigured && !opts.yes) {
    io.out(`\n${path} already exists. Current state:\n`);
    printStatus(hostStatus(process.platform, env), io);
    io.out(`\nProposed changes would overwrite it. Pass --yes to confirm.\n`);
    return 1;
  }

  writeEnvFile(path, content);
  io.out('mercury host setup\n');
  io.out(redactedSummary(answers) + '\n');
  io.out(`\nWrote ${path} (mode 0600). Start the host with \`mercury host doctor\` (M4).\n`);
  return 0;
}

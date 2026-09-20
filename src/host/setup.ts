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
 *    presence and length. Since #649 §1 (decision 6) secret prompts (admin/API and Atlas
 *    tokens) use a muted-echo readline mode: an existing token's default is shown as
 *    `<set, N chars>` (never echoed), and typed characters are never written to the
 *    terminal. The one exception is the generated admin/API token, which is printed
 *    once in the "Register on the Fleet side" block so the operator can copy it — that
 *    is an intentional hand-off, not prompt echo.
 */

import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { hostStatus, printStatus } from './lifecycle.ts';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HOST_HARNESSES } from '../config.ts';
import { suggestionFor } from '../adapters/configSchema.ts';
import { loadEnvFile } from './doctor.ts';
import { harnessSpecs, probeHarness, type HarnessProbeResult } from './probe.ts';

/** The wizard's answers, before validation. Every field maps to a MERCURY_* variable. */
export interface HostSetupAnswers {
  hostName: string;
  dataDir: string;
  workspaceDir: string;
  /** GC retention in DAYS (the prompt unit); written as MERCURY_WORKSPACE_RETENTION_MS. */
  retentionDays: number;
  /**
   * Admin/API token written as MERCURY_ADMIN_TOKEN (issue #648). Empty = the wizard
   * generates one (32 random bytes, hex). On a re-run the existing file's token is
   * preserved by default so a --yes re-run never rotates the credential Fleet holds
   * without the operator asking for it.
   */
  adminToken: string;
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
  'MERCURY_ADMIN_TOKEN',
  'MERCURY_ATLAS_URL',
  'MERCURY_ATLAS_TOKEN',
  'MERCURY_ATLAS_PROJECT',
  'MERCURY_HARNESSES',
  'MERCURY_DEFAULT_AGENT',
] as const;

/** Known harness ids the wizard can enable: the shipped host harnesses (single source:
 *  HOST_HARNESSES in src/config.ts, which also enforces MERCURY_HARNESSES at load). */
export const KNOWN_HARNESSES = HOST_HARNESSES;

export interface HostSetupOptions {
  nonInteractive: boolean;
  /** Path to a JSON answers file (--non-interactive only). */
  answersFile?: string;
  /** Print what would be written and touch nothing. */
  dryRun: boolean;
  /** Confirm overwriting an existing mercury.env (M5 re-run gate). */
  yes: boolean;
  /** Enable a harness the probe flagged too-old/missing anyway (explicit operator override). */
  force: boolean;
}

export function parseHostSetupArgs(args: string[]): HostSetupOptions {
  const opts: HostSetupOptions = { nonInteractive: false, dryRun: false, yes: false, force: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--non-interactive') opts.nonInteractive = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--answers') {
      const v = args[i + 1];
      if (!v || v.startsWith('--')) throw new Error('host setup: --answers needs a file path');
      opts.answersFile = v;
      i += 1;
    } else {
      throw new Error(`host setup: unknown flag '${a}'. Expected --non-interactive, --answers <file>, --yes, --force or --dry-run`);
    }
  }
  // --answers only makes sense with --non-interactive; silently ignoring the file and
  // falling into interactive mode would surprise the caller (review #633).
  if (opts.answersFile && !opts.nonInteractive) {
    throw new Error('host setup: --answers requires --non-interactive');
  }
  return opts;
}

/**
 * The safe charset for any value written unquoted into mercury.env (issue #649 §3):
 * `[A-Za-z0-9._:/@+=,-]`. The comma is safe because `MERCURY_HARNESSES` is a
 * comma-separated list, not a delimiter inside a value. The file is consumed by three
 * parsers with different semantics — systemd `EnvironmentFile=`, a bash `source`
 * wrapper, and the doctor's line regex — and only an inert charset makes them agree:
 * no whitespace (a space breaks `source`, a newline injects a second variable), no
 * quotes (different quote handling per parser), no `$` (bash expands it, systemd does
 * not), no `#` (bash comment), no backslash.
 */
export const SAFE_VALUE_RE = /^[A-Za-z0-9._:/@+=,-]*$/;

/** The safe-charset error message for one value (no key prefix — the caller adds
 *  `<key>:` exactly once), or null when the value is safe. */
export function unsafeValueError(_key: string, value: string): string | null {
  if (SAFE_VALUE_RE.test(value)) return null;
  return 'value contains characters outside the safe charset [A-Za-z0-9._:/@+=,-] — mercury.env is read by three parsers (systemd EnvironmentFile, bash source, the doctor) and only an inert charset keeps them in agreement';
}

/** Validate one answer. Returns an error message or null. */
export function validateAnswer(key: keyof HostSetupAnswers, value: unknown): string | null {
  const charsetErr = (k: string, s: string): string | null => unsafeValueError(k, s);
  switch (key) {
    case 'hostName': {
      if (typeof value !== 'string' || value.trim().length === 0) return 'host name must not be empty';
      return charsetErr('hostName', value.trim());
    }
    case 'dataDir':
    case 'workspaceDir': {
      if (typeof value !== 'string' || value.trim().length === 0) return 'path must not be empty';
      return charsetErr(key, value.trim());
    }
    case 'retentionDays':
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? null : 'retention must be a positive number of days';
    case 'atlasEnabled':
      return typeof value === 'boolean' ? null : 'atlasEnabled must be a boolean';
    case 'atlasUrl': {
      if (typeof value !== 'string') return 'Atlas URL must be a string';
      if (value.trim() === '') return null;
      if (!/^https?:\/\//.test(value.trim())) return 'Atlas URL must start with http:// or https://';
      return charsetErr('atlasUrl', value.trim());
    }
    case 'adminToken': {
      // The generated token is hex; a supplied token still must be inert in the file.
      if (typeof value !== 'string') return 'admin token must be a string';
      if (value.trim().length === 0) return null;
      return charsetErr('adminToken', value.trim());
    }
    case 'atlasToken': {
      if (typeof value !== 'string') return 'Atlas token must be a string';
      if (value.trim().length === 0) return null;
      return charsetErr('atlasToken', value.trim());
    }
    case 'atlasProject': {
      if (typeof value !== 'string') return 'Atlas project must be a string';
      if (value.trim().length === 0) return null;
      return charsetErr('atlasProject', value.trim());
    }
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

/** Validate the whole answer set. Returns a list of errors (empty = valid).
 *
 * `probe` is the M2 cross-field input (#647): a harness the probe flagged too-old or
 * missing cannot be enabled unless `force`. An `unknown` probe (no floor declared or an
 * unparsable version) enables with a warning — the operator may know better. */
export function validateAnswers(
  a: HostSetupAnswers,
  probe?: Map<string, HarnessProbeResult>,
  force = false,
): string[] {
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
  if (probe) {
    for (const h of a.harnesses) {
      const p = probe.get(h);
      if (!p) continue;
      if (p.status === 'too-old') {
        if (!force) errors.push(`harnesses: '${h}' is too old (found ${p.version ?? 'unknown'}, needs ${p.minVersion ?? '?'}); upgrade it or pass --force`);
      } else if (p.status === 'missing') {
        if (!force) errors.push(`harnesses: '${h}' is not installed (probe found no binary); install it or pass --force`);
      }
    }
  }
  return errors;
}

/** Render the validated answers as mercury.env lines (sorted, one per variable). */
export function renderEnv(a: HostSetupAnswers): string {
  if (!a.adminToken.trim()) throw new Error('adminToken: resolve before rendering (generateAdminToken)');
  // Defense in depth (#649 §3): validateAnswers already enforced the safe charset; a
  // direct renderEnv caller must not bypass it, or one of the three parsers breaks.
  const checked: [string, string][] = [
    ['hostName', a.hostName.trim()],
    ['dataDir', a.dataDir.trim()],
    ['workspaceDir', a.workspaceDir.trim()],
    ['adminToken', a.adminToken.trim()],
    ...a.harnesses.flatMap((h): [string, string][] => [['harnesses', h]]),
    ...(a.atlasEnabled
      ? ([
          ['atlasUrl', a.atlasUrl.trim()],
          ['atlasToken', a.atlasToken.trim()],
          ['atlasProject', a.atlasProject.trim()],
        ] as [string, string][])
      : []),
  ];
  for (const [k, v] of checked) {
    const err = unsafeValueError(k, v);
    if (err) throw new Error(`${k}: ${err}`);
  }
  const lines: string[] = [];
  lines.push(`MERCURY_ATLAS_HOST_ID=${a.hostName.trim()}`);
  lines.push(`MERCURY_DB=${join(a.dataDir.trim(), 'mercury.db')}`);
  lines.push(`MERCURY_WORKSPACE_BASE=${a.workspaceDir.trim()}`);
  lines.push(`MERCURY_WORKSPACE_RETENTION_MS=${Math.round(a.retentionDays * 24 * 60 * 60 * 1000)}`);
  lines.push(`MERCURY_ADMIN_TOKEN=${a.adminToken.trim()}`);
  if (a.atlasEnabled) {
    lines.push(`MERCURY_ATLAS_URL=${a.atlasUrl.trim()}`);
    lines.push(`MERCURY_ATLAS_TOKEN=${a.atlasToken.trim()}`);
    lines.push(`MERCURY_ATLAS_PROJECT=${a.atlasProject.trim()}`);
  }
  lines.push(`MERCURY_HARNESSES=${a.harnesses.join(',')}`);
  lines.push(`MERCURY_DEFAULT_AGENT=${a.harnesses[0]}`);
  return lines.sort().join('\n') + '\n';
}

/** Lines whose VALUE is a credential — shown redacted in diffs. */
const REDACTED_KEYS = new Set(['MERCURY_ADMIN_TOKEN', 'MERCURY_ATLAS_TOKEN']);

/**
 * A compact line-level diff between the current and proposed mercury.env content, with
 * credential values redacted (issue #649 §6, M5 gate). Lines present in both files with
 * the same value are omitted; `- old` / `+ new` for changed or added keys, `- old` alone
 * for removed ones. Returns '' when the contents are identical.
 */
export function envDiff(current: string, proposed: string): string {
  const parse = (s: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const line of s.split('\n')) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) m.set(match[1]!, match[2]!);
    }
    return m;
  };
  const cur = parse(current);
  const prop = parse(proposed);
  const keys = [...new Set([...cur.keys(), ...prop.keys()])].sort();
  const show = (key: string, value: string): string =>
    REDACTED_KEYS.has(key) ? `${key}=<redacted, ${value.length} chars>` : `${key}=${value}`;
  const out: string[] = [];
  for (const key of keys) {
    const a = cur.get(key);
    const b = prop.get(key);
    if (a === b) continue;
    if (a !== undefined) out.push(`- ${show(key, a)}`);
    if (b !== undefined) out.push(`+ ${show(key, b)}`);
  }
  return out.length > 0 ? out.join('\n') + '\n' : '';
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
  const admin = a.adminToken.trim();
  return [
    `host name: ${a.hostName.trim()}`,
    `data dir: ${a.dataDir.trim()}`,
    `workspace dir: ${a.workspaceDir.trim()}`,
    `GC retention: ${a.retentionDays} day(s)`,
    `admin token: ${admin ? `<set, ${admin.length} chars>` : '<unset — will be generated>'}`,
    `Atlas: ${atlasLine}`,
    `harnesses: ${a.harnesses.join(', ')}`,
  ].join('\n');
}

/** Generate a fresh admin/API token: 32 random bytes, hex (64 chars). */
export function generateAdminToken(): string {
  return randomBytes(32).toString('hex');
}

/** Read MERCURY_ADMIN_TOKEN from an existing mercury.env, or ''. */
export function existingAdminToken(env: NodeJS.ProcessEnv = process.env): string {
  return existingVar('MERCURY_ADMIN_TOKEN', env);
}

/** Read a variable from an existing mercury.env, or '' (issue #649 §1: the atlas token
 *  needs the same re-run continuity the admin token already had). */
export function existingVar(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = envFilePath(env);
  if (!existsSync(file)) return '';
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : '';
}

/** Default answers from the environment (non-interactive without an answers file). */
export function defaultAnswers(env: NodeJS.ProcessEnv = process.env): HostSetupAnswers {
  // Trim entries like parseHarnesses does (review #653): 'primeagent, claude' must not
  // silently drop 'claude' from the wizard defaults.
  const detected = (env.MERCURY_HARNESSES ?? 'primeagent,hermes,claude')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return {
    hostName: env.MERCURY_ATLAS_HOST_ID?.trim() || hostname(),
    dataDir: env.MERCURY_DB ? dirname(env.MERCURY_DB) : join(homedir(), '.local', 'state', 'mercury'),
    workspaceDir: env.MERCURY_WORKSPACE_BASE?.trim() || join(homedir(), 'mercury-workspaces'),
    retentionDays: 7,
    // Re-run safety (#648): keep the token the host already runs with unless the caller
    // supplies a new one. Generation happens in renderEnv so the default stays pure.
    adminToken: env.MERCURY_ADMIN_TOKEN?.trim() || existingAdminToken(env),
    atlasEnabled: env.MERCURY_ATLAS_URL ? true : false,
    atlasUrl: env.MERCURY_ATLAS_URL?.trim() || '',
    atlasToken: env.MERCURY_ATLAS_TOKEN?.trim() || existingVar('MERCURY_ATLAS_TOKEN', env),
    atlasProject: env.MERCURY_ATLAS_PROJECT?.trim() || '',
    harnesses: detected.filter((h) => (KNOWN_HARNESSES as readonly string[]).includes(h)),
  };
}

/** The keys an answers file may set (issue #649 §2, decision 10). */
const ANSWERS_FILE_KEYS = [
  'hostName',
  'dataDir',
  'workspaceDir',
  'retentionDays',
  'adminToken',
  'atlasEnabled',
  'atlasUrl',
  'atlasToken',
  'atlasProject',
  'harnesses',
] as const satisfies readonly (keyof HostSetupAnswers)[];

/** Read answers from a JSON file. Unknown keys are REJECTED (issue #649 §2, decision 10):
 *  a typo (`atlasUlr`, `harness`, `retention_days`) must not silently fall back to the
 *  default — Atlas silently off or retention silently reset to 7 days is exactly the
 *  failure this refuses to cause. */
export function readAnswersFile(path: string, env: NodeJS.ProcessEnv = process.env): HostSetupAnswers {
  const raw = readFileSync(path, 'utf8');
  let parsed: Partial<HostSetupAnswers>;
  try {
    parsed = JSON.parse(raw) as Partial<HostSetupAnswers>;
  } catch {
    // JSON.parse's message quotes a snippet of the input, which can carry secret values
    // from the file (#648 review). Report the problem, never the content.
    throw new Error('answers file is not valid JSON');
  }
  // A non-object file must be rejected, not defaulted (Copilot #659): `null` would throw
  // from Object.keys, and a scalar (`true`, `1`, `"x"`) has no keys, so it would be
  // accepted and silently produce an all-defaults mercury.env. An array is likewise not
  // an answers mapping.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('answers file must be a JSON object with answers-file keys');
  }
  const unknown = Object.keys(parsed as Record<string, unknown>).filter(
    (k) => !(ANSWERS_FILE_KEYS as readonly string[]).includes(k),
  );
  if (unknown.length > 0) {
    const described = unknown.map((k) => {
      const s = suggestionFor(k, ANSWERS_FILE_KEYS);
      return s ? `${k} (did you mean '${s}'?)` : k;
    });
    throw new Error(
      `answers file has unknown ${unknown.length === 1 ? 'key' : 'keys'}: ${described.join(', ')}. ` +
        `Known keys: ${ANSWERS_FILE_KEYS.join(', ')}.`,
    );
  }
  const base = defaultAnswers(env);
  return {
    hostName: parsed.hostName ?? base.hostName,
    dataDir: parsed.dataDir ?? base.dataDir,
    workspaceDir: parsed.workspaceDir ?? base.workspaceDir,
    retentionDays: parsed.retentionDays ?? base.retentionDays,
    adminToken: parsed.adminToken ?? base.adminToken,
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
  /** Muted-echo question for secrets (issue #649 §1, decision 6). Falls back to
   *  `question` when the terminal cannot mute (tests, piped stdin). */
  secretQuestion?: (q: string) => Promise<string>;
}, env: NodeJS.ProcessEnv = process.env, probe?: Map<string, HarnessProbeResult>): Promise<HostSetupAnswers> {
  const base = defaultAnswers(env);
  // Probe-driven checklist default (#647): what the probe found healthy, not a
  // hard-coded list. Without a probe (degraded mode) keep the env/default list.
  if (probe) {
    const ok = [...probe.values()].filter((p) => p.status === 'ok').map((p) => p.id);
    if (ok.length > 0 || probe.size > 0) base.harnesses = ok;
  }
  const q = async (prompt: string, def: string): Promise<string> => {
    const line = await io.question(`${prompt} [${def}] `);
    return line.trim() === '' ? def : line.trim();
  };
  const hostName = await q('Host name', base.hostName);
  const dataDir = await q('Data dir (mercury.db lives here)', base.dataDir);
  const workspaceDir = await q('Workspace dir', base.workspaceDir);
  const retention = await q('GC retention (days)', String(base.retentionDays));
  // Mask an existing token default (#648 review): the prompt must never echo the live
  // credential from the env file on an interactive re-run. Enter keeps it; a typed
  // value replaces it; empty on a fresh host generates one later in runHostSetup.
  const secret = io.secretQuestion ?? io.question;
  const adminPrompt = base.adminToken
    ? `Admin/API token [<set, ${base.adminToken.length} chars> — enter to keep, new value to rotate]`
    : 'Admin/API token (empty = generate one)';
  const adminRaw = (await secret(`${adminPrompt} `)).trim();
  const adminToken = base.adminToken && adminRaw === '' ? base.adminToken : adminRaw;
  const atlasOn = (await q('Enable Atlas? (yes/no)', base.atlasEnabled ? 'yes' : 'no')).toLowerCase();
  const atlasEnabled = atlasOn === 'yes' || atlasOn === 'y';
  const atlasUrl = atlasEnabled ? await q('Atlas URL', base.atlasUrl) : '';
  // The Atlas token is a credential: masked default (never echoed from the env), muted
  // input while typing (issue #649 §1, decision 6 — same treatment as the admin token).
  const atlasPrompt = base.atlasToken
    ? `Atlas token [<set, ${base.atlasToken.length} chars> — enter to keep, new value to rotate]`
    : 'Atlas token';
  const atlasRaw = atlasEnabled ? (await secret(`${atlasPrompt} `)).trim() : '';
  const atlasToken = base.atlasToken && atlasRaw === '' ? base.atlasToken : atlasRaw;
  const atlasProject = atlasEnabled ? await q('Atlas project', base.atlasProject) : '';
  const harnessPrompt = probe && probe.size > 0
    ? `Harnesses to enable (comma-separated). Probe: ${
        [...probe.values()].map((p) => `${p.id}=${p.status}${p.status === 'too-old' ? ` (needs ${p.minVersion}) ` : ''}`).join(', ')
      }`
    : 'Harnesses to enable (comma-separated)';
  const harnessesRaw = await q(harnessPrompt, base.harnesses.join(','));
  const harnesses = harnessesRaw.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    hostName,
    dataDir,
    workspaceDir,
    // Keep the parsed number as-is (0/NaN included): validateAnswers rejects it, so an
    // invalid input cannot silently fall back to the default and pass (review #633).
    retentionDays: Number.parseFloat(retention),
    adminToken,
    atlasEnabled,
    atlasUrl,
    atlasToken,
    atlasProject,
    harnesses,
  };
}

/** Run the M2 probe over the shipped harnesses (#647). Injectable for tests. */
export type ProbeFn = () => Promise<HarnessProbeResult[]>;

export async function runSetupProbe(env: NodeJS.ProcessEnv = process.env): Promise<HarnessProbeResult[]> {
  return Promise.all(harnessSpecs(env).map(probeHarness));
}

/** Run the wizard. Returns the process exit code. */
export async function runHostSetup(
  args: string[],
  io: {
    out: (s: string) => void;
    err: (s: string) => void;
    question?: (q: string) => Promise<string>;
    /** Muted-echo question for secrets (issue #649 §1). Optional; when absent the
     *  plain question channel is used (tests, piped stdin). */
    secretQuestion?: (q: string) => Promise<string>;
    /** Injected probe (tests). Default: probe the real binaries once, bounded. */
    probe?: ProbeFn;
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

  // M2 cross-field input (#647): probe before prompting. A hung binary cannot hang the
  // wizard — probeVersion bounds each binary ask; see src/host/probe.ts rule 2.
  const probeFn: ProbeFn = io.probe ?? (() => runSetupProbe(env));
  let probe: Map<string, HarnessProbeResult>;
  try {
    probe = new Map((await probeFn()).map((p) => [p.id, p]));
  } catch (e) {
    // The probe must not block configuration: rule 2 of the probe. Degrade to no gate
    // and say so.
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    io.err(`host setup: probe failed (${detail}); harness status checks skipped\n`);
    probe = new Map();
  }

  let answers: HostSetupAnswers;
  if (opts.nonInteractive) {
    if (opts.answersFile) {
      try {
        answers = readAnswersFile(opts.answersFile, env);
      } catch (e) {
        io.err(`host setup: cannot read answers file: ${(e as Error).message}\n`);
        return 1;
      }
    } else {
      answers = defaultAnswers(env);
      // No explicit harness list: enable what the probe found healthy (#647), not a
      // hard-coded triple. Empty probe result = nothing enabled by default; the
      // validation below then asks the operator to enable something explicitly.
      if (!env.MERCURY_HARNESSES?.trim()) {
        const ok = [...probe.values()].filter((p) => p.status === 'ok').map((p) => p.id);
        if (ok.length > 0) answers.harnesses = ok;
      }
    }
  } else {
    // Interactive: use the injected question fn (tests) or a real readline on stdin.
    // readline's question() only works on a TTY; with piped stdin it delivers the
    // first line to the first question and hangs on the rest, so for non-TTY stdin we
    // read all lines upfront and answer questions from the buffer.
    let question: (q: string) => Promise<string>;
    if (io.question) {
      question = io.question;
      answers = await promptAnswers({ question, secretQuestion: io.secretQuestion }, env, probe);
    } else if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      question = (q) => new Promise<string>((res) => rl.question(q, res));
      // Muted echo for secrets (issue #649 §1, decision 6). readline redraws the line as
      // "<prompt><typed input>" on keypresses, so a startsWith(prompt) filter would leak
      // the secret through those redraws. While a secret question is pending, the
      // output callback writes ONLY the exact prompt string captured when the question
      // started — every other chunk (typed characters, redraw suffixes, control
      // sequences) is dropped. Normal questions restore the original callback.
      const rlAny = rl as unknown as { _writeToOutput: (s: string) => void };
      const stdoutWrite = rlAny._writeToOutput.bind(rl);
      let mutedPrompt: string | null = null;
      rlAny._writeToOutput = (s: string) => {
        if (mutedPrompt !== null) {
          // Muted: the ONLY thing allowed through is the exact prompt itself.
          if (s === mutedPrompt) stdoutWrite(s);
          return;
        }
        stdoutWrite(s);
      };
      const secretQuestion = (sq: string) => {
        mutedPrompt = sq;
        return new Promise<string>((res) =>
          rl.question(sq, (answer) => {
            mutedPrompt = null;
            stdoutWrite('\n');
            res(answer);
          }),
        );
      };
      answers = await promptAnswers({ question, secretQuestion }, env, probe);
      rl.close();
    } else {
      const lines = readFileSync(0, 'utf8').split('\n');
      let i = 0;
      question = async () => lines[i++] ?? '';
      answers = await promptAnswers({ question }, env, probe);
    }
  }

  // Unknown-status harnesses enable with a warning (#647): no floor declared or an
  // unparsable version is not proof of breakage, only of missing information.
  for (const h of answers.harnesses) {
    const p = probe.get(h);
    if (p && p.status === 'unknown') {
      io.err(`warning: ${h} probe status unknown${p.error ? ` (${p.error})` : ''}; enabling anyway\n`);
    }
  }
  const errors = validateAnswers(answers, probe, opts.force);
  if (errors.length > 0) {
    for (const e of errors) io.err(`  invalid: ${e}\n`);
    io.err('\nNothing was written. Fix the answers and re-run.\n');
    return 1;
  }

  // Resolve the admin token AFTER validation and BEFORE rendering so both entry paths
  // (interactive / answers file) and --dry-run see the same value (#648).
  const generatedToken = !answers.adminToken.trim();
  if (generatedToken) answers.adminToken = generateAdminToken();

  const content = renderEnv(answers);
  const path = envFilePath(env);
  const alreadyConfigured = existsSync(path);
  if (opts.dryRun) {
    io.out('mercury host setup --dry-run\n');
    io.out(redactedSummary(answers) + '\n');
    if (alreadyConfigured) {
      const diff = envDiff(readFileSync(path, 'utf8'), content);
      if (diff) io.out(`\n--dry-run would OVERWRITE ${path}. Proposed diff (secrets redacted):\n${diff}`);
      else io.out(`\n${path} already exists and the proposed answers are IDENTICAL — --dry-run would rewrite the same content.`);
    } else {
      io.out(`\nWould write ${path} (${content.split('\n').length} lines, mode 0600).\n`);
    }
    return 0;
  }

  // Re-run on a configured host: show the diff of proposed changes and require
  // confirmation (M5 gate: "re-running on a configured host shows the diff of any
  // proposed change"; design decision 5). Identical answers are a no-op that exits 0.
  if (alreadyConfigured && !opts.yes) {
    const current = readFileSync(path, 'utf8');
    const diff = envDiff(current, content);
    if (!diff) {
      io.out(`\n${path} already exists and the proposed answers are identical — nothing to change.\n`);
      return 0;
    }
    io.out(`\n${path} already exists. Proposed changes (secrets redacted):\n`);
    io.out(diff);
    io.out(`\nPass --yes to confirm.
`);
    return 1;
  }

  writeEnvFile(path, content);
  io.out('mercury host setup\n');
  io.out(redactedSummary(answers) + '\n');
  io.out(`\nWrote ${path} (mode 0600). Start the host with \`mercury host doctor\` (M4).\n`);
  if (generatedToken) {
    // The one place the generated token is shown (#648, decision 6): Fleet presents it
    // as a Bearer token to the host API, so the operator registers exactly this value
    // on the Fleet side. It is in the 0600 file afterwards and never printed again.
    // The port is the one the doctor will use — the env file's, not this shell's (#648 review).
    const port = loadEnvFile(path).MERCURY_PORT ?? '3000';
    io.out('\nRegister on the Fleet side (shown once, not again):\n');
    io.out(`  host API base URL: http://<this-host>:${port}\n`);
    io.out(`  host API token:    ${answers.adminToken}\n`);
  }
  return 0;
}

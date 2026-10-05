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
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, lstatSync, readdirSync, renameSync, statSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { HOST_HARNESSES } from '../config.ts';
import { suggestionFor } from '../adapters/configSchema.ts';
import { checkLaya, isLayaAuthRejected, loadEnvFile, parseLayaTimeoutMs, schemeFor } from './doctor.ts';
import { readLayaCredentials } from './layaCredentials.ts';
import { DEFAULT_PYTHON_CANDIDATES, detectPython, ensureLayaCredentials, LAYA_DEFAULT_PORT, LAYA_SERVE_PIN, layaStepActions, planLayaSidecar, renderLayaLaunchdPlist, renderLayaSystemdUnit, type LayaPlan, type RunFn } from './layaSidecar.ts';
import { harnessSpecs, probeHarness, type HarnessProbeResult } from './probe.ts';
import { isWizardManagedLayaDefault, validateLayaBaseUrl } from '../laya/layaUrl.ts';

/** The wizard's answers, before validation. Every field maps to a MERCURY_* variable. */
export interface HostSetupAnswers {
  hostName: string;
  dataDir: string;
  workspaceDir: string;
  /**
   * API bind address written as MERCURY_BIND_HOST (issue #665). '' = leave the host's
   * secure default (127.0.0.1, loopback only) in place — the file then does not carry
   * the variable at all, so the default cannot drift from src/config.ts.
   */
  bindHost: string;
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
  /** Opt-in Laya sidecar (#831, Laya design §5.3). Default FALSE — opt-out writes nothing. */
  layaEnabled: boolean;
  /**
   * The MERCURY_LAYA_URL to write. '' = wizard-managed local install (the 127.0.0.1:8302
   * default). A NON-EMPTY value is an EXTERNALLY configured endpoint preserved from the
   * existing env (r21): setup keeps it verbatim and verifies it with the doctor probe instead
   * of installing/restarting a sidecar that would silently replace the working endpoint.
   */
  layaUrl: string;
}

/** The MERCURY_* names the wizard may emit. The CI test asserts every one of these
 *  exists in docs/configuration.md (design decision 10). */
export const WIZARD_VARIABLES = [
  'MERCURY_ATLAS_HOST_ID',
  'MERCURY_BIND_HOST',
  'MERCURY_DB',
  'MERCURY_WORKSPACE_BASE',
  'MERCURY_WORKSPACE_RETENTION_MS',
  'MERCURY_ADMIN_TOKEN',
  'MERCURY_ATLAS_URL',
  'MERCURY_ATLAS_TOKEN',
  'MERCURY_ATLAS_PROJECT',
  'MERCURY_HARNESSES',
  'MERCURY_DEFAULT_AGENT',
  'MERCURY_LAYA_URL',
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
    case 'layaEnabled':
      return typeof value === 'boolean' ? null : 'layaEnabled must be a boolean';
    case 'layaUrl': {
      // The shape contract lives in ONE validator (src/laya/layaUrl.ts) shared with loadConfig
      // and the doctor (Copilot #840 r34): the wizard cannot be the only gate when hand-written
      // env files bypass it.
      const err = validateLayaBaseUrl(value, 'layaUrl');
      if (err !== null) return err;
      // The validator proved value is a string (its typeof branch returned otherwise).
      return charsetErr('layaUrl', (value as string).trim());
    }
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
    case 'bindHost': {
      // '' = keep the host's secure loopback default (the file omits the variable).
      if (typeof value !== 'string') return 'bind host must be a string';
      const v = value.trim();
      if (v === '') return null;
      if (v === 'loopback') return null;
      // No ':' — a port or an IPv6 literal would break the `http://<bind>:<port>` URL
      // interpolation (Copilot review on #668); a host name or IPv4 address only.
      if (!/^(0\.0\.0\.0|[A-Za-z0-9._-]+)$/.test(v)) {
        return "bind host must be 'loopback', '0.0.0.0', or a host name / IPv4 address (no port, no IPv6)";
      }
      return charsetErr('bindHost', v);
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
  // The sidecar's unit embeds ABSOLUTE paths (systemd ExecStart rejects relative
  // executables, Copilot #840 r25): a WIZARD-MANAGED local install requires an absolute data
  // dir. A preserved external URL installs no venv or unit and never uses dataDir, so a
  // relative data dir stays valid for the host itself (Copilot #840 r31). A non-string
  // dataDir is already reported by validateAnswer above — guard the type so the cross-field
  // check itself cannot throw (Copilot #840 r29).
  const dataDirStr = typeof a.dataDir === 'string' ? a.dataDir.trim() : '';
  const layaUrlStr = typeof a.layaUrl === 'string' ? a.layaUrl.trim() : '';
  const externalLaya = layaUrlStr !== '' && !isWizardManagedLayaDefault(layaUrlStr, LAYA_DEFAULT_PORT);
  if (a.layaEnabled && !externalLaya && !isAbsolute(dataDirStr)) {
    errors.push(`dataDir: must be an absolute path when the Laya sidecar is enabled (got '${dataDirStr || String(a.dataDir)}')`);
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

/** Render the validated answers as mercury.env lines (sorted, one per variable).
 *  `preserve` carries operator-managed variables (e.g. MERCURY_TLS_CERT/KEY read from
 *  the current file) verbatim through a rewrite — they are not wizard answers and are
 *  not re-validated (issue #668 round 6: a re-run must not downgrade a TLS host). */
export function renderEnv(a: HostSetupAnswers, preserve: Record<string, string> = {}): string {
  if (!a.adminToken.trim()) throw new Error('adminToken: resolve before rendering (generateAdminToken)');
  // Defense in depth (#649 §3): validateAnswers already enforced the safe charset; a
  // direct renderEnv caller must not bypass it, or one of the three parsers breaks.
  const checked: [string, string][] = [
    ['hostName', a.hostName.trim()],
    ['dataDir', a.dataDir.trim()],
    ['workspaceDir', a.workspaceDir.trim()],
    ['adminToken', a.adminToken.trim()],
    ...(a.bindHost.trim() ? ([['bindHost', a.bindHost.trim()]] as [string, string][]) : []),
    ...a.harnesses.flatMap((h): [string, string][] => [['harnesses', h]]),
    ...(a.atlasEnabled
      ? ([
          ['atlasUrl', a.atlasUrl.trim()],
          ['atlasToken', a.atlasToken.trim()],
          ['atlasProject', a.atlasProject.trim()],
        ] as [string, string][])
      : []),
    // MERCURY_LAYA_URL is a plain URL (no credential): the laya KEY lives in the 0600
    // laya-credentials.json (#831, design §5.1), so it never passes through the env file.
    ...(a.layaEnabled ? ([['layaUrl', a.layaUrl || `http://127.0.0.1:${LAYA_DEFAULT_PORT}`]] as [string, string][]) : []),
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
  // '' = secure loopback default from src/config.ts; emitting nothing keeps that single
  // source of truth (issue #665).
  if (a.bindHost.trim()) lines.push(`MERCURY_BIND_HOST=${a.bindHost.trim()}`);
  if (a.atlasEnabled) {
    lines.push(`MERCURY_ATLAS_URL=${a.atlasUrl.trim()}`);
    lines.push(`MERCURY_ATLAS_TOKEN=${a.atlasToken.trim()}`);
    lines.push(`MERCURY_ATLAS_PROJECT=${a.atlasProject.trim()}`);
  }
  // r21: a preserved EXTERNAL URL is written verbatim; '' = wizard-managed local default.
  if (a.layaEnabled) lines.push(`MERCURY_LAYA_URL=${a.layaUrl || `http://127.0.0.1:${LAYA_DEFAULT_PORT}`}`);
  lines.push(`MERCURY_HARNESSES=${a.harnesses.join(',')}`);
  lines.push(`MERCURY_DEFAULT_AGENT=${a.harnesses[0]}`);
  for (const [k, v] of Object.entries(preserve)) lines.push(`${k}=${v}`);
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
export function redactedSummary(a: HostSetupAnswers, preservedVarNames: string[] = []): string {
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
    ...(preservedVarNames.length > 0
      ? [`preserved (hand-set): ${preservedVarNames.join(', ')}`]
      : []),
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

/** Same read WITHOUT trimming (Copilot #840 r38): a persisted padded value must reach
 *  validateAnswers unchanged so the shared URL contract rejects it — trimming here would
 *  silently normalize what loadConfig and the doctor refuse. */
export function existingVarRaw(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = envFilePath(env);
  if (!existsSync(file)) return '';
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1) : '';
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
    // Re-run continuity (#665): keep the bind address the host already uses (env var or
    // the written file) unless the operator supplies a new one — an enter-press on the
    // prompt must not silently un-expose the API.
    bindHost: env.MERCURY_BIND_HOST?.trim() || existingVar('MERCURY_BIND_HOST', env),
    harnesses: detected.filter((h) => (KNOWN_HARNESSES as readonly string[]).includes(h)),
    // Opt-in continuity (#831): a re-run keeps the sidecar enabled when the host already has
    // MERCURY_LAYA_URL — in the process env OR the written mercury.env (bindHost solves the
    // same problem with existingVar). A fresh host defaults to NO: the sidecar is never a
    // silent default.
    layaEnabled: Boolean(env.MERCURY_LAYA_URL?.trim() || existingVar('MERCURY_LAYA_URL', env)),
    // Continuity (r21): a hand-set URL is preserved verbatim; '' only on a fresh host (the
    // wizard-managed local default is applied at render time).
    // RAW value through to validateAnswers (Copilot #840 r37): trimming here would let a
    // padded env value pass setup while loadConfig/doctor refuse it. An exactly-EMPTY process
    // value counts as absent so the configured endpoint keeps its continuity (r42) — only
    // absent-empty-everywhere falls back to ''. Non-empty padded values still pass through raw
    // and are refused at validation. (layaEnabled keeps the trim: presence, not value, decides
    // the default.)
    layaUrl: env.MERCURY_LAYA_URL !== undefined && env.MERCURY_LAYA_URL !== ''
      ? env.MERCURY_LAYA_URL
      : (existingVarRaw('MERCURY_LAYA_URL', env) || ''),
  };
}

/** The keys an answers file may set (issue #649 §2, decision 10). */
const ANSWERS_FILE_KEYS = [
  'layaUrl',
  'hostName',
  'dataDir',
  'workspaceDir',
  'bindHost',
  'retentionDays',
  'adminToken',
  'atlasEnabled',
  'atlasUrl',
  'atlasToken',
  'atlasProject',
  'harnesses',
  'layaEnabled',
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
    // File-settable (r21): an answers file may pin an external URL; continuity still applies
    // when absent (base carries the preserved env value). A non-null INVALID value passes
    // through untouched so validateAnswers reports the type error (same rule as atlasUrl) —
    // normalizing it to the default would install a local sidecar over a malformed endpoint
    // instead of refusing (Copilot #840 r23).
    layaUrl: parsed.layaUrl ?? base.layaUrl,
    dataDir: parsed.dataDir ?? base.dataDir,
    workspaceDir: parsed.workspaceDir ?? base.workspaceDir,
    // 'loopback' is a prompt spelling, never a file value (#665 review) — normalized
    // case/whitespace-insensitively so `Loopback`/` LOOPBACK ` cannot become a hostname.
    // Non-strings pass through untouched so validateAnswers reports the friendly error.
    bindHost: typeof parsed.bindHost === 'string' && parsed.bindHost.trim().toLowerCase() === 'loopback'
      ? ''
      : parsed.bindHost ?? base.bindHost,
    retentionDays: parsed.retentionDays ?? base.retentionDays,
    adminToken: parsed.adminToken ?? base.adminToken,
    atlasEnabled: parsed.atlasEnabled ?? base.atlasEnabled,
    atlasUrl: parsed.atlasUrl ?? base.atlasUrl,
    atlasToken: parsed.atlasToken ?? base.atlasToken,
    atlasProject: parsed.atlasProject ?? base.atlasProject,
    harnesses: parsed.harnesses ?? base.harnesses,
    layaEnabled: parsed.layaEnabled ?? base.layaEnabled,
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
  // Fleet reachability (issue #665): the enrollment doc names "(b) a bind/port reachable
  // from Fleet" and nothing implemented it — the host answered only from loopback. The
  // default stays the secure loopback; answering here is what makes the hand-off URL real.
  const bindRaw = (await q('Expose the API to Fleet? (loopback / 0.0.0.0 / an address)', base.bindHost || 'loopback')).toLowerCase();
  // 'loopback' is a prompt spelling, never a file value: normalized to '' so the written
  // env omits MERCURY_BIND_HOST and src/config.ts keeps the secure default (#665 review).
  const bindHost = bindRaw === 'loopback' || bindRaw === '' ? '' : bindRaw;
  // Opt-in Laya sidecar (#831): default NO — pressing enter installs nothing. A re-run on a
  // host that already has MERCURY_LAYA_URL defaults to yes so an enter-press doesn't silently
  // disable a configured sidecar (same continuity rule as the admin token/bind).
  const layaOn = (await q('Install the Laya sidecar? (yes/no; selection support, opt-in)', base.layaEnabled ? 'yes' : 'no')).toLowerCase();
  const layaEnabled = layaOn === 'yes' || layaOn === 'y';
  return {
    hostName,
    layaUrl: base.layaUrl,
    dataDir,
    workspaceDir,
    bindHost,
    // Keep the parsed number as-is (0/NaN included): validateAnswers rejects it, so an
    // invalid input cannot silently fall back to the default and pass (review #633).
    retentionDays: Number.parseFloat(retention),
    adminToken,
    atlasEnabled,
    atlasUrl,
    atlasToken,
    atlasProject,
    harnesses,
    layaEnabled,
  };
}

/** Run the M2 probe over the shipped harnesses (#647). Injectable for tests. */
export type ProbeFn = () => Promise<HarnessProbeResult[]>;

/** Bounded sidecar exec default (#831): spawnSync with a hard timeout — a hung uv/pip is a
 *  failure with a readable message, not a hang (the installer's bound-everything rule). */
export const sidecarExec: RunFn = (argv, timeoutMs) => {
  // killSignal SIGKILL (Copilot #840 r40): spawnSync's default SIGTERM is catchable — a
  // uv/pip child that traps it keeps spawnSync waiting forever after timeoutMs, breaking the
  // installer's bounded-command guarantee. SIGKILL is uncatchable, so the bound always holds.
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' });
  // A timed-out command keeps stderr '' while r.error carries ETIMEDOUT (Copilot #840 r9):
  // `stderr ?? error` would discard the timeout and the step would report only 'no output'.
  // Prefer NON-EMPTY stderr, then the spawn error, then ''.
  const stderr = (r.stderr && r.stderr.trim() !== '' ? r.stderr : r.error?.message) ?? '';
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? '', stderr };
};

export async function runSetupProbe(env: NodeJS.ProcessEnv = process.env): Promise<HarnessProbeResult[]> {
  return Promise.all(harnessSpecs(env).map(probeHarness));
}

/** True when a controlling terminal can be opened, even if stdin is a pipe (`curl | bash`,
 *  issue #671). The install.sh hand-off normally redirects stdin from /dev/tty itself; this
 *  covers direct `mercury host setup` invocations from a piped/odd stdin. */
function ttyAvailable(): boolean {
  try {
    const fd = openSync('/dev/tty', 'r');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** Run the wizard. Returns the process exit code. */
/**
 * Restore the previous unit bytes (best effort) after a rollback: the unit file was already
 * overwritten when the failure happened, so the restored venv must be referenced by the OLD
 * unit too (Copilot #840 r59). A null backup leaves the current unit in place.
 */
function restoreLayaUnit(unitPath: string, backupText: string | null): boolean {
  if (backupText === null) return true; // nothing to restore: the unit still is the previous one
  try {
    const tmpUnit = join(dirname(unitPath), `.${basename(unitPath)}.rollback-${process.pid}-${randomBytes(6).toString('hex')}`);
    writeFileSync(tmpUnit, backupText, { flag: 'wx', mode: 0o600 });
    renameSync(tmpUnit, unitPath);
    return true;
  } catch {
    // The caller decides what a failed restore means for the build directory (#845 r2).
    return false;
  }
}

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
    /** Injected sidecar exec (tests, #831): the bounded runner for uv/venv/pip. Default runFn. */
    sidecarRun?: RunFn;
    /** Injected sidecar data dir override (tests). Default: the answers' dataDir. */
    sidecarDataDir?: string;
    /** Overall readiness budget in ms (r11/r21): default 18 min — a fresh sidecar downloads
     *  the ~843 MB English checkpoint before it answers. Tests shrink this. */
    sidecarReadinessBudgetMs?: number;
    /** Gap between readiness probes; default 5 000 ms. Tests shrink this. */
    sidecarReadinessGapMs?: number;
    /** Probe base URL override (r16): tests point it at an ephemeral-port fake so they never
     *  bind 127.0.0.1:8302 — the fixed port a real sidecar may already own on a dev host. */
    sidecarProbeUrl?: string;
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
    } else if (process.stdin.isTTY || ttyAvailable()) {
      // TTY stdin, or a controlling terminal behind a pipe (`curl | bash`, #671): the
      // prompts must reach the operator, not the exhausted script stream. /dev/tty is
      // opened for INPUT; output still goes to stdout.
      // A controlling terminal can exist behind a pipe (`curl | bash`, #671): prompts
      // read /dev/tty, never the exhausted script stream.
      const ttyInput = process.stdin.isTTY ? null : createReadStream('', { fd: openSync('/dev/tty', 'r') });
      const input = ttyInput ?? process.stdin;
      const rl = createInterface({ input, output: process.stdout });
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
      try {
        answers = await promptAnswers({ question, secretQuestion }, env, probe);
      } finally {
        // The /dev/tty stream (when we opened it) must be released even when prompting
        // throws — a leaked fd keeps the tty open after the process should be done
        // (Copilot review on #675).
        rl.close();
        if (ttyInput) ttyInput.close();
      }
    } else {
      // Last resort: genuinely scripted/test input via piped stdin. Reached only when
      // stdin is not a TTY AND no controlling terminal exists (#671), so the
      // empty-buffer-makes-everything-default hazard cannot hit a real install.
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

  // Operator-managed variables must survive a rewrite (#673, generalizing #668 round 6):
  // every existing key the wizard does not own (MERCURY_PORT, MERCURY_LOG_LEVEL, TLS vars,
  // sandbox/runtime settings — anything the host reads that the wizard never asks about)
  // is carried forward verbatim. A re-run that silently dropped MERCURY_PORT would restart
  // the host on the default port and make the hand-off print the wrong URL.
  const existingVars = existsSync(envFilePath(env)) ? loadEnvFile(envFilePath(env)) : {};
  const wizardOwned = WIZARD_VARIABLES as readonly string[];
  // Empty-string values are preserved too: an operator may set a variable empty ON
  // PURPOSE to hold the host at a non-default (dropping it would silently re-enable the
  // default — Copilot review on #677).
  const preservedEntries = Object.entries(existingVars)
    .filter(([k]) => !wizardOwned.includes(k))
    .filter((pair): pair is [string, string] => typeof pair[1] === 'string');
  // The file feeds systemd EnvironmentFile, bash source, and the doctor parser (#649 §3):
  // a preserved value outside the safe charset must fail the re-run, not sneak back in.
  for (const [k, v] of preservedEntries) {
    const err = unsafeValueError(k, v);
    if (err) throw new Error(`${k}: ${err}`);
  }
  const preserved = Object.fromEntries(preservedEntries);
  // Names only in the summary — some preserved values may be credentials (#673).
  const preservedNames = preservedEntries.map(([k]) => k).sort();
  const content = renderEnv(answers, preserved);
  const path = envFilePath(env);
  const alreadyConfigured = existsSync(path);
  if (opts.dryRun) {
    io.out('mercury host setup --dry-run\n');
    io.out(redactedSummary(answers, preservedNames) + '\n');
    if (answers.layaEnabled) {
      // --dry-run touches nothing (M1/M3 rule): no interpreter probing, no exec — pythonBin
      // does not change the plan, and the plan comes from the VALIDATED answers, not the old
      // env file (Copilot #840 r1).
      // r22: an external URL is PRESERVED, not installed — the plan must mirror what a
      // confirmed run actually does (verify only), not list local-install actions that would
      // be skipped.
      if (answers.layaUrl.trim() !== '' && !isWizardManagedLayaDefault(answers.layaUrl, LAYA_DEFAULT_PORT)) {
        io.out(`\nLaya sidecar (external): preserve MERCURY_LAYA_URL=${answers.layaUrl.trim()} and verify it with the doctor probe (no local install)\n`);
      } else {
        // #845: mirror the real run — a versioned build directory, not the legacy path.
        const dryDataDir = io.sidecarDataDir ?? answers.dataDir.trim();
        const plan = planLayaSidecar({
          dataDir: dryDataDir, pythonBin: 'python3', env,
          venvDir: join(dryDataDir, `laya-venv-${LAYA_SERVE_PIN}-<UTC timestamp>-<random>`),
        });
        io.out('\nLaya sidecar (opt-in) would:\n' + layaStepActions(plan, 'both').map((a) => `  - ${a}`).join('\n') + '\n');
      }
    }
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
    io.out(`\n${path} already exists. Current state:\n`);
    printStatus(hostStatus(process.platform, env), io);
    io.out(`\nProposed changes (secrets redacted):\n`);
    io.out(diff);
    io.out('\nPass --yes to confirm.\n');
    return 1;
  }

  writeEnvFile(path, content);
  io.out('mercury host setup\n');
  io.out(redactedSummary(answers, preservedNames) + '\n');
  io.out(`\nWrote ${path} (mode 0600). Start the host with \`mercury host doctor\` (M4).\n`);
  // Opt-in Laya sidecar (#831): interpreter gate → venv → pinned install → credentials →
  // unit. Every command is bounded; the injected runner keeps tests off the real uv/pip.
  if (answers.layaEnabled) {
      // r21: an EXTERNALLY configured URL (preserved from the old env) is verified, never
    // replaced: installing/restarting a local sidecar would silently take over the endpoint.
    const externalLaya = answers.layaUrl.trim() !== '' && !isWizardManagedLayaDefault(answers.layaUrl, LAYA_DEFAULT_PORT);
    const dataDir = io.sidecarDataDir ?? dirname(loadEnvFile(path).MERCURY_DB ?? join(homedir(), '.local', 'state', 'mercury', 'mercury.db'));
    const run = io.sidecarRun ?? sidecarExec;
    if (externalLaya) {
      const written0 = loadEnvFile(path);
      const timeout0 = parseLayaTimeoutMs(written0);
      if (!timeout0.ok) {
        io.err(`\nlaya: ${timeout0.detail}\n`);
        return 1;
      }
      // The doctor's own credential resolution (runHostDoctor): read laya-credentials.json and
      // use its api key. A missing/unreadable entry is a NAMED FAILURE exactly as the doctor
      // reports it ("auth cannot be checked") — probing key-less would let an auth-disabled
      // endpoint answer 200 and print `doctor ok` for a config the doctor immediately rejects
      // (Copilot #840 r27).
      let apiKey: string | undefined;
      let keyDetail: string | undefined;
      try {
        apiKey = readLayaCredentials(env).api;
      } catch (err) {
        keyDetail = (err as Error).message;
      }
      if (apiKey === undefined) {
        io.err(`\nlaya: auth cannot be checked: ${keyDetail ?? 'no laya credentials'}\n`);
        io.err('laya: write laya-credentials.json ({"api": "<key>"}, mode 0600) — or unset MERCURY_LAYA_URL to let setup manage a local sidecar — then re-run.\n');
        return 1;
      }
      io.out(`laya: external endpoint ${answers.layaUrl.trim()} preserved — verifying with the doctor probe (no local install)\n`);
      const probe = await checkLaya(answers.layaUrl.trim(), apiKey, timeout0.timeoutMs);
      if (!probe.ok) {
        io.err(`\nlaya: the preserved endpoint failed the doctor probe: ${probe.detail}\n`);
        io.err('laya: fix the external sidecar, or point MERCURY_LAYA_URL at a local install and re-run setup.\n');
        return 1;
      }
      io.out(`laya: doctor ok — ${probe.detail}\n`);
    } else {
    // env flows in so PATH discovery sees the operator's PATH (r15: spaced interpreter dirs).
    // The readiness gate needs a valid MERCURY_LAYA_TIMEOUT_MS. Refuse an invalid one HERE,
    // before the live venv is moved aside or the unit restarted: failing after activation
    // left a full backup venv behind on every re-run (Copilot #840 r61).
    const timeoutPre = parseLayaTimeoutMs(loadEnvFile(path));
    if (!timeoutPre.ok) {
      io.err(`\nlaya: ${timeoutPre.detail}\n`);
      return 1;
    }
    const det = detectPython(run, DEFAULT_PYTHON_CANDIDATES, process.platform, env);
    if (!det.ok) {
      io.err(`\nlaya: not installed — ${det.reason}\n`);
      io.err('laya: the sidecar needs uv (recommended) or Python >= 3.10. Install one first:\n');
      io.err('  macOS:   brew install uv   (or: brew install python@3.12 — setup finds python3.12 on PATH)\n');
      io.err('  Linux:   install uv (curl -LsSf https://astral.sh/uv/install.sh | sh) or the distro python3\n');
      io.err('laya: then re-run `mercury host setup --yes`, or answer no to the sidecar prompt.\n');
      return 1;
    }
    // #845: build into a versioned directory a previous run can never have used; the unit is
    // the only commit point. The previous generation (whatever the CURRENT unit references, or
    // the #840-era '<dataDir>/laya-venv') is never touched until the sweep after readiness.
    const unitPlan = planLayaSidecar({ dataDir, pythonBin: det.bin!, env });
    const prevUnitText = existsSync(unitPlan.unitPath) ? readFileSync(unitPlan.unitPath, 'utf8') : null;
    // The previous generation's venv directory: the unit's own laya-serve path (versioned
    // dirs, #845) or the legacy '<dataDir>/laya-venv' for a #840-era unit / fresh host.
    const prevVenv = (() => {
      if (prevUnitText === null) return join(dataDir, 'laya-venv');
      const m = /<string>([^<]*\/bin\/laya-serve)<\/string>/.exec(prevUnitText) ?? /ExecStart=([^\s]+)/.exec(prevUnitText);
      const serve = m?.[1];
      return serve && serve.startsWith(dataDir) ? dirname(dirname(serve)) : join(dataDir, 'laya-venv');
    })();
    const buildDir = join(dataDir, `laya-venv-${LAYA_SERVE_PIN}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`);
    const plan: LayaPlan = planLayaSidecar({ dataDir, pythonBin: det.bin!, venvDir: buildDir, env });
    // The detector must tell us HOW it found the interpreter: `uv venv` without seed has no
    // pip, and a plain-python fallback has no uv at all (Copilot #840 r1). Replay the winning
    // candidate's own venv command and install through the venv's pip (seeded for uv).
    // Snapshot the OLD unit bytes for rollback (#845/#840 r56/r61): the unit is overwritten
    // before the service is reloaded, so a failed activation must be able to restore both the
    // previous unit and the generation it references.
    let unitBackupText: string | null = prevUnitText;
    const steps: Array<[string, () => void]> = [
      ['venv', det.argv![0] === 'uv'
        ? () => {
            const r = run(['uv', 'venv', plan.venvDir, '--python', `3.${det.version!.split('.')[1]}`, '--seed'], 120_000);
            if (!r.ok) throw new Error(`uv venv failed: ${r.stderr.trim() || r.stdout.trim() || 'no output'}`);
          }
        : () => {
            // The executable is det.argv[0] — the exact path that passed -V. det.bin can contain
            // spaces (a discovered interpreter under '/Users/Jane Doe/bin'), and splitting on
            // ' ' would truncate it (Copilot #840 r15).
            const pyBin = det.argv![0]!;
            const r = run([pyBin, '-m', 'venv', plan.venvDir], 120_000);
            if (!r.ok) throw new Error(`python -m venv failed: ${r.stderr.trim() || r.stdout.trim() || 'no output'}`);
          }],
      ['install', () => {
        const r = run([join(plan.venvDir, 'bin', 'python3'), '-m', 'pip', 'install', `laya[serve]==${LAYA_SERVE_PIN}`], 300_000);
        if (!r.ok) throw new Error(`pip install laya[serve]==${LAYA_SERVE_PIN} failed: ${r.stderr.trim() || r.stdout.trim() || 'no output'}`);
      }],
      ['credentials', () => {
        ensureLayaCredentials(env);
      }],
      ['unit', () => {
        const creds = ensureLayaCredentials(env);
        mkdirSync(dirname(plan.unitPath), { recursive: true });
        const text = process.platform === 'darwin' ? renderLayaLaunchdPlist(plan, creds.key) : renderLayaSystemdUnit(plan, creds.key);
        // The unit embeds the API key: secret-bearing bytes must never land in a loose file
        // (Copilot #840 r15). Atomic 0600 temp + fsync + rename, then enforce 0600 — the same
        // pattern as writeEnvFile; a re-run over a pre-existing 0644 unit therefore never
        // exposes the key at any instant (r1's trailing chmod alone is too late).
        // Unique O_EXCL temp (Copilot #840 r52): a crashed run's leftover `.<label>.tmp-<pid>`
        // keeps its old mode when the PID is reused — `mode` only applies at creation. 'wx' +
        // a random suffix guarantees a fresh 0600 file.
        const tmpUnit = join(dirname(plan.unitPath), `.${plan.unitLabel}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
        writeFileSync(tmpUnit, text, { flag: 'wx', mode: 0o600 });
        const fd = openSync(tmpUnit, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmpUnit, plan.unitPath);
        chmodSync(plan.unitPath, 0o600);
        // Best-effort cleanup of a crashed run's predictable temp (same pid) — ours to remove.
        rmSync(join(dirname(plan.unitPath), `.${plan.unitLabel}.tmp-${process.pid}`), { recursive: true, force: true });
      }],
    ];
    // Roll the service back to the previous environment when activation or the readiness gate
    // fails (#845): restore the previous UNIT bytes, reload, and delete the unverified build
    // directory. The previous venv was never moved, so there is nothing else to restore.
    // Best effort — the original error is what the operator sees.
    const rollbackLaya = () => {
      // Whether the enabled unit no longer references the (unverified) build directory: the
      // unit bytes are restored AND the service manager accepted the rollback (Copilot #846
      // r5) — a manager that still caches the new ExecStart must keep the executable tree.
      let unitSafe = false;
      try {
        if (unitBackupText === null) {
          // No previous unit (a fresh install): there is nothing to go back TO, but the new unit
          // is already enabled/bootstrapped. Leaving it would keep a failed sidecar in a restart
          // loop (Copilot #840 r63). Stop and unregister it, remove the unit file, and delete
          // the unverified build directory so the host is as before setup.
          let stopped = true;
          if (process.platform === 'darwin') {
            // A fresh install whose bootstrap itself failed never registered the job — bootout
            // would answer 'not loaded' and read as a failure (Copilot #846 r6). Ask the
            // manager first: not loaded = stopped.
            const printR = run(['launchctl', 'print', `${uid}/${plan.unitLabel}`], 10_000);
            stopped = printR.ok
              ? run(['launchctl', 'bootout', `${uid}/${plan.unitLabel}`], 10_000).ok
              : true;
          } else {
            const stoppedR = run(['systemctl', '--user', 'disable', '--now', plan.unitLabel], 15_000);
            stopped = stoppedR.ok;
            if (stopped) run(['systemctl', '--user', 'daemon-reload'], 15_000);
          }
          if (stopped) rmSync(plan.unitPath, { force: true });
          unitSafe = stopped && !existsSync(plan.unitPath);
        } else {
          const restored = restoreLayaUnit(plan.unitPath, unitBackupText);
          let reloaded = false;
          if (restored) {
            if (process.platform === 'darwin') {
              run(['launchctl', 'bootout', `${uid}/${plan.unitLabel}`], 10_000);
              reloaded = run(['launchctl', 'bootstrap', uid, plan.unitPath], 15_000).ok;
            } else {
              const reload = run(['systemctl', '--user', 'daemon-reload'], 15_000);
              reloaded = reload.ok && run(['systemctl', '--user', 'restart', plan.unitLabel], 15_000).ok;
            }
          }
          // The unit bytes on disk are the previous ones; the manager accepted them only if the
          // reload/restart succeeded.
          unitSafe = restored && reloaded
            && (() => { try { return readFileSync(plan.unitPath, 'utf8') === unitBackupText; } catch { return false; } })();
        }
      } catch {
        // Best effort — the original error is what the operator sees.
      }
      // The build directory is not live unless readiness proved it; after any post-commit
      // failure it is garbage (best effort: injected runners may not have created it). Keep it
      // whenever the enabled unit might still reference it (Copilot #846 r2/r3/r5).
      if (unitSafe) rmSync(plan.venvDir, { recursive: true, force: true });
    };
    try {
      for (const [name, step] of steps) {
        step();
        io.out(`laya: ${name} ok\n`);
      }
      io.out(`laya: unit written at ${plan.unitPath}\n`);
    } catch (e) {
      // Rollback (#845): a failure during build/install/unit leaves the previous unit and venv
      // untouched (the unit rename is the commit point) — only the partial build directory must
      // go. If the unit WAS already renamed, restore the previous bytes — and delete the build
      // directory only if the enabled unit no longer references it (a failed restore would
      // otherwise leave the unit pointing at a deleted tree, Copilot #846 r3).
      if (unitBackupText === null && existsSync(plan.unitPath)) {
        // A fresh install that failed AFTER the commit rename (a throwing chmod/cleanup): the
        // new unit references the unverified build dir and must go (Copilot #846 r4).
        try {
          rmSync(plan.unitPath, { force: true });
          if (process.platform !== 'darwin') run(['systemctl', '--user', 'daemon-reload'], 15_000);
        } catch {
          // Kept below: a failed removal keeps the build dir for the enabled unit.
        }
      }
      restoreLayaUnit(plan.unitPath, unitBackupText);
      const restored = (() => {
        try {
          if (unitBackupText === null) return !existsSync(plan.unitPath);
          return existsSync(plan.unitPath) && readFileSync(plan.unitPath, 'utf8') === unitBackupText;
        } catch {
          return false;
        }
      })();
      if (restored) rmSync(plan.venvDir, { recursive: true, force: true });
      io.err(`\nlaya: not installed — ${(e as Error).message}\n`);
      io.err('laya: mercury.env was written; the sidecar can be finished later by re-running `mercury host setup --yes`.\n');
      return 1;
    }
    // Load the agent idempotently and verify with the doctor's own probe (#831 acceptance:
    // the run finishes with doctor `laya: ok` — an unloaded agent makes that probe unreachable,
    // Copilot #840 r10). Bounded, injected through the same run fn as every other step.
    const uid = `gui/${process.getuid?.() ?? 501}`;
    if (process.platform === 'darwin') {
      // Same choreography as `mercury host service install` (src/host/service.ts, issue #650):
      // kick out the LOADED job first, then bootstrap the NEW plist. kickstart alone would
      // restart launchd's cached job and never pick up the rewritten plist (Copilot #840 r12) —
      // e.g. a re-run that moved the data dir would keep serving the OLD venv path.
      const target = `${uid}/${plan.unitLabel}`;
      const printR = run(['launchctl', 'print', target], 10_000);
      if (printR.ok) {
        const bootout = run(['launchctl', 'bootout', target], 10_000);
        if (!bootout.ok) io.err(`laya: bootout failed (continuing): ${(bootout.stderr.trim() || bootout.stdout.trim() || 'no output').split('\n')[0]}\n`);
      }
      const bootstrap = run(['launchctl', 'bootstrap', uid, plan.unitPath], 15_000);
      if (!bootstrap.ok) {
        io.err(`\nlaya: launchctl bootstrap failed: ${(bootstrap.stderr.trim() || bootstrap.stdout.trim() || 'no output').split('\n')[0]}\n`);
        rollbackLaya();
        return 1;
      }
    } else {
      // Reload the user manager FIRST (Copilot #840 r13): a freshly written unit is invisible
      // to `enable --now` until daemon-reload ("Unit ... not found") — the same order the host
      // and bot installers use (src/host/service.ts, src/host/bots/service.ts). Any systemctl
      // failure returns immediately: waiting through the readiness window against a service
      // that was never started only produces a confusing 'unreachable'.
      const reload = run(['systemctl', '--user', 'daemon-reload'], 15_000);
      if (!reload.ok) {
        io.err(`\nlaya: systemctl --user daemon-reload failed: ${(reload.stderr.trim() || reload.stdout.trim() || 'no output').split('\n')[0]}\n`);
        rollbackLaya();
        return 1;
      }
      // enable WITHOUT --now (r18): --now starts the unit and the restart below would kill the
      // first process mid-preload (the ~843 MB checkpoint download) and start over. A plain
      // enable registers the unit; the single `restart` then STARTS an inactive unit and
      // RESTARTS an active one — exactly one startup on both the fresh and the re-run path.
      const loadCmd = ['systemctl', '--user', 'enable', plan.unitLabel];
      io.out(`laya: loading — ${loadCmd.join(' ')}`);
      const loaded = run(loadCmd, 15_000);
      if (!loaded.ok) {
        io.err(`\nlaya: systemctl enable failed: ${(loaded.stderr.trim() || loaded.stdout.trim() || 'no output').split('\n')[0]}\n`);
        rollbackLaya();
        return 1;
      }
      // A re-run that rewrote the unit or rotated the key must not leave the OLD process
      // serving (Copilot #840 r11) — restart unconditionally.
      const restarted = run(['systemctl', '--user', 'restart', plan.unitLabel], 15_000);
      if (!restarted.ok) {
        io.err(`\nlaya: systemctl restart failed: ${(restarted.stderr.trim() || restarted.stdout.trim() || 'no output').split('\n')[0]}\n`);
        rollbackLaya();
        return 1;
      }
    }
    const written = loadEnvFile(path);
    // Tests inject the probe URL (r16) so they never bind the fixed port a real sidecar may
    // already own on a development host.
    const baseUrl = io.sidecarProbeUrl ?? written.MERCURY_LAYA_URL ?? `http://127.0.0.1:${plan.port}/v1/systemone`;
    const creds = ensureLayaCredentials(env);
    // The success gate is the doctor's own check: the SAME timeout parsing/deadline doctor will
    // use (MERCURY_LAYA_TIMEOUT_MS, default 500 — Copilot #840 r12). An invalid value refuses
    // here with the doctor's wording instead of reporting ok against a deadline doctor rejects.
    const timeout = parseLayaTimeoutMs(written);
    if (!timeout.ok) {
      // Unreachable in practice (validated before the rebuild, r61) — but this is after
      // activation, so it must still roll back (Copilot #840 r63).
      io.err(`\nlaya: ${timeout.detail}\n`);
      rollbackLaya();
      return 1;
    }
    // A FRESH sidecar preloads the English checkpoint (~843 MB) before it answers — the
    // readiness window must cover that first download, not a few seconds (Copilot #840 r11).
    // The window is an ELAPSED-TIME budget (default 18 min), not an attempt count: a large
    // MERCURY_LAYA_TIMEOUT_MS must not stretch setup to hours (Copilot #840 r21). Each probe
    // and sleep is capped to the remaining budget, so the loop is hard-bounded.
    const budgetMs = io.sidecarReadinessBudgetMs ?? 18 * 60_000;
    const gapMs = io.sidecarReadinessGapMs ?? 5_000;
    const started = Date.now();
    let last = '';
    let attempts = 0;
    for (;;) {
      const remaining = budgetMs - (Date.now() - started);
      if (remaining <= 0) {
        io.err(`\nlaya: loaded but the doctor probe failed within ${Math.round(budgetMs / 60_000)} min (${attempts} attempts): ${last}\n`);
        io.err(`laya: inspect with \`launchctl print ${uid}/${plan.unitLabel}\` (macOS) or \`journalctl --user -u ${plan.unitLabel}\` (Linux), then re-run setup.\n`);
        rollbackLaya();
        return 1;
      }
      attempts += 1;
      // The probe is the doctor's #830 line, not a new check: same client, same deadline
      // (capped to the remaining budget).
      const probe = await checkLaya(baseUrl, creds.key, Math.min(timeout.timeoutMs, remaining));
      last = probe.detail;
      if (probe.ok) {
        // A successful AUTHENTICATED probe does not prove auth is ON: laya-serve answers
        // every request when LAYA_API_KEY is unset, so an UNAUTHENTICATED sidecar that already
        // owns the port would read as healthy (Copilot #840 r21). Require a key-less probe to
        // get 401 — the unit embeds the key, so the answering service must be ours.
        // A timed-out or transiently-failing anonymous probe is INCONCLUSIVE — it must not be
        // read as "answers without a key" (Copilot #840 r28): a healthy sidecar mid-request or
        // a 5xx blip would fail the install. Only a successful anonymous response proves the
        // endpoint is open; a definitive 401 proves auth is on. Everything else retries within
        // the remaining budget. The anon timeout is at least 1 ms and bounded by what is left,
        // so a long first probe can never push the second past the budget.
        for (;;) {
          const anonLeft = budgetMs - (Date.now() - started);
          if (anonLeft <= 0) {
            io.err(`\nlaya: the readiness budget ran out while proving auth on ${baseUrl} (${attempts} attempts) — last probe: ${last}\n`);
            io.err(`laya: inspect with \`launchctl print ${uid}/${plan.unitLabel}\` (macOS) or \`journalctl --user -u ${plan.unitLabel}\` (Linux), then re-run setup.\n`);
            rollbackLaya();
            return 1;
          }
          const anon = await checkLaya(baseUrl, '', Math.max(1, Math.min(timeout.timeoutMs, anonLeft)));
          if (anon.ok) {
            io.err(`\nlaya: the sidecar at ${baseUrl} answers WITHOUT a key — that is not the unit setup installed (LAYA_API_KEY unset), so the port is owned by another service.\n`);
            // The new unit is already active: route through the transaction like every other
            // post-activation failure (Copilot #840 r63).
            rollbackLaya();
            return 1;
          }
          if (isLayaAuthRejected(anon.detail)) break; // auth proven (normalized verdict, not a '401' substring)
          // Inconclusive (timeout/unreachable/5xx): retry after the gap, like the main loop.
          // Recorded only for the FAILURE paths — the success line keeps the AUTHENTICATED
          // probe's detail (printing a stale anon blip under 'doctor ok' misled, Copilot #840 r30).
          last = anon.detail;
          const sleepMs = Math.min(gapMs, budgetMs - (Date.now() - started));
          if (sleepMs > 0) await new Promise((res) => setTimeout(res, sleepMs));
        }
        io.out(`laya: doctor ok — ${probe.detail}\n`);
        break;
      }
      // A 401 on the AUTHENTICATED probe is definitive, not startup noise: our unit either
      // holds the port (the embedded key matches → 200) or has not bound yet (unreachable →
      // retry). A sidecar that is UP and rejecting our key is ANOTHER auth-enabled service
      // that got there first — retrying would just burn the budget (Copilot #840 r32).
      if (probe.ok === false && isLayaAuthRejected(probe.detail)) {
        io.err(`\nlaya: the sidecar at ${baseUrl} rejected the configured key (401) while the unit is not yet serving — another auth-enabled sidecar owns the port.\n`);
        io.err(`laya: stop that service or set MERCURY_LAYA_URL to its URL, then re-run setup.\n`);
        rollbackLaya();
        return 1;
      }
      if (attempts === 1) io.out('laya: waiting for the sidecar — first start downloads the English checkpoint (~843 MB)\n');
      const sleepMs = Math.min(gapMs, budgetMs - (Date.now() - started));
      if (sleepMs > 0) await new Promise((res) => setTimeout(res, sleepMs));
    }
    // Readiness proven — the new venv is live. Sweep (#845): remove installer-owned venv
    // directories the new unit does not reference, keeping exactly one previous generation
    // (the one the previous unit pointed at). Installer-owned means the exact legacy name
    // 'laya-venv' or a generated 'laya-venv-<pin>-<ts>-<rand>' — an operator's
    // 'laya-venv-notes' or 'laya-venv.backup-manual' is never touched (Copilot #846 r2).
    // Per-entry try/catch: cleanup is best effort — a dangling symlink or an unreadable entry
    // is disk space, never a reason to fail a finished install (Copilot #846 r2).
    {
      // Pin-independent: after a pin upgrade the previous pin's generated dirs must still be
      // swept (Copilot #846 r3).
      const gen = /^laya-venv-\d+\.\d+\.\d+-\d{14}-[0-9a-f]{8}$/;
      const keep = new Set([plan.venvDir, prevVenv]);
      for (const entry of existsSync(dataDir) ? readdirSync(dataDir) : []) {
        const owned = entry === 'laya-venv' || gen.test(entry);
        if (!owned) continue;
        const full = join(dataDir, entry);
        if (keep.has(full)) continue;
        try {
          if (lstatSync(full).isDirectory()) rmSync(full, { recursive: true, force: true });
          else unlinkSync(full); // a file or dangling symlink with an installer-owned name
        } catch {
          // Best effort: leave it — disk space, not a correctness problem.
        }
      }
    }
    }
  }
  // The Fleet hand-off is the wizard's output contract on EVERY successful write, not
  // only when a token is generated (#672): the loopback branch advises re-running with a
  // bind address, and that re-run (token preserved since #648) must still print the URL
  // the operator came for.
  {
    // The port is the one the doctor will use — the env file's, not this shell's (#648 review).
    const port = loadEnvFile(path).MERCURY_PORT ?? '3000';
    const written = loadEnvFile(path);
    const scheme = schemeFor(written);
    io.out('\nRegister on the Fleet side:\n');
    if (generatedToken) {
      // The one place the generated token is shown (#648, decision 6): Fleet presents it
      // as a Bearer token to the host API, so the operator registers exactly this value
      // on the Fleet side. It is in the 0600 file afterwards and never printed again.
      io.out(`  host API token:    ${answers.adminToken}\n`);
    } else if (existingVars.MERCURY_ADMIN_TOKEN === answers.adminToken) {
      io.out('  host API token:    unchanged (already registered on the Fleet side)\n');
    } else {
      // Rotated interactively (a new value was typed) or supplied for the first time:
      // never display it (#648 decision 6), but do not claim it is unchanged
      // (Copilot review on #676).
      io.out('  host API token:    updated (not shown; register the new value on the Fleet side)\n');
    }
    // Fleet reachability (issue #665): with the secure default the API answers only from
    // the host itself, so a URL would register a host that never comes up. Say so, and
    // name the TLS variables — this exposes an admin-token API over plain http.
    const bindShown = answers.bindHost.trim().toLowerCase();
    // Loopback-equivalent values (explicit 127.0.0.1 / localhost, or the empty default)
    // are unreachable from Fleet — the whole point of this block (issue #649 review on
    // #668): never print a URL Fleet cannot use.
    const loopbackLike = !bindShown || bindShown === 'loopback' || bindShown === '127.0.0.1' || bindShown === 'localhost';
    if (!loopbackLike) {
      const shown = bindShown === '0.0.0.0' ? '<this-host>' : bindShown;
      // Scheme must match what the API serves: https when MERCURY_TLS_CERT/KEY are
      // written, plain http otherwise (#668 round 6 review).
      io.out(`  host API base URL: ${scheme}://${shown}:${port}\n`);
      if (scheme === 'http') {
        io.out('  NOTE: the API is exposed over plain http with an admin token (MERCURY_TLS_CERT/MERCURY_TLS_KEY are unset).\n');
        io.out('  Put the host behind a TLS-terminating reverse proxy or set MERCURY_TLS_CERT and MERCURY_TLS_KEY.\n');
      }
    } else {
      io.out(`  API bind: loopback (secure default). Fleet cannot reach it from here.\n`);
      io.out('  Re-run `mercury host setup --yes` and answer the bind question with 0.0.0.0 or an address,\n');
      io.out('  or tunnel the port. The token above stays valid either way.\n');
    }
  }
  return 0;
}

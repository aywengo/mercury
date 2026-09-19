/**
 * `mercury host probe` — the M2 harness probe (docs/host-installer.md M2).
 *
 * Reports, for each harness with a shipped adapter, the facts the configuration wizard
 * needs to render its enable checklist:
 *
 *   - binary path (the configured cmd; a bare name is resolved through PATH, which is
 *     the same resolution the adapter's spawn uses)
 *   - detected version (bounded probe of the real binary)
 *   - the adapter's declared minimum version
 *   - whether the detected version satisfies the floor
 *   - the harness's known config path
 *   - auth/login state (best-effort file signals, never secrets)
 *
 * Three rules this file exists to enforce:
 *
 * 1. **It never requires a configured host.** Like `host install`, this runs before
 *    `loadConfig()`: the wizard uses it on a host that is not configured yet.
 * 2. **It never throws on a missing/broken harness.** A harness that is not installed,
 *    whose binary hangs, or whose version cannot be parsed is reported as `missing` /
 *    `unknown` — the wizard renders those states instead of crashing.
 * 3. **A harness without a shipped adapter does not appear at all.** The probe iterates
 *    the shipped adapter set (primeagent, hermes, claude); `fake` and declarative
 *    local agents are not host harnesses and are not probed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { compareVersions } from '../domain/goalSupport.ts';
import { probeVersion } from '../adapters/versionProbe.ts';
import { PrimeAgentAdapter } from '../adapters/primeAgentAdapter.ts';
import { HermesAgentAdapter } from '../adapters/hermesAgentAdapter.ts';
import { ClaudeCodeAdapter } from '../adapters/claudeCodeAdapter.ts';

/** One harness the probe knows how to inspect. */
export interface HarnessSpec {
  id: string;
  label: string;
  /** Resolved binary path: env override or the adapter default. */
  cmd: string;
  /** The adapter's declared minimum version (capabilities.minVersion). */
  minVersion: string | undefined;
  /** Known config file/dir, for the wizard's "where is it configured" column. */
  configPath: string;
  /** Best-effort auth signal: 'yes' when a real credential file exists, 'no' when the
   *  harness is known to be logged out, 'unknown' when the platform cannot tell
   *  cheaply (issue #650: a false positive misreads as logged-in). */
  auth: () => 'yes' | 'no' | 'unknown';
}

export interface HarnessProbeResult {
  id: string;
  label: string;
  binary: string;
  /** Detected version, or null when the binary is missing/unparsable. */
  version: string | null;
  versionRaw: string | null;
  /** The adapter's declared floor. */
  minVersion: string | null;
  /** 'ok' | 'too-old' | 'missing' | 'unknown' — the wizard's checklist states. */
  status: 'ok' | 'too-old' | 'missing' | 'unknown';
  configPath: string;
  configExists: boolean;
  auth: 'logged-in' | 'not-logged-in' | 'unknown';
  /** Probe error detail, when the binary could not be asked. */
  error?: string;
}

/** The shipped harness set. `fake` and declarative local agents are not host harnesses. */
export function harnessSpecs(env: NodeJS.ProcessEnv = process.env): HarnessSpec[] {
  const home = homedir();
  return [
    {
      id: 'primeagent',
      label: 'PrimeAgent',
      cmd: env.MERCURY_PRIMEAGENT_CMD ?? 'prime-agent',
      minVersion: new PrimeAgentAdapter('prime-agent').capabilities.minVersion,
      configPath: join(home, '.prime', 'agent'),
      auth: () => (existsSync(join(home, '.prime', 'agent', 'auth.json')) ? 'yes' : 'no'),
    },
    {
      id: 'hermes',
      label: 'Hermes Agent',
      cmd: env.MERCURY_HERMES_CMD ?? 'hermes',
      minVersion: new HermesAgentAdapter().capabilities.minVersion,
      configPath: join(home, '.hermes', 'config.yaml'),
      auth: () => {
        const p = join(home, '.hermes', 'config.yaml');
        if (!existsSync(p)) return 'no';
        try {
          // The exact YAML key `api_key:` — NOT `api_key_file:`/`api_key_path:`, which
          // would be a false positive for "logged in" (review #631).
          return readFileSync(p, 'utf8').split('\n').some((l) => /^api_key\s*:/.test(l.trim())) ? 'yes' : 'no';
        } catch {
          // An unreadable file is not a known logged-out state (Copilot review on #657):
          // the signal cannot be inspected, which is `unknown`, not a false negative.
          return 'unknown';
        }
      },
    },
    {
      id: 'claude',
      label: 'Claude Code',
      cmd: env.MERCURY_CLAUDE_CMD ?? 'claude',
      minVersion: new ClaudeCodeAdapter().capabilities.minVersion,
      configPath: join(home, '.claude.json'),
      // ~/.claude.json is created on first launch whether or not the user is logged
      // in (issue #650), so it is not an auth signal. The credential file exists only
      // after a real login on Linux — absent reads `not-logged-in` there. On macOS
      // the copy lives in the Keychain, which is not cheaply checkable: honest
      // `unknown` beats both a false positive and a false negative.
      auth: () => {
        if (existsSync(join(home, '.claude', '.credentials.json'))) return 'yes';
        return process.platform === 'darwin' ? 'unknown' : 'no';
      },
    },
  ];
}

/** Probe one harness. Never throws: every failure mode becomes a status. */
export async function probeHarness(spec: HarnessSpec): Promise<HarnessProbeResult> {
  const base: HarnessProbeResult = {
    id: spec.id,
    label: spec.label,
    binary: spec.cmd,
    version: null,
    versionRaw: null,
    minVersion: spec.minVersion ?? null,
    status: 'unknown',
    configPath: spec.configPath,
    configExists: existsSync(spec.configPath),
    auth: 'unknown',
  };

  // Auth comes from config-file signals and is reportable even when the binary is
  // missing or unparsable — the wizard wants "not logged in" next to "missing".
  const authSignal = spec.auth();
  base.auth = authSignal === 'yes' ? 'logged-in' : authSignal === 'no' ? 'not-logged-in' : 'unknown';

  const info = await probeVersion({ cmd: spec.cmd });
  if (info.error) {
    base.error = info.error;
    // Branch on the machine-readable code, not the message wording (issue #650).
    base.status = info.code === 'ENOENT' ? 'missing' : 'unknown';
    return base;
  }
  base.version = info.version;
  base.versionRaw = info.raw;

  if (spec.minVersion === undefined) {
    base.status = 'unknown';
  } else if (info.version === null) {
    base.status = 'unknown';
  } else {
    base.status = compareVersions(info.version, spec.minVersion) >= 0 ? 'ok' : 'too-old';
  }
  return base;
}

/** Run the probe and print JSON. Returns the process exit code. */
export async function runHostProbe(
  args: string[],
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
): Promise<number> {
  for (const a of args) {
    if (a !== '--json') {
      io.err(`host probe: unknown flag '${a}'. Expected --json.\n`);
      return 1;
    }
  }
  const results = await Promise.all(harnessSpecs().map(probeHarness));
  io.out(JSON.stringify({ harnesses: results }, null, 2) + '\n');
  // Exit 0 even when a harness is missing: the probe REPORTS state, it does not gate on it.
  return 0;
}

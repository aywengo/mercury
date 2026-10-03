/**
 * The opt-in Laya sidecar installer step (#831, Laya design §5.3).
 *
 * Never a default: the wizard asks and only an explicit yes runs this. The pieces that must
 * be test-pinned are pure functions here — interpreter detection, the venv/plan layout, the
 * user-scoped service unit text (launchd/systemd) and the credential step — so the wizard
 * only sequences them. The actual `venv`/`pip` execution goes through an injectable runner
 * (tests script it; the real one is bounded like every installer command).
 *
 * Rules this file exists to enforce:
 *
 * 1. **Opt-in, default no.** Opt-out writes NOTHING: no env keys, no venv, no unit, no
 *    credentials entry (the acceptance criterion).
 * 2. **A re-run preserves an existing key.** The `laya` entry in bot-credentials.json is
 *    only generated when absent — rotating a sidecar key on a re-run would break the bots
 *    already configured against it.
 * 3. **Python ≥ 3.10, uv preferred.** The macOS system Python (3.9.6) is refused with the
 *    reason, never silently used.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The upstream laya[serve] version the client contract was verified against (#825). */
export const LAYA_SERVE_PIN = '0.3.25';

/** The default loopback port the sidecar unit binds. */
export const LAYA_DEFAULT_PORT = 8302;

export interface PythonCandidate {
  /** argv for the interpreter ask, e.g. ['python3', '-V'] or ['uv', 'python', 'find', '3.10']. */
  argv: string[];
  /** How the plan should refer to this interpreter in the unit's ProgramArguments. */
  bin: string;
}

/** uv first (design: "uv-managed interpreter preferred"), then the plain python3s. */
export const DEFAULT_PYTHON_CANDIDATES: PythonCandidate[] = [
  { argv: ['uv', 'python', 'find', '3.10'], bin: 'uv run --python 3.10 python3' },
  { argv: ['python3', '-V'], bin: 'python3' },
];

export type RunFn = (argv: string[], timeoutMs: number) => { ok: boolean; stdout: string; stderr: string };

export interface PythonDetection {
  ok: boolean;
  /** The interpreter the plan will use (candidate.bin). */
  bin?: string;
  version?: string;
  /** When not ok: the named reason (acceptance: "system 3.9.6 on macOS is refused with the reason"). */
  reason?: string;
}

/** Minimal "3.10" / "3.9.6" parser → comparable number (minor*10+patch: 3.9.6 → 96,
 *  3.10.0 → 100, 3.12.4 → 124; a bare "3.10" → 100). */
export function parsePythonVersion(out: string): number | null {
  const m = out.match(/3\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return Number(m[1]) * 10 + Number(m[2] ?? 0);
}

export function detectPython(
  run: RunFn,
  candidates: PythonCandidate[] = DEFAULT_PYTHON_CANDIDATES,
  platform: NodeJS.Platform = process.platform,
): PythonDetection {
  const failures: string[] = [];
  for (const cand of candidates) {
    const r = run(cand.argv, 10_000);
    if (!r.ok) {
      failures.push(`${cand.argv[0]}: not usable`);
      continue;
    }
    const v = parsePythonVersion(`${r.stdout}\n${r.stderr}`);
    if (v === null) {
      failures.push(`${cand.argv[0]}: no parsable version`);
      continue;
    }
    if (v < 100) {
      // The acceptance wording: the macOS SYSTEM python is the 3.9 case. Name the platform
      // and the found version; do not silently fall through to a worse interpreter.
      failures.push(
        platform === 'darwin'
          ? `the system Python on macOS is too old (${r.stdout.trim() || r.stderr.trim()}); need >= 3.10 (uv preferred)`
          : `python too old (${r.stdout.trim() || r.stderr.trim()}); need >= 3.10`,
      );
      continue;
    }
    return { ok: true, bin: cand.bin, version: `3.${Math.floor(v / 10)}.${v % 10}` };
  }
  return { ok: false, reason: failures.join('; ') };
}

export interface LayaPlan {
  venvDir: string;
  serveCmd: string;
  port: number;
  envUrl: string;
  /** Unit text destination per platform; the text itself is renderLayaLaunchd/SystemdUnit. */
  unitPath: string;
  unitLabel: string;
}

/** The sidecar layout: user-scoped venv under the Mercury data dir, user-scoped unit next to
 *  Mercury's (design §5.3). Deterministic: same inputs → same plan. */
export function planLayaSidecar(opts: { dataDir: string; pythonBin: string; port?: number; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): LayaPlan {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const port = opts.port ?? LAYA_DEFAULT_PORT;
  const venvDir = join(opts.dataDir, 'laya-venv');
  const serveCmd = `${join(venvDir, 'bin', 'laya-serve')}`;
  const unitLabel = 'com.mercury.laya';
  const unitPath = platform === 'darwin'
    ? join(env.HOME?.trim() || homedir(), 'Library', 'LaunchAgents', `${unitLabel}.plist`)
    : join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'systemd', 'user', `${unitLabel}.service`);
  return { venvDir, serveCmd, port, envUrl: `http://127.0.0.1:${port}`, unitPath, unitLabel };
}

/** launchd plist (macOS), deterministic: same plan → same bytes (test-pinned). */
export function renderLayaLaunchdPlist(plan: LayaPlan, apiKey: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${plan.unitLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${plan.serveCmd}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LAYA_HOST</key><string>127.0.0.1</string>
    <key>LAYA_PORT</key><string>${plan.port}</string>
    <key>LAYA_API_KEY</key><string>${apiKey}</string>
    <key>LAYA_PRELOAD</key><string>1</string>
    <key>LAYA_MODELS</key><string>english</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

/** systemd user unit (Linux), deterministic: same plan → same bytes (test-pinned). */
export function renderLayaSystemdUnit(plan: LayaPlan, apiKey: string): string {
  return `[Unit]
Description=Mercury Laya sidecar (laya-serve ${LAYA_SERVE_PIN}, loopback only)
After=network.target

[Service]
ExecStart=${plan.serveCmd}
Environment=LAYA_HOST=127.0.0.1
Environment=LAYA_PORT=${plan.port}
Environment=LAYA_API_KEY=${apiKey}
Environment=LAYA_PRELOAD=1
Environment=LAYA_MODELS=english
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

/** The steps the wizard sequences, in order, for --dry-run and the real run. */
export function layaStepActions(plan: LayaPlan): string[] {
  return [
    `create venv: uv venv ${plan.venvDir} (python >= 3.10)`,
    `install pinned sidecar: pip install 'laya[serve]==${LAYA_SERVE_PIN}'`,
    `write unit: ${plan.unitPath} (bind 127.0.0.1, LAYA_PRELOAD=1, LAYA_MODELS=english)`,
    `write env: MERCURY_LAYA_URL=${plan.envUrl} (+ the LAYA_API_KEY in bot-credentials.json, key 'laya')`,
    `verify with: mercury host doctor (the laya: line, #830)`,
  ];
}

/** The `laya` credential entry in bot-credentials.json (#831): PRESERVE an existing key on a
 *  re-run (acceptance), generate one (32 hex) when absent. Returns {key, generated}. */
export function ensureLayaCredentials(env: NodeJS.ProcessEnv = process.env, gen: () => string = () => randomBytes(32).toString('hex')): { key: string; generated: boolean } {
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== '' ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  const path = join(xdg, 'mercury', 'bot-credentials.json');
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  }
  const entry = raw.laya;
  if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).api === 'string' && ((entry as Record<string, unknown>).api as string).trim() !== '') {
    return { key: (entry as Record<string, unknown>).api as string, generated: false };
  }
  const key = gen();
  raw.laya = { api: key };
  mkdirSync(join(xdg, 'mercury'), { recursive: true });
  const mode = existsSync(path) ? undefined : 0o600;
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n', mode !== undefined ? { mode } : undefined);
  return { key, generated: true };
}

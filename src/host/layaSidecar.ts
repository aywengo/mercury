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
 * 2. **A re-run preserves an existing key.** laya-credentials.json (layaCredentials.ts) is
 *    only generated when absent — rotating a sidecar key on a re-run would break the bots
 *    already configured against it.
 * 3. **Python ≥ 3.10, uv preferred.** The macOS system Python (3.9.6) is refused with the
 *    reason, never silently used.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

/** uv first (design: "uv-managed interpreter preferred"), then Homebrew's versioned
 *  interpreters (the plain `python3` shim on macOS stays the old system one while
 *  `python3.12`/`python3.11` are on PATH after `brew install python@3.12` — Copilot #840 r6),
 *  then the plain python3s. */
export const DEFAULT_PYTHON_CANDIDATES: PythonCandidate[] = [
  // `uv python find '>=3.10'` resolves ANY installed interpreter at or above the gate (r8) —
  // pinning the 3.10 series rejected hosts whose only uv-managed Python is newer.
  { argv: ['uv', 'python', 'find', '>=3.10'], bin: 'uv run --python >=3.10 python3' },
  { argv: ['python3.15', '-V'], bin: 'python3.15' },
  { argv: ['python3.14', '-V'], bin: 'python3.14' },
  { argv: ['python3.13', '-V'], bin: 'python3.13' },
  { argv: ['python3.12', '-V'], bin: 'python3.12' },
  { argv: ['python3.11', '-V'], bin: 'python3.11' },
  { argv: ['python3.10', '-V'], bin: 'python3.10' },
  { argv: ['python3', '-V'], bin: 'python3' },
];

export type RunFn = (argv: string[], timeoutMs: number) => { ok: boolean; stdout: string; stderr: string };

export interface PythonDetection {
  ok: boolean;
  /** The interpreter the plan will use (candidate.bin). */
  bin?: string;
  /** The winning candidate's detection argv — the venv step replays THIS tool (uv vs python3). */
  argv?: string[];
  version?: string;
  /** When not ok: the named reason (acceptance: "system 3.9.6 on macOS is refused with the reason"). */
  reason?: string;
}

/** Minimal "3.10" / "3.9.6" parser → [minor, patch] or null. A TUPLE, not a packed number:
 *  minor*10+patch breaks at 3.9.10 (= 100, indistinguishable from 3.10.0) and would accept an
 *  unsupported 3.9 interpreter. */
export function parsePythonVersion(out: string): [number, number] | null {
  const m = out.match(/3\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0)];
}

/** 3.minor.patch >= 3.10 in tuple order. */
function atLeast310(v: [number, number]): boolean {
  return v[0] > 10 || (v[0] === 10 && v[1] >= 0);
}

export function detectPython(
  run: RunFn,
  candidates: PythonCandidate[] = DEFAULT_PYTHON_CANDIDATES,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): PythonDetection {
  const failures: string[] = [];
  for (const cand of candidates) {
    const r = run(cand.argv, 10_000);
    if (!r.ok) {
      failures.push(`${cand.argv[0]}: not usable`);
      continue;
    }
    // `uv python find 3.10` prints an interpreter PATH, not "Python X.Y" (Copilot #840 r5):
    // parsing that path as a version would reject a valid uv-only install. Verify by asking
    // the located interpreter directly; on failure treat the candidate as unusable.
    let versionOut = `${r.stdout}\n${r.stderr}`;
    if (cand.argv[0] === 'uv') {
      const located = r.stdout.trim().split('\n')[0] ?? '';
      const verify = run([located, '-V'], 10_000);
      if (!verify.ok) {
        failures.push('uv: the located interpreter could not be run');
        continue;
      }
      versionOut = `${verify.stdout}\n${verify.stderr}`;
    }
    const v = parsePythonVersion(versionOut);
    if (v === null) {
      failures.push(`${cand.argv[0]}: no parsable version`);
      continue;
    }
    if (!atLeast310(v)) {
      // The acceptance wording: the macOS SYSTEM python is the 3.9 case. Name the platform
      // and the verified version (NOT the raw candidate output — for uv that is a PATH, and
      // quoting it would read like a version), never the key material. Do not silently fall
      // through to a worse interpreter.
      const shown = versionOut.trim().split('\n')[0] ?? '';
      failures.push(
        platform === 'darwin'
          ? `the system Python on macOS is too old (${shown}); need >= 3.10 (uv preferred)`
          : `python too old (${shown}); need >= 3.10`,
      );
      continue;
    }
    return { ok: true, bin: cand.bin, argv: cand.argv, version: `3.${v[0]}.${v[1]}` };
  }
  return { ok: false, reason: failures.join('; ') };
}

export interface LayaPlan {
  venvDir: string;
  /** Hugging Face cache root inside the Mercury data dir (design §5.3: weights cached there) —
   *  the unit pins HF_HOME so the ~843 MB checkpoint never lands in the user's global cache. */
  hfHome: string;
  /** launchd stdout/stderr capture (systemd captures to the journal by default). */
  logPath: string;
  serveCmd: string;
  port: number;
  envUrl: string;
  /** Unit text destination per platform; the text itself is renderLayaLaunchd/SystemdUnit. */
  unitPath: string;
  unitLabel: string;
}

/** The sidecar layout: user-scoped venv under the Mercury data dir, user-scoped unit next to
 *  Mercury's (design §5.3). Deterministic: same inputs → same plan. */
export function planLayaSidecar(opts: { dataDir: string; pythonBin: string; venvDir?: string; port?: number; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): LayaPlan {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const port = opts.port ?? LAYA_DEFAULT_PORT;
  // #845: the venv path is the caller's choice — setup builds into a versioned directory
  // (`laya-venv-<pin>-<ts>-<rand>`); the deterministic default stays the #840 layout for
  // doctor/plan consumers.
  const venvDir = opts.venvDir ?? join(opts.dataDir, 'laya-venv');
  const hfHome = join(opts.dataDir, 'laya-hf');
  // Preload failures (a failed checkpoint download) print to stdout/stderr — capture them like
  // the host LaunchAgent does (src/host/service.ts) or the error is lost (r20).
  const logPath = join(opts.dataDir, 'laya-sidecar.log');
  const serveCmd = `${join(venvDir, 'bin', 'laya-serve')}`;
  const unitLabel = 'com.mercury.laya';
  const unitPath = platform === 'darwin'
    ? join(env.HOME?.trim() || homedir(), 'Library', 'LaunchAgents', `${unitLabel}.plist`)
    : join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'systemd', 'user', `${unitLabel}.service`);
  return { venvDir, hfHome, logPath, serveCmd, port, envUrl: `http://127.0.0.1:${port}`, unitPath, unitLabel };
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
    <key>HF_HOME</key><string>${plan.hfHome}</string>
  </dict>
  <key>StandardOutPath</key><string>${plan.logPath}</string>
  <key>StandardErrorPath</key><string>${plan.logPath}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
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
Environment=HF_HOME=${plan.hfHome}
Restart=on-failure
# Same backoff as the host and bot units: a preload/startup failure must not loop tightly.
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;
}

/** The steps the wizard sequences, in EXECUTION order, for --dry-run and the real run.
 *  venvTool mirrors the real step: uv when the detector picked uv (with --seed), else
 *  `python3 -m venv` (Copilot #840 r2). 'both' is the non-executing dry-run form: it names
 *  BOTH possible venv branches (which one runs depends on the interpreter detection, which
 *  must not exec during --dry-run) and the credential step explicitly (Copilot #840 r5). */
export function layaStepActions(plan: LayaPlan, venvTool: 'uv' | 'python3' | 'both' = 'uv'): string[] {
  const venvLine = venvTool === 'uv'
    ? `create venv: uv venv ${plan.venvDir} --seed (python >= 3.10)`
    : venvTool === 'python3'
      ? `create venv: python3 -m venv ${plan.venvDir} (python >= 3.10)`
      : `create venv: uv venv ${plan.venvDir} --seed (when uv is present) OR python3 -m venv ${plan.venvDir} (fallback)`;
  const credsLine = venvTool === 'both'
    ? `write credentials: generate/keep LAYA_API_KEY in laya-credentials.json (0600)`
    : `write credentials: generate/keep LAYA_API_KEY in laya-credentials.json (0600)`;
  const loadLines = process.platform === 'darwin'
    ? [
        // Same choreography the real run performs (r10-r12): bootout the loaded job, bootstrap
        // the new plist, then the doctor-probe readiness window.
        `load agent: launchctl print/bootout gui/$UID/${plan.unitLabel} if loaded, then launchctl bootstrap gui/$UID ${plan.unitPath}`,
        `wait for readiness: probe the doctor's laya line (first start downloads the ~843 MB checkpoint)`,
      ]
    : [
        `load agent: systemctl --user daemon-reload && systemctl --user enable ${plan.unitLabel}`,
        `start/restart: systemctl --user restart ${plan.unitLabel} (exactly one startup, fresh or re-run)`,
        `wait for readiness: probe the doctor's laya line (first start downloads the ~843 MB checkpoint)`,
      ];
  return [
    `write env: MERCURY_LAYA_URL=${plan.envUrl} (mercury.env; the LAYA_API_KEY goes to laya-credentials.json)`,
    venvLine,
    `install pinned sidecar: pip install 'laya[serve]==${LAYA_SERVE_PIN}' into ${plan.venvDir}`,
    credsLine,
    `write unit: ${plan.unitPath} (bind 127.0.0.1, LAYA_PRELOAD=1, LAYA_MODELS=english, HF_HOME=${plan.hfHome})`,
    ...loadLines,
    `verify with: mercury host doctor (the laya: line, #830)`,
  ];
}

/** The sidecar key lives in its own file (layaCredentials.ts, #840 r62). Re-exported so the
 *  installer's pieces stay importable from one place. */
export { ensureLayaCredentials } from './layaCredentials.ts';

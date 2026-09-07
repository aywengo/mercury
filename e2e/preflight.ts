/**
 * Preflight checks for the local E2E gate. See docs/local-e2e-design.md section 8.1.
 *
 * Every failure here is meant to be short and actionable, and to leave nothing behind: these run
 * before any container exists.
 */

import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(E2E_DIR);
export const COMPOSE_FILE = join(E2E_DIR, 'compose.yml');

/** Ceilings from the design. These are safety limits, not expected durations. */
export const LIMITS = {
  runtimeProbeMs: 30_000,
  requestMs: 5_000,
  startupMs: 60_000,
  teardownMs: 30_000,
  diagnosticsMs: 20_000,
} as const;

/** The Node floor from package.json engines, parsed once. */
const FLOOR = [22, 18, 0];

export class PreflightError extends Error {}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new PreflightError(`${cmd} is not available: ${(err as Error).message}`));
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new PreflightError(`${cmd} ${args.join(' ')} did not finish in ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { out += d; });
    child.stderr.on('data', (d: string) => { out += d; });
    // A missing binary surfaces here rather than as a non-zero exit. Without this the promise
    // would settle only via the timer and report a misleading timeout.
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(new PreflightError(`${cmd} is not available: ${err.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.trim() });
    });
  });
}

/** Fail fast, with the reason a developer can act on, before Docker is touched. */
export async function preflight(): Promise<{ node: string; docker: string; compose: string }> {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const older = major < FLOOR[0]
    || (major === FLOOR[0] && minor < FLOOR[1])
    || (major === FLOOR[0] && minor === FLOOR[1] && patch < FLOOR[2]);
  if (older) {
    throw new PreflightError(
      `Node ${process.versions.node} is older than the supported floor ${FLOOR.join('.')}. `
      + 'Mercury runs TypeScript directly, which the floor release enables.',
    );
  }

  try {
    await access(COMPOSE_FILE);
  } catch {
    throw new PreflightError(`compose model not found at ${COMPOSE_FILE}`);
  }

  const docker = await run('docker', ['info', '--format', '{{.ServerVersion}}'], LIMITS.runtimeProbeMs);
  if (docker.code !== 0) {
    throw new PreflightError(
      'no usable container runtime. `docker info` failed:\n' + docker.out.slice(0, 400)
      + '\n\nThe E2E gate needs a running Docker (or Podman) daemon. `npm test` does not, so use that '
      + 'when the daemon is unavailable.',
    );
  }

  const compose = await run('docker', ['compose', 'version'], LIMITS.runtimeProbeMs);
  if (compose.code !== 0) {
    throw new PreflightError(
      'Docker Compose v2 is not available to the docker CLI. Docker Desktop ships it; the legacy '
      + '`docker-compose` binary is not used here.\n' + compose.out.slice(0, 300),
    );
  }

  return { node: process.versions.node, docker: docker.out, compose: compose.out };
}

/** True when the caller asked to keep the stack after a failure for inspection. */
export function keepOnFail(): boolean {
  return process.env.MERCURY_E2E_KEEP_ON_FAIL === '1';
}

export function verbose(): boolean {
  return process.env.MERCURY_E2E_VERBOSE === '1';
}

/** Read the compose model as text, for the assertions that check the model rather than a running stack. */
export async function composeText(): Promise<string> {
  return readFile(COMPOSE_FILE, 'utf8');
}

/** The subset of the resolved Compose model the isolation assertions need. */
export interface ComposeMount {
  type: string;
  source?: string;
  target?: string;
}

export interface ComposePort {
  host_ip?: string;
  published?: string | number;
  target?: number;
}

export interface ComposeService {
  volumes?: ComposeMount[];
  ports?: ComposePort[] | null;
  user?: string | null;
  /** Compose normalises `restart: "no"` here; a one-shot must never restart. */
  restart?: string | null;
  /** The resolved command. Compose keeps a list as a list and folds a string into one. */
  command?: string[] | string | null;
  healthcheck?: { test?: string[] | string | null } | null;
}

export interface ComposeModel {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

/**
 * The RESOLVED Compose model, not the file text.
 *
 * Asserting on the file means writing regexes over YAML, and YAML has too many ways to spell the
 * same mount for that to be safe: `- ./src:/app`, `- type: bind` with the source on its own line,
 * `- ${HOME}/x:/y` and `- /Users/me/repo:/app` are four different shapes that all mean "the
 * container can reach host files". Compose normalises every one of them to `{type: "bind",
 * source: ...}`, so checking the resolved model catches all of them and a future syntax cannot
 * slip past. It also resolves the port to a concrete `host_ip`, which the file leaves implicit.
 */
export async function composeModel(): Promise<ComposeModel> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', 'compose.yml', 'config', '--format', 'json'],
      { cwd: E2E_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new PreflightError('`docker compose config` did not finish in ' + LIMITS.runtimeProbeMs + 'ms'));
    }, LIMITS.runtimeProbeMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.stderr.on('data', (chunk: string) => { err += chunk; });
    child.once('error', (e) => { clearTimeout(timer); reject(new PreflightError(`docker compose config unavailable: ${e.message}`)); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new PreflightError(`compose model is invalid: ${err.slice(0, 500)}`));
      else resolve(JSON.parse(out) as ComposeModel);
    });
  });
}

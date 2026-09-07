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

/**
 * Hard ceiling on any single diagnostics file.
 *
 * A chatty service can emit far more than a developer can read, and the point of writing logs to
 * disk is to read them AFTER a failure -- so an uncapped dump trades a fast failure for a directory
 * the next run has to clean up. One source, so the collector and the guard on it cannot disagree.
 */
export const DIAGNOSTIC_CAP_BYTES = 1_000_000;

/** Cap a buffer without copying it when it is already small enough. */
export function capBuffer(buf: Buffer, maxBytes: number = DIAGNOSTIC_CAP_BYTES): Buffer {
  return buf.byteLength <= maxBytes ? buf : buf.subarray(0, maxBytes);
}

/**
 * The state Docker reports for every container of a project, as `name -> "running" | ...`.
 *
 * Uses the CLI rather than the Testcontainers handle because the case that matters is a container
 * that has already exited: `getContainer()` hands back a handle regardless of whether the process
 * behind it is alive, so a handle is not evidence of life.
 */
export async function containerStates(project: string): Promise<Record<string, string>> {
  const { code, out } = await run('docker', ['ps', '-a',
    '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}\t{{.State}}'],
    LIMITS.runtimeProbeMs);
  if (code !== 0) throw new PreflightError(`docker ps failed for project ${project}: ${out}`);
  const states: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const [name, state] = line.split('\t');
    if (name && state) states[name] = state;
  }
  return states;
}

/**
 * Tail a service's logs through the compose CLI.
 *
 * `container.logs()` needs a container Testcontainers tracked as started, and it is the wrong tool
 * for a process that died during or just after startup -- the exact case this exists for. The compose
 * CLI reads the container's log file and works whether the process is alive, dead, or one-shot.
 */
export async function serviceLogs(project: string, service: string, tail = 60): Promise<string> {
  const { out } = await run('docker', ['compose', '-p', project, 'logs', '--no-color',
    '--tail', String(tail), service], LIMITS.diagnosticsMs);
  return out;
}

/**
 * Which of a project's expected services are not running, derived from a container-state map.
 *
 * Pure, so the naming rule it encodes is testable without a Docker daemon.
 *
 * The rule is deliberately NOT "<service>-1". Compose names containers `<project>-<service>-<index>`,
 * and a guard that hardcodes index 1 reports "all fine" when `api-1` is up and `api-2` died -- a
 * silent weakening that only shows up once something is scaled, which is exactly when it matters.
 * Matching any index also survives a naming change instead of reporting a container that "does not
 * exist" while the real one dies unreported.
 */
export function deadServices(states: Record<string, string>, project: string, services: string[]): string[] {
  const esc = project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const problems: string[] = [];
  for (const service of services) {
    const pattern = new RegExp(`^${esc}-${service}-\\d+$`);
    const mine = Object.entries(states).filter(([name]) => pattern.test(name));
    if (mine.length === 0) {
      problems.push(`${service}: no container matching ${service}-<n> exists in project ${project}`);
      continue;
    }
    for (const [name, state] of mine.filter(([, st]) => st !== 'running')) problems.push(`${name}: state=${state}`);
  }
  return problems;
}

/**
 * Name every service of a project that is not running, with the log tail that says why.
 *
 * A compose healthcheck can report `healthy` and the process can die immediately afterwards: the API
 * binds its port, answers the probe, then fails while opening the database. Testcontainers' health
 * wait strategy returns the moment it sees `healthy`, so `up()` resolves over a dead service and
 * every later test then fails with `Cannot get container "api-1" as it is not running` -- repeated
 * once per test, none of them containing the reason. This is the re-check that closes that window.
 *
 * Resolves to '' when everything is up, so a caller can use it as a guard without a second query.
 */
export async function deadServiceReport(project: string, services: string[]): Promise<string> {
  const states = await containerStates(project);
  const detailed: string[] = [];
  for (const problem of deadServices(states, project, services)) {
    // Only a located container has logs to fetch; "no container exists" does not.
    const named = /^([a-z0-9_-]+): state=/.exec(problem);
    if (!named) { detailed.push(problem); continue; }
    const service = named[1].replace(new RegExp(`^${project}-`), '').replace(/-\d+$/, '');
    const logs = capBuffer(Buffer.from(await serviceLogs(project, service))).toString('utf8');
    detailed.push(`${problem}\n${logs}`);
  }
  return detailed.join('\n\n');
}

/**
 * Throw with the reason if any expected service is not running.
 *
 * This is what the startup path calls, so a test of the guard exercises the same function the gate
 * relies on rather than a helper that merely resembles it.
 */
export async function assertServicesAlive(project: string, services: string[]): Promise<void> {
  const report = await deadServiceReport(project, services);
  if (report !== '') throw new Error(`service(s) not running in project ${project}:\n${report}`);
}

/**
 * The exact commands to inspect and remove a retained project.
 *
 * Printed only when the gate deliberately leaves containers running, and printed verbatim-runnable:
 * a developer staring at a failed run should paste, not reconstruct. Kept as a pure function so a
 * test can hold the format -- a silently wrong project name here means `down -v` deletes nothing, or
 * the wrong thing.
 */
export function inspectionCommands(project: string, composeFile: string = COMPOSE_FILE): string[] {
  return [
    `docker compose -p ${project} -f ${composeFile} ps`,
    `docker compose -p ${project} -f ${composeFile} logs --no-color`,
    `docker compose -p ${project} -f ${composeFile} down -v --remove-orphans`,
  ];
}

/**
 * Compose project names this repository's E2E files generate.
 *
 * Used by the stale-project sweep so it can recognise its own leftovers without matching unrelated
 * containers a developer may be running on purpose.
 */
export const PROJECT_PREFIX = 'mercury-e2e';

/**
 * What to do when teardown fails, given whether a scenario already failed.
 *
 * The rule: a teardown problem must never replace the scenario failure that caused it. A developer
 * debugging a broken journey who is shown "volume is busy" instead of "the run never left QUEUED" is
 * sent to the wrong file. But with no scenario failure, teardown IS the only failure, so it has to
 * propagate or the gate would report green over a leaked stack.
 *
 * It takes the scenario *error*, not a boolean, for two reasons. A boolean lets the log point at a
 * failure it cannot name -- "that is the failure to read" while never saying what it is -- and it lets
 * a caller hand in a flag while holding the real error somewhere else, which is how the two get out of
 * sync. Requiring the error makes that impossible and makes the message useful.
 *
 * It does not surface the scenario error itself: the test runner reports that, because `guarded()`
 * rethrows. This decides only whether teardown ADDS a second failure on top.
 *
 * Extracted because that asymmetry is exactly the kind of thing an inline `if` loses on a later
 * edit, and it is invisible until someone is misled by it.
 */
export function teardownOutcome(scenarioError: unknown, teardownError: Error): { propagate: boolean; log: string } {
  const failed = scenarioError !== undefined && scenarioError !== null;
  const names = failed ? `: ${scenarioError instanceof Error ? scenarioError.message : String(scenarioError)}` : '';
  return {
    propagate: !failed,
    log: `e2e: teardown reported a problem: ${teardownError.message}`
      + (failed
        ? ` (not raised: a scenario already failed and that is the failure to read${names})`
        : ''),
  };
}

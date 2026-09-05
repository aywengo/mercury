// Shared live-server harness for the client contract suites.
//
// Lives in one file on purpose. Two suites each starting their own copy of "spawn a Mercury server,
// wait for readiness, make a Run" is how one of them ends up waiting on a fixed sleep while the other
// polls, and then one of them is flaky for a reason the other does not share.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export const REPO = join(import.meta.dirname, '..', '..', '..');
export const BIN = join(import.meta.dirname, '..', '..', 'bin.ts');
export const TOKEN = 'tok-contract-alice';

export interface LiveServer {
  url: string;
  dir: string;
  proc: ChildProcess;
  /** Server log, capped. Included in failure messages so a crash is diagnosable from the report. */
  log: () => string;
  stop: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') { probe.close(); reject(new Error('no port')); return; }
      const port = addr.port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start a real `node src/cli.ts server` on a free port.
 *
 * Spawned rather than imported because client/ may not import src/ (§15.4), and a subprocess is not an
 * import. Readiness is polled on a real endpoint: a fixed sleep is either flaky or slow, and it proves
 * nothing about whether the server can answer.
 */
export async function startMercuryServer(prefix = 'mercuryctl-live-'): Promise<LiveServer> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const proc = spawn(process.execPath, ['--no-warnings', join(REPO, 'src', 'cli.ts'), 'server'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MERCURY_DB: join(dir, 'contract.db'),
      MERCURY_PORT: String(port),
      MERCURY_BIND_HOST: '127.0.0.1',
      MERCURY_API_TOKENS: `${TOKEN}:alice`,
      MERCURY_EMBEDDED_WORKER: 'false',
    },
  });
  const url = `http://127.0.0.1:${port}`;

  // DRAIN THE PIPES. A piped stdout that nobody reads fills at 64KB, after which the server blocks in
  // write() and stops answering requests -- which surfaces as a later, unrelated test failing with
  // "fetch failed" and no explanation. This harness ran fine until one suite held the server open for
  // ~90s of slow tests, at which point everything after that point died. Ignoring the streams would
  // also work but throws away the only evidence available when the server crashes early, so they are
  // consumed into a capped buffer instead.
  const tail: string[] = [];
  let tailBytes = 0;
  const TAIL_LIMIT = 64 * 1024;
  const drain = (stream: NodeJS.ReadableStream | null, label: string): void => {
    stream?.on('data', (chunk: Buffer) => {
      if (tailBytes < TAIL_LIMIT) tail.push(`[${label}] ${chunk.toString()}`);
      tailBytes += chunk.length;
    });
  };
  drain(proc.stdout, 'stdout');
  drain(proc.stderr, 'stderr');
  const log = (): string => tail.join('');

  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (proc.exitCode !== null) throw new Error(`server exited early with code ${proc.exitCode}:\n${log()}`);
    try {
      const res = await fetch(`${url}/api/agents`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (res.ok) {
        return {
          url,
          dir,
          proc,
          log,
          stop: async () => {
            proc.kill('SIGTERM');
            await delay(200);
            if (proc.exitCode === null) proc.kill('SIGKILL');
            rmSync(dir, { recursive: true, force: true });
          },
        };
      }
    } catch {
      /* not listening yet */
    }
    await delay(250);
  }
  proc.kill('SIGKILL');
  throw new Error(`server did not become ready:\n${log()}`);
}

/** Run the real CLI as a subprocess. Returns exit code and both streams. */
export function runCli(
  server: { url: string; dir: string },
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {},
) {
  const r = spawnSyncCli(args, {
    MERCURY_CLIENT_URL: server.url,
    MERCURY_CLIENT_TOKEN: TOKEN,
    // XDG_CONFIG_HOME is the real override for the config/credential directory (client/credentials.ts
    // configDir). Pointing it at a directory that does not exist means a developer's own
    // ~/.config/mercury cannot make a test pass or fail for unrelated reasons.
    XDG_CONFIG_HOME: join(server.dir, 'no-such-config'),
    ...options.env,
  }, options.input);
  return r;
}

function spawnSyncCli(args: string[], env: Record<string, string>, input?: string) {
  const r = spawnSync(process.execPath, ['--no-warnings', BIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    input,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Direct API call, used to set up state the CLI cannot produce yet. */
export async function apiCall(
  server: { url: string },
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${server.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

export async function createRunViaApi(server: { url: string }, task: string): Promise<string> {
  const res = await apiCall(server, '/api/runs', {
    method: 'POST',
    body: JSON.stringify({ task, repository: { url: 'https://example.invalid/r.git' } }),
  });
  if (res.status !== 201) throw new Error(`create failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.runId as string;
}

/**
 * Put a Run into NEEDS_INPUT directly in the database.
 *
 * Needed because no adapter except the real PrimeAgent one ever produces that status, and driving a
 * live agent from a client test would make the client suite depend on an LLM. The state is real, not
 * simulated: the server reads status from this same row, so the code under test cannot tell the
 * difference. Setting it by hand is honest as long as it is labelled -- what it does NOT prove is that
 * the worker ever reaches this status, and no client test should be read as claiming that.
 */
export function forceNeedsInput(server: LiveServer, runId: string): void {
  const db = join(server.dir, 'contract.db');
  const r = spawnSync(
    'sqlite3',
    [db, `UPDATE runs SET status = 'NEEDS_INPUT' WHERE id = '${runId}';`],
    { encoding: 'utf8', timeout: 15_000 },
  );
  if (r.status !== 0) throw new Error(`could not set NEEDS_INPUT: ${r.stderr}`);
}

/**
 * Async variant of runCli. REQUIRED whenever the test also hosts a server in-process.
 *
 * spawnSync blocks the test process's event loop for the whole run. Anything that needs that loop --
 * an in-process stub answering the CLI, or the drain that keeps the real server's stdout pipe from
 * filling -- simply stops making progress. The symptoms were misleading: stub-backed tests timed out at
 * 30s as though the client were broken, and a later, unrelated test died with "fetch failed" because the
 * blocked drain let the server's pipe fill and wedge the server. Both were this.
 *
 * The synchronous variant stays for tests that only talk to the separate server process, where nothing
 * in this process needs to run concurrently.
 */
export async function runCliAsync(
  server: { url: string; dir: string },
  args: string[],
  options: { env?: Record<string, string>; input?: string; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--no-warnings', BIN, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MERCURY_CLIENT_URL: server.url,
      MERCURY_CLIENT_TOKEN: TOKEN,
      XDG_CONFIG_HOME: join(server.dir, 'no-such-config'),
      ...options.env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();

  const timeoutMs = options.timeoutMs ?? 20_000;
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
  const [code] = (await once(child, 'exit')) as [number | null];
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/**
 * Insert persisted events directly, with sequential sequences.
 *
 * The worker is what normally appends events, and running it would make the client suite depend on an
 * agent backend. Writing rows directly produces the same persisted state the endpoints read. What this
 * does NOT prove is that the worker emits the right events in the right order -- that is the worker's
 * own test surface.
 */
export function seedEvents(
  server: LiveServer,
  runId: string,
  events: Array<{ type: string; payload?: unknown }>,
): void {
  const db = join(server.dir, 'contract.db');
  const now = new Date().toISOString();
  // Continue from the Run's existing maximum rather than starting at 1. Creating a Run already writes
  // run.created and run.queued, so seeding from 1 collides with the (run_id, sequence) unique index --
  // and a helper that only works on a Run with no events would be useless for testing paging.
  const maxOut = spawnSync('sqlite3', [db, `SELECT COALESCE(MAX(sequence), 0) FROM events WHERE run_id = '${runId}';`],
    { encoding: 'utf8', timeout: 15_000 });
  if (maxOut.status !== 0) throw new Error(`could not read max sequence: ${maxOut.stderr}`);
  const startSequence = Number(maxOut.stdout.trim()) + 1;
  const statements = events.map((event, index) => {
    const payload = JSON.stringify(event.payload ?? { note: `event ${index + 1}` });
    const escaped = payload.replace(/'/g, "''");
    const seq = startSequence + index;
    return `INSERT INTO events (id, run_id, type, sequence, timestamp, payload_json) VALUES ` +
      `('evt_seed_${runId}_${seq}', '${runId}', '${event.type}', ${seq}, '${now}', '${escaped}');`;
  });
  const r = spawnSync('sqlite3', [db, statements.join(' ')], { encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) throw new Error(`could not seed events: ${r.stderr}`);
}

/** Set a Run's status directly, for terminal-state tests that no CLI command can reach on its own. */
export function forceStatus(server: LiveServer, runId: string, status: string): void {
  const db = join(server.dir, 'contract.db');
  const r = spawnSync(
    'sqlite3',
    [db, `UPDATE runs SET status = '${status}', completed_at = '${new Date().toISOString()}' WHERE id = '${runId}';`],
    { encoding: 'utf8', timeout: 15_000 },
  );
  if (r.status !== 0) throw new Error(`could not set status: ${r.stderr}`);
}

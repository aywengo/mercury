// Shared test environment: temp dir, in-memory DB, stores, worker, fake agent.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db/database.ts';
import { createRedactor } from '../src/domain/redact.ts';
import { createLogger, nullLogger } from '../src/logger.ts';
import { EventStore } from '../src/events/eventStore.ts';
import { RunQueue } from '../src/queue/runQueue.ts';
import { RunStore } from '../src/runs/runStore.ts';
import { RunService } from '../src/runs/runService.ts';
import { SkillRegistry } from '../src/skills/skillRegistry.ts';
import { createSkillSelector } from '../src/skills/skillSelector.ts';
import { WorkspaceManager } from '../src/workspace/workspaceManager.ts';
import { FakeAgentAdapter, type FakeAgentConfig } from '../src/adapters/fakeAgentAdapter.ts';
import { PrimeAgentAdapter } from '../src/adapters/primeAgentAdapter.ts';
import { Worker } from '../src/worker/worker.ts';
import type { AgentAdapter } from '../src/adapters/agentAdapter.ts';
import type { DatabaseSync } from 'node:sqlite';

export const SKILLS_DIR = join(import.meta.dirname, '..', '.agents', 'skills');

export interface TestEnv {
  dir: string;
  db: DatabaseSync;
  runs: RunStore;
  events: EventStore;
  queue: RunQueue;
  skills: SkillRegistry;
  workspace: WorkspaceManager;
  runService: RunService;
  worker: Worker;
  adapters: Record<string, AgentAdapter>;
  close(): void;
}

export function makeEnv(opts: {
  fakeScript?: FakeAgentConfig['script'];
  /** Redactor for the EventStore (production wiring passes one; tests default to none). */
  redactor?: import('../src/domain/redact.ts').Redactor;
  workspaceMode?: 'git-worktree' | 'copy';
  repoDir?: string;
  workerEnabled?: boolean;
  maxRetries?: number;
  retryBackoffMs?: number;
  leaseMs?: number;
  pollMs?: number;
  inputTimeoutMs?: number;
  stuckRunThresholdMs?: number;
  stuckCheckIntervalMs?: number;
  logger?: boolean;
  /** Capture worker log lines instead of discarding them (issue #73 L2 backlog timing test). */
  logCapture?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown>) => void;
  backlogAlertThreshold?: number;
  backlogCheckIntervalMs?: number;
  sandbox?: import('../src/sandbox/sandboxManager.ts').SandboxManager;
  primeagent?: { cmd: string; args?: string[] };
  /** Extra adapters to register (merged over the built-in fake). */
  adapters?: Record<string, AgentAdapter>;
} = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  const runs = new RunStore(db);
  const events = new EventStore(db, opts.redactor);
  const queue = new RunQueue(db, runs);
  const skills = new SkillRegistry(SKILLS_DIR);
  const workspace = new WorkspaceManager({
    baseDir: join(dir, 'workspaces'),
    mode: opts.workspaceMode ?? 'copy',
  });
  const fake = new FakeAgentAdapter({ script: opts.fakeScript ?? [] });
  const adapters: Record<string, AgentAdapter> = { fake, ...(opts.adapters ?? {}) };
  if (opts.primeagent) {
    adapters.primeagent = new PrimeAgentAdapter(opts.primeagent.cmd, { args: opts.primeagent.args, sandbox: opts.sandbox });
  }
  const runService = new RunService({
    db,
    runs,
    events,
    skills,
    selector: createSkillSelector(),
    knownAgents: Object.keys(adapters),
    defaultMaxDurationMs: 60_000,
    defaultMaxRetries: opts.maxRetries ?? 2,
    redactor: opts.redactor,
  });
  const logger = opts.logger ? createLogger(createRedactor([]), 'debug') : nullLogger;
  // A capturing Logger must forward child() or the worker's per-run logger drops the capture.
  const captureLogger: typeof logger | null = opts.logCapture
    ? {
        debug: (f, m) => opts.logCapture!('debug', m, f),
        info: (f, m) => opts.logCapture!('info', m, f),
        warn: (f, m) => opts.logCapture!('warn', m, f),
        error: (f, m) => opts.logCapture!('error', m, f),
        child: () => captureLogger!,
      }
    : null;
  const worker = new Worker({
    db,
    runs,
    events,
    queue,
    skills,
    workspace,
    adapters,
    runService,
    logger: captureLogger ?? logger,
    backlogAlertThreshold: opts.backlogAlertThreshold,
    backlogCheckIntervalMs: opts.backlogCheckIntervalMs,
    workerId: 'test-worker',
    leaseMs: opts.leaseMs ?? 60_000,
    leaseHeartbeatMs: 5_000,
    pollMs: opts.pollMs ?? 20,
    inputPollMs: 10,
    inputTimeoutMs: opts.inputTimeoutMs ?? 30 * 60 * 1000,
    stuckRunThresholdMs: opts.stuckRunThresholdMs ?? 0,
    stuckCheckIntervalMs: opts.stuckCheckIntervalMs ?? 60_000,
    retryBackoffMs: opts.retryBackoffMs ?? 50,
    sandbox: opts.sandbox,
    redactor: opts.redactor,
  });
  if (opts.workerEnabled !== false) worker.start();

  return {
    dir,
    db,
    runs,
    events,
    queue,
    skills,
    workspace,
    runService,
    worker,
    adapters,
    close: () => {
      worker.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function makeGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'initial']);
  return dir;
}

export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A temp dir that is removed when the whole test file finishes.
 *
 * Fixture repos were created with bare `mkdtempSync` and never removed (issue #73 L8): every run
 * of the suite left ~40 git repos plus their worktrees behind in the system temp dir. `makeEnv`
 * already cleaned its own directory in `close()`, so this covers the remaining direct callers.
 *
 * Registered against the test runner's file-level `after()` rather than threaded through each test
 * as `t.after(...)`. That would have been the more precise scope, but it needs a `t` parameter
 * added to ~40 test callbacks across 11 files for no behavioural gain -- these are read-only
 * fixture repos, so holding them until the file ends is equivalent in practice and keeps the diff
 * to the call sites that actually allocate.
 *
 * The teardown also runs for a file that aborts partway, which per-test cleanup inside a `finally`
 * would not guarantee.
 */
const leakedDirs = new Set<string>();

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  leakedDirs.add(dir);
  return dir;
}

/**
 * A path for a single loose temp FILE (argv dumps, RPC logs, env captures), removed with the
 * same file-level teardown as tempDir(). Several adapter tests wrote these straight into the
 * system temp dir with a Date.now() suffix, so each run left another dozen files behind.
 */
export function tempFile(prefix: string, ext = ''): string {
  // Normalise the dot. Callers pass 'json' as well as '.json', and concatenating bare gave names
  // like "hermes-argvjson". The tests read the file back by the returned path so nothing failed,
  // which is exactly why the helper has to be right rather than the call sites lucky.
  const suffix = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
  const file = join(mkdtempSync(join(tmpdir(), `${prefix}-`)), `${prefix}${suffix}`);
  leakedDirs.add(dirname(file));
  return file;
}

after(() => {
  for (const dir of leakedDirs) {
    // force: true -- git marks objects and worktree metadata read-only, so a plain recursive
    // remove fails on them on some platforms.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A cleanup failure must not fail a test that passed; the dir is in the temp dir anyway.
    }
  }
  leakedDirs.clear();
});

/**
 * Assert an HTTP status and, on mismatch, report WHO ANSWERED -- not just the number.
 *
 * Issue #185: a `test:core` run reported `actual: 403, expected: 401`, and nothing in `src/` can
 * return 403. The failing test name scrolled past and no response body was captured, so the run
 * could not be attributed to the application or to something else on the port. Every such report is
 * unactionable, and an unactionable flake is eventually re-run into silence.
 *
 * The discriminator is `x-powered-by`. Express marks EVERY response it produces with
 * `x-powered-by: Express` (verified against a live app, including 401s), so:
 *   - 403 WITH that header  -> Mercury produced it. A real auth bug. Go find it in src/.
 *   - 403 WITHOUT it        -> some other process answered. The app is not implicated.
 * That turns "the suite produced a status it cannot produce" into a fact either way.
 *
 * The body is read ONLY on the failure path. Reading it eagerly would drain a body that later
 * assertions still expect untouched -- the same trap recorded in auth.test.ts (issue #73 L5), where
 * an `assert.equal` message interpolated `await r.clone().text()` and drained it on every PASS.
 */
export async function expectStatus(res: Response, want: number, label: string): Promise<void> {
  if (res.status === want) return;
  const body = (await res.text().catch(() => '<unreadable>')).slice(0, 300);
  const powered = res.headers.get('x-powered-by');
  const server = res.headers.get('server');
  const verdict = powered === 'Express'
    ? 'FROM THE APP: Express marked this response, so the status came from Mercury\'s own code.'
    : powered || server
      ? `UNMARKED BY EXPRESS (x-powered-by=${powered ?? 'none'}, server=${server ?? 'none'}): ` +
        'not a Mercury response. Another process answered on this port.'
      : 'NO FRAMEWORK MARKER at all: not a Mercury response. Another process answered on this port.';
  assert.fail(`${label}: expected ${want}, got ${res.status}. url=${res.url}. ${verdict}. body=${body}`);
}

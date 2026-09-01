// Shared test environment: temp dir, in-memory DB, stores, worker, fake agent.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

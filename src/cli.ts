// Mercury CLI: dev (API + embedded worker), server (API only), worker, migrate, redact-events.
// The web server does NOT execute agent processes unless MERCURY_EMBEDDED_WORKER=true
// (dev mode) — production runs `mercury server` and `mercury worker` separately.

function envInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/database.ts';
import { createRedactor } from './domain/redact.ts';
import { createLogger } from './logger.ts';
import { EventStore } from './events/eventStore.ts';
import { EventStream } from './events/eventStream.ts';
import { RunQueue } from './queue/runQueue.ts';
import { RunStore } from './runs/runStore.ts';
import { RunService } from './runs/runService.ts';
import { SkillRegistry } from './skills/skillRegistry.ts';
import { createSkillSelector } from './skills/skillSelector.ts';
import { WorkspaceManager } from './workspace/workspaceManager.ts';
import { WorkspaceGC } from './workspace/workspaceGC.ts';
import { FakeAgentAdapter } from './adapters/fakeAgentAdapter.ts';
import { PrimeAgentAdapter } from './adapters/primeAgentAdapter.ts';
import { LocalAgentRegistry } from './adapters/localAgentRegistry.ts';
import { RemoteAgentRegistry } from './adapters/remoteAgentRegistry.ts';
import { RpcAgentRegistry } from './adapters/rpcAgentRegistry.ts';
import { HermesAgentAdapter } from './adapters/hermesAgentAdapter.ts';
import { DaemonAgentAdapter } from './adapters/daemonAgentAdapter.ts';
import { SandboxManager } from './sandbox/sandboxManager.ts';
import { Worker } from './worker/worker.ts';
import { startServer } from './api/server.ts';

const SKILLS_DIR = resolve(import.meta.dirname, '..', '.agents', 'skills');

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const config = loadConfig();
  const redactor = createRedactor(config.secrets);
  const logger = createLogger(redactor, config.logLevel);

  if (cmd === 'migrate') {
    const db = openDatabase(config.dbPath);
    logger.info({ db: config.dbPath }, 'migrations applied');
    db.close();
    return;
  }

  if (cmd === 'redact-events') {
    const db = openDatabase(config.dbPath);
    const events = new EventStore(db, redactor);
    const changed = events.backfillRedact();
    logger.info({ db: config.dbPath, changed }, 'retroactive redaction complete');
    db.close();
    return;
  }

  mkdirSync(resolve(config.workspaceBase), { recursive: true });

  const db = openDatabase(config.dbPath);
  const runs = new RunStore(db);
  const events = new EventStore(db, redactor);
  const queue = new RunQueue(db, runs);
  const skills = new SkillRegistry(SKILLS_DIR);
  const selector = createSkillSelector();
  const workspace = new WorkspaceManager({ baseDir: config.workspaceBase, mode: config.workspaceMode });
  const gc = new WorkspaceGC(runs, workspace, {
    retentionMs: config.workspaceRetentionMs,
    quotaBytes: config.workspaceQuotaBytes,
    orphanGraceMs: 60 * 60 * 1000,
  });

  const workerId = `worker-${process.pid}`;
  const sandbox = new SandboxManager({ runtime: process.env.MERCURY_SANDBOX_RUNTIME });
  const adapters: Record<string, import('./adapters/agentAdapter.ts').AgentAdapter> = {
    primeagent: config.agentMode === 'daemon'
      ? new DaemonAgentAdapter(config.primeAgentCmd, { args: config.primeAgentArgs, sandbox, workerId })
      : new PrimeAgentAdapter(config.primeAgentCmd, { args: config.primeAgentArgs, sandbox, workerId }),
    fake: new FakeAgentAdapter({ script: [] }),
    hermes: new HermesAgentAdapter({
      cmd: process.env.MERCURY_HERMES_CMD ?? 'hermes',
      args: (process.env.MERCURY_HERMES_ARGS ?? '').split(/\s+/).filter(Boolean),
      sandbox,
      workerId,
      maxTurns: envInt(process.env.MERCURY_HERMES_MAX_TURNS),
      runBudgetSeconds: envInt(process.env.MERCURY_HERMES_RUN_BUDGET_SECONDS),
      yolo: process.env.MERCURY_HERMES_YOLO === 'true',
      acceptHooks: process.env.MERCURY_HERMES_ACCEPT_HOOKS === 'true',
    }),
    // declarative local CLI agents (docs/agent-adapters.md section 4):
    // JSON configs in MERCURY_LOCAL_AGENTS_DIR (default ./local-agents)
    ...new LocalAgentRegistry(
      process.env.MERCURY_LOCAL_AGENTS_DIR ?? resolve(import.meta.dirname, '..', 'local-agents'),
      { sandbox, workerId },
    ).load(),
    // declarative remote API agents (docs/agent-adapters.md section 5):
    // JSON configs in MERCURY_REMOTE_AGENTS_DIR (default ./remote-agents)
    ...new RemoteAgentRegistry(
      process.env.MERCURY_REMOTE_AGENTS_DIR ?? resolve(import.meta.dirname, '..', 'remote-agents'),
    ).load(),
    // declarative RPC agents (docs/agent-adapters.md section 6):
    // JSON configs in MERCURY_RPC_AGENTS_DIR (default ./rpc-agents)
    ...new RpcAgentRegistry(
      process.env.MERCURY_RPC_AGENTS_DIR ?? resolve(import.meta.dirname, '..', 'rpc-agents'),
      { sandbox, workerId },
    ).load(),
  };

  const runService = new RunService({
    db,
    runs,
    events,
    skills,
    selector,
    knownAgents: Object.keys(adapters),
    defaultMaxDurationMs: 60 * 60 * 1000,
    defaultMaxRetries: config.maxRetries,
    redactor,
  });

  const stream = new EventStream(db, events, config.pollMs);

  if (cmd === 'gc') {
    const report = await gc.run();
    logger.info({ ...report }, 'workspace gc pass complete');
    console.log(JSON.stringify(report, null, 2));
    db.close();
    return;
  }

  if (cmd === 'worker' || (cmd === 'dev' && config.embeddedWorker)) {
    const worker = new Worker({
      db,
      runs,
      events,
      queue,
      skills,
      workspace,
      adapters,
      runService,
      logger,
      workerId,
      leaseMs: config.leaseMs,
      leaseHeartbeatMs: config.leaseHeartbeatMs,
      pollMs: config.pollMs,
      inputPollMs: config.inputPollMs,
      inputTimeoutMs: config.inputTimeoutMs,
      stuckRunThresholdMs: config.stuckRunThresholdMs,
      redactor,
      stuckCheckIntervalMs: config.stuckCheckIntervalMs,
      retryBackoffMs: config.retryBackoffMs,
      backlogAlertThreshold: config.backlogAlertThreshold,
      alertWebhookUrl: config.alertWebhookUrl,
      sandbox,
    });
    worker.start();
    logger.info({}, 'worker started');

    // periodic workspace GC (retention + quota)
    const gcRun = async (): Promise<void> => {
      try {
        const report = await gc.run();
        if (report.removed.length > 0 || report.overQuota) {
          logger.info({ removed: report.removed.length, freedBytes: report.freedBytes, totalBytes: report.totalBytes }, 'workspace gc pass');
        }
      } catch (err) {
        logger.error({ err }, 'workspace gc pass failed');
      }
    };
    void gcRun();
    const gcTimer = setInterval(() => void gcRun(), config.gcIntervalMs);
    gcTimer.unref();
  }

  if (cmd === 'server' || cmd === 'dev') {
    stream.start();
    const server = await startServer(
      { runService, events, stream, queue, apiTokens: config.apiTokens, adminToken: config.adminToken },
      config.port,
      { host: config.bindHost, tls: config.tls ?? undefined },
    );
    logger.info({ port: config.port, host: config.bindHost, tls: config.tls !== null, db: config.dbPath }, 'mercury api listening');
    const shutdown = (): void => {
      server.close().then(() => {
        db.close();
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (cmd === 'worker') {
    const shutdown = (): void => {
      db.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  console.error('usage: mercury <dev|server|worker|gc|migrate|redact-events>');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

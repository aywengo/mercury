#!/usr/bin/env node
// Mercury CLI: dev (API + embedded worker), server (API only), worker, migrate, redact-events
// (retroactive secret redaction: events.payload_json, run_inputs.input_json, runs.error,
// runs.task, runs.repository_json, runs.repositories_json).
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
import { WakeupListener, WakeupWriter } from './events/wakeup.ts';
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
import { ClaudeCodeAdapter } from './adapters/claudeCodeAdapter.ts';
import {
  forwardedCredentialValues,
  MIN_CREDENTIAL_LEN,
  subThresholdForwardedCredentials,
} from './sandbox/sandboxManager.ts';
import { selectPrimeAgentAdapter } from './adapters/selectAgentAdapter.ts';
import { SandboxManager } from './sandbox/sandboxManager.ts';
import { Worker } from './worker/worker.ts';
import { startServer } from './api/server.ts';
import { HOST_VERSION } from './version.ts';

const SKILLS_DIR = resolve(import.meta.dirname, '..', '.agents', 'skills');

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === '--version' || cmd === '-V') {
    process.stdout.write(`mercury-host ${HOST_VERSION}\n`);
    return;
  }
  const config = loadConfig();
  // Two layers (issue #214): the operator's declared MERCURY_SECRETS, plus the exact VALUES of
  // the provider credentials this process may hand to a Run. The second layer is what makes
  // redaction track forwarding instead of guessing at key shapes -- if the sandbox can pass a key
  // to an agent, that key cannot come back out through an event.
  const redactor = createRedactor([
    ...config.secrets,
    ...forwardedCredentialValues(process.env, config.sandboxEnv),
  ]);
  const logger = createLogger(redactor, config.logLevel);

  // A forwarded credential below the length floor is handed to an untrusted agent and NOT scrubbed.
  // Say so at startup: a silent gap here looks exactly like a working redactor. Names only -- a
  // warning about a secret must not leak the secret into its own log line.
  const tooShort = subThresholdForwardedCredentials(process.env, config.sandboxEnv);
  if (tooShort.length > 0) {
    logger.warn(
      { vars: tooShort, minLength: MIN_CREDENTIAL_LEN },
      'forwarded credentials too short to redact; their values may appear in events and logs',
    );
  }
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
  const sandbox = new SandboxManager({
    runtime: process.env.MERCURY_SANDBOX_RUNTIME,
    image: config.sandboxImage ?? undefined,
    envAllowlist: config.sandboxEnv ?? undefined,
    diskLimitsSupported: config.sandboxDiskLimits,
  });
  const adapters: Record<string, import('./adapters/agentAdapter.ts').AgentAdapter> = {
    primeagent: selectPrimeAgentAdapter(config.agentMode, config.primeAgentCmd,
      { args: config.primeAgentArgs, sandbox, workerId }),
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
    claude: new ClaudeCodeAdapter({
      cmd: process.env.MERCURY_CLAUDE_CMD ?? 'claude',
      args: (process.env.MERCURY_CLAUDE_ARGS ?? '').split(/\s+/).filter(Boolean),
      sandbox,
      workerId,
      model: process.env.MERCURY_CLAUDE_MODEL || undefined,
      allowedTools: process.env.MERCURY_CLAUDE_ALLOWED_TOOLS || undefined,
      disallowedTools: process.env.MERCURY_CLAUDE_DISALLOWED_TOOLS || undefined,
      mcpConfig: process.env.MERCURY_CLAUDE_MCP_CONFIG || undefined,
      skipPermissions: process.env.MERCURY_CLAUDE_SKIP_PERMISSIONS === 'true',
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
    defaultAgent: config.defaultAgent,
    defaultMaxDurationMs: 60 * 60 * 1000,
    defaultMaxRetries: config.maxRetries,
    redactor,
  });

  // The logger matters here: EventStream.poll() logs the two failures it can observe -- a failed
  // event read and a subscriber whose delivery throws -- rather than swallowing them (issue #139).
  // subscribe() reads too, but it rethrows to its caller and src/api/routes.ts handles that (issue
  // #143), so poll() is the only path that would otherwise stay silent. Without a logger here the
  // default nullLogger would keep exactly the silence this removes.
  const stream = new EventStream(db, events, config.pollMs, undefined, logger.child({ c: 'events' }));

  // Stage 1 same-host wake-up channel (issue #202, design section 8.2). MERCURY_EVENT_WAKEUP_SOCKET is
  // unset by default and unset means none of this exists: no socket, no listener, no writer, and
  // delivery is byte-identical to polling. The channel is advisory -- it only says "look now" -- so the
  // poller keeps running unconditionally and a missing socket cannot lose an event.
  let wakeupListener: WakeupListener | null = null;
  let wakeupWriter: WakeupWriter | null = null;
  if (config.eventWakeupSocket && (cmd === 'server' || cmd === 'dev')) {
    wakeupListener = new WakeupListener(config.eventWakeupSocket, (runId) => stream.wakeRun(runId));
    try {
      await wakeupListener.listen();
      logger.info({ path: config.eventWakeupSocket }, 'event wake-up listener started');
    } catch (err) {
      // Failing to bind the hint channel must not stop the API: polling still delivers everything.
      logger.error({ err, path: config.eventWakeupSocket },
        'event wake-up listener failed to start; continuing on polling alone');
      wakeupListener = null;
    }
  }

  if (cmd === 'gc') {
    const report = await gc.run();
    logger.info({ ...report }, 'workspace gc pass complete');
    console.log(JSON.stringify(report, null, 2));
    db.close();
    return;
  }

  // Hoisted so the SIGTERM/SIGINT handler below can reach it. The handler previously could
  // not -- `worker` was scoped to the block that built it -- which is precisely why it did
  // nothing but close the database (issue #51).
  let workerRef: Worker | null = null;

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
      backlogCheckIntervalMs: config.backlogCheckIntervalMs,
      alertWebhookUrl: config.alertWebhookUrl,
      sandbox,
    });
    if (config.eventWakeupSocket) {
      // Registered on the existing append hook rather than at the ~20 append call sites: one seam, and
      // the writer is contractually unable to throw, so an append can never fail because a hint failed.
      wakeupWriter = new WakeupWriter(config.eventWakeupSocket, (total) => {
        // The worker has no metrics endpoint, so this log line IS the drops signal (§12). Throttled by
        // the writer to the first drop and then every 1000, so a slow leak still surfaces.
        logger.warn({ drops: total, path: config.eventWakeupSocket },
          'event wake-up notifications dropped; polling still delivers every event');
      });
      events.onAppend((runId, event) => wakeupWriter!.notify(runId, event.sequence));
      logger.info({ path: config.eventWakeupSocket }, 'event wake-up writer enabled for this worker');
    }
    workerRef = worker;
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
      {
        runService,
        events,
        stream,
        queue,
        apiTokens: config.apiTokens,
        adminToken: config.adminToken,
        // Issue #64: the session cookie used to omit `Secure` unconditionally, so a TLS
        // deployment still sent the session id in cleartext over plain http. Encryption is
        // detected per request; this only forces it for proxies that do not forward the proto.
        cookieSecure: config.cookieSecure,
        // Issue #65: the rate limiter keys on req.ip. Behind a proxy that is the proxy's own
        // address unless we say how many hops to trust, so all clients share one bucket.
        trustProxy: config.trustProxy,
        // Records the real cause of a 500, which is deliberately not sent to the client.
        logger,
        // Aggregate queries for /metrics (issue #131).
        db,
        // Stage 1 wake-up counter (issue #204). Only present when the socket is configured, so the
        // series stays absent -- rather than reading zero -- in the default deployment.
        wakeupStats: wakeupListener ? () => wakeupListener!.wakeupsReceived : undefined,
      },
      config.port,
      { host: config.bindHost, tls: config.tls ?? undefined },
    );
    logger.info({ port: config.port, host: config.bindHost, tls: config.tls !== null, db: config.dbPath }, 'mercury api listening');
    const shutdown = (): void => {
      // Remove our socket file on the way out; a stale path makes the next start unlink and rebind,
      // but leaving it behind is the kind of debris that turns a restart into a confusing failure.
      wakeupListener?.close();
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
    // Graceful shutdown (issue #51). The old handler was `db.close(); process.exit(0)`: it
    // never stopped the worker, never terminated the agent, and never handed the run back.
    // In-flight runs therefore stayed RUNNING until the lease expired (~60s), were reaped as
    // FAILED(infrastructure), and were auto-retried -- every deploy converted running work
    // into spurious infrastructure failures and duplicate agent spend.
    //
    // Order matters:
    //   1. stop() -- stop claiming, and signal any run in flight to hand itself back.
    //   2. wait (bounded) for that run to terminate its agent and requeue itself. Its own
    //      finally does the terminate, so waiting here is what makes the agent stop before
    //      the process does (issue #46).
    //   3. only then close the database.
    // Bounded, because a wedged agent must not turn a deploy into a hang; systemd escalates
    // to SIGKILL at TimeoutStopSec and the lease/reaper path is the backstop.
    const shutdown = async (): Promise<void> => {
      const graceMs = config.shutdownGraceMs;
      logger.info({ graceMs }, 'worker shutting down');
      workerRef?.stop();
      const deadline = Date.now() + graceMs;
      while (workerRef && workerRef.activeCount() > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      if (workerRef && workerRef.activeCount() > 0) {
        logger.warn({ active: workerRef.activeCount() }, 'shutdown grace expired with runs still active; leaving them to the reaper');
      }
      wakeupWriter?.close();
      wakeupListener?.close();
      db.close();
      process.exit(0);
    };
    // Idempotent, with escalation. Both SIGINT and SIGTERM are registered and either can
    // arrive twice -- an operator pressing Ctrl-C again, or `systemctl restart` while a
    // shutdown is already draining. Two concurrent shutdown() calls would race two
    // db.close() calls and two process.exit() calls, and whichever finished last would win the
    // exit code arbitrarily.
    //
    // A repeat signal exits immediately instead of waiting out the grace period. That is what
    // the operator is asking for, and it is safe: the run stays RUNNING, the lease expires,
    // and the reaper/retry path is the documented backstop -- the same outcome a grace-period
    // expiry already produces.
    let shutdownStarted = false;
    const onSignal = (signal: string): void => {
      if (shutdownStarted) {
        logger.warn({ signal }, 'shutdown already in progress; exiting immediately (in-flight runs go to the reaper)');
        process.exit(1);
      }
      shutdownStarted = true;
      void shutdown().catch((err) => {
        logger.error({ error: String(err) }, 'shutdown failed');
        process.exit(1);
      });
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    return;
  }

  console.error('usage: mercury [--version|-V] | <dev|server|worker|gc|migrate|redact-events>');
console.error('redact-events: retroactive secret redaction of events.payload_json, run_inputs.input_json, runs.error, runs.task, runs.repository_json, runs.repositories_json');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

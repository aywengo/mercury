// Multi-worker deployment (roadmap item 5): queue backlog alerting, worker
// health endpoint, and lease-loss recovery (Mercury.md sections 16, 17, 25).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { Express } from 'express';
import { createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { Worker } from '../src/worker/worker.ts';
import { nullLogger, type Logger, type LogFields } from '../src/logger.ts';
import { makeEnv, makeGitRepo, sleep, tempDir, waitFor } from './helpers.ts';
import { canTransition, shutdownRequeueSources } from '../src/domain/stateMachine.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

// --- helpers ---------------------------------------------------------------

function envDir(): string {
  // system temp dir (not the repo) so tests never litter the checkout. tempDir() registers the
  // path for removal when this file finishes (issue #73 L8).
  return tempDir('mercury-mw-');
}

function makeSpyLogger(): { root: Logger; warns: { fields: Record<string, unknown>; msg: string }[]; errors: { fields: Record<string, unknown>; msg: string }[] } {
  const warns: { fields: Record<string, unknown>; msg: string }[] = [];
  const errors: { fields: Record<string, unknown>; msg: string }[] = [];
  const mk = (prefix: Record<string, unknown>): Logger => ({
    debug: () => {},
    info: () => {},
    warn: (fields: LogFields, msg: string) => warns.push({ fields: { ...prefix, ...fields }, msg }),
    error: (fields: LogFields, msg: string) => errors.push({ fields: { ...prefix, ...fields }, msg }),
    child: (fields: LogFields) => mk({ ...prefix, ...fields }),
  });
  return { root: mk({}), warns, errors };
}

interface WebhookHit { path: string; body: Record<string, unknown> }

function startWebhookServer(): Promise<{ url: string; hits: WebhookHit[]; close: () => Promise<void> }> {
  const hits: WebhookHit[] = [];
  const server: HttpServer = createServer((req, res) => {
    let data = '';
    req.on('data', (c: string) => { data += c; });
    req.on('end', () => {
      hits.push({ path: req.url ?? '', body: JSON.parse(data) as Record<string, unknown> });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        hits,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function makeWorker(
  env: ReturnType<typeof makeEnv>,
  opts: {
    workerId?: string;
    pollMs?: number;
    leaseHeartbeatMs?: number;
    backlogAlertThreshold?: number;
    alertWebhookUrl?: string | null;
    inputTimeoutMs?: number;
    stuckRunThresholdMs?: number;
    stuckCheckIntervalMs?: number;
    logger?: Logger;
  } = {},
): Worker {
  return new Worker({
    db: env.db,
    runs: env.runs,
    events: env.events,
    queue: env.queue,
    skills: env.skills,
    workspace: env.workspace,
    adapters: env.adapters,
    runService: env.runService,
    logger: opts.logger ?? nullLogger,
    workerId: opts.workerId ?? 'mw-worker',
    leaseMs: 60_000,
    leaseHeartbeatMs: opts.leaseHeartbeatMs ?? 5_000,
    pollMs: opts.pollMs ?? 20,
    inputPollMs: 10,
    inputTimeoutMs: opts.inputTimeoutMs ?? 30 * 60 * 1000,
    stuckRunThresholdMs: opts.stuckRunThresholdMs ?? 0,
    stuckCheckIntervalMs: opts.stuckCheckIntervalMs ?? 60_000,
    retryBackoffMs: 50,
    backlogAlertThreshold: opts.backlogAlertThreshold,
    alertWebhookUrl: opts.alertWebhookUrl,
  });
}

function listen(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// --- tests ------------------------------------------------------------------

test('queuedCount reflects QUEUED runs', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    assert.equal(env.queue.queuedCount(), 0);
    const a = env.runService.create({ ownerId: 'alice', task: 'a', agent: 'fake' });
    env.runService.create({ ownerId: 'alice', task: 'b', agent: 'fake' });
    const c = env.runService.create({ ownerId: 'alice', task: 'c', agent: 'fake' });
    assert.equal(env.queue.queuedCount(), 3);
    env.runService.cancel(c.id, 'alice', false);
    assert.equal(env.queue.queuedCount(), 2);
    // claiming a run does not change its QUEUED status (lease only)
    const claimed = env.queue.claim('w1', 60_000);
    assert.equal(claimed?.id, a.id);
    assert.equal(env.queue.queuedCount(), 2);
  } finally {
    env.close();
  }
});

test('backlog alert: warn + webhook once per threshold crossing, resets below', async () => {
  const webhook = await startWebhookServer();
  const spy = makeSpyLogger();
  const repoDir = makeGitRepo(join(envDir(), 'repo-bk'));
  const env = makeEnv({
    workerEnabled: false,
    fakeScript: [{ event: { type: 'agent.message', payload: { text: 'fast' } } }],
  });
  const worker = makeWorker(env, { backlogAlertThreshold: 2, alertWebhookUrl: webhook.url, logger: spy.root });
  try {
    worker.start();
    const createRun = (task: string) => env.runService.create({ ownerId: 'alice', task, agent: 'fake', repository: { localPath: repoDir } });
    const a = createRun('a');
    const b = createRun('b');

    // 2 queued >= threshold 2 -> exactly one alert
    await waitFor(() => webhook.hits.length === 1, 10_000);
    await waitFor(() => spy.warns.some((w) => w.msg === 'queue backlog above threshold'), 1_000);
    await sleep(300);
    assert.equal(webhook.hits.length, 1);
    assert.equal(spy.warns.filter((w) => w.msg === 'queue backlog above threshold').length, 1);

    // drain: worker claims and completes a, then b
    await waitFor(() => [a, b].every((r) => env.runs.get(r.id)!.status === 'COMPLETED'), 10_000);
    // below threshold -> reset
    await waitFor(() => env.queue.queuedCount() === 0, 5_000);
    await sleep(300);
    assert.equal(webhook.hits.length, 1);

    // cross again -> second alert
    const c = createRun('c');
    const d = createRun('d');
    await waitFor(() => webhook.hits.length === 2, 10_000);
    assert.equal(spy.warns.filter((w) => w.msg === 'queue backlog above threshold').length, 2);

    // webhook payload shape
    for (const h of webhook.hits) {
      assert.equal(h.path, '/hook');
      assert.equal(h.body.threshold, 2);
      assert.equal(h.body.workerId, 'mw-worker');
      assert.ok((h.body.queueDepth as number) >= 2);
      assert.ok(!Number.isNaN(Date.parse(h.body.ts as string)));
    }

    // let everything settle so the env can close cleanly
    await waitFor(() => [a, b, c, d].every((r) => TERMINAL.has(env.runs.get(r.id)!.status)), 20_000);
  } finally {
    worker.stop();
    await webhook.close();
    env.close();
  }
});

test('stuck runs: RUNNING run with no event activity beyond threshold -> warn + webhook', async () => {
  const webhook = await startWebhookServer();
  const spy = makeSpyLogger();
  const repoDir = makeGitRepo(join(envDir(), 'repo-stuck'));
  const env = makeEnv({
    workerEnabled: false,
    // single event after start, then silent: no new events -> "stuck"
    fakeScript: [{ event: { type: 'agent.message', payload: { text: 'working' } }, delayMs: 5_000 }],
  });
  const worker = makeWorker(env, {
    pollMs: 10,
    stuckRunThresholdMs: 200,
    stuckCheckIntervalMs: 50,
    alertWebhookUrl: webhook.url,
    logger: spy.root,
  });
  let run: ReturnType<typeof env.runService.create>;
  try {
    worker.start();
    run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repoDir } });
    await waitFor(() => env.runs.get(run.id)!.status === 'RUNNING', 10_000);

    // while the worker is driving the run, the (independent) stuck check fires
    await waitFor(() => webhook.hits.some((h) => h.body.type === 'stuck_runs'), 10_000);
    const hit = webhook.hits.find((h) => h.body.type === 'stuck_runs')!;
    assert.equal(hit.body.workerId, 'mw-worker');
    const stuckRuns = hit.body.runs as { runId: string; status: string; idleMs: number }[];
    assert.ok(stuckRuns.some((r) => r.runId === run.id && r.status === 'RUNNING'));
    assert.ok(stuckRuns.every((r) => r.idleMs >= 200));
    assert.ok(spy.warns.some((w) => w.msg === 'runs stuck beyond inactivity threshold'));

    // a healthy (recent activity) run does not alert: create one that emits fast
    // while the first is still stuck; it may or may not appear in later hits,
    // so only assert the first hit's shape above.
  } finally {
    // let the run finish so the env can close cleanly
    await waitFor(() => TERMINAL.has(env.runs.get(run.id)!.status), 20_000);
    worker.stop();
    await webhook.close();
    env.close();
  }
});

test('GET /healthz/workers reports active workers and queue depth', async () => {
  const repoDir = makeGitRepo(join(envDir(), 'repo'));
  const env = makeEnv({
    // run stays RUNNING long enough to observe it via the endpoint
    fakeScript: [{ event: { type: 'agent.message', payload: { text: 'working' } }, delayMs: 2_500 }],
  });
  // helper to create runs with a repository so the worker can build a workspace
  const createRun = (task: string) => env.runService.create({ ownerId: 'alice', task, agent: 'fake', repository: { localPath: repoDir } });
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    queue: env.queue,
    apiTokens: new Map([['tok-alice', 'alice']]),
    adminToken: null,
  });
  const srv = await listen(app);
  try {
    const r1 = createRun('x');
    await waitFor(() => env.runs.get(r1.id)!.status === 'RUNNING', 10_000);
    const r2 = createRun('y'); // stays QUEUED

    // public endpoint (no auth), public like /healthz
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz/workers`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      workers: { workerId: string; activeRuns: number; oldestLeaseExpiresAt: string | null }[];
      queueDepth: number;
    };
    assert.equal(body.queueDepth, 1);
    assert.equal(body.workers.length, 1);
    assert.equal(body.workers[0].workerId, 'test-worker');
    assert.equal(body.workers[0].activeRuns, 1);
    assert.ok(body.workers[0].oldestLeaseExpiresAt);
    assert.ok(Date.parse(body.workers[0].oldestLeaseExpiresAt!) > Date.now());

    // after all runs finish: no active workers, empty queue
    await waitFor(() => [r1, r2].every((r) => env.runs.get(r.id)!.status === 'COMPLETED'), 20_000);
    const res2 = await fetch(`http://127.0.0.1:${srv.port}/healthz/workers`);
    assert.equal(res2.status, 200);
    const body2 = (await res2.json()) as typeof body;
    assert.deepEqual(body2.workers, []);
    assert.equal(body2.queueDepth, 0);
  } finally {
    await srv.close();
    stream.stop();
    env.close();
  }
});

// Shared by the lease-loss test and its positive control below, so the two cannot drift apart.
// If the window ever becomes too short for the delayed event to land, the control fails loudly
// instead of the absence assertion quietly becoming vacuous.
const ABORT_PROBE_DELAY_MS = 300;
const ABORT_PROBE_WINDOW_MS = 900;

test('lease loss: worker aborts and touches NOTHING, leaving the run to its new owner (issue #59)', async () => {
  const repoDir = makeGitRepo(join(envDir(), 'repo-lease-59'));
  const env = makeEnv({
    workerEnabled: false,
    fakeScript: [
      // 'first' lands immediately so there is something to compare against.
      // 'second' is delayed just long enough to still be pending when the lease is stolen
      // (~100ms heartbeat), but SHORT enough that it would definitely have arrived during the
      // observation window below if the agent were never aborted. An absence assertion is only
      // evidence when the thing absent had time to show up: the original 3_000ms delay against a
      // 400ms window passed even with the abort removed, i.e. it asserted nothing.
      { event: { type: 'agent.message', payload: { text: 'first' } } },
      { event: { type: 'agent.message', payload: { text: 'second' } }, delayMs: ABORT_PROBE_DELAY_MS },
    ],
  });
  const spy = makeSpyLogger();
  const worker = makeWorker(env, { workerId: 'lease-worker', leaseHeartbeatMs: 100, logger: spy.root });
  try {
    worker.start();
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repoDir } });
    await waitFor(() => env.runs.get(run.id)!.status === 'RUNNING', 10_000);

    // Simulate a takeover: 'other-worker' now holds the lease.
    env.db.prepare('UPDATE runs SET lease_owner = ? WHERE id = ?').run('other-worker', run.id);
    const leaseBefore = env.runs.get(run.id)!.leaseExpiresAt;

    // The worker notices on the next heartbeat and aborts.
    await waitFor(() => spy.warns.some((w) => w.msg === 'lease lost during execution'), 5_000);
    await waitFor(() => env.events.list(run.id).some((e) => e.type === 'lease.lost'), 5_000);

    // The contract that matters: we no longer own the run, so we must not change it.
    // Before issue #59 this asserted the opposite -- that the losing worker requeued the
    // run. That "rescue" is the bug: it cleared the LIVE owner's lease and reset an
    // actively-executing run to QUEUED, so a third worker could claim it while the second
    // was still running. Two agents, one workspace.
    const after = env.runs.get(run.id)!;
    assert.equal(after.status, 'RUNNING', 'a worker that lost its lease must not change run status');
    assert.equal(after.leaseOwner, 'other-worker', 'a worker that lost its lease must not clear the new owner');
    assert.equal(after.leaseExpiresAt, leaseBefore, 'a worker that lost its lease must not reset the lease expiry');
    assert.equal(env.events.list(run.id).filter((e) => e.type === 'run.started').length, 1,
      'the run must not be restarted by the worker that lost it');

    // It must also stop driving the agent: the scripted 'second' event (delayed 300ms) never
    // gets emitted. The window is 3x that delay, so a worker that failed to abort would emit it.
    await sleep(ABORT_PROBE_WINDOW_MS);
    const texts = env.events.list(run.id)
      .filter((e) => e.type === 'agent.message')
      .map((e) => (e.payload as { text?: string }).text);
    assert.ok(texts.includes('first'), 'the agent did emit before the abort');
    assert.ok(!texts.includes('second'), 'the agent must be aborted once the lease is lost');

    // Recovery still works, via the ONE sanctioned path: the lease expires, the reaper marks
    // it FAILED(infrastructure) per section 6, and retry-as-new-run takes over per section 21.
    env.db.prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), run.id);
    const { failed } = env.queue.reapExpiredLeases();
    assert.deepEqual(failed, [run.id], 'the reaper must still recover a run abandoned by its owner');
    assert.equal(env.runs.get(run.id)!.status, 'FAILED');
    assert.equal(env.runs.get(run.id)!.errorKind, 'infrastructure');
  } finally {
    worker.stop();
    env.close();
  }
});
test('CLI wiring: /healthz/workers returns 200 when started via cli.ts server (issue #4)', async () => {
  const { spawn } = await import('node:child_process');
  const dir = tempDir('mercury-cli-healthz-');
  const port = 3900 + Math.floor(Math.random() * 500);
  const env = {
    ...process.env,
    MERCURY_DB: join(dir, 'test.db'),
    MERCURY_WORKSPACE_BASE: join(dir, 'ws'),
    MERCURY_API_TOKENS: 'tok-alice:alice',
    MERCURY_PORT: String(port),
    MERCURY_BIND_HOST: '127.0.0.1',
  };
  const proc = spawn(process.execPath, ['src/cli.ts', 'server'], {
    cwd: join(import.meta.dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // wait for the server to come up
    let ok = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.status === 200) { ok = true; break; }
      } catch {
        await sleep(250);
      }
    }
    assert.ok(ok, 'server did not start');
    const res = await fetch(`http://127.0.0.1:${port}/healthz/workers`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { workers: unknown[]; queueDepth: number };
    assert.ok(Array.isArray(body.workers));
    assert.equal(typeof body.queueDepth, 'number');
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.once('exit', r));
  }
});
test('CLI wiring: redact-events backfills persisted secrets (issue #18)', async () => {
  const { spawn } = await import('node:child_process');
  const { openDatabase } = await import('../src/db/database.ts');
  const { EventStore } = await import('../src/events/eventStore.ts');
  const dir = tempDir('mercury-cli-redact-');
  const dbPath = join(dir, 'test.db');
  // seed a DB with a secret-bearing event (no redactor)
  const db = openDatabase(dbPath);
  const events = new EventStore(db);
  events.append('run-1', 'agent.message', { text: 'token=abc123def' });
  db.close();
  // run the CLI backfill
  const proc = spawn(process.execPath, ['src/cli.ts', 'redact-events'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, MERCURY_DB: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = await new Promise<string>((resolve, reject) => {
    let acc = '';
    proc.stdout.on('data', (d) => { acc += String(d); });
    proc.stderr.on('data', (d) => { acc += String(d); });
    proc.on('exit', (code) => (code === 0 ? resolve(acc) : reject(new Error(`exit ${code}: ${acc}`))));
  });
  assert.match(out, /retroactive redaction complete/);
  // verify the event is redacted
  const db2 = openDatabase(dbPath);
  const events2 = new EventStore(db2);
  const all = events2.list('run-1');
  const msg = all.find((e) => e.type === 'agent.message');
  assert.ok(msg, 'event present');
  assert.ok(!(msg.payload as { text: string }).text.includes('abc123def'), 'secret removed');
  db2.close();
});


test('CLI wiring: backlog alert webhook fires when configured via env (issue #5)', async () => {
  const { spawn } = await import('node:child_process');
  const webhook = await startWebhookServer();
  const dir = tempDir('mercury-cli-alert-');
  const port = 4400 + Math.floor(Math.random() * 500);
  const env = {
    ...process.env,
    MERCURY_DB: join(dir, 'test.db'),
    MERCURY_WORKSPACE_BASE: join(dir, 'ws'),
    MERCURY_API_TOKENS: 'tok-alice:alice',
    MERCURY_BACKLOG_ALERT_THRESHOLD: '1',
    MERCURY_ALERT_WEBHOOK_URL: webhook.url,
    MERCURY_POLL_MS: '50',
  };
  // enqueue runs BEFORE the worker starts (single-writer: avoid two SQLite
  // connections racing; the worker claims one run, leaving depth 1 >= threshold 1)
  const { openDatabase } = await import('../src/db/database.ts');
  const { RunStore } = await import('../src/runs/runStore.ts');
  const { RunService } = await import('../src/runs/runService.ts');
  const { SkillRegistry } = await import('../src/skills/skillRegistry.ts');
  const { createSkillSelector } = await import('../src/skills/skillSelector.ts');
  const { EventStore } = await import('../src/events/eventStore.ts');
  {
    const db = openDatabase(join(dir, 'test.db'));
    const runs = new RunStore(db);
    const events = new EventStore(db);
    const skills = new SkillRegistry(join(import.meta.dirname, '..', '.agents', 'skills'));
    const runService = new RunService({
      db, runs, events, skills,
      selector: createSkillSelector(),
      knownAgents: ['fake'],
      defaultMaxDurationMs: 60_000,
      defaultMaxRetries: 0,
    });
    runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    runService.create({ ownerId: 'alice', task: 'y', agent: 'fake' });
    db.close();
  }
  const proc = spawn(process.execPath, ['src/cli.ts', 'worker'], {
    cwd: join(import.meta.dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // the worker should claim one run and fire the backlog alert
    await waitFor(() => webhook.hits.length > 0, 10_000);
    const hit = webhook.hits[0];
    assert.equal(hit.path, '/hook');
    assert.equal(hit.body.type ?? hit.body.queueDepth !== undefined, true);
    assert.ok((hit.body as { queueDepth?: number }).queueDepth !== undefined);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.once('exit', r));
    await webhook.close();
  }
});

test('worker.stop() hands an in-flight run back to the queue instead of failing it (issue #51)', async () => {
  const repoDir = makeGitRepo(join(envDir(), 'repo-shutdown'));
  const env = makeEnv({
    workerEnabled: false,
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'first' } }, delayMs: 1_200 },
      { event: { type: 'agent.message', payload: { text: 'second' } } },
    ],
  });
  const a = makeWorker(env, { workerId: 'shutting-down' });
  const b = makeWorker(env, { workerId: 'successor' });
  try {
    a.start();
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repoDir } });
    await waitFor(() => env.runs.get(run.id)!.status === 'RUNNING', 10_000);

    // This is a deploy. Before the fix the process just exited here, the run stayed RUNNING
    // until the lease expired ~60s later, the reaper recorded FAILED(infrastructure), and the
    // run was auto-retried -- spurious failures plus duplicate agent spend on every restart.
    a.stop();

    await waitFor(() => env.runs.get(run.id)!.status === 'QUEUED', 10_000);
    assert.equal(env.runs.get(run.id)!.errorKind, null, 'a graceful handback must not record an infrastructure failure');
    const row = env.db.prepare('SELECT lease_owner, lease_expires_at FROM runs WHERE id = ?').get(run.id) as
      { lease_owner: string | null; lease_expires_at: string | null };
    assert.equal(row.lease_owner, null, 'the requeued run must not keep the departed worker as owner');
    assert.equal(row.lease_expires_at, null);

    // The point of requeueing: somebody else can pick it up immediately, not after a lease expiry.
    b.start();
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 15_000);
    assert.equal(env.runs.get(run.id)!.attempt, 1, 'a handback is not a retry');
  } finally {
    a.stop();
    b.stop();
    env.close();
  }
});

test('releaseLease does not strand a still-active run (issue #51)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.queue.claim('w1', 60_000);
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING');

    // Clearing the lease on an active run used to be possible and catastrophic: the reaper
    // only selects rows with lease_expires_at IS NOT NULL, so the run became invisible to it
    // forever while remaining unclaimable (status is not QUEUED).
    env.queue.releaseLease(run.id, 'w1');
    assert.equal(env.runs.get(run.id)!.leaseOwner, 'w1', 'releaseLease must be a no-op while the run is active');

    // The property that matters is RECOVERABILITY, not that nothing happened. Because the
    // lease is still live, the reaper can still see the run once it expires. Before the guard
    // this same call at +10min found nothing at all -- the run was invisible forever.
    const { failed, requeued } = env.queue.reapExpiredLeases(Date.now() + 10 * 60_000);
    assert.deepEqual(requeued, []);
    assert.deepEqual(failed, [run.id], 'the run must still be visible to the reaper, i.e. recoverable');
    assert.equal(env.runs.get(run.id)!.status, 'FAILED');
    assert.equal(env.runs.get(run.id)!.errorKind, 'infrastructure');

    // Once terminal, releasing still works -- that is the normal path from execute()'s finally.
    const other = env.runService.create({ ownerId: 'alice', task: 'z', agent: 'fake' });
    env.queue.claim('w1', 60_000);
    env.runs.transition(other.id, 'STARTING');
    env.runs.transition(other.id, 'RUNNING');
    env.runs.transition(other.id, 'COMPLETED');
    env.queue.releaseLease(other.id, 'w1');
    assert.equal(env.runs.get(other.id)!.leaseOwner, null, 'a terminal run must still have its lease released');
  } finally {
    env.close();
  }
});

test('requeueForShutdown only requeues runs this worker owns (issue #51)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const mine = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.queue.claim('w1', 60_000);
    env.runs.transition(mine.id, 'STARTING');
    env.runs.transition(mine.id, 'RUNNING');

    // A non-owner must not be able to hand somebody else's run back.
    assert.equal(env.queue.requeueForShutdown(mine.id, 'w2'), false, 'only the owner may requeue on shutdown');
    assert.equal(env.runs.get(mine.id)!.status, 'RUNNING');

    assert.equal(env.queue.requeueForShutdown(mine.id, 'w1'), true);
    assert.equal(env.runs.get(mine.id)!.status, 'QUEUED');
    // and a terminal run is left alone
    const done = env.runService.create({ ownerId: 'alice', task: 'y', agent: 'fake' });
    env.queue.claim('w1', 60_000);
    env.runs.transition(done.id, 'STARTING');
    env.runs.transition(done.id, 'RUNNING');
    env.runs.transition(done.id, 'COMPLETED');
    assert.equal(env.queue.requeueForShutdown(done.id, 'w1'), false, 'a completed run must not be resurrected');
    assert.equal(env.runs.get(done.id)!.status, 'COMPLETED');

    // The shutdown/cancellation race: if the user cancels at the same moment stop() fires,
    // drive() can return SHUTDOWN for a run the database already calls CANCELLED. Requeueing
    // there would resurrect a run the user deliberately stopped and re-execute it -- the
    // exact class of bug #47 was. The status filter is what prevents it, so it is pinned here
    // rather than relied upon.
    const cancelled = env.runService.create({ ownerId: 'alice', task: 'z', agent: 'fake' });
    env.queue.claim('w1', 60_000);
    env.runs.transition(cancelled.id, 'STARTING');
    env.runs.transition(cancelled.id, 'RUNNING');
    env.runs.transition(cancelled.id, 'CANCELLED');
    assert.equal(env.queue.requeueForShutdown(cancelled.id, 'w1'), false, 'a cancelled run must never be requeued');
    assert.equal(env.runs.get(cancelled.id)!.status, 'CANCELLED', 'cancellation must survive a concurrent shutdown');
  } finally {
    env.close();
  }
});

test('shutdown terminates the agent BEFORE requeueing (issue #51)', async () => {
  // Why this ordering matters: finalize() requeues, and a requeued run is QUEUED with no
  // lease, so it is instantly claimable. If the agent process is still alive at that moment,
  // the successor worker starts a SECOND agent against the same workspace while the first is
  // still writing into it. The finally block in execute() does terminate, but it runs after
  // finalize -- so on this path the guarantee the finally documents was not actually held.
  const repoDir = makeGitRepo(join(envDir(), 'repo-term-order'));
  const env = makeEnv({
    workerEnabled: false,
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'first' } }, delayMs: 1_500 },
      { event: { type: 'agent.message', payload: { text: 'second' } } },
    ],
  });

  let runId = '';
  const observed: string[] = [];
  const fake = env.adapters.fake;
  const innerStart = fake.start.bind(fake);
  fake.start = (async (ctx: Parameters<typeof innerStart>[0]) => {
    const handle = await innerStart(ctx);
    const innerTerminate = handle.terminate.bind(handle);
    handle.terminate = async () => {
      // First terminate only: the finally block terminates again and that no-op must not
      // overwrite the ordering evidence.
      if (observed.length === 0) observed.push(env.runs.get(ctx.run.id)?.status ?? 'missing');
      return innerTerminate();
    };
    return handle;
  }) as typeof fake.start;

  const w = makeWorker(env, { workerId: 'ordered-shutdown' });
  try {
    w.start();
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repoDir } });
    runId = run.id;
    await waitFor(() => env.runs.get(runId)!.status === 'RUNNING', 10_000);

    w.stop();
    await waitFor(() => env.runs.get(runId)!.status === 'QUEUED', 10_000);

    assert.ok(observed.length > 0, 'the agent must be terminated during a graceful shutdown at all');
    // The run must still be owned/active when the agent is killed. If this reads 'QUEUED',
    // the requeue beat the terminate and the double-agent window is open.
    assert.equal(
      observed[0],
      'RUNNING',
      `agent was terminated while the run was ${observed[0]}; it must still be RUNNING, `
        + 'otherwise the run is already claimable by another worker while this agent is alive',
    );
  } finally {
    w.stop();
    env.close();
  }
});

test('reap writes the FAILED state and its events atomically (issue #61)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.queue.claim('w1', 60_000);
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING');

    const { failed } = env.queue.reapExpiredLeases(Date.now() + 10 * 60_000, (runId) => {
      env.events.append(runId, 'error', { message: 'lease expired' });
      env.events.append(runId, 'run.failed', { runId, error: 'lease expired', kind: 'infrastructure' });
    });
    assert.deepEqual(failed, [run.id]);
    assert.equal(env.runs.get(run.id)!.status, 'FAILED');
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('error'), `the FAILED run has no error event: ${types.join(',')}`);
    assert.ok(types.includes('run.failed'), `the FAILED run has no run.failed event: ${types.join(',')}`);
  } finally {
    env.close();
  }
});

test('a failed event append rolls the reap back rather than leaving a FAILED run with no events (issue #61)', async () => {
  // This is the whole point of #61. Before the fix the events were appended AFTER the
  // transaction committed, so any failure in that window -- a crash, a busy database, a throw
  // from a listener -- produced a run marked FAILED whose timeline claimed nothing happened.
  // An operator reading it saw a run stop dead with no explanation and no failure record.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.queue.claim('w1', 60_000);
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING');
    const eventsBefore = env.events.list(run.id).length;

    assert.throws(
      () =>
        env.queue.reapExpiredLeases(Date.now() + 10 * 60_000, () => {
          throw new Error('event store exploded');
        }),
      /event store exploded/,
      'the callback error must propagate',
    );

    // Rolled back: the run is still RUNNING (and still owned), so a later reap or the owning
    // worker can still settle it correctly. It is NOT in the contradictory state.
    const after = env.runs.get(run.id)!;
    assert.equal(after.status, 'RUNNING', `reap did not roll back: status is ${after.status}`);
    assert.equal(after.leaseOwner, 'w1', 'the lease must also be restored by the rollback');
    assert.equal(
      env.events.list(run.id).length,
      eventsBefore,
      'no partial events may survive a rolled-back reap',
    );
  } finally {
    env.close();
  }
});

test('a skipped run releases the lease it already holds (issue #71)', async () => {
  // The ownership guard at the top of execute() returned BEFORE the try/finally that owns
  // releaseLease, so a run cancelled between claim and execute kept lease_owner and
  // lease_expires_at forever. Nothing revisits a TERMINAL skipped run: the reaper only selects
  // non-terminal statuses, and a terminal run is not claimable. (The guard also skips
  // non-terminal runs that moved on or belong to another worker -- those do not leak, and this
  // test covers the terminal case that does.)
  const env = makeEnv({ workerEnabled: false });
  const w = makeWorker(env, { workerId: 'skipper' });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    // Claim it as this worker, then cancel it -- the exact interleaving the guard exists for.
    const claimed = env.queue.claim('skipper', 60_000);
    assert.equal(claimed?.id, run.id);
    env.runs.transition(run.id, 'CANCELLED');
    assert.equal(env.runs.get(run.id)!.leaseOwner, 'skipper', 'precondition: this worker holds the lease');

    // execute() is private; the skip path is only reachable through the claim loop, which
    // cannot be interrupted between claim and execute without a race. Calling it directly
    // keeps the test deterministic instead of sleeping on a window.
    await (w as unknown as { execute(r: typeof run): Promise<void> }).execute(run);

    assert.equal(env.runs.get(run.id)!.status, 'CANCELLED', 'skipping must not alter the run');
    const row = env.db
      .prepare('SELECT lease_owner, lease_expires_at FROM runs WHERE id = ?')
      .get(run.id) as { lease_owner: string | null; lease_expires_at: string | null };
    assert.equal(row.lease_owner, null, `skipped run kept its lease: ${JSON.stringify(row)}`);
    assert.equal(row.lease_expires_at, null);
  } finally {
    w.stop();
   env.close();
  }
});

test('a worker with no lease cannot requeue a run another worker is executing (issue #59)', () => {
  // Direct unit-level proof of the bug that requeueLostLease allowed. It matched
  // `lease_owner IS NOT NULL AND lease_owner != ?`, so it acted on runs owned by somebody
  // else -- the exact opposite of the safety its doc comment claimed.
  const repoDir = makeGitRepo(join(envDir(), 'repo-theft-59'));
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repoDir } });
    assert.ok(env.queue.claim('worker-B', 60_000));
    env.runs.transition(run.id, 'STARTING', {});
    env.runs.transition(run.id, 'RUNNING', {});
    const before = env.runs.get(run.id)!;
    assert.equal(before.leaseOwner, 'worker-B');
    assert.equal(before.status, 'RUNNING');

    // The method is gone. This is a RUNTIME property lookup, not a type check -- the cast to
    // Record<string, unknown> deliberately erases the type, so re-adding the method would still
    // typecheck and this assertion is what catches it. (A compile-time guard would need a
    // `// @ts-expect-error` on a direct call, which fails the build the moment the method returns;
    // that is the stronger check, so it is done here as well.)
    const queue = env.queue as unknown as Record<string, unknown>;
    assert.equal(queue.requeueLostLease, undefined,
      'requeueLostLease must not come back: it requeued runs whose lease was live elsewhere');

    // And the surviving requeue is owner-scoped: worker-A holding nothing cannot touch it.
    assert.equal(env.queue.requeueForShutdown(run.id, 'worker-A'), false,
      'a non-owner must never requeue another worker\'s run');
    const after = env.runs.get(run.id)!;
    assert.equal(after.status, 'RUNNING', 'status must be untouched by a non-owner');
    assert.equal(after.leaseOwner, 'worker-B', 'the live owner\'s lease must be untouched');

    // Compile-time half. `@ts-expect-error` requires the next line to be an error: while
    // requeueLostLease does not exist it is one, and the moment anyone re-adds the method the
    // directive becomes unused and `tsc --noEmit` fails the build. That is the check the runtime
    // assertion above cannot provide.
    // @ts-expect-error requeueLostLease was removed by issue #59 and must stay removed
    void (env.queue.requeueLostLease as unknown);
  } finally {
    env.close();
  }
});

test('requeueForShutdown derives its status filter from the state machine (issue #59)', () => {
  // The complaint in #59 was not that the old hardcoded filter was wrong -- it was that nothing
  // would have noticed if the machine and the SQL diverged. This pins the coupling.
  const sources = shutdownRequeueSources();
  assert.deepEqual([...sources].sort(), ['NEEDS_INPUT', 'RUNNING', 'STARTING'],
    'exactly the active states may requeue on shutdown');
  // Terminal states must never be requeue sources: that is the resurrection guard.
  for (const t of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const) {
    assert.equal(canTransition(t, 'QUEUED'), false, `${t} must never transition back to QUEUED`);
  }
  // QUEUED -> QUEUED would be a self-loop and is not declared.
  assert.equal(canTransition('QUEUED', 'QUEUED'), false);

  // Behavioural half: a terminal run is declined even by its own recorded owner.
  const repoDir = makeGitRepo(join(envDir(), 'repo-drift-59'));
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repoDir } });
    assert.ok(env.queue.claim('w1', 60_000));
    env.runs.transition(run.id, 'STARTING', {});
    env.runs.transition(run.id, 'RUNNING', {});
    env.runs.transition(run.id, 'COMPLETED', { completedAt: new Date().toISOString() });
    assert.equal(env.queue.requeueForShutdown(run.id, 'w1'), false,
      'a completed run must never be requeued');
    assert.equal(env.runs.get(run.id)!.status, 'COMPLETED');
  } finally {
    env.close();
  }
});

test('control: the abort assertion in the lease-loss test can actually fail (issue #59)', async () => {
  // Positive control. The lease-loss test asserts 'second' is ABSENT to prove the agent was
  // aborted. An absence assertion is only evidence if the thing absent had time to arrive, and
  // the original version failed that bar: it delayed 'second' by 3_000ms and watched for 400ms,
  // so it passed even with the abort deleted.
  //
  // This runs the IDENTICAL script and observation window with no lease theft, and requires
  // 'second' to show up. If someone lengthens the delay or shortens the window until the absence
  // check becomes vacuous again, this test fails instead of silently weakening the other one.
  const repoDir = makeGitRepo(join(envDir(), 'repo-abort-control-59'));
  const env = makeEnv({
    workerEnabled: false,
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'first' } } },
      { event: { type: 'agent.message', payload: { text: 'second' } }, delayMs: ABORT_PROBE_DELAY_MS },
    ],
  });
  const worker = makeWorker(env, { workerId: 'control-worker', leaseHeartbeatMs: 100 });
  try {
    worker.start();
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repoDir } });
    await waitFor(() => env.runs.get(run.id)!.status === 'RUNNING', 10_000);
    // Same 900ms window the lease-loss test uses, and nobody touches the lease.
    await sleep(ABORT_PROBE_WINDOW_MS);
    const texts = env.events.list(run.id)
      .filter((e) => e.type === 'agent.message')
      .map((e) => (e.payload as { text?: string }).text);
    assert.ok(texts.includes('first'), 'control: first emitted');
    assert.ok(texts.includes('second'),
      'control: second MUST arrive within the observation window, otherwise the absence '
      + 'assertion in the lease-loss test proves nothing');
  } finally {
    worker.stop();
    env.close();
  }
});

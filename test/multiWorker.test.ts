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
import { makeEnv, makeGitRepo, waitFor, sleep } from './helpers.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

// --- helpers ---------------------------------------------------------------

function envDir(): string {
  // system temp dir (not the repo) so tests never litter the checkout
  return join(tmpdir(), `mercury-mw-${Math.random().toString(16).slice(2)}`);
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
    maxRetries: 2,
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

test('lease loss: worker aborts execution and requeues the run', async () => {
  const repoDir = makeGitRepo(join(envDir(), 'repo-lease'));
  const env = makeEnv({
    workerEnabled: false,
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'first' } }, delayMs: 1_500 },
      { event: { type: 'agent.message', payload: { text: 'second' } } },
    ],
  });
  const spy = makeSpyLogger();
  const worker = makeWorker(env, { workerId: 'lease-worker', leaseHeartbeatMs: 100, logger: spy.root });
  try {
    worker.start();
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', repository: { localPath: repoDir } });
    await waitFor(() => env.runs.get(run.id)!.status === 'RUNNING', 10_000);

    // simulate another worker taking the run over (lease stolen)
    env.db.prepare('UPDATE runs SET lease_owner = ? WHERE id = ?').run('other-worker', run.id);

    // the worker detects it on the next heartbeat, aborts, and requeues; the run is
    // then re-executed by the (still owning) worker and completes. The requeue window
    // is milliseconds, so wait for the re-execution to finish and inspect the events.
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 15_000);
    const final = env.runs.get(run.id)!;
    assert.equal(final.attempt, 1); // requeued, not a retry chain
    const list = env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 10 });
    assert.equal(list.runs.length, 1);
    const types = env.events.list(run.id).map((e) => e.type);
    assert.equal(types.filter((t) => t === 'run.started').length, 2);
    assert.equal(types.filter((t) => t === 'run.completed').length, 1);
    assert.ok(types.includes('lease.lost'));
    assert.ok(spy.warns.some((w) => w.msg === 'lease lost during execution'));
  } finally {
    worker.stop();
    env.close();
  }
});

test('CLI wiring: /healthz/workers returns 200 when started via cli.ts server (issue #4)', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'mercury-cli-healthz-'));
  const port = 3900 + Math.floor(Math.random() * 500);
  const env = {
    ...process.env,
    MERCURY_DB_PATH: join(dir, 'test.db'),
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

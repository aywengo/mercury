// Bot scheduler tests (B1-1, issue #735; docs/dispatcher-bot-design.md §5, §15).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, resolveTemplate, runIsNonTerminal, type SchedulerClient, type BotRunView, type DispatchRequest } from '../src/host/bots/scheduler.ts';
import type { BotConfig, BotTaskConfig } from '../src/host/bots/config.ts';
import { dispatchKey, scheduledWallMinuteId } from '../src/host/bots/keys.ts';

function task(over: Partial<BotTaskConfig> = {}): BotTaskConfig {
  return {
    name: 'nightly',
    cron: '* * * * *',
    template: { task: 'maintenance {{fire.date}} {{fire.time}}' },
    singleFlight: false,
    onMiss: 'skip',
    ...over,
  };
}

function cfg(tasks: BotTaskConfig[], alias = 'ops', apiUrl?: string): BotConfig {
  return { alias, tasks, api: apiUrl ? { url: apiUrl } : {}, warnings: [] };
}

/** Scripted client: records createRun calls, serves a canned run list (one page). */
function fakeClient(ownRuns: BotRunView[] = []): SchedulerClient & { calls: DispatchRequest[]; failList: string | null; listCalls: number } {
  const self = {
    calls: [] as DispatchRequest[],
    failList: null as string | null,
    listCalls: 0,
    async listOwnRuns(_limit?: number, _cursor?: string | null): Promise<{ runs: BotRunView[]; nextCursor: string | null }> {
      self.listCalls++;
      if (self.failList) throw new Error(self.failList);
      return { runs: ownRuns, nextCursor: null };
    },
    async createRun(req: DispatchRequest) {
      self.calls.push(req);
      return { runId: `run-${self.calls.length}`, replayed: false };
    },
  };
  return self;
}

const MIN = 60_000;

test('tick dispatches the on-time fire with the derived key and botTask hint', async () => {
  const now = Date.UTC(2026, 5, 10, 3, 15, 30); // 03:15:30 — the 03:15 fire is on-time
  const c = fakeClient();
  const out = await tick(cfg([task()]), c, { nowMs: now, afterMs: now - MIN });
  assert.equal(out.dispatched.length, 1);
  assert.equal(c.calls.length, 1);
  const call = c.calls[0]!;
  // The key is the scheduled wall minute (03:15), not the tick instant (03:15:30).
  assert.equal(call.key, 'bot-ops:nightly:w2026-06-10T03:15');
  assert.equal(call.body.constraints && (call.body.constraints as Record<string, unknown>).botTask, 'nightly');
  // Defaults for the two enforced constraints.
  assert.equal((call.body.constraints as Record<string, unknown>).maxDurationMs, 3_600_000);
  assert.equal((call.body.constraints as Record<string, unknown>).maxRetries, 0);
  // Template placeholders resolved to the fire's wall clock.
  assert.equal(call.body.task, 'maintenance 2026-06-10 03:15');
});

test('100 fires produce exactly 100 keyed dispatches when nothing blocks (acceptance)', async () => {
  const c = fakeClient();
  // The bot ticks once per minute, so 100 fires = 100 single-minute ticks against an every-minute
  // cron. Each fire is on-time in its own tick and keyed to its own scheduled minute.
  const start = Date.UTC(2026, 5, 10, 0, 0, 0);
  let dispatched = 0;
  for (let i = 1; i <= 100; i++) {
    const nowMs = start + i * MIN;
    const out = await tick(cfg([task()]), c, { nowMs, afterMs: nowMs - MIN });
    dispatched += out.dispatched.length;
  }
  assert.equal(dispatched, 100);
  assert.equal(c.calls.length, 100);
  const keys = new Set(c.calls.map((x) => x.key));
  assert.equal(keys.size, 100, 'each scheduled minute gets its own key');
  // Keys ascend with the schedule.
  const ordered = c.calls.map((x) => x.key);
  assert.deepEqual([...ordered].sort(), ordered);
});

test('a 100-minute catch-up window yields exactly what onMiss allows (acceptance, policy side)', async () => {
  // skip: 99 missed dropped, only the on-time fire.
  const start = Date.UTC(2026, 5, 10, 0, 0, 0);
  const now = start + 100 * MIN;
  const cSkip = fakeClient();
  const outSkip = await tick(cfg([task({ onMiss: 'skip' })]), cSkip, { nowMs: now, afterMs: start });
  assert.equal(outSkip.dispatched.length, 1);
  assert.equal(outSkip.skippedMissed.length, 99);
  // run with maxCatchUp 3: 3 missed + 1 on-time.
  const cRun = fakeClient();
  const outRun = await tick(cfg([task({ onMiss: 'run', singleFlight: false })]), cRun, { nowMs: now, afterMs: start });
  assert.equal(outRun.dispatched.length, 4);
  // collapse: 1 missed (keyed to minute 99) + 1 on-time.
  const cCol = fakeClient();
  const outCol = await tick(cfg([task({ onMiss: 'collapse' })]), cCol, { nowMs: now, afterMs: start });
  assert.equal(outCol.dispatched.length, 2);
  assert.ok(cCol.calls.some((x) => x.key === 'bot-ops:nightly:w2026-06-10T01:39'));
});

test('singleFlight skips NEEDS_INPUT (and every non-terminal status), dispatches on terminal (§5.3)', async () => {
  const now = Date.UTC(2026, 5, 10, 3, 15, 30);
  for (const status of ['QUEUED', 'STARTING', 'RUNNING', 'NEEDS_INPUT'] as const) {
    const c = fakeClient([{ id: 'r1', status, constraints: { botTask: 'nightly' } }]);
    const out = await tick(cfg([task({ singleFlight: true })]), c, { nowMs: now, afterMs: now - MIN });
    assert.equal(c.calls.length, 0, `${status} must block`);
    assert.equal(out.skippedSingleFlight.length, 1);
  }
  for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const) {
    const c = fakeClient([{ id: 'r1', status, constraints: { botTask: 'nightly' } }]);
    await tick(cfg([task({ singleFlight: true })]), c, { nowMs: now, afterMs: now - MIN });
    assert.equal(c.calls.length, 1, `${status} must not block`);
  }
});

test('runIsNonTerminal is a deny-list: an unknown future status counts as non-terminal', () => {
  assert.equal(runIsNonTerminal('RUNNING'), true);
  assert.equal(runIsNonTerminal('COMPLETED'), false);
  assert.equal(runIsNonTerminal('PAUSED_WHATEVER'), true, 'a status the bot does not know must block, not fire');
});

test('onMiss skip drops missed fires but still fires the on-time one', async () => {
  const now = Date.UTC(2026, 5, 10, 3, 15, 0);
  const c = fakeClient();
  // Down for 3 minutes: fires at 03:13 and 03:14 are missed, 03:15 is on-time.
  const out = await tick(cfg([task({ onMiss: 'skip' })]), c, { nowMs: now, afterMs: now - 3 * MIN });
  assert.equal(out.dispatched.length, 1);
  assert.equal(c.calls[0]!.key, 'bot-ops:nightly:w2026-06-10T03:15');
  assert.deepEqual(out.skippedMissed.map((s) => s.fireMs), [now - 2 * MIN, now - MIN]);
});

test('onMiss collapse fires once keyed to the newest MISSED scheduled minute', async () => {
  const now = Date.UTC(2026, 5, 10, 3, 15, 0);
  const c = fakeClient();
  const out = await tick(cfg([task({ onMiss: 'collapse' })]), c, { nowMs: now, afterMs: now - 3 * MIN });
  assert.equal(out.dispatched.length, 2, 'on-time fire + the collapsed missed fire');
  const keys = c.calls.map((x) => x.key);
  assert.ok(keys.includes('bot-ops:nightly:w2026-06-10T03:14'), 'collapse keys to the missed minute, not now');
  // Pure catch-up window (bot starts late; the current minute does not match the cron):
  // exactly one dispatch, keyed to the newest missed scheduled minute.
  const c2 = fakeClient();
  const fiveMinNow = Date.UTC(2026, 5, 10, 3, 12, 59); // cron */5: fires 03:00/05/10, none at 03:12
  const out2 = await tick(cfg([task({ onMiss: 'collapse', cron: '*/5 * * * *' })]), c2, { nowMs: fiveMinNow, afterMs: fiveMinNow - 11 * MIN });
  assert.equal(out2.dispatched.length, 1);
  assert.equal(c2.calls[0]!.key, 'bot-ops:nightly:w2026-06-10T03:10');
});

test('onMiss run fires once per missed interval capped at maxCatchUp (default 3)', async () => {
  const now = Date.UTC(2026, 5, 10, 3, 15, 0);
  const c = fakeClient();
  await tick(cfg([task({ onMiss: 'run', singleFlight: false })]), c, { nowMs: now, afterMs: now - 6 * MIN });
  // 6 missed fires (03:09..03:14) + on-time (03:15); cap keeps the newest 3 missed.
  assert.equal(c.calls.length, 4);
  assert.deepEqual(
    c.calls.map((x) => x.key),
    [
      'bot-ops:nightly:w2026-06-10T03:12',
      'bot-ops:nightly:w2026-06-10T03:13',
      'bot-ops:nightly:w2026-06-10T03:14',
      'bot-ops:nightly:w2026-06-10T03:15',
    ],
  );
  const c2 = fakeClient();
  await tick(cfg([task({ onMiss: 'run', maxCatchUp: 2, singleFlight: false })]), c2, { nowMs: now, afterMs: now - 6 * MIN });
  assert.equal(c2.calls.length, 3);
});

test('run + singleFlight collapses to one fire within a tick (the pinned §5.3 interaction)', async () => {
  const now = Date.UTC(2026, 5, 10, 3, 15, 0);
  const c = fakeClient(); // empty run list: nothing blocks fire #1
  const out = await tick(cfg([task({ onMiss: 'run', singleFlight: true })]), c, { nowMs: now, afterMs: now - 3 * MIN });
  // Fire #1 (oldest catch-up) dispatches; fires #2/#3/#4 see the tick's own dispatch and skip.
  assert.equal(out.dispatched.length, 1);
  assert.equal(out.skippedSingleFlight.length, 2, 'fires #2 and #3 see the tick\'s own dispatch');
  assert.equal(c.calls.length, 1);
});

test('derived keys are stable across ticks: the same window replays the same key', async () => {
  const now = Date.UTC(2026, 5, 10, 3, 15, 30);
  const c1 = fakeClient();
  await tick(cfg([task()]), c1, { nowMs: now, afterMs: now - MIN });
  const c2 = fakeClient();
  await tick(cfg([task()]), c2, { nowMs: now + 5_000, afterMs: now - MIN });
  assert.equal(c1.calls[0]!.key, c2.calls[0]!.key, 'restart mid-window derives the same key');
});

test('a listOwnRuns failure refuses singleFlight dispatch but not singleFlight:false tasks', async () => {
  const now = Date.UTC(2026, 5, 10, 3, 15, 30);
  const c = fakeClient();
  c.failList = 'boom';
  const out = await tick(cfg([task({ singleFlight: true, name: 'guarded' }), task({ singleFlight: false, name: 'free' })]), c, { nowMs: now, afterMs: now - MIN });
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0]!.body.task !== undefined, true);
  assert.match(out.errors[0]!.message, /singleFlight list walk failed: Error: boom/);
  assert.equal(out.errors[0]!.task, 'guarded');
});

test('resolveTemplate substitutes {{fire.*}} and resolves notAfterAt in UTC and fixed offsets', () => {
  const fire = Date.UTC(2026, 5, 10, 3, 15, 0);
  const parts = { date: '2026-06-10', time: '03:15', iso: scheduledWallMinuteId(fire, 'UTC') };
  const out = resolveTemplate(task({ template: { task: 'x', notAfterAt: '06:00' } }), parts);
  assert.equal(out.notAfterAt, undefined, 'the helper is consumed, not sent');
  // UTC: 06:00Z on the fire's date.
  assert.equal((out.constraints as Record<string, unknown>).notAfter, '2026-06-10T06:00:00.000Z');
  // +02:00: 06:00 wall = 04:00Z.
  const out2 = resolveTemplate(
    task({ tz: '+02:00', template: { task: 'x', notAfterAt: '06:00' } }),
    { date: '2026-06-10', time: '03:15', iso: scheduledWallMinuteId(fire, { offsetMinutes: 120 }) },
  );
  assert.equal((out2.constraints as Record<string, unknown>).notAfter, '2026-06-10T04:00:00.000Z');
  // An explicit template notAfter wins over the helper.
  const out3 = resolveTemplate(
    task({ template: { task: 'x', notAfterAt: '06:00', constraints: { notAfter: '2026-06-10T23:00:00Z' } } }),
    parts,
  );
  assert.equal((out3.constraints as Record<string, unknown>).notAfter, '2026-06-10T23:00:00Z');
  // A malformed helper is a loud error, not a silent drop.
  assert.throws(() => resolveTemplate(task({ template: { task: 'x', notAfterAt: '6pm' } }), parts), /notAfterAt/);
});


// ---- Contract: the bot HTTP client against the real server ----

import { makeEnv, tempDir } from './helpers.ts';
import { closeServer, createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeBotClient, runBot, botStatePath, readBotState, writeBotState } from '../src/host/bots/process.ts';
import type { Express } from 'express';

async function listen(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    // Bind loopback EXPLICITLY (issue #185): a wildcard bind on macOS/BSD can lose the race to
    // another socket on 127.0.0.1 and the test then talks to the wrong server.
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => new Promise<void>((res) => server.close(() => res())) });
    });
  });
}

async function startServer(tokens: [string, string][], opts: { createRunMax?: number } = {}) {
  const env = makeEnv({ workerEnabled: false });
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService, events: env.events, stream, apiTokens: new Map(tokens), adminToken: null,
    // The bot dispatches on a schedule; the default 30/min create limit would rate-limit the
    // 100-fire acceptance dispatches. The nightly host's real deployment raises this too.
    rateLimits: opts.createRunMax ? { createRun: { windowMs: 60_000, max: opts.createRunMax } } : undefined,
  });
  const srv = await listen(app);
  return {
    env, srv,
    base: `http://127.0.0.1:${srv.port}`,
    async close() { await srv.close(); stream.stop(); env.close(); },
  };
}

test('bot client dispatches to the real server: owner, botTask, and idempotent replay', async () => {
  const S = await startServer([['bot-token-ops', 'bot-ops']]);
  try {
    const client = makeBotClient(cfg([task()], 'ops', S.base), { XDG_CONFIG_HOME: configHome({ 'ops': { api: 'bot-token-ops' } }) });
    await client.probeHealth();
    const fire = Date.UTC(2026, 5, 10, 3, 15, 0);
    const key = dispatchKey('ops', 'nightly', fire, 'UTC');
    const body = { task: 'maintenance', constraints: { botTask: 'nightly', maxDurationMs: 3_600_000, maxRetries: 0 } };
    const r1 = await client.createRun({ taskName: 'nightly', fireMs: fire, wallMinute: scheduledWallMinuteId(fire, 'UTC'), key, body });
    assert.equal(r1.replayed, false);
    const r2 = await client.createRun({ taskName: 'nightly', fireMs: fire, wallMinute: scheduledWallMinuteId(fire, 'UTC'), key, body });
    // §5.2 prerequisite, asserted against the real server: same key -> same Run, no 409, no dup.
    assert.equal(r2.runId, r1.runId);
    const got = await fetch(`${S.base}/api/runs/${r1.runId}`, { headers: { authorization: 'Bearer bot-token-ops' } });
    const gotBody = (await got.json()) as { run: { ownerId: string; constraints: { botTask?: string } } };
    assert.equal(gotBody.run.ownerId, 'bot-ops', 'dispatched Runs are owned by the bot identity');
    assert.equal(gotBody.run.constraints.botTask, 'nightly');
    const list = await fetch(`${S.base}/api/runs`, { headers: { authorization: 'Bearer bot-token-ops' } });
    const listBody = (await list.json()) as { runs: unknown[] };
    assert.equal(listBody.runs.length, 1, 'the replay did not create a second Run');
  } finally {
    await S.close();
  }
});

test('tick through the real client: 100 fires -> 100 Runs, each keyed to its own minute (acceptance)', async () => {
  const S = await startServer([['bot-token-ops', 'bot-ops']], { createRunMax: 500 });
  try {
    const envAdd = { XDG_CONFIG_HOME: configHome({ 'ops': { api: 'bot-token-ops' } }) };
    const client = makeBotClient(cfg([task()], 'ops', S.base), envAdd);
    const start = Date.UTC(2026, 5, 10, 0, 0, 0);
    let dispatched = 0;
    for (let i = 1; i <= 100; i++) {
      const nowMs = start + i * MIN;
      const out = await tick(cfg([task()]), client, { nowMs, afterMs: nowMs - MIN });
      dispatched += out.dispatched.length;
    }
    assert.equal(dispatched, 100);
    const list = await fetch(`${S.base}/api/runs?limit=200`, { headers: { authorization: 'Bearer bot-token-ops' } });
    const listBody = (await list.json()) as { runs: { id: string; constraints: { botTask?: string } }[] };
    assert.equal(listBody.runs.length, 100);
    assert.ok(listBody.runs.every((r) => r.constraints.botTask === 'nightly'));
  } finally {
    await S.close();
  }
});

test('singleFlight through the real server: a Run parked in NEEDS_INPUT blocks the next fire', async () => {
  const S = await startServer([['bot-token-ops', 'bot-ops']]);
  try {
    const envAdd = { XDG_CONFIG_HOME: configHome({ 'ops': { api: 'bot-token-ops' } }) };
    const client = makeBotClient(cfg([task()], 'ops', S.base), envAdd);
    const fire = Date.UTC(2026, 5, 10, 3, 15, 0);
    await client.createRun({ taskName: 'nightly', fireMs: fire, wallMinute: scheduledWallMinuteId(fire, 'UTC'), key: dispatchKey('ops', 'nightly', fire, 'UTC'), body: { task: 'x', constraints: { botTask: 'nightly', maxDurationMs: 3_600_000, maxRetries: 0 } } });
    // Park the Run in NEEDS_INPUT directly (seed state; no adapter can produce it deterministically).
    const list = await (await fetch(`${S.base}/api/runs`, { headers: { authorization: 'Bearer bot-token-ops' } })).json() as { runs: { id: string }[] };
    S.env.runs.transition(list.runs[0]!.id, 'STARTING' as never);
    S.env.runs.transition(list.runs[0]!.id, 'RUNNING' as never);
    S.env.runs.transition(list.runs[0]!.id, 'NEEDS_INPUT' as never);
    const now = Date.UTC(2026, 5, 10, 3, 16, 30);
    const out = await tick(cfg([task({ singleFlight: true })]), client, { nowMs: now, afterMs: now - MIN });
    assert.equal(out.dispatched.length, 0);
    assert.equal(out.skippedSingleFlight.length, 1);
  } finally {
    await S.close();
  }
});

// ---- Subprocess: `mercury host bot run --once` against the real server ----

let credsSeq = 0;
/**
 * A config-home dir holding bot-credentials.json (0600) — the SAME layout the config loader
 * expects under XDG_CONFIG_HOME, so contract tests and subprocess tests share one helper.
 */
function configHome(entries: Record<string, { api: string }>): string {
  const dir = tempDir(`bot-sched-creds-${++credsSeq}-`);
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify(entries), { mode: 0o600 });
  return dir;
}

function botEnv(S: { base: string }, dir: string, extra: Record<string, string> = {}): Record<string, string> {
  // dir IS the config home: it already holds mercury/bots/ops.json and mercury/bot-credentials.json.
  return {
    ...process.env,
    XDG_CONFIG_HOME: dir,
    ...extra,
  } as Record<string, string>;
}

test('subprocess `host bot run --once` fires on schedule against the real server (fake clock via state file)', async () => {
  const S = await startServer([['bot-token-ops', 'bot-ops']]);
  const dir = tempDir('bot-sched-');
  const stateDir = tempDir('bot-sched-state-');
  try {
    const botsDir = join(dir, 'mercury', 'bots');
    mkdirSync(botsDir, { recursive: true });
    writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify({ 'ops': { api: 'bot-token-ops' } }), { mode: 0o600 });
    // The cron minute is pinned 5 minutes IN THE PAST (inside the state window) instead of the
    // current minute: a past minute never moves, so a slow subprocess start or a minute boundary
    // between computing the cron and the bot's tick cannot miss the fire (round-4 review).
    const fireMinute = new Date(Date.now() - 5 * 60_000).getUTCMinutes();
    writeFileSync(join(botsDir, 'ops.json'), JSON.stringify({
      api: { url: S.base },
      schedule: { tasks: [{ name: 'now-task', cron: `${fireMinute} * * * *`, template: { task: 'subprocess maintenance {{fire.iso}}' }, singleFlight: false, onMiss: 'collapse' }] },
    }));
    // Fresh bots do not fire the current minute (no onMiss window). Seed the state file 10 minutes
    // back so the current-minute fire is in-window: onMiss=collapse dispatches it keyed to its
    // scheduled minute. This is the fake clock: the wall label comes from the state window.
    mkdirSync(join(stateDir, 'mercury', 'bots'), { recursive: true });
    writeFileSync(join(stateDir, 'mercury', 'bots', 'ops.state.json'), JSON.stringify({ lastTickMs: Date.now() - 10 * 60_000 }));
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const res = await run('node', ['src/cli.ts', 'host', 'bot', 'run', '--alias', 'ops', '--once'], { env: botEnv(S, dir, { XDG_STATE_HOME: stateDir }), timeout: 30_000, cwd: join(import.meta.dirname, '..') });
    assert.match(res.stdout, /healthz ok/);
    assert.match(res.stdout, /run=run-1|task=now-task/);
    const list = await (await fetch(`${S.base}/api/runs`, { headers: { authorization: 'Bearer bot-token-ops' } })).json() as { runs: { id: string; task: string; constraints: { botTask?: string } }[] };
    assert.equal(list.runs.length, 1);
    assert.equal(list.runs[0]!.constraints.botTask, 'now-task');
    assert.match(list.runs[0]!.task, /subprocess maintenance w\d{4}/);
  } finally {
    await S.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('subprocess restart mid-cycle does not double-dispatch (state + derived key)', async () => {
  const S = await startServer([['bot-token-ops', 'bot-ops']]);
  const dir = tempDir('bot-sched-');
  const stateDir = tempDir('bot-sched-state-');
  try {
    const botsDir = join(dir, 'mercury', 'bots');
    mkdirSync(botsDir, { recursive: true });
    writeFileSync(join(dir, 'mercury', 'bot-credentials.json'), JSON.stringify({ 'ops': { api: 'bot-token-ops' } }), { mode: 0o600 });
    const fireMinute = new Date(Date.now() - 5 * 60_000).getUTCMinutes();
    writeFileSync(join(botsDir, 'ops.json'), JSON.stringify({
      api: { url: S.base },
      schedule: { tasks: [{ name: 'now-task', cron: `${fireMinute} * * * *`, template: { task: 'restart-safe' }, singleFlight: false, onMiss: 'collapse' }] },
    }));
    mkdirSync(join(stateDir, 'mercury', 'bots'), { recursive: true });
    writeFileSync(join(stateDir, 'mercury', 'bots', 'ops.state.json'), JSON.stringify({ lastTickMs: Date.now() - 10 * 60_000 }));
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const r1 = await run('node', ['src/cli.ts', 'host', 'bot', 'run', '--alias', 'ops', '--once'], { env: botEnv(S, dir, { XDG_STATE_HOME: stateDir }), timeout: 30_000, cwd: join(import.meta.dirname, '..') });
    assert.match(r1.stdout, /task=now-task/, 'first run dispatches');
    // Restart immediately: the state file's lastTickMs is ~now, the window is empty, and even a
    // re-evaluated fire replays to the same derived key.
    const r2 = await run('node', ['src/cli.ts', 'host', 'bot', 'run', '--alias', 'ops', '--once'], { env: botEnv(S, dir, { XDG_STATE_HOME: stateDir }), timeout: 30_000, cwd: join(import.meta.dirname, '..') });
    assert.doesNotMatch(r2.stdout, /task=now-task/, 'second run has nothing due');
    const list = await (await fetch(`${S.base}/api/runs`, { headers: { authorization: 'Bearer bot-token-ops' } })).json() as { runs: unknown[] };
    assert.equal(list.runs.length, 1, 'restart must not double-dispatch');
  } finally {
    await S.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('state file is written after the tick with 0600 and read back across restarts', () => {
  const dir = tempDir('bot-sched-');
  try {
    const env = { XDG_STATE_HOME: dir };
    assert.equal(botStatePath('ops', env), join(dir, 'mercury', 'bots', 'ops.state.json'));
    writeBotState('ops', { lastTickMs: 1234 }, env);
    assert.equal(readBotState('ops', env).lastTickMs, 1234);
    const mode = statSync(botStatePath('ops', env)).mode & 0o777;
    assert.equal(mode, 0o600, 'state file is owner-only');
    // Absent state = no onMiss window, not a crash.
    assert.deepEqual(readBotState('never', env), {});
    // An alias is interpolated into the path: reject traversal-shaped aliases loudly.
    assert.throws(() => botStatePath('../escape', env), /alias must match/);
    assert.throws(() => botStatePath('a/b', env), /alias must match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('singleFlight walks ALL list pages: a parked NEEDS_INPUT run on page 2 still blocks (round-2 review)', async () => {
  const now = Date.UTC(2026, 5, 10, 3, 15, 30);
  // Page 1: one terminal run; page 2: the old parked NEEDS_INPUT run.
  const pages = [
    { runs: [{ id: 'r-new', status: 'COMPLETED', constraints: { botTask: 'nightly' } }], nextCursor: 'c2' },
    { runs: [{ id: 'r-old', status: 'NEEDS_INPUT', constraints: { botTask: 'nightly' } }], nextCursor: null },
  ];
  let page = 0;
  const client: SchedulerClient = {
    async listOwnRuns() { return pages[Math.min(page++, pages.length - 1)]!; },
    async createRun(req) { return { runId: 'x', replayed: false }; },
  };
  const out = await tick(cfg([task({ singleFlight: true })]), client, { nowMs: now, afterMs: now - MIN });
  assert.equal(out.dispatched.length, 0, 'the page-2 parked run must block');
  assert.equal(out.skippedSingleFlight.length, 1);
});

test('singleFlight fails closed when the list walk exceeds the page cap', async () => {
  const now = Date.UTC(2026, 5, 10, 3, 15, 30);
  const client: SchedulerClient = {
    async listOwnRuns() { return { runs: [{ id: 'r', status: 'COMPLETED', constraints: { botTask: 'nightly' } }], nextCursor: 'more' }; },
    async createRun(req) { return { runId: 'x', replayed: false }; },
  };
  const out = await tick(cfg([task({ singleFlight: true })]), client, { nowMs: now, afterMs: now - MIN });
  assert.equal(out.dispatched.length, 0, 'cap exhaustion refuses guarded dispatch (fail-closed)');
  assert.match(out.errors[0]!.message, /page cap/);
});


test('maxCatchUp: 0 means NO catch-up fires (slice(-0) guard, round-5 review)', async () => {
  const now = Date.UTC(2026, 5, 10, 3, 15, 0);
  const c = fakeClient();
  const out = await tick(cfg([task({ onMiss: 'run', maxCatchUp: 0 })]), c, { nowMs: now, afterMs: now - 6 * MIN });
  assert.equal(out.dispatched.length, 1, 'cap 0 suppresses catch-up only; the on-time fire still runs');
  assert.equal(out.skippedMissed.length, 5, 'cap 0 must not degrade to unbounded catch-up (slice(-0) guard)');
  assert.ok(c.calls.every((x) => x.key === 'bot-ops:nightly:w2026-06-10T03:15'));
  // A positive cap still keeps the newest N.
  const c2 = fakeClient();
  const out2 = await tick(cfg([task({ onMiss: 'run', maxCatchUp: 1 })]), c2, { nowMs: now, afterMs: now - 3 * MIN });
  assert.equal(out2.dispatched.length, 2, '1 missed + 1 on-time');
  assert.ok(c2.calls.some((x) => x.key === 'bot-ops:nightly:w2026-06-10T03:14'));
});

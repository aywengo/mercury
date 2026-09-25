// `host bot dispatch` and `host bot status` tests (B1-2, issue #736; §11).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManualFire, dispatchTask } from '../src/host/bots/dispatch.ts';
import { nextFires, statusView, renderStatus } from '../src/host/bots/status.ts';
import { tick, type SchedulerClient, type BotRunView } from '../src/host/bots/scheduler.ts';
import type { BotConfig, BotTaskConfig } from '../src/host/bots/config.ts';

function task(over: Partial<BotTaskConfig> = {}): BotTaskConfig {
  return {
    name: 'nightly',
    cron: '0 3 * * *',
    template: { task: 'manual {{fire.time}}' },
    singleFlight: false,
    onMiss: 'skip',
    ...over,
  };
}

function cfg(tasks: BotTaskConfig[], alias = 'ops'): BotConfig {
  return { alias, tasks, api: {}, warnings: [] };
}

function fakeClient(ownRuns: BotRunView[] = [], opts: { pages?: { runs: BotRunView[]; nextCursor: string | null }[] } = {}): SchedulerClient & { calls: { key: string; body: Record<string, unknown> }[] } {
  const self = {
    calls: [] as { key: string; body: Record<string, unknown> }[],
    async listOwnRuns(_limit?: number, _cursor?: string | null) {
      if (opts.pages) {
        const page = opts.pages.shift() ?? { runs: [], nextCursor: null };
        return page;
      }
      return { runs: ownRuns, nextCursor: null };
    },
    async createRun(req: { key: string; body: Record<string, unknown> }) {
      self.calls.push({ key: req.key, body: req.body });
      return { runId: `run-${self.calls.length}`, replayed: false };
    },
  };
  return self;
}

const MIN = 60_000;

// ---- dispatch ----

test('buildManualFire resolves the template and derives a manual- key', () => {
  const now = Date.UTC(2026, 5, 10, 14, 7, 30);
  const fire = buildManualFire(cfg([task()]), 'nightly', now);
  assert.match(fire.key, /^bot-ops:nightly:manual-w2026-06-10T14:07$/, 'key uses the dispatch wall minute, manual- prefixed');
  assert.equal((fire.body.constraints as Record<string, unknown>).botTask, 'nightly');
  assert.equal(fire.body.task, 'manual 14:07');
  // A scheduled fire for the same minute can never collide: its key has no manual- segment.
  assert.notEqual(fire.key, `bot-ops:nightly:w2026-06-10T14:07`);
});

test('buildManualFire refuses an unknown task with the known list', () => {
  assert.throws(() => buildManualFire(cfg([task()]), 'nope', Date.now()), /known: nightly/);
});

test('dispatch without --yes refuses and without --dry-run does not write', async () => {
  const c = fakeClient();
  const d = await dispatchTask(cfg([task()]), c, 'nightly', { nowMs: Date.now(), dryRun: false, yes: false });
  assert.equal(d.fired, false);
  assert.match(d.reason ?? '', /--yes/);
  assert.equal(c.calls.length, 0, 'no write without --yes');
});

test('dispatch --dry-run prints the plan and writes nothing', async () => {
  const c = fakeClient();
  const d = await dispatchTask(cfg([task()]), c, 'nightly', { nowMs: Date.UTC(2026, 5, 10, 14, 7, 0), dryRun: true, yes: false });
  assert.equal(d.fired, false);
  assert.equal(d.reason, 'dry-run');
  assert.ok(d.fire, 'the plan is present for printing');
  assert.equal(c.calls.length, 0);
});

test('dispatch --yes fires with singleFlight respected', async () => {
  const now = Date.now();
  const c = fakeClient();
  const d = await dispatchTask(cfg([task()]), c, 'nightly', { nowMs: now, dryRun: false, yes: true });
  assert.equal(d.fired, true);
  assert.equal(c.calls.length, 1);
  // A parked Run blocks a singleFlight task.
  const c2 = fakeClient([{ id: 'r1', status: 'NEEDS_INPUT', constraints: { botTask: 'nightly' } }]);
  const d2 = await dispatchTask(cfg([task({ singleFlight: true })]), c2, 'nightly', { nowMs: now, dryRun: false, yes: true });
  assert.equal(d2.fired, false);
  assert.match(d2.reason ?? '', /singleFlight: task 'nightly' has non-terminal Run r1 \(status NEEDS_INPUT\)/);
  assert.equal(c2.calls.length, 0);
  // singleFlight: false fires regardless.
  const c3 = fakeClient([{ id: 'r1', status: 'NEEDS_INPUT', constraints: { botTask: 'nightly' } }]);
  const d3 = await dispatchTask(cfg([task()]), c3, 'nightly', { nowMs: now, dryRun: false, yes: true });
  assert.equal(d3.fired, true);
});

test('two dispatches in the same minute share the key (replay), the next minute does not', () => {
  const t0 = Date.UTC(2026, 5, 10, 14, 7, 30);
  const k1 = buildManualFire(cfg([task()]), 'nightly', t0).key;
  const k2 = buildManualFire(cfg([task()]), 'nightly', t0 + 20_000).key;
  const k3 = buildManualFire(cfg([task()]), 'nightly', t0 + MIN).key;
  assert.equal(k1, k2, 'same wall minute -> same key');
  assert.notEqual(k1, k3);
});

// ---- status ----

test('nextFires reports the next scheduled fire per task within the horizon', () => {
  const now = Date.UTC(2026, 5, 10, 14, 0, 0);
  const nf = nextFires(cfg([task(), task({ name: 'impossible', cron: '0 2 31 2 *' })]), now);
  assert.equal(nf.length, 2);
  assert.equal(nf[0]!.task, 'nightly');
  assert.equal(nf[0]!.fireMs, Date.UTC(2026, 5, 11, 3, 0, 0), 'next 03:00 UTC is tomorrow');
  assert.equal(nf[0]!.wallMinute, 'w2026-06-11T03:00');
  assert.equal(nf[1]!.fireMs, NaN, 'an impossible schedule is reported, not dropped');
  assert.match(nf[1]!.wallMinute, /none within 24h/);
});

test('statusView counts dispatches in the last hour FROM THE API and lists recent actions', async () => {
  const now = Date.now();
  const runs: BotRunView[] = [
    { id: 'r1', status: 'RUNNING', constraints: { botTask: 'nightly' }, createdAt: new Date(now - 5 * MIN).toISOString() },
    { id: 'r2', status: 'COMPLETED', constraints: { botTask: 'nightly' }, createdAt: new Date(now - 30 * MIN).toISOString() },
    { id: 'r3', status: 'FAILED', constraints: { botTask: 'other' }, createdAt: new Date(now - 61 * MIN).toISOString() },
    { id: 'r4', status: 'COMPLETED', constraints: { botTask: 'nightly' }, createdAt: new Date(now - 90 * MIN).toISOString() },
  ];
  const view = await statusView(cfg([task()]), fakeClient(runs), now);
  assert.equal(view.dispatchesLastHour, 2, 'only Runs created within the last hour count');
  assert.equal(view.lastActions.length, 4);
  assert.equal(view.apiError, undefined);
  const rendered = renderStatus(cfg([task()]), view, now);
  assert.match(rendered, /dispatches in the last hour: 2/);
  assert.match(rendered, /next nightly: /);
});

test('statusView walks pages for the hourly count until Runs fall out of the window', async () => {
  const now = Date.now();
  const pages = [
    { runs: [{ id: 'r1', status: 'RUNNING', constraints: { botTask: 'nightly' }, createdAt: new Date(now - 5 * MIN).toISOString() }], nextCursor: 'c2' },
    { runs: [{ id: 'r2', status: 'COMPLETED', constraints: { botTask: 'nightly' }, createdAt: new Date(now - 30 * MIN).toISOString() }], nextCursor: 'c3' },
    { runs: [{ id: 'r3', status: 'COMPLETED', constraints: { botTask: 'nightly' }, createdAt: new Date(now - 61 * MIN).toISOString() }], nextCursor: null },
  ];
  const view = await statusView(cfg([task()]), fakeClient(undefined, { pages: [...pages] }), now);
  assert.equal(view.dispatchesLastHour, 2, 'page 2 counts, page 3 (older than the window) does not');
});

test('statusView marks the API-backed sections unavailable and the caller fails the command', async () => {
  const now = Date.now();
  const client: SchedulerClient = {
    async listOwnRuns() { throw new Error('boom'); },
    async createRun() { return { runId: 'x', replayed: false }; },
  };
  const view = await statusView(cfg([task()]), client, now);
  assert.ok(view.apiError);
  assert.equal(view.dispatchesLastHour, 0);
  assert.equal(view.nextFires.length, 1, 'next fires still work offline');
  const rendered = renderStatus(cfg([task()]), view, now);
  assert.match(rendered, /UNAVAILABLE/);
});

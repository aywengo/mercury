// The Fleet scheduler client (FB2b, #973; docs/fleet-bots-design.md §4 option A, §7).
//
// A fake Fleet server stands in for the real one: it owns the same two-call surface a bot uses
// (`POST /fleet/runs` with an Idempotency-Key, `GET /fleet/runs?owner=self&limit=&cursor=`), scopes
// bindings by the caller's token, and replays a repeated key with 200 — so the acceptance points
// below are exercised over HTTP, not against a hand-rolled stub of our own client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.ts';
import { loadBotConfig, type BotConfig, type BotTaskConfig } from '../src/host/bots/config.ts';
import { readBotCredentials, type BotTokenPair } from '../src/host/bots/credentials.ts';
import { makeFleetClient, bindingToBotRun, FLEET_UNKNOWN } from '../src/host/bots/fleetClient.ts';
import { makeSchedulerClient } from '../src/host/bots/process.ts';
import { dispatchKey, scheduledWallMinuteId } from '../src/host/bots/keys.ts';
import { tick, type DispatchRequest } from '../src/host/bots/scheduler.ts';

const MIN = 60_000;

function task(over: Partial<BotTaskConfig> = {}): BotTaskConfig {
  return {
    name: 'nightly',
    cron: '* * * * *',
    template: { task: 'maintenance {{fire.date}}' },
    singleFlight: true,
    onMiss: 'skip',
    ...over,
  };
}

function cfg(base: string, tasks: BotTaskConfig[] = [task()], via?: 'host' | 'fleet'): BotConfig {
  return { alias: 'ops', api: { url: base, ...(via ? { via } : {}) }, tasks, warnings: [] };
}

// ---- A fake Fleet -------------------------------------------------------------------------

interface FakeBinding {
  fleetRunId: string;
  ownerId: string;
  hostId: string;
  key: string | null;
  requested: Record<string, unknown>;
  createdAt: string;
  state: { status: string } | null;
}

interface FakeFleet {
  base: string;
  bindings: FakeBinding[];
  /** Every request the bot made, in order — the wire assertion for `via: "fleet"`. */
  requests: { method: string; url: string; idempotencyKey: string | null }[];
  /** Force the next POST /fleet/runs to answer with this status (contract-break cases). */
  forceCreateStatus: number | null;
  close: () => Promise<void>;
}

/** Token -> owner. The fake scopes the list by owner exactly as FB2a's `owner=self` does. */
const TOKENS: Record<string, string> = {
  'fleet-token-ops': 'bot-ops',
  'fleet-token-other': 'someone-else',
};

async function startFakeFleet(): Promise<FakeFleet> {
  const fake: FakeFleet = {
    base: '',
    bindings: [],
    requests: [],
    forceCreateStatus: null,
    close: async () => {},
  };
  let seq = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const ownerId = TOKENS[auth];
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    fake.requests.push({
      method: req.method ?? '', url: url.pathname + url.search,
      idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
    });
    if (url.pathname === '/healthz') {
      send(200, { ok: true });
      return;
    }
    if (ownerId === undefined) {
      send(401, { error: 'unauthenticated' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/fleet/runs') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (fake.forceCreateStatus !== null) {
          send(fake.forceCreateStatus, { error: 'forced' });
          return;
        }
        const parsed = JSON.parse(raw || '{}') as Record<string, unknown>;
        // Same precedence as the real Fleet (fleet/server.ts): a non-empty body `idempotency` wins
        // over the `Idempotency-Key` header. Modelling it here is what lets the regression test
        // below prove a template-level value cannot silently take over the derived key.
        const bodyIdem = typeof parsed.idempotency === 'string' && parsed.idempotency !== '' ? parsed.idempotency : null;
        const key = bodyIdem ?? ((req.headers['idempotency-key'] as string | undefined) ?? null);
        const existing = key === null ? undefined : fake.bindings.find((b) => b.ownerId === ownerId && b.key === key);
        if (existing) {
          // §4: a replayed key answers 200 with the ORIGINAL binding — no second Run.
          send(200, { fleetRunId: existing.fleetRunId, hostId: existing.hostId, reused: true });
          return;
        }
        const binding: FakeBinding = {
          fleetRunId: `fleet-${++seq}`,
          ownerId,
          hostId: 'host-a',
          key,
          requested: parsed,
          // Distinct timestamps keep the keyset order deterministic across the paging test.
          createdAt: new Date(Date.UTC(2026, 5, 10, 0, 0, seq)).toISOString(),
          state: null,
        };
        fake.bindings.push(binding);
        send(201, { fleetRunId: binding.fleetRunId, hostId: binding.hostId, reused: false });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/fleet/runs') {
      const owner = url.searchParams.get('owner');
      if (owner !== null && owner !== 'self') {
        send(400, { error: 'owner must be "self"' });
        return;
      }
      let rows = fake.bindings.filter((b) => owner !== 'self' || b.ownerId === ownerId);
      rows = [...rows].sort((a, b) => (a.createdAt === b.createdAt
        ? (a.fleetRunId < b.fleetRunId ? 1 : -1)
        : (a.createdAt < b.createdAt ? 1 : -1)));
      const cursor = url.searchParams.get('cursor');
      if (cursor) {
        const [at, id] = cursor.split('|');
        rows = rows.filter((b) => b.createdAt < at! || (b.createdAt === at && b.fleetRunId < id!));
      }
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? '50') || 50, 200));
      const page = rows.slice(0, limit);
      const nextCursor = rows.length > limit && page.length > 0
        ? `${page[page.length - 1]!.createdAt}|${page[page.length - 1]!.fleetRunId}`
        : null;
      send(200, {
        runs: page.map((b) => ({
          fleetRunId: b.fleetRunId, hostId: b.hostId, ownerId: b.ownerId,
          requested: b.requested, createdAt: b.createdAt,
          state: b.state === null ? null : { status: b.state.status },
        })),
        nextCursor,
      });
      return;
    }
    send(404, { error: 'no such route' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  fake.base = `http://127.0.0.1:${addr.port}`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}

/**
 * A config home holding bot-credentials.json (0600) for the fleet-via bot.
 *
 * The entry type is `BotTokenPair`, where `api` is OPTIONAL: one test below deliberately writes a
 * Fleet-only entry to prove `readBotCredentials` still refuses it at runtime (the `api` token stays
 * required by the reader, not by the fixture's type).
 */
function configHome(entries: Record<string, BotTokenPair>): { dir: string; cleanup: () => void } {
  const dir = tempDir('bot-fleet-creds-');
  mkdirSync(join(dir, 'mercury'), { recursive: true });
  const path = join(dir, 'mercury', 'bot-credentials.json');
  writeFileSync(path, JSON.stringify(entries));
  chmodSync(path, 0o600);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- Config: `api.via` --------------------------------------------------------------------

const OK_TASKS = {
  schedule: {
    tasks: [{ name: 'nightly', cron: '17 3 * * *', template: { task: 'maintenance' } }],
  },
};

function withBots(configs: Record<string, unknown>, creds?: unknown): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const root = tempDir('bot-fleet-cfg-');
  const botsDir = join(root, 'mercury', 'bots');
  mkdirSync(botsDir, { recursive: true });
  for (const [alias, c] of Object.entries(configs)) {
    writeFileSync(join(botsDir, `${alias}.json`), JSON.stringify(c));
  }
  if (creds !== undefined) {
    const path = join(root, 'mercury', 'bot-credentials.json');
    writeFileSync(path, JSON.stringify(creds));
    chmodSync(path, 0o600);
  }
  return { env: { XDG_CONFIG_HOME: root }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('config: api.via "fleet" without a Fleet token is refused at load, naming the alias (acceptance 5)', () => {
  // No credentials file at all.
  {
    const { env, cleanup } = withBots({ ops: { api: { via: 'fleet' }, ...OK_TASKS } });
    try {
      assert.throws(
        () => loadBotConfig('ops', env),
        /api\.via: via 'fleet' needs a Fleet token for alias 'ops'.*cannot read bot config?.*|api\.via: via 'fleet' needs a Fleet token for alias 'ops'/,
      );
    } finally {
      cleanup();
    }
  }
  // Credentials present for the alias, but only the host token: the fleet key is named.
  {
    const { env, cleanup } = withBots({ ops: { api: { via: 'fleet' }, ...OK_TASKS } }, { ops: { api: 'tok-host-ops' } });
    try {
      assert.throws(
        () => loadBotConfig('ops', env),
        /api\.via: via 'fleet' requires a 'fleet' token for alias 'ops' in bot-credentials\.json/,
      );
    } finally {
      cleanup();
    }
  }
});

test('config: api.via "fleet" loads with a Fleet token; unknown values and non-strings are refused', () => {
  {
    const { env, cleanup } = withBots(
      { ops: { api: { url: 'http://127.0.0.1:1', via: 'fleet' }, ...OK_TASKS } },
      { ops: { api: 'tok-host-ops', fleet: 'fleet-token-ops' } },
    );
    try {
      const cfg = loadBotConfig('ops', env);
      assert.equal(cfg.api.via, 'fleet');
      assert.equal(cfg.api.url, 'http://127.0.0.1:1');
    } finally {
      cleanup();
    }
  }
  for (const bad of ['Fleet', 'direct', '', 1, null] as const) {
    const { env, cleanup } = withBots({ ops: { api: { via: bad }, ...OK_TASKS } });
    try {
      assert.throws(() => loadBotConfig('ops', env), /api\.via: must be one of host, fleet/);
    } finally {
      cleanup();
    }
  }
});

test('config: no `via`, or `via: "host"`, reads no credentials file and reports no via (acceptance 4)', () => {
  // No bot-credentials.json exists at all in this config home: loading must not need it.
  {
    const { env, cleanup } = withBots({ ops: OK_TASKS });
    try {
      const cfg = loadBotConfig('ops', env);
      assert.equal(cfg.api.via, undefined, 'absent via stays absent, so existing configs are unchanged');
    } finally {
      cleanup();
    }
  }
  {
    const { env, cleanup } = withBots({ ops: { api: { via: 'host' }, ...OK_TASKS } });
    try {
      assert.equal(loadBotConfig('ops', env).api.via, 'host');
    } finally {
      cleanup();
    }
  }
});

test('credentials: the entry accepts a `fleet` token beside `api`, and still requires `api`', () => {
  {
    const { dir, cleanup } = configHome({ ops: { api: 'tok-host-ops', fleet: 'fleet-token-ops' } });
    try {
      const pair = readBotCredentials('ops', { XDG_CONFIG_HOME: dir });
      assert.equal(pair.api, 'tok-host-ops');
      assert.equal(pair.fleet, 'fleet-token-ops');
    } finally {
      cleanup();
    }
  }
  {
    const { dir, cleanup } = configHome({ ops: { fleet: 'fleet-token-ops' } });
    try {
      assert.throws(() => readBotCredentials('ops', { XDG_CONFIG_HOME: dir }), /entry 'ops\.api' is required/);
    } finally {
      cleanup();
    }
  }
});

// ---- The client over HTTP ------------------------------------------------------------------

test('a fire through Fleet creates exactly one Run; a crash-retry with the same key replays it (acceptance 1)', async () => {
  const fleet = await startFakeFleet();
  const home = configHome({ ops: { api: 'tok-host-ops', fleet: 'fleet-token-ops' } });
  try {
    const client = makeFleetClient(cfg(fleet.base, [task()], 'fleet'), { XDG_CONFIG_HOME: home.dir });
    await client.probeHealth();
    const fire = Date.UTC(2026, 5, 10, 3, 15, 0);
    const key = dispatchKey('ops', 'nightly', fire, 'UTC');
    const req: DispatchRequest = {
      taskName: 'nightly', fireMs: fire, wallMinute: scheduledWallMinuteId(fire, 'UTC'), key,
      body: { task: 'maintenance', constraints: { botTask: 'nightly', maxDurationMs: 3_600_000, maxRetries: 0 } },
    };
    const first = await client.createRun(req);
    assert.equal(first.replayed, false);
    assert.equal(fleet.bindings.length, 1, 'exactly one Fleet Run');
    // The key travelled as Fleet's Idempotency-Key, which is what makes the retry safe.
    assert.equal(fleet.requests.filter((r) => r.method === 'POST').at(-1)!.idempotencyKey, key);
    const retry = await client.createRun(req);
    assert.equal(retry.runId, first.runId, 'the replay returns the ORIGINAL Fleet Run');
    assert.equal(retry.replayed, true);
    assert.equal(fleet.bindings.length, 1, 'the retry created no second Run');
    // The bot's own payload is what Fleet stores, so single-flight still sees its task name.
    assert.equal(fleet.bindings[0]!.requested.constraints !== undefined, true);
  } finally {
    home.cleanup();
    await fleet.close();
  }
});

test('a template-level `idempotency` cannot take over the derived fire key (review r4331407356)', async () => {
  const fleet = await startFakeFleet();
  const home = configHome({ ops: { api: 'tok-host-ops', fleet: 'fleet-token-ops' } });
  try {
    const client = makeFleetClient(cfg(fleet.base, [task()], 'fleet'), { XDG_CONFIG_HOME: home.dir });
    const fireA = Date.UTC(2026, 5, 10, 3, 15, 0);
    const fireB = fireA + MIN;
    // A task template may carry `idempotency` (it is inert on the host path: src/api/routes.ts reads
    // the header only). Fleet prefers a non-empty body field, so an unstripped body would make the
    // second fire replay the first binding instead of creating a Run — a bot that silently stops
    // dispatching after its first fire.
    const mk = (fire: number): DispatchRequest => ({
      taskName: 'nightly', fireMs: fire, wallMinute: scheduledWallMinuteId(fire, 'UTC'),
      key: dispatchKey('ops', 'nightly', fire, 'UTC'),
      body: { task: 'maintenance', idempotency: 'nightly', constraints: { botTask: 'nightly' } },
    });
    const a = await client.createRun(mk(fireA));
    const b = await client.createRun(mk(fireB));
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, false, 'the second fire is a NEW Run, not a replay of the first');
    assert.notEqual(b.runId, a.runId);
    assert.equal(fleet.bindings.length, 2, 'two distinct fire keys -> two Fleet Runs');
    // The key Fleet bound is the derived one, never the template's static value.
    assert.deepEqual(
      fleet.bindings.map((x) => x.key),
      [mk(fireA).key, mk(fireB).key],
      'the Idempotency-Key header stays authoritative',
    );
    assert.equal(fleet.bindings[0]!.requested.idempotency, undefined, 'the template field never reaches Fleet');
  } finally {
    home.cleanup();
    await fleet.close();
  }
});

test('tick through the Fleet client: one fire -> one Fleet Run, and the list is owner=self (acceptance 1, 3)', async () => {
  const fleet = await startFakeFleet();
  const home = configHome({ ops: { api: 'tok-host-ops', fleet: 'fleet-token-ops' } });
  try {
    // Another caller's non-terminal Run on the SAME host: it must not block this bot.
    fleet.bindings.push({
      fleetRunId: 'fleet-other', ownerId: 'someone-else', hostId: 'host-a', key: null,
      requested: { task: 'x', constraints: { botTask: 'nightly' } },
      createdAt: new Date(Date.UTC(2026, 5, 10, 0, 0, 0)).toISOString(),
      state: { status: 'RUNNING' },
    });
    const client = makeFleetClient(cfg(fleet.base, [task({ singleFlight: true })], 'fleet'), { XDG_CONFIG_HOME: home.dir });
    const now = Date.UTC(2026, 5, 10, 3, 15, 30);
    const out = await tick(cfg(fleet.base, [task({ singleFlight: true })], 'fleet'), client, { nowMs: now, afterMs: now - MIN });
    assert.equal(out.dispatched.length, 1, "another caller's Run must not block this bot (owner scoping)");
    assert.equal(out.skippedSingleFlight.length, 0);
    const mine = fleet.bindings.filter((b) => b.ownerId === 'bot-ops');
    assert.equal(mine.length, 1, 'exactly one Fleet Run for this fire');
    assert.equal(mine[0]!.key, 'bot-ops:nightly:w2026-06-10T03:15');
    assert.equal(mine[0]!.requested.constraints && (mine[0]!.requested.constraints as Record<string, unknown>).botTask, 'nightly');
    // The list call asked Fleet for the bot's OWN Runs, never for everything on the host.
    assert.ok(fleet.requests.some((r) => r.method === 'GET' && r.url.startsWith('/fleet/runs?owner=self')));
  } finally {
    home.cleanup();
    await fleet.close();
  }
});

test('an UNKNOWN Fleet Run blocks the next fire (acceptance 2)', async () => {
  const fleet = await startFakeFleet();
  const home = configHome({ ops: { api: 'tok-host-ops', fleet: 'fleet-token-ops' } });
  try {
    // A binding Fleet has not confirmed on the host: state is null, which is Fleet's UNKNOWN.
    fleet.bindings.push({
      fleetRunId: 'fleet-unknown', ownerId: 'bot-ops', hostId: 'host-a', key: 'k',
      requested: { task: 'x', constraints: { botTask: 'nightly' } },
      createdAt: new Date(Date.UTC(2026, 5, 10, 0, 0, 0)).toISOString(),
      state: null,
    });
    const client = makeFleetClient(cfg(fleet.base, [task()], 'fleet'), { XDG_CONFIG_HOME: home.dir });
    const now = Date.UTC(2026, 5, 10, 3, 15, 30);
    const out = await tick(cfg(fleet.base, [task()], 'fleet'), client, { nowMs: now, afterMs: now - MIN });
    assert.equal(out.dispatched.length, 0, 'UNKNOWN must block single-flight');
    assert.equal(out.skippedSingleFlight.length, 1);
    assert.equal(fleet.bindings.filter((b) => b.ownerId === 'bot-ops').length, 1, 'no second Run was created');
  } finally {
    home.cleanup();
    await fleet.close();
  }
});

test('the list walk follows Fleet nextCursor pages, so an old parked Run still blocks', async () => {
  const fleet = await startFakeFleet();
  const home = configHome({ ops: { api: 'tok-host-ops', fleet: 'fleet-token-ops' } });
  try {
    // Two of the bot's bindings; only the older one is non-terminal. One page of limit 1 cannot
    // see it, so the walk must follow nextCursor.
    fleet.bindings.push(
      {
        fleetRunId: 'fleet-old', ownerId: 'bot-ops', hostId: 'host-a', key: 'k1',
        requested: { task: 'x', constraints: { botTask: 'nightly' } },
        createdAt: new Date(Date.UTC(2026, 5, 10, 0, 0, 1)).toISOString(),
        state: { status: 'NEEDS_INPUT' },
      },
      {
        fleetRunId: 'fleet-new', ownerId: 'bot-ops', hostId: 'host-a', key: 'k2',
        requested: { task: 'y', constraints: { botTask: 'nightly' } },
        createdAt: new Date(Date.UTC(2026, 5, 10, 0, 0, 2)).toISOString(),
        state: { status: 'COMPLETED' },
      },
    );
    const client = makeFleetClient(cfg(fleet.base, [task()], 'fleet'), { XDG_CONFIG_HOME: home.dir });
    const first = await client.listOwnRuns(1);
    assert.equal(first.runs.length, 1);
    assert.equal(first.runs[0]!.id, 'fleet-new');
    assert.ok(first.nextCursor, 'a second page exists');
    const second = await client.listOwnRuns(1, first.nextCursor);
    assert.equal(second.runs[0]!.id, 'fleet-old');
    assert.equal(second.runs[0]!.status, 'NEEDS_INPUT');
    assert.equal(second.nextCursor, null);
    const now = Date.UTC(2026, 5, 10, 3, 15, 30);
    const out = await tick(cfg(fleet.base, [task()], 'fleet'), client, { nowMs: now, afterMs: now - MIN });
    assert.equal(out.dispatched.length, 0, 'the page-2 parked Run blocks the fire');
    assert.equal(out.skippedSingleFlight.length, 1);
  } finally {
    home.cleanup();
    await fleet.close();
  }
});

test('bindingToBotRun: missing state maps to UNKNOWN (non-terminal), missing constraints to no task', () => {
  const view = bindingToBotRun({ fleetRunId: 'f1', state: null, requested: { task: 'x' } });
  assert.equal(view.id, 'f1');
  assert.equal(view.status, FLEET_UNKNOWN);
  assert.equal(view.constraints, undefined);
  const withTask = bindingToBotRun({ fleetRunId: 'f2', state: { status: 'RUNNING' }, requested: { constraints: { botTask: 'nightly' } } });
  assert.equal(withTask.status, 'RUNNING');
  assert.deepEqual(withTask.constraints, { botTask: 'nightly' });
  // A status Fleet reports but the bot's deny-list does not know is non-terminal by construction.
  assert.equal(bindingToBotRun({ fleetRunId: 'f3', state: { status: 'PAUSED_LATER' } }).status, 'PAUSED_LATER');
});

test('a POST that answers outside 201/200 is refused, not read as a dispatch', async () => {
  const fleet = await startFakeFleet();
  const home = configHome({ ops: { api: 'tok-host-ops', fleet: 'fleet-token-ops' } });
  try {
    const client = makeFleetClient(cfg(fleet.base, [task()], 'fleet'), { XDG_CONFIG_HOME: home.dir });
    fleet.forceCreateStatus = 202;
    await assert.rejects(
      () => client.createRun({ taskName: 'nightly', fireMs: 0, wallMinute: 'w', key: 'k', body: { task: 'x' } }),
      /POST \/fleet\/runs answered 202/,
    );
  } finally {
    home.cleanup();
    await fleet.close();
  }
});

test('makeSchedulerClient picks Fleet for api.via "fleet" and the host client otherwise', async () => {
  const fleet = await startFakeFleet();
  const home = configHome({ ops: { api: 'tok-host-ops', fleet: 'fleet-token-ops' } });
  try {
    const env = { XDG_CONFIG_HOME: home.dir };
    const viaFleet = makeSchedulerClient(cfg(fleet.base, [task()], 'fleet'), env);
    await viaFleet.createRun({ taskName: 'nightly', fireMs: 0, wallMinute: 'w', key: 'k', body: { task: 'x' } });
    assert.ok(fleet.requests.some((r) => r.method === 'POST' && r.url === '/fleet/runs'), 'a fleet bot dispatches through Fleet');
    // Without `via`, the client is the host one: it posts to the HOST route, not Fleet's. The fake
    // serves no /api/runs (and does not know the host token), so the call fails — the assertion is
    // on which URL was called, which is what `via` decides.
    const viaHost = makeSchedulerClient(cfg(fleet.base, [task()]), env);
    await assert.rejects(
      () => viaHost.createRun({ taskName: 'nightly', fireMs: 0, wallMinute: 'w', key: 'k2', body: { task: 'x' } }),
      /POST \/api\/runs answered 40[14]/,
    );
    assert.ok(fleet.requests.some((r) => r.method === 'POST' && r.url === '/api/runs'), 'a host bot never calls Fleet');
  } finally {
    home.cleanup();
    await fleet.close();
  }
});

test('a fleet config with no Fleet token cannot build a client (hand-built config guard)', () => {
  const home = configHome({ ops: { api: 'tok-host-ops' } });
  try {
    assert.throws(
      () => makeFleetClient(cfg('http://127.0.0.1:1', [task()], 'fleet'), { XDG_CONFIG_HOME: home.dir }),
      /bot 'ops': api\.via 'fleet' needs a 'fleet' token/,
    );
  } finally {
    home.cleanup();
  }
});

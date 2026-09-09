/**
 * Fleet <-> Mercury contract, across a real process boundary.
 *
 * Fleet has ~190 tests. All of them either build a server in-process with `createFleetServer(...)` or,
 * in the one case that crosses a process boundary (`fleet/test/journey.test.ts`), point the real
 * `fleet serve` at a hand-written fake Mercury whose body is a literal written by the same author as the
 * probe that reads it:
 *
 *     { workers: [{ workerId: 'w1', activeRuns: 0 }], queueDepth: 0 }
 *
 * That literal is the whole problem. It pins Fleet to a *description* of Mercury that nothing else
 * reads. The real host answers `{ workers: ActiveLease[], queueDepth }` where
 * `ActiveLease = { workerId, activeRuns, oldestLeaseExpiresAt }`, returns 503 when no queue is wired,
 * and adds a `defaultAgent` field to `/api/agents`. Rename `activeRuns` on the host, or drop
 * `oldestLeaseExpiresAt`, and both suites stay green while Fleet breaks in production -- the classic
 * integration failure, invisible because each side only ever tests itself.
 *
 * So this file puts a REAL Mercury on the wire. `makeEnv()` builds a real SQLite database, RunStore and
 * RunQueue, and `createApp()` builds the real Express router, so `/healthz/workers` is answered by
 * `activeLeases()` and its SQL. `fleet serve` runs as a real child process. Only the process is shared;
 * the wire between them is entirely real, and that wire is what is under test.
 *
 * It lives in `test/`, not `fleet/test/`, on purpose. `fleet/test/coupling.test.ts` forbids any file
 * under `fleet/` from importing outside `fleet/`, and this file must import the host's real code to be
 * worth anything. The coupling rule is the point: Fleet must not depend on Mercury, so the test that
 * proves the two interoperate belongs on the Mercury side and reaches Fleet only by spawning it and
 * speaking HTTP. Nothing here imports anything under `fleet/`.
 *
 * No Docker. `e2e/` owns container topology and is deliberately outside CI; this needs no container and
 * therefore runs in CI under `npm test`, which is the whole reason to prefer a process boundary here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, closeServer } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { makeEnv, tempDir } from './helpers.ts';

const FLEET_DIR = join(import.meta.dirname, '..', 'fleet');
const HOST_TOKEN = 'contract-host-token-6f1a2b';
const ADMIN_TOKEN = 'contract-admin-token-9c3d4e';
const CALLER_TOKEN = 'contract-caller-token-1a5b';

/** A real Mercury API on loopback, backed by a real queue. */
async function realMercury(opts: { queue?: boolean } = {}) {
  const env = makeEnv({ workerEnabled: false });
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    apiTokens: new Map([[HOST_TOKEN, 'alice']]),
    adminToken: null,
    // Passing `queue` is what makes /healthz/workers answer with real leases. Omitting it reproduces the
    // 503 "queue not configured" path, which is a separate test below.
    ...(opts.queue === false ? {} : { queue: env.queue }),
  } as Parameters<typeof createApp>[0]);

  // Bind loopback EXPLICITLY. app.listen(0) with no host binds the wildcard, and on macOS/BSD a wildcard
  // bind can coexist with another process already holding 127.0.0.1 on that port, so a request meant for
  // this app is answered by an unrelated server (issue #185). An explicit host makes it EADDRINUSE.
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    env,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await closeServer(server);
      stream.stop();
      env.close();
    },
  };
}

/** A real `fleet serve` child, pointed at `mercuryUrl`, with a real 0600 credential file. */
async function realFleet(mercuryUrl: string, dir: string) {
  const credFile = join(dir, 'credentials.json');
  writeFileSync(credFile, JSON.stringify({ 'contract-host': HOST_TOKEN }));
  chmodSync(credFile, 0o600);

  const port = 21_000 + (process.pid % 20_000);
  const base = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const child = spawn(process.execPath, [join(FLEET_DIR, 'cli.ts'), 'serve'], {
    cwd: FLEET_DIR,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FLEET_BIND_HOST: '127.0.0.1',
      FLEET_PORT: String(port),
      FLEET_DB: join(dir, 'fleet.db'),
      FLEET_CREDENTIALS_FILE: credFile,
      FLEET_ADMIN_TOKEN: ADMIN_TOKEN,
      FLEET_API_TOKENS: `${CALLER_TOKEN}:alice:*`,
      // No background sweeping: every probe below is explicit, so capacity cannot change underneath an
      // assertion because a timer fired.
      FLEET_PROBE_INTERVAL_MS: '3600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (c: string) => logs.push(c));
  child.stderr!.on('data', (c: string) => logs.push(c));

  const started = Date.now();
  let last = 'no response';
  while (Date.now() - started < 30_000) {
    if (child.exitCode !== null) throw new Error(`fleet serve exited early (${child.exitCode}):\n${logs.join('')}`);
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5_000) });
      if (r.status === 200) break;
      last = String(r.status);
    } catch (e) { last = String(e); }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (last !== 'no response' && child.exitCode !== null) throw new Error(`fleet serve died: ${logs.join('')}`);

  const req = async (path: string, token: string | null, init?: RequestInit) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) as Record<string, never> };
  };

  return {
    base, req, logs,
    async registerHost(id = 'lab-1') {
      return req('/fleet/hosts', ADMIN_TOKEN, {
        method: 'POST', body: JSON.stringify({ id, baseUrl: mercuryUrl, credentialRef: 'contract-host' }),
      });
    },
    async probe(id = 'lab-1') { return req(`/fleet/hosts/${id}/probe`, ADMIN_TOKEN, { method: 'POST' }); },
    async hosts() { return req('/fleet/hosts', CALLER_TOKEN); },
    async close() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((done) => {
          const t = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5_000);
          child.on('exit', () => { clearTimeout(t); done(); });
        });
      }
    },
  };
}

async function withStack(
  run: (m: Awaited<ReturnType<typeof realMercury>>, f: Awaited<ReturnType<typeof realFleet>>) => Promise<void>,
  opts: { queue?: boolean } = {},
) {
  const dir = tempDir('fleet-contract');
  const mercury = await realMercury(opts);
  let fleet: Awaited<ReturnType<typeof realFleet>> | null = null;
  try {
    fleet = await realFleet(mercury.url, dir);
    await run(mercury, fleet);
  } finally {
    if (fleet) await fleet.close();
    await mercury.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Claim a queued Run and move it into active work, the way a real worker does.
 *
 * `claim()` alone is NOT enough to create capacity. It sets lease_owner and lease_expires_at but leaves
 * the status QUEUED, and `activeLeases()` deliberately excludes QUEUED: a queued Run holding a lease is
 * the claim-to-STARTING window, where a worker may have died, so it is not evidence of a live worker
 * (see LEASE_HOLDING_STATUSES / ACTIVE_WORK_STATUSES in src/domain/stateMachine.ts, and issue #141).
 * A test that only claimed would assert activeRuns === 0 and believe it had tested capacity.
 */
function claimAndStart(env: Awaited<ReturnType<typeof realMercury>>['env'], workerId: string) {
  const run = env.queue.claim(workerId, 60_000);
  if (!run) throw new Error('claim() returned null: nothing was queued');
  return env.runs.transition(run.id, 'STARTING');
}

async function probeRecord(f: Awaited<ReturnType<typeof realFleet>>) {
  const added = await f.registerHost();
  assert.equal(added.status, 201, `register failed: ${added.status} ${added.text.slice(0, 240)}`);
  const probed = await f.probe();
  assert.equal(probed.status, 200, `probe failed: ${probed.status} ${probed.text.slice(0, 240)}`);
  const listed = await f.hosts();
  const hosts = (listed.json() as unknown as { hosts: Array<{ probe: Record<string, unknown> | null }> }).hosts;
  assert.equal(hosts.length, 1);
  assert.ok(hosts[0].probe, `no probe record stored: ${listed.text.slice(0, 400)}`);
  return hosts[0].probe!;
}

test('Fleet reports capacity that came from the real host, not from a stub', async () => {
  // The fake in fleet/test/journey.test.ts hardcodes `activeRuns: 0`. So every existing test that
  // asserts capacity has only ever proven that Fleet can copy a zero. This puts real numbers on the
  // wire: two queued Runs, one claimed by a real worker with a real lease, so the host's own SQL
  // (activeLeases -> COUNT(*) GROUP BY lease_owner) produces activeRuns=1 and queuedCount()=1.
  await withStack(async (m, f) => {
    m.env.runService.create({ ownerId: 'alice', task: 'first', agent: 'fake' });
    m.env.runService.create({ ownerId: 'alice', task: 'second', agent: 'fake' });
    claimAndStart(m.env, 'worker-1');

    // Ground truth straight from the host, before Fleet is involved at all.
    const truth = await (await fetch(`${m.url}/healthz/workers`)).json() as {
      workers: Array<{ workerId: string; activeRuns: number }>; queueDepth: number;
    };
    assert.equal(truth.workers.length, 1, `expected one lease owner, got ${JSON.stringify(truth.workers)}`);
    assert.equal(truth.workers[0]!.workerId, 'worker-1');
    assert.equal(truth.workers[0]!.activeRuns, 1);
    assert.equal(truth.queueDepth, 1);

    const probe = await probeRecord(f);
    // Fleet must report the host's numbers, not a copy of a literal.
    assert.equal(probe.outcome, 'ok', `outcome ${probe.outcome} (${probe.detail})`);
    assert.equal(probe.activeRuns, truth.workers.reduce((n, w) => n + w.activeRuns, 0),
      `Fleet summed activeRuns wrong: ${JSON.stringify(probe)}`);
    assert.equal(probe.queueDepth, truth.queueDepth, `Fleet read queueDepth wrong: ${JSON.stringify(probe)}`);
    assert.equal(probe.workerCount, truth.workers.length);
    assert.equal(probe.workerId, 'worker-1');
  });
});

test('capacity moves when the real host changes, without Fleet being restarted', async () => {
  // A stub cannot change underneath a test. A real host can, and this is the property that matters
  // operationally: Fleet's cached view must track reality across a probe, not freeze at first sight.
  await withStack(async (m, f) => {
    m.env.runService.create({ ownerId: 'alice', task: 'only', agent: 'fake' });
    const run = claimAndStart(m.env, 'worker-1');
    const first = await probeRecord(f);
    assert.equal(first.activeRuns, 1, `first probe: ${JSON.stringify(first)}`);

    // Finish the Run the way a real worker does: STARTING -> RUNNING -> COMPLETED.
    //
    // NOT releaseLease(). That method starts with `if (!row || !isTerminal(row.status)) return;` -- it
    // only clears a lease once the Run is terminal, and returns void, so calling it on an active Run is
    // a silent no-op. A first draft of this test did exactly that, saw activeRuns stay at 1, and looked
    // like a Fleet staleness bug. Fleet was correct; the test had changed nothing.
    m.env.runs.transition(run.id, 'RUNNING');
    m.env.runs.transition(run.id, 'COMPLETED');
    const again = await f.probe();
    assert.equal(again.status, 200, again.text.slice(0, 200));
    const second = ((await f.hosts()).json() as unknown as { hosts: Array<{ probe: Record<string, unknown> }> }).hosts[0]!.probe!;
    assert.equal(second.activeRuns, 0, `Fleet kept stale capacity after the lease was released: ${JSON.stringify(second)}`);
  });
});

test('a real Mercury with no queue is not_serving, not unreachable', async () => {
  // The 503 that means "reachable, but this Mercury cannot execute anything" is a real response from
  // src/api/server.ts when deps.queue is absent. The fake never produced it, so the distinction was
  // only ever tested against a status code Fleet's author invented.
  await withStack(async (m, f) => {
    const raw = await fetch(`${m.url}/healthz/workers`);
    assert.equal(raw.status, 503, 'the host must really answer 503 for this test to mean anything');

    const probe = await probeRecord(f);
    assert.equal(probe.outcome, 'not_serving',
      `a queue-less Mercury must read as not_serving, got ${probe.outcome} (${probe.detail})`);
    assert.notEqual(probe.outcome, 'unreachable', 'a live HTTP server is not a network failure');
  }, { queue: false });
});

test('the agents Fleet reports are the real host agent list', async () => {
  // The fake returned a hardcoded ['prime-agent']. The real host answers { agents, defaultAgent } from
  // runService.listAgents(), so this asserts Fleet reads the list rather than a shape it memorised --
  // and that the extra `defaultAgent` field the fake never sent does not upset it.
  await withStack(async (m, f) => {
    const raw = await (await fetch(`${m.url}/api/agents`, {
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    })).json() as { agents: string[]; defaultAgent: string };
    assert.ok(Array.isArray(raw.agents) && raw.agents.length > 0, `host returned no agents: ${JSON.stringify(raw)}`);
    assert.ok('defaultAgent' in raw, 'the host sends defaultAgent; the fake never did');

    const probe = await probeRecord(f);
    assert.equal(probe.outcome, 'ok', `outcome ${probe.outcome} (${probe.detail})`);
    assert.deepEqual(probe.agents, raw.agents, 'Fleet did not report the host agent list verbatim');
  });
});

test('the wire contract: the keys Fleet parses are the keys the host sends', async () => {
  // Behavioural tests can agree by accident. This one compares shapes directly, so a rename on EITHER
  // side fails here with a message naming both sides -- which is the failure mode the fake could never
  // produce, because the fake was written to match the probe rather than the host.
  await withStack(async (m) => {
    const health = await (await fetch(`${m.url}/healthz`)).json() as Record<string, unknown>;
    const workers = await (await fetch(`${m.url}/healthz/workers`)).json() as Record<string, unknown>;
    const agents = await (await fetch(`${m.url}/api/agents`, {
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    })).json() as Record<string, unknown>;

    // What Fleet's probe actually reads out of each response (fleet/probe.ts).
    assert.deepEqual(Object.keys(health).sort(), ['ok', 'product', 'ts', 'version'].sort(),
      '/healthz shape changed; fleet/probe.ts reads ok/product/version');
    assert.deepEqual(Object.keys(workers).sort(), ['queueDepth', 'workers'].sort(),
      '/healthz/workers shape changed; fleet/probe.ts reads workers and queueDepth');
    // A lease MUST exist here. Without one, `workers` is [] and the key-set assertion below is
    // vacuously true -- it would pass against a host that renamed every field. The first draft of this
    // test had exactly that hole: dropping oldestLeaseExpiresAt from ActiveLease passed cleanly.
    m.env.runService.create({ ownerId: 'alice', task: 'shape', agent: 'fake' });
    claimAndStart(m.env, 'worker-shape');
    const leases = (await (await fetch(`${m.url}/healthz/workers`)).json() as { workers: Array<Record<string, unknown>> }).workers;
    assert.equal(leases.length, 1, `this test needs a live lease to assert its shape, got ${leases.length}`);
    assert.deepEqual(Object.keys(leases[0]!).sort(), ['activeRuns', 'oldestLeaseExpiresAt', 'workerId'].sort(),
      'ActiveLease shape changed; fleet/probe.ts reads workerId and activeRuns, and the drift guard reads all three');
    assert.deepEqual(Object.keys(agents).sort(), ['agents', 'defaultAgent'].sort(),
      '/api/agents shape changed; fleet/probe.ts reads agents');
    assert.equal(typeof workers.queueDepth, 'number', 'queueDepth must stay a number; Fleet sums it');
    assert.equal(typeof health.ok, 'boolean', 'healthz.ok must stay a boolean; Fleet identifies Mercury by it');
  });
});

test('this test reaches Fleet only over a socket, never by import', async () => {
  // The coupling rule says nothing under fleet/ may import outside fleet/. That rule is what keeps Fleet
  // a separate product, and it also means the interoperability proof cannot live in fleet/test/. This
  // assertion keeps the arrangement honest from the other side: if someone later imports Fleet source
  // here to "simplify" the harness, the test stops proving processes agree and starts proving modules
  // agree, which is a much weaker claim that in-process tests already make.
  const src = await import('node:fs').then((fs) => fs.readFileSync(import.meta.dirname + '/fleetContract.test.ts', 'utf8'));
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  const fleetImports = imports.filter((s) => s.includes('/fleet/') || s.startsWith('../fleet'));
  assert.deepEqual(fleetImports, [], `this file must reach Fleet by process + HTTP only, but imports: ${fleetImports.join(', ')}`);
});

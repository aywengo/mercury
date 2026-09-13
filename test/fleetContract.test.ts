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
import { realMercury } from './realMercury.ts';
import { tempDir } from './helpers.ts';

const FLEET_DIR = join(import.meta.dirname, '..', 'fleet');
const HOST_TOKEN = 'contract-host-token-6f1a2b';
const ADMIN_TOKEN = 'contract-admin-token-9c3d4e';
const CALLER_TOKEN = 'contract-caller-token-1a5b';

/** Distinct loopback ports per logical Fleet, so two can run in one test. */
const ID_OFFSETS: Record<string, number> = { a: 0, b: 7 };

/** A real `fleet serve` child, pointed at `mercuryUrl`, with a real 0600 credential file. */
async function realFleet(mercuryUrl: string, dir: string, id = 'a') {
  const credFile = join(dir, `credentials-${id}.json`);
  writeFileSync(credFile, JSON.stringify({ 'contract-host': HOST_TOKEN }));
  chmodSync(credFile, 0o600);

  // Each Fleet needs its own port AND its own database. Deriving the port from process.pid alone gives
  // every Fleet in a test the same port, and reusing `dir` for the SQLite path makes two "separate"
  // Fleets share one registry -- which made a second Fleet answer 400 "duplicate id" for a host the
  // first one had already registered, instead of being the independent instance the test needs.
  const port = 21_000 + (process.pid % 20_000) + ID_OFFSETS[id]!;
  const base = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const child = spawn(process.execPath, [join(FLEET_DIR, 'cli.ts'), 'serve'], {
    cwd: FLEET_DIR,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FLEET_BIND_HOST: '127.0.0.1',
      FLEET_PORT: String(port),
      FLEET_DB: join(dir, `fleet-${id}.db`),
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

  // Everything from spawn() to the returned close() must kill the child on the way out. If startup
  // throws and the caller never receives an object, nobody can close it: the child survives holding
  // FLEET_PORT, and the next test in the file gets EADDRINUSE or, worse, talks to the orphan. A leak
  // that only happens when something already failed is the kind a green suite never shows you.
  //
  // Both throw paths below call the same kill(). The early-exit path is exercised for real: removing
  // FLEET_ADMIN_TOKEN makes `fleet serve` die on a config error, and the suite then fails with the
  // child's own log and leaves no `fleet/cli.ts` process behind. The 30s timeout path shares this
  // helper but is NOT exercised by a test -- forcing it needs a child that stays alive yet never serves
  // 200, and Fleet refuses to bind any address but exactly 127.0.0.1 without TLS (assertServeable in
  // fleet/config.ts), so there is no deterministic way to get one.
  const kill = () => new Promise<void>((done) => {
    if (child.exitCode !== null) return done();
    const t = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5_000);
    child.on('exit', () => { clearTimeout(t); done(); });
    child.kill('SIGTERM');
  });
  const started = Date.now();
  let last = 'no response';
  let ready = false;
  while (Date.now() - started < 30_000) {
    if (child.exitCode !== null) { await kill(); throw new Error(`fleet serve exited early (${child.exitCode}):\n${logs.join('')}`); }
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5_000) });
      if (r.status === 200) { ready = true; break; }
      last = String(r.status);
    } catch (e) { last = String(e); }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) {
    await kill();
    throw new Error(`fleet serve never became healthy within 30s; last: ${last}\n${logs.join('')}`);
  }

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
    close: kill,
  };
}

async function withStack(
  run: (m: Awaited<ReturnType<typeof realMercury>>, f: Awaited<ReturnType<typeof realFleet>>) => Promise<void>,
  opts: { queue?: boolean } = {},
) {
  // Every resource is acquired INSIDE the try. Acquiring before it means a throw between acquisition
  // and the try leaves the resource unreachable by the finally -- the shape that orphaned a temp dir
  // and, with realFleet, a live child holding a port.
  let dir: string | null = null;
  let mercury: Awaited<ReturnType<typeof realMercury>> | null = null;
  let fleet: Awaited<ReturnType<typeof realFleet>> | null = null;
  try {
    dir = tempDir('fleet-contract');
    mercury = await realMercury({ ...opts, token: HOST_TOKEN });
    fleet = await realFleet(mercury.url, dir);
    await run(mercury, fleet);
  } finally {
    if (fleet) await fleet.close();
    if (mercury) await mercury.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
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
  //
  // This covers the three endpoints Fleet's PROBE reads. The other seven, which fleet/child.ts calls,
  // are covered by test/apiSchemaVersion.test.ts against test/fixtures/api-shapes.json; together the
  // two are the whole allowlist, and that test also decides whether a drift needs an
  // API_SCHEMA_VERSION bump.
  await withStack(async (m) => {
    const health = await (await fetch(`${m.url}/healthz`)).json() as Record<string, unknown>;
    const workers = await (await fetch(`${m.url}/healthz/workers`)).json() as Record<string, unknown>;
    const agents = await (await fetch(`${m.url}/api/agents`, {
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    })).json() as Record<string, unknown>;

    // What Fleet's probe actually reads out of each response (fleet/probe.ts).
    assert.deepEqual(Object.keys(health).sort(), ['api', 'ok', 'product', 'ts', 'version'].sort(),
      '/healthz shape changed; fleet/probe.ts reads ok/product/version/api');
    // The one field whose entire purpose is to be compared, so its TYPE is the contract: Fleet
    // decides whether it can read this host with `api < MIN_HOST_API`, and a semver STRING there
    // would make that comparison depend on operand order.
    assert.equal(typeof health.api, 'number',
      'healthz.api must stay a number; Fleet rejects a host with `api < MIN_HOST_API`');
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
    assert.deepEqual(Object.keys(agents).sort(), ['agents', 'capabilities', 'defaultAgent'].sort(),
      '/api/agents shape changed; fleet/probe.ts reads agents');
    // `capabilities` was added for goal support (docs/goals.md 13.6) and is ADDITIVE: Fleet
    // reads only `agents`, and `agents` deliberately stayed string[] rather than becoming an
    // array of capability objects. Assert that here, because the key-set check above would
    // still pass if someone reshaped `agents` and dropped `defaultAgent` -- and a reshaped
    // `agents` is the change that would silently break the dashboard's loadAgents().
    assert.ok(Array.isArray(agents.agents), 'agents must stay an array; Fleet and the UI both index it');
    assert.ok((agents.agents as unknown[]).every((a) => typeof a === 'string'),
      'agents must stay an array of STRINGS; the dashboard bails to hardcoded options otherwise');
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
  // Strip comments first: this file's own prose mentions "fleet/", and matching prose would report a
  // violation that is not an import. Same reason testHygiene.test.ts carries a codeOnly() helper.
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .map((l) => {
      const i = l.search(/\s\/\//);
      if (i < 0) return l;
      const before = l.slice(0, i);
      return (before.match(/(?<!\\)['"`]/g) ?? []).length % 2 === 0 ? before : l;
    })
    .join('\n');

  // Every way a module can be pulled in, not just the static form. A guard matching only `from '...'`
  // passes while an import() or require() reaches straight into fleet/, and reports "no fleet imports"
  // about a file that has one -- worse than no guard, because it looks like a check.
  const specifiers = [
    ...[...code.matchAll(/\bfrom\s+['"`]([^'"`]+)['"`]/g)].map((m) => m[1]!),
    ...[...code.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]!),
    ...[...code.matchAll(/\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]!),
  ];
  const fleetImports = specifiers.filter((spec) => spec.includes('/fleet/') || spec.startsWith('../fleet'));
  assert.deepEqual(fleetImports, [], `this file must reach Fleet by process + HTTP only, but imports: ${fleetImports.join(', ')}`);

  // The guard must be capable of failing. A regex that matches nothing at all is indistinguishable from
  // a file with no violations, so assert the scan is actually reading this file.
  assert.ok(specifiers.length > 5, `the import scan found only ${specifiers.length} specifiers; it is not reading this file`);
});

test('work submitted through Fleet lands as a real Run on the real Mercury', async () => {
  // The product journey Fleet exists for: a caller talks to Fleet, and the work appears on Mercury.
  // Every existing dispatch test drives submitRun() in-process against a stubbed child, so none of them
  // has ever seen the real host accept a real POST /api/runs with the body Fleet builds. Fleet strips
  // `host` and `idempotency` from the request and injects nothing else, so a drift in what the host's
  // create endpoint accepts would surface here and nowhere else.
  await withStack(async (m, f) => {
    const added = await f.registerHost();
    assert.equal(added.status, 201, added.text.slice(0, 200));
    const probed = await f.probe();
    assert.equal(probed.status, 200, `probe first so routing has real agent data: ${probed.text.slice(0, 200)}`);

    const submitted = await f.req('/fleet/runs', CALLER_TOKEN, {
      method: 'POST',
      body: JSON.stringify({ host: 'lab-1', task: 'do the thing', agent: 'fake' }),
    });
    assert.equal(submitted.status, 201, `dispatch failed: ${submitted.status} ${submitted.text.slice(0, 400)}`);
    const ack = submitted.json() as unknown as {
      fleetRunId: string; hostId: string; childRunId: string | null; pending: boolean;
    };
    assert.equal(ack.hostId, 'lab-1');
    assert.ok(ack.childRunId, `Fleet reported no child Run id; the submit never reached Mercury: ${submitted.text.slice(0, 400)}`);

    // The claim that matters: read the Run back FROM MERCURY, not from Fleet's own binding table.
    // A test that only asserted Fleet's bookkeeping would pass against a host that rejected the body.
    const onHost = await fetch(`${m.url}/api/runs/${ack.childRunId}`, {
      headers: { authorization: `Bearer ${HOST_TOKEN}` }, signal: AbortSignal.timeout(15_000),
    });
    // Read the body ONCE. `fetch` bodies are single-use, and an assertion message is an argument, so it
    // is evaluated eagerly even when the assertion passes -- writing ${(await res.text())} inside
    // assert.equal's message consumes the stream and the later .json() dies with "Body is unusable".
    const hostBody = await onHost.text();
    assert.equal(onHost.status, 200, `Mercury has no such Run: ${onHost.status} ${hostBody.slice(0, 300)}`);
    // The host wraps it: GET /api/runs/:runId answers { run, skills }, not the Run bare.
    const run = (JSON.parse(hostBody) as { run: { id: string; task: string; agent: string; status: string; ownerId: string } }).run;
    assert.equal(run.id, ack.childRunId);
    assert.equal(run.task, 'do the thing', `Mercury stored a different task than Fleet was asked to send: ${JSON.stringify(run)}`);
    assert.equal(run.agent, 'fake');
    // Ownership does NOT travel with the Fleet caller. Mercury attributes the Run to whoever its OWN
    // credential belongs to -- Fleet authenticates to a host with the registry credential, so every Run
    // any Fleet caller submits lands on Mercury owned by that credential's owner. Measured, not
    // reasoned: remapping FLEET_API_TOKENS so the Fleet caller is `bob` leaves the Run owned by `alice`,
    // because `alice` is who HOST_TOKEN resolves to. An earlier draft of this line asserted
    // ownerId === 'alice' and claimed it proved the Fleet caller's identity crossed the wire. It proved
    // the opposite, and it could not fail -- both sides were 'alice' by construction.
    //
    // This is a real property of the design, not a defect: Fleet is a single-tenant-per-host front, and
    // per-caller isolation lives in Fleet's own scoping (a caller cannot read or act on a Run bound to a
    // host they may not see). It does mean Mercury-side ownership cannot distinguish two Fleet callers,
    // so any future per-caller attribution on the host needs an explicit identity to be threaded through.
    assert.equal(run.ownerId, 'alice', `Mercury should own the Run by its own credential, not the Fleet caller's: ${JSON.stringify(run)}`);

    // And Fleet's own view agrees with Mercury's, which is the whole point of the binding.
    const listed = await f.req('/fleet/runs', CALLER_TOKEN);
    assert.equal(listed.status, 200, listed.text.slice(0, 200));
    const runs = (listed.json() as unknown as { runs: Array<Record<string, unknown>> }).runs;
    assert.equal(runs.length, 1, `Fleet listed ${runs.length} runs: ${listed.text.slice(0, 300)}`);
    assert.equal(runs[0]!.childRunId, ack.childRunId);
  });
});

test('a replay through the same Fleet returns the same child Run instead of a second one', async () => {
  // What this proves, precisely: Fleet's OWN binding table dedupes a repeated client token before it
  // reaches the network. That was measured, not assumed -- dropping the `idempotency-key` header Fleet
  // sends to Mercury, and making Mercury ignore that header, BOTH leave this test green, because the
  // second submit never leaves Fleet at all. The host-side key is exercised by the next test, which
  // uses a second Fleet that has never seen the first one's binding.
  await withStack(async (m, f) => {
    assert.equal((await f.registerHost()).status, 201);
    assert.equal((await f.probe()).status, 200);

    const body = JSON.stringify({ host: 'lab-1', task: 'idempotent thing', agent: 'fake', idempotency: 'key-abc' });
    const first = await f.req('/fleet/runs', CALLER_TOKEN, { method: 'POST', body });
    assert.equal(first.status, 201, `first submit: ${first.status} ${first.text.slice(0, 300)}`);
    const second = await f.req('/fleet/runs', CALLER_TOKEN, { method: 'POST', body });
    // 200 (reused), not 201: the route distinguishes a fresh create from a replay.
    assert.equal(second.status, 200, `a replay must not report a fresh create: ${second.status} ${second.text.slice(0, 300)}`);
    const a = first.json() as unknown as { childRunId: string };
    const b = second.json() as unknown as { childRunId: string; reused: boolean };
    assert.equal(b.childRunId, a.childRunId, 'the replay bound to a different child Run');
    assert.equal(b.reused, true);

    // Ground truth on Mercury: exactly one Run exists.
    const hostRuns = await (await fetch(`${m.url}/api/runs?limit=50`, {
      headers: { authorization: `Bearer ${HOST_TOKEN}` }, signal: AbortSignal.timeout(15_000),
    })).json() as { runs: Array<{ task: string }> };
    const dupes = hostRuns.runs.filter((r) => r.task === 'idempotent thing');
    assert.equal(dupes.length, 1, `Mercury holds ${dupes.length} Runs for one idempotency key`);
  });
});

test('a Fleet restart does not double-book: the binding survives in its own database', async () => {
  // The recovery case that actually happens: an operator restarts Fleet (or it crashes and systemd
  // brings it back) and a retried submit arrives with the same idempotency token. The binding has to
  // come back out of Fleet's SQLite file, not out of process memory, or the retry does the work twice.
  //
  // What this deliberately does NOT claim: that two INDEPENDENT Fleets dedupe against each other. They
  // do not, and that is the design. Fleet sends Mercury its own generated fleetRunId as the
  // `idempotency-key` header (dispatch.ts -> child.createRun(host, payload, fleetRunId)), not the
  // caller's token, so the caller's token is scoped to one Fleet's binding table and Mercury's key is
  // scoped to one Fleet binding. A first draft of this test spun up a second Fleet with a fresh
  // database, expected one Run, and got two -- which was a wrong expectation about the product, not a
  // bug in it. Verified: the two child Run ids differed, and Mercury was right to create both.
  // Acquired INSIDE the try, same rule withStack() follows: a resource taken before the try is
  // unreachable from the finally if the acquisition itself throws. This was reintroduced here after
  // being fixed in withStack(), and a reviewer caught it.
  let dir: string | null = null;
  let mercury: Awaited<ReturnType<typeof realMercury>> | null = null;
  let a: Awaited<ReturnType<typeof realFleet>> | null = null;
  try {
    dir = tempDir('fleet-restart-');
    mercury = await realMercury({ token: HOST_TOKEN });
    a = await realFleet(mercury.url, dir, 'a');
    assert.equal((await a.registerHost()).status, 201);
    assert.equal((await a.probe()).status, 200);
    const body = JSON.stringify({ host: 'lab-1', task: 'survive the restart', agent: 'fake', idempotency: 'restart-key-1' });
    const first = await a.req('/fleet/runs', CALLER_TOKEN, { method: 'POST', body });
    assert.equal(first.status, 201, `first submit: ${first.status} ${first.text.slice(0, 300)}`);
    const firstChild = (first.json() as unknown as { childRunId: string }).childRunId;
    const firstFleetId = (first.json() as unknown as { fleetRunId: string }).fleetRunId;

    // Hard stop, then a NEW process on the SAME database. Nothing carries over in memory.
    await a.close();
    a = null;
    const b = await realFleet(mercury.url, dir, 'a');
    try {
      // The registry survived too -- otherwise this would be testing a fresh Fleet, not a restarted one.
      const hosts = await b.hosts();
      const listed = (hosts.json() as unknown as { hosts: Array<{ id: string }> }).hosts;
      assert.deepEqual(listed.map((h) => h.id), ['lab-1'], `registry did not survive the restart: ${hosts.text.slice(0, 200)}`);

      const again = await b.req('/fleet/runs', CALLER_TOKEN, { method: 'POST', body });
      assert.ok([200, 201].includes(again.status), `replay after restart: ${again.status} ${again.text.slice(0, 300)}`);
      const replay = again.json() as unknown as { childRunId: string; fleetRunId: string };
      assert.equal(replay.fleetRunId, firstFleetId,
        `the restart minted a new binding instead of reusing it: ${firstFleetId} vs ${replay.fleetRunId}`);
      assert.equal(replay.childRunId, firstChild,
        `the replay booked a second child Run: ${firstChild} vs ${replay.childRunId}`);

      const hostRuns = await (await fetch(`${mercury.url}/api/runs?limit=50`, {
        headers: { authorization: `Bearer ${HOST_TOKEN}` }, signal: AbortSignal.timeout(15_000),
      })).text();
      const dupes = (JSON.parse(hostRuns) as { runs: Array<{ task: string }> }).runs
        .filter((r) => r.task === 'survive the restart');
      assert.equal(dupes.length, 1, `Mercury holds ${dupes.length} Runs after a Fleet restart`);
    } finally {
      await b.close();
    }
  } finally {
    if (a) await a.close();
    if (mercury) await mercury.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

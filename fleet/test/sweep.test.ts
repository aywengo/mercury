import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openFleetDb } from '../db.ts';
import { HostRegistry } from '../registry.ts';
import { BindingStore, UNKNOWN } from '../bindings.ts';
import { createChildClient } from '../child.ts';
import { submitRun, type DispatchDeps } from '../dispatch.ts';
import { isTerminal, LOST, startSweeper, sweepOnce, type SweepEvent, type SweeperHandle } from '../sweep.ts';

/**
 * A stand-in child whose answers a test can change between sweeps. Every row of section 7's table is a
 * different answer to the same question, so the answers have to be mutable while the binding stays put. `mode` is mutated in place so a test can watch a binding move
 * across states -- which is the only way to show LOST is recoverable rather than a dead end.
 */
interface ChildMode {
  /** 'ok' returns { run }; a number answers that HTTP status; 'silent' destroys the socket. */
  answer: 'ok' | number | 'silent';
  status: string;
  error?: string | null;
  requests: number;
  seen: string[];
  /** How many Runs the child has handed out, so ids stay unique. */
  created: number;
  /** Answer an error status with no body at all, which is what a proxy in front of the child does. */
  emptyBody?: boolean;
}

async function fakeChild(mode: ChildMode): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    mode.requests++;
    const runId = decodeURIComponent((req.url ?? '').split('/').pop() ?? '');
    mode.seen.push(runId);
    if (req.method === 'POST') {
      if (mode.answer === 'silent') {
        req.socket.destroy();
        return;
      }
      // POST /api/runs answers { runId, status } -- a different envelope from the GET. Each Run gets its own
      // id, because fleet_runs has UNIQUE (host_id, child_run_id) and a fake that reuses one id cannot
      // represent a fleet with two Runs on a host.
      mode.created++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runId: `run_${mode.created}`, status: 'QUEUED' }));
      return;
    }
    if (mode.answer === 'silent') {
      req.socket.destroy();
      return;
    }
    if (mode.answer !== 'ok') {
      res.writeHead(mode.answer, { 'content-type': 'application/json' });
      res.end(mode.emptyBody ? '' : JSON.stringify({ error: 'child said no' }));
      return;
    }
    // The real envelope: GET /api/runs/:runId answers { run, skills }.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ run: { id: runId, status: mode.status, error: mode.error ?? null }, skills: [] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    // Shut idle sockets first. fetch/undici pools connections, and server.close() only resolves once every
    // connection is gone, so closing without this leaves teardown waiting on a socket nobody is holding.
    close: () => new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

async function harness(mode: ChildMode = { answer: 'ok', status: 'RUNNING', requests: 0, seen: [], created: 0 }) {
  const child = await fakeChild(mode);
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  registry.add({ id: 'studio', baseUrl: child.url, credentialRef: 'lan-ref' });
  const bindings = new BindingStore(db);
  const dispatch: DispatchDeps = {
    registry, bindings,
    child: createChildClient({ timeoutMs: 800 }),
    resolveToken: (ref) => (ref === 'lan-ref' ? 'secret-value' : (() => { throw new Error('unknown ref'); })()),
  };
  const submit = (task = 'job') => submitRun(dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task } });
  return { mode, child, db, registry, bindings, dispatch, submit };
}

test('the sweep advances a running Run and copies terminal states verbatim', async () => {
  const h = await harness();
  try {
    const { binding } = await h.submit();
    const report = await sweepOnce(h.dispatch);
    assert.equal(report.examined, 1);
    assert.equal(report.advanced, 1);
    assert.equal(h.bindings.state(binding.fleetRunId)!.status, 'RUNNING');

    // One Run per status: once a binding is terminal the sweep stops reading it, so a single binding cannot
    // be walked through every terminal state. That skip is the next test's subject.
    for (const terminal of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']) {
      const extra = await h.submit(`job ${terminal}`);
      h.mode.status = terminal;
      await sweepOnce(h.dispatch);
      assert.equal(h.bindings.state(extra.binding.fleetRunId)!.status, terminal,
        'section 7: these are the only states Fleet may copy, and it must copy them exactly');
    }
  } finally { await h.child.close(); h.db.close(); }
});

test('terminal bindings are skipped, not re-read forever', async () => {
  const h = await harness();
  try {
    await h.submit();
    h.mode.status = 'COMPLETED';
    await sweepOnce(h.dispatch);
    const after = h.mode.requests;
    for (let i = 0; i < 5; i++) await sweepOnce(h.dispatch);
    assert.equal(h.mode.requests, after,
      'a terminal Run must cost no further child requests; the sweep is bounded by live work');
  } finally { await h.child.close(); h.db.close(); }
});

test('an unreachable child yields UNKNOWN, never FAILED', async () => {
  const h = await harness();
  try {
    const { binding } = await h.submit();
    h.mode.status = 'RUNNING';
    await sweepOnce(h.dispatch);
    assert.equal(h.bindings.state(binding.fleetRunId)!.status, 'RUNNING');

    h.mode.answer = 'silent';
    const report = await sweepOnce(h.dispatch);
    const state = h.bindings.state(binding.fleetRunId)!;
    assert.equal(report.stale, 1);
    // The last known status stands. Marking FAILED here would destroy a Run that is still running and
    // spending money -- the single most expensive mistake this design can make.
    assert.equal(state.status, 'RUNNING', 'a network partition is not a Run outcome');
    assert.notEqual(state.status, 'FAILED');
    assert.ok(state.lastError, 'but the record must say the reading may be stale');

    // A binding that was never read at all becomes UNKNOWN rather than inheriting nothing.
    const fresh = await h.submit('second');
    await sweepOnce(h.dispatch);
    assert.equal(h.bindings.state(fresh.binding.fleetRunId)!.status, UNKNOWN);
  } finally { await h.child.close(); h.db.close(); }
});

test('a 404 for a bound Run becomes LOST and is reported once', async () => {
  const h = await harness();
  const events: SweepEvent[] = [];
  try {
    const { binding } = await h.submit();
    h.mode.answer = 404;
    const first = await sweepOnce(h.dispatch, { onEvent: (e) => events.push(e) });
    assert.equal(first.lost, 1);
    assert.equal(h.bindings.state(binding.fleetRunId)!.status, LOST);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'lost');
    assert.equal(events[0].childRunId, binding.childRunId);
    assert.match(h.bindings.state(binding.fleetRunId)!.lastError!, /HTTP 404/);
    // The child's own words matter here: "run not found" and "no such workspace" point at different fixes,
    // and an operator reading only "HTTP 404" has to go and reproduce it themselves.
    assert.match(h.bindings.state(binding.fleetRunId)!.lastError!, /child said no/);

    // Repeated sweeps must not turn one incident into an alert per interval.
    await sweepOnce(h.dispatch, { onEvent: (e) => events.push(e) });
    await sweepOnce(h.dispatch, { onEvent: (e) => events.push(e) });
    assert.equal(events.length, 1, 'LOST is reported on transition, not per sweep');
  } finally { await h.child.close(); h.db.close(); }
});

test('LOST is recoverable: it is not a terminal state', async () => {
  const h = await harness();
  try {
    const { binding } = await h.submit();
    h.mode.answer = 404;
    await sweepOnce(h.dispatch);
    assert.equal(h.bindings.state(binding.fleetRunId)!.status, LOST);

    // The child comes back -- a restored database, a restarted process -- and the Run is still there.
    h.mode.answer = 'ok';
    h.mode.status = 'RUNNING';
    const report = await sweepOnce(h.dispatch);
    assert.equal(report.examined, 1, 'LOST bindings stay in the sweep');
    assert.equal(h.bindings.state(binding.fleetRunId)!.status, 'RUNNING');
    assert.equal(isTerminal(LOST), false);
  } finally { await h.child.close(); h.db.close(); }
});

test('a 5xx keeps the last known status and records the reason', async () => {
  const h = await harness();
  try {
    const { binding } = await h.submit();
    h.mode.status = 'RUNNING';
    await sweepOnce(h.dispatch);
    // Seeded rather than read back: two sweeps can land in the same millisecond, and an assertion that
    // compares two calls to Date.now() passes by luck. This one can only pass by preserving the value.
    h.bindings.recordState({
      fleetRunId: binding.fleetRunId, status: 'RUNNING', cursor: 3,
      lastSeenAt: '2020-01-01T00:00:00.000Z', lastError: null,
    });

    h.mode.answer = 503;
    await sweepOnce(h.dispatch);
    const after = h.bindings.state(binding.fleetRunId)!;
    // Never overwrite good state with bad.
    assert.equal(after.status, 'RUNNING');
    assert.equal(after.cursor, 3, 'a failed read must not disturb the cursor either');
    assert.equal(after.lastSeenAt, '2020-01-01T00:00:00.000Z', 'a failed read is not a fresh observation');
    assert.match(after.lastError!, /HTTP 503/);
  } finally { await h.child.close(); h.db.close(); }
});

test('a host removed under a live binding keeps state and says why', async () => {
  const h = await harness();
  try {
    const { binding } = await h.submit();
    h.mode.status = 'RUNNING';
    await sweepOnce(h.dispatch);
    h.registry.setEnabled('studio', false);
    const report = await sweepOnce(h.dispatch);
    assert.equal(report.stale, 1);
    assert.equal(report.examined, 0, 'a disabled host costs no child request');
    const state = h.bindings.state(binding.fleetRunId)!;
    assert.equal(state.status, 'RUNNING');
    assert.ok(state.lastError);
  } finally { await h.child.close(); h.db.close(); }
});

test('bindings with no child answer are left to dispatch recovery', async () => {
  const h = await harness({ answer: 'silent', status: 'RUNNING', requests: 0, seen: [], created: 0 });
  try {
    const { binding, pending } = await h.submit();
    assert.equal(pending, true);
    assert.equal(binding.childRunId, null);
    const report = await sweepOnce(h.dispatch);
    assert.equal(report.pending, 1);
    assert.equal(report.examined, 0, 'there is nothing to read until a child id exists');
  } finally { await h.child.close(); h.db.close(); }
});

test('the sweeper runs on a timer and cannot overlap itself', async () => {
  // Slow the child enough that a second tick would land mid-pass if the guard were missing.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const seen = { requests: 0 };
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
      // Only the reconciliation read is gated. Gating POST too would stall submitRun and the sweeper would
      // never start, and the test would fail for a reason unrelated to overlap.
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runId: 'run_1', status: 'QUEUED' }));
      return;
    }
    seen.requests++;
    await gate;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ run: { id: 'run_1', status: 'RUNNING' }, skills: [] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const { db } = openFleetDb(':memory:');
  // Declared before the try so the finally can always reach it. Declaring it inside the try made the finally
  // throw ReferenceError, which skipped release() and the server close -- and the gated request plus the live
  // timer then kept the process alive forever.
  let sweeper: SweeperHandle | null = null;
  try {
    const registry = new HostRegistry(db);
    registry.add({ id: 'studio', baseUrl: `http://127.0.0.1:${port}`, credentialRef: 'lan-ref' });
    const bindings = new BindingStore(db);
    const dispatch: DispatchDeps = {
      registry, bindings,
      child: createChildClient({ timeoutMs: 60_000 }),
      resolveToken: () => 'secret-value',
    };
    await submitRun(dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'slow' } });

    sweeper = startSweeper(dispatch, { intervalMs: 20 });
    // The first pass starts synchronously inside startSweeper, so it is already in flight here.
    assert.equal(sweeper.running, true, 'the first pass must begin at startup, not after one interval');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.requests, 1, 'five intervals must produce one in-flight request, not five');
    release();
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(seen.requests >= 2, 'it must keep going after a pass completes');
    sweeper.stop();
    // Let any pass already in flight land before sampling. Snapshotting immediately after stop() raced with a
    // tick that fired microseconds earlier and whose request had not arrived yet.
    await new Promise((r) => setTimeout(r, 120));
    const settled = seen.requests;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(seen.requests, settled, 'stop() ends the timer');
    db.close();
  } finally {
    sweeper?.stop();
    release();
    // Force idle keep-alive sockets shut. The reconciliation client is undici, which pools connections, and
    // server.close() only resolves once every connection is gone -- so without this the test body finishes
    // and the process still never exits. createFleetServer's close() does the same thing for the same reason.
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    if (db.isOpen) db.close();
  }
});

test('the child detail reaches the operator, and an empty one adds no punctuation', async () => {
  const h = await harness();
  try {
    const { binding } = await h.submit();
    h.mode.answer = 403;
    await sweepOnce(h.dispatch);
    // Auth and validation failures are invisible unless the child's own words survive the trip.
    assert.match(h.bindings.state(binding.fleetRunId)!.lastError!, /HTTP 403/);
    assert.match(h.bindings.state(binding.fleetRunId)!.lastError!, /child said no/);

    // A proxy answering 403 with no body must not leave "child said HTTP 403: " in an operator's log.
    // (A 5xx takes a different path on purpose: the client classifies it as unknown, so §7 keeps the last
    // known status rather than treating a transient 5xx as an answer about the Run.)
    h.mode.answer = 403;
    h.mode.emptyBody = true;
    await sweepOnce(h.dispatch);
    const err = h.bindings.state(binding.fleetRunId)!.lastError!;
    assert.equal(err, 'child said HTTP 403', `dangling punctuation: ${JSON.stringify(err)}`);
  } finally { await h.child.close(); h.db.close(); }
});

test('a 404 with no body still reads as LOST without dangling punctuation', async () => {
  const h = await harness();
  try {
    const { binding } = await h.submit();
    h.mode.answer = 404;
    h.mode.emptyBody = true;
    await sweepOnce(h.dispatch);
    assert.equal(h.bindings.state(binding.fleetRunId)!.status, LOST);
    assert.equal(h.bindings.state(binding.fleetRunId)!.lastError!, 'child reports no such Run (HTTP 404)');
  } finally { await h.child.close(); h.db.close(); }
});

test('the sweeper actually passes event deps through to the sweep', async () => {
  // Wiring bug this catches: startSweeper accepted an `events` option and never forwarded it, so mirroring
  // silently never ran in production while every direct sweepOnce test stayed green. A type that accepts a
  // field the call site drops is invisible to the compiler, so the forwarding itself needs a test.
  const mode: ChildMode = { answer: 'ok', status: 'RUNNING', requests: 0, seen: [], created: 0 };
  const h = await harness(mode);
  try {
    await h.submit();
    let mirrored = 0;
    const eventsDeps = {
      db: h.db, bindings: h.bindings, registry: h.registry,
      child: {
        createRun: h.dispatch.child.createRun,
        getRun: h.dispatch.child.getRun,
        getEvents: async (host: any, runId: string, after: number, limit: number) => {
          mirrored++;
          return { kind: 'ok' as const, value: { events: [], lastSequence: 0, nextCursor: after, hasMore: false } };
        },
        submitInput: async () => ({ kind: 'ok' as const, value: { ok: true } }),
        cancelRun: async () => ({ kind: 'ok' as const, value: { runId: 'run_1', status: 'CANCELLED' } }),
        retryRun: async () => ({ kind: 'ok' as const, value: { runId: 'run_2', status: 'QUEUED', retryOf: 'run_1' } }),
        getMetrics: async () => ({ kind: 'ok' as const, value: '' }),
      },
      resolveToken: () => 'secret-value',
    };
    let sweeper: SweeperHandle | null = null;
    try {
      sweeper = startSweeper(h.dispatch, { intervalMs: 10_000, events: eventsDeps });
      await new Promise((r) => setTimeout(r, 120));
      assert.ok(mirrored > 0, 'the timer pass must carry the event deps into sweepOnce');
    } finally {
      sweeper?.stop();
    }
  } finally { await h.child.close(); h.db.close(); }
});

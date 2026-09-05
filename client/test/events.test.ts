// Events and watch (docs/cli-tui-design.md §6.1, §10.2; issue #232 acceptance).
//
// Split deliberately in two halves, because they prove different things:
//
// * End-to-end against a real Mercury server for anything the server can put into state -- paging,
//   exit codes, Ctrl-C.
// * Against a scripted client for the reconnect and gap-recovery paths. Producing a genuine mid-stream
//   disconnect from a healthy server is a timing race, and a test that depends on winning that race is
//   the kind that passes locally and flakes in CI. The scripted half fixes the sequence of failures
//   exactly; the cost is that it does not exercise real socket teardown, which transport.test.ts covers.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { BIN, apiCall, createRunViaApi, forceNeedsInput, forceStatus, runCli, runCliAsync, seedEvents, startMercuryServer, type LiveServer } from './helpers/server.ts';
import { observeRun } from '../observe/runObserver.ts';
import { StreamUnrecoverableError, TransportError } from '../api/errors.ts';
import { watchExitCode } from '../commands/events.ts';
import type { MercuryEvent } from '../api/protocol.ts';

let server: LiveServer;
before(async () => { server = await startMercuryServer('mercuryctl-events-'); });
after(async () => { await server.stop(); });

const ev = (sequence: number, type = 'agent.message'): MercuryEvent => ({
  id: `evt_${sequence}`, runId: 'run_x', type, sequence,
  timestamp: '2026-01-01T00:00:00.000Z', payload: { text: `event ${sequence}` },
} as MercuryEvent);

/**
 * A scripted client backed by a real event store model.
 *
 * History is a single flat list, and listEvents pages it from `after` with `limit`, computing
 * nextCursor and hasMore exactly the way the server does. The first version of this fixture instead
 * indexed a list of pages by call count, which is not how any store behaves: it could report
 * hasMore=false while events remained, and that made a CORRECT observer look like it was dropping
 * events. A fake that can lie about paging cannot be used to test paging.
 *
 * `streamBatches` is the list of batches delivered before each disconnect; each batch is followed by a
 * thrown socket error, which is what a dropped connection looks like from the observer's side.
 */
function scriptedObserverClient(options: {
  events: MercuryEvent[];
  streamBatches: MercuryEvent[][];
  status?: string;
  /** Become terminal once the queued events have been published, so a mid-stream gap can be observed. */
  completeOnPublish?: boolean;
  pageSize?: number;
}) {
  const all = [...options.events].sort((a, b) => a.sequence - b.sequence);
  const trueMax = (): number => (all.length > 0 ? all[all.length - 1].sequence : 0);
  let streamCalls = 0;
  let historyCalls = 0;
  const pendingPublish: MercuryEvent[] = [];
  // Flipped by publishOnNextStream so the Run can become terminal once the run-ahead event exists.
  let published = false;
  return {
    historyCalls: () => historyCalls,
    streamCalls: () => streamCalls,
    /**
     * Persist events mid-test.
     *
     * Gap recovery can only be exercised if events can become visible in history AFTER the stream has
     * already run ahead of them -- which is exactly the real situation, since the live fan-out is
     * in-memory and can drop an event that was nevertheless persisted. A store frozen at construction
     * makes the gap unreachable, because the initial history drain would already contain everything
     * the stream could later deliver.
     */
    /** Persist events the next time history is read, modelling a write landing mid-observation. */
    publishOnNextStream: (...extra: MercuryEvent[]) => { pendingPublish.push(...extra); },
    addEvents: (...extra: MercuryEvent[]) => {
      all.push(...extra);
      all.sort((a, b) => a.sequence - b.sequence);
    },

    client: {
      async listEvents(_runId: string, query: { after?: number; limit?: number } = {}) {
        historyCalls += 1;
        const after = query.after ?? 0;
        // Honour BOTH the caller's limit and the store's own page size, the way a real server caps a
        // request at its maximum. The first version used only the caller's limit, so the observer's
        // default page size of 200 returned everything in one page and the test named "a capped page"
        // never capped anything -- which is exactly why mutating nextCursor to lastSequence survived.
        const limit = Math.min(query.limit ?? Infinity, options.pageSize ?? Infinity);
        const events = all.filter((e) => e.sequence > after).slice(0, limit);
        const nextCursor = events.length > 0 ? events[events.length - 1].sequence : after;
        // Exactly the server's rule: the cursor is the last sequence RETURNED, and more remain when
        // that is behind the store's true maximum. Using trueMax here is the bug in issue #54.
        const max = trueMax();
        return { events, lastSequence: max, nextCursor, hasMore: nextCursor < max };
      },
      async getRun() {
        // The terminal transition has to happen INSIDE the observation. A status that is terminal from
        // the start makes the observer finish right after the initial history drain, so the streaming
        // loop -- and therefore the gap path -- is never reached; a status that is never terminal makes
        // it exhaust the reconnect budget, which is a different property.
        const terminal = options.completeOnPublish === true && published;
        return { run: { status: terminal ? 'COMPLETED' : options.status ?? 'RUNNING' }, skills: [] };
      },
      streamEvents(_runId: string, query: { after?: number } = {}) {
        // Anything queued for publication becomes visible exactly when the stream is opened, i.e. after
        // the initial history drain. That ordering is the point: a gap can only be observed if the
        // missing events were NOT already in the first drain.
        if (pendingPublish.length > 0) { all.push(...pendingPublish); pendingPublish.length = 0; all.sort((a, b) => a.sequence - b.sequence); published = true; }
        const batch = options.streamBatches[Math.min(streamCalls, options.streamBatches.length - 1)] ?? [];
        streamCalls += 1;
        const after = query.after ?? 0;
        const frames = batch.filter((e) => e.sequence > after)
          .map((e) => ({ event: e.type, data: JSON.stringify(e) }));
        return {
          [Symbol.asyncIterator]: () => {
            let i = 0;
            return {
              next: async () => (i < frames.length
                ? { value: frames[i++], done: false }
                // Throwing rather than returning done: a dropped connection must stay distinguishable
                // from the server ending the stream on a terminal transition.
                // A TransportError, matching what the real client raises. Throwing a bare Error made
                // the observer treat it as an unexpected fault and rethrow, so the reconnect paths the
                // three tests below exercise were never reached.
                : (() => { throw new TransportError('socket hang up'); })()),
            };
          },
        };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Paging and gap recovery
// ---------------------------------------------------------------------------

test('a capped page advances from nextCursor and every event is delivered exactly once', async () => {
  // The criterion this exists for. The server returns lastSequence alongside nextCursor and warns that
  // lastSequence is not a safe resume point on a truncated page; resuming from it silently skips events.
  // Five events behind a page size of two, so paging must take three trips.
  const spy = scriptedObserverClient({
    events: [ev(1), ev(2), ev(3), ev(4), ev(5)],
    streamBatches: [[], [], [], []],
    status: 'COMPLETED',
    pageSize: 2,
  });
  const seen: number[] = [];
  const outcome = await observeRun({
    client: spy.client as never,
    runId: 'run_x',
    onEvent: (e) => { seen.push(e.sequence); },
    sleep: async () => {},
  });
  assert.deepEqual(seen, [1, 2, 3, 4, 5], `paging lost or reordered events: ${seen}`);
  assert.equal(new Set(seen).size, seen.length, 'an event was delivered twice');
  assert.equal(outcome.finalStatus, 'COMPLETED');
});

test('a stream that jumps ahead recovers the gap from history instead of skipping it', async () => {
  // The gap has to be real: the stream runs ahead to sequence 5 while 3 and 4 are not yet visible in
  // history, then they become visible. Accepting the jump would lose two persisted events.
  const spy = scriptedObserverClient({
    events: [ev(1), ev(2)],
    streamBatches: [[ev(1), ev(2), ev(5)], [], [], []],
    // The status has to CHANGE during the test. A terminal status makes the observer finish right after
    // the initial history drain -- it never enters the streaming loop, so the gap path is unreachable.
    // A permanently RUNNING status makes it exhaust the reconnect budget, which tests a different
    // property. The gap is only observable while the Run is live and the stream is being followed, so
    // the store reports RUNNING until the run-ahead event exists, then COMPLETED.
    completeOnPublish: true,
    pageSize: 2,
  });
  const seen: number[] = [];
  spy.publishOnNextStream(ev(3), ev(4), ev(5));
  const outcome = await observeRun({
    client: spy.client as never, runId: 'run_x',
    onEvent: (e) => { seen.push(e.sequence); },
    sleep: async () => {},
  });
  assert.deepEqual(seen, [1, 2, 3, 4, 5], `gap was not closed: ${seen}`);
  assert.ok(outcome.gapsRecovered >= 1, 'the gap was not counted');
});

test('a forced disconnect loses no persisted event', async () => {
  // Stream dies after two events; the next history page contains the rest. This is the acceptance
  // criterion stated directly: a disconnect must not cost the operator data.
  const spy = scriptedObserverClient({
    events: [ev(1), ev(2), ev(3), ev(4)],
    streamBatches: [[ev(1), ev(2)], [], [], [], []],
    status: 'COMPLETED',
    pageSize: 2,
  });
  const seen: number[] = [];
  const outcome = await observeRun({
    client: spy.client as never, runId: 'run_x',
    onEvent: (e) => { seen.push(e.sequence); },
    sleep: async () => {},
  });
  assert.deepEqual(seen, [1, 2, 3, 4], `events lost across a disconnect: ${seen}`);
});

test('a stream failure while the Run is still running is counted as a reconnect', async () => {
  // The accounting above cannot be observed on a terminal Run: when the stream dies and the Run is
  // already terminal, the observer finishes from the status read instead of reconnecting, which is the
  // right thing to do. So the counter needs a Run that is genuinely still going.
  const spy = scriptedObserverClient({
    events: [ev(1), ev(2)],
    streamBatches: [[ev(1), ev(2)], [ev(1), ev(2)], [], []],
    status: 'RUNNING',
    pageSize: 2,
  });
  const seen: number[] = [];
  await assert.rejects(
    () => observeRun({
      client: spy.client as never, runId: 'run_x',
      onEvent: (e) => { seen.push(e.sequence); },
      sleep: async () => {}, maxReconnects: 2,
    }),
    StreamUnrecoverableError,
  );
  assert.ok(spy.streamCalls() >= 2, 'the stream was never resumed after the failure');
});

test('an exhausted reconnect budget is a distinct, actionable failure', async () => {
  const spy = scriptedObserverClient({ events: [ev(1)], streamBatches: [[]], status: 'RUNNING', pageSize: 2 });
  await assert.rejects(
    () => observeRun({
      client: spy.client as never, runId: 'run_x', onEvent: () => {},
      sleep: async () => {}, maxReconnects: 2,
    }),
    (err: unknown) => {
      assert.ok(err instanceof StreamUnrecoverableError, 'expected StreamUnrecoverableError');
      // Must say where to resume from, or the operator starts over and re-reads everything.
      assert.match((err as Error).message, /[Ll]ast sequence/);
      return true;
    },
  );
});

test('duplicates after a reconnect are dropped', async () => {
  const spy = scriptedObserverClient({
    events: [ev(1), ev(2), ev(3)],
    // seq 2 is redelivered after the reconnect, which is what a resume from the server's side looks like.
    streamBatches: [[ev(1), ev(2)], [ev(2), ev(3)], [], []],
    status: 'COMPLETED',
    pageSize: 2,
  });
  const seen: number[] = [];
  await observeRun({ client: spy.client as never, runId: 'run_x', onEvent: (e) => { seen.push(e.sequence); }, sleep: async () => {} });
  assert.deepEqual(seen, [1, 2, 3], `duplicates were re-delivered: ${seen}`);
});

// ---------------------------------------------------------------------------
// Watch exit codes (§10.2)
// ---------------------------------------------------------------------------

test('watch exit codes distinguish completed, failed, cancelled and timed out', () => {
  const base = { lastSequence: 1, eventsDelivered: 1, reconnects: 0, gapsRecovered: 0 };
  assert.equal(watchExitCode({ ...base, finalStatus: 'COMPLETED' }), 0);
  assert.equal(watchExitCode({ ...base, finalStatus: 'FAILED' }), 10);
  assert.equal(watchExitCode({ ...base, finalStatus: 'CANCELLED' }), 11);
  assert.equal(watchExitCode({ ...base, finalStatus: 'TIMED_OUT' }), 12);
  // An unknown outcome must not silently look like success.
  assert.equal(watchExitCode({ ...base, finalStatus: null }), 8);
});

for (const [status, code] of [['FAILED', 10], ['CANCELLED', 11], ['TIMED_OUT', 12]] as const) {
  test(`an already-${status} Run exits with ${code} without waiting`, async () => {
    const runId = await createRunViaApi(server, `m3: already ${status}`);
    seedEvents(server, runId, [{ type: 'run.started' }, { type: 'agent.message', payload: { text: 'work' } }]);
    forceStatus(server, runId, status);
    const started = Date.now();
    const r = await runCliAsync(server, ['runs', 'watch', runId, '--timeout', '20s']);
    assert.equal(r.code, code, `expected ${code}, got ${r.code}: ${r.stderr}`);
    assert.ok(Date.now() - started < 20_000, 'watch waited for a stream on an already-terminal Run');
  });
}

// ---------------------------------------------------------------------------
// runs events (a read, so exit 0 regardless of status)
// ---------------------------------------------------------------------------

test('runs events lists persisted history and exits 0 for a FAILED Run', async () => {
  const runId = await createRunViaApi(server, 'm3: events read');
  seedEvents(server, runId, [
    { type: 'run.started' },
    { type: 'agent.message', payload: { text: 'working on it' } },
    { type: 'run.failed', payload: { error: 'boom' } },
  ]);
  forceStatus(server, runId, 'FAILED');
  const r = runCli(server, ['runs', 'events', runId]);
  assert.equal(r.code, 0, `reading a failed Run is not a failure: ${r.stderr}`);
  assert.match(r.stdout, /run\.started/);
  assert.match(r.stdout, /working on it/);
});

test('runs events --json emits exactly one JSON value', async () => {
  const runId = await createRunViaApi(server, 'm3: events json');
  seedEvents(server, runId, [{ type: 'run.started' }, { type: 'run.completed' }]);
  const r = runCli(server, ['runs', 'events', runId, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);   // throws if stdout is more than one value
  // Creating a Run already writes run.created, run.queued and one skill.selected per candidate skill,
  // so the count is not two. Assert on what this test seeded rather than on a total that the server
  // owns and may legitimately change.
  const types = parsed.events.map((e: { type: string }) => e.type);
  assert.ok(types.includes('run.started'), `seeded events missing: ${types}`);
  assert.ok(types.includes('run.completed'), `seeded events missing: ${types}`);
  assert.equal(typeof parsed.nextCursor, 'number');
});

test('runs events --follow emits NDJSON, one complete line per event', async () => {
  const runId = await createRunViaApi(server, 'm3: events ndjson');
  seedEvents(server, runId, [{ type: 'run.started' }, { type: 'run.completed' }]);
  forceStatus(server, runId, 'COMPLETED');
  const r = await runCliAsync(server, ['runs', 'events', runId, '--follow', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.length >= 2, `expected one line per event, got ${lines.length}`);
  for (const line of lines) JSON.parse(line);   // every line must stand alone
});

test('runs events --after and --limit page from the requested sequence', async () => {
  const runId = await createRunViaApi(server, 'm3: events paging');
  seedEvents(server, runId, [1, 2, 3, 4, 5].map((n) => ({ type: 'agent.message', payload: { text: `e${n}` } })));
  const r = runCli(server, ['runs', 'events', runId, '--json', '--after', '2', '--limit', '2']);
  assert.equal(r.code, 0, r.stderr);
  const page = JSON.parse(r.stdout);
  assert.equal(page.events[0].sequence, 3);
  assert.equal(page.events.length, 2);
});

// ---------------------------------------------------------------------------
// Ctrl-C stops only the client (§11.3)
// ---------------------------------------------------------------------------

test('Ctrl-C stops the watch, exits 130, and leaves the Run untouched', async () => {
  const runId = await createRunViaApi(server, 'm3: interrupt me');
  seedEvents(server, runId, [{ type: 'run.started' }]);
  // The Run stays QUEUED, so the watch would otherwise wait for the stream indefinitely.
  const child = spawn(process.execPath, ['--no-warnings', BIN, 'runs', 'watch', runId, '--timeout', '60s'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MERCURY_CLIENT_URL: server.url, MERCURY_CLIENT_TOKEN: 'tok-contract-alice' },
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  await delay(2_500);
  child.kill('SIGINT');
  const [code] = await new Promise<[number | null, string]>((resolve) => {
    child.on('exit', (c) => resolve([c, '']));
    setTimeout(() => { child.kill('SIGKILL'); resolve([null, 'killed']); }, 15_000);
  });
  assert.equal(code, 130, `expected 130 for SIGINT, got ${code}; stderr: ${stderr}`);
  const after = await apiCall(server, `/api/runs/${runId}`);
  assert.equal(after.body.run.status, 'QUEUED', 'Ctrl-C must not cancel the Run');
});// ---------------------------------------------------------------------------
// Live following (the path every earlier watch test skipped)
// ---------------------------------------------------------------------------

test('runs watch follows events appended AFTER the watch started and exits cancelled', async () => {
  // The acceptance behaviour of the milestone, and the one thing the rest of this file could not see.
  // streamEvents built its request but never ended it, so the server never answered and the iterator
  // waited for a response that could not arrive -- yet every test here passed, because each one used an
  // already-terminal Run, which the observer finishes from the history drain plus a status read without
  // ever entering the streaming loop. A suite that only exercises the terminal case cannot see the live
  // case at all.
  //
  // Cancelling a QUEUED Run is used to produce the live events because it is the only API that appends
  // through the normal path without a worker: submitInput stores the answer and appends nothing, so it
  // looks like a live event and is not one.
  const runId = await createRunViaApi(server, 'm3: follow me live');

  const child = spawn(process.execPath, ['--no-warnings', BIN, 'runs', 'watch', runId, '--json', '--timeout', '60s'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MERCURY_CLIENT_URL: server.url, MERCURY_CLIENT_TOKEN: 'tok-contract-alice' },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
  // Started at spawn time, not when the test gets round to asking. An earlier version attached the
  // listener after waiting for the live event, and by then the child had already exited and the 'exit'
  // event had been delivered to nobody -- the test then reported a hang that did not exist.
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

  try {
    // Wait until the watch has actually printed the Run's history. A fixed sleep here was the second
    // version of this test: it passed alone and failed inside the full suite, because several servers
    // and CLI processes start at once and the watch had not attached yet. Reading for the history the
    // watch must print before it can follow anything makes the ordering explicit instead of probable.
    const attached = await waitFor(() => out.includes('run.queued'), 30_000);
    assert.ok(attached, `the watch never printed the Run's history.\nstderr: ${err.slice(0, 400)}`);
    const tCancel = Date.now();
    const cancel = await apiCall(server, `/api/runs/${runId}/cancel`, { method: 'POST' });
    assert.equal(cancel.status, 200, `cancel should succeed: ${cancel.status} ${JSON.stringify(cancel.body)}`);

    const seen = await waitFor(() => out.includes('run.cancelled'), 30_000);
    assert.ok(seen, `live events never reached the watch after ${Date.now() - tCancel}ms.` +
      `\nstdout: ${out.slice(0, 400)}\nstderr: ${err.slice(0, 400)}`);
    const tLive = Date.now() - tCancel;

    // The watch must finish on its own once the server ends the stream, not wait for its timeout.
    const code = await withTimeout(exited, 30_000, `the watch did not exit on its own (live event took ${tLive}ms)`);
    assert.equal(code, 11, `a cancelled Run must exit 11, got ${code} (live event took ${tLive}ms)`);
    // Every line stands alone, or the NDJSON contract is broken on the live path.
    for (const line of out.trim().split('\n')) JSON.parse(line);
    const lines = out.trim().split('\n').map((l: string) => JSON.parse(l));
    const types = lines.map((l: { type: string }) => l.type);
    assert.ok(types.includes('run.cancelling'), `the earlier live event was skipped: ${types}`);
    assert.ok(types.includes('run.cancelled'), `the terminal live event was skipped: ${types}`);
  } finally {
    child.kill('SIGKILL');
  }
});

/** Poll a predicate on the event loop. Bounded, so a missing event fails rather than hanging. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await delay(100);
  }
}

/** Race a promise against a hard cap, so a missing result fails with a message instead of hanging. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

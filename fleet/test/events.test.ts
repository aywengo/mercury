import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openFleetDb } from '../db.ts';
import { HostRegistry } from '../registry.ts';
import { BindingStore } from '../bindings.ts';
import { createChildClient } from '../child.ts';
import { submitRun, type DispatchDeps } from '../dispatch.ts';
import { listMirroredEvents, mirrorEvents, type EventMirrorDeps } from '../events.ts';
import { sweepOnce } from '../sweep.ts';

/**
 * A child serving a fixed event log with real paging. The interesting property is the one Mercury had wrong
 * in issue #54: nextCursor is the last sequence RETURNED, while lastSequence is the run's true maximum. A
 * mirror that resumes from lastSequence silently skips everything a truncated page left out, so the fake must
 * model both values distinctly or the tests cannot tell the two strategies apart.
 */
interface EventLog {
  total: number;
  /** Status the child reports for the Run, so a test can put it in a terminal state before the first read. */
  runStatus?: string;
  pageSize: number;
  requests: { after: number; limit: number }[];
  /** Reads of the Run itself, counted separately so a test can prove a settled status is not re-asked. */
  statusRequests?: number;
  failAfter: number | null;
}

async function fakeChild(log: EventLog): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runId: 'run_1', status: 'QUEUED' }));
      return;
    }
    if (url.pathname.endsWith('/events')) {
      const after = Number(url.searchParams.get('after') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '1000');
      log.requests.push({ after, limit });
      if (log.failAfter !== null && after >= log.failAfter) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('');
        return;
      }
      const seqs: number[] = [];
      for (let s = after + 1; s <= log.total && seqs.length < log.pageSize; s++) seqs.push(s);
      const last = seqs.length > 0 ? seqs[seqs.length - 1] : after;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        events: seqs.map((s) => ({
          id: `ev_${s}`, runId: 'run_1', type: s % 3 === 0 ? 'run.output' : 'run.log',
          sequence: s, timestamp: new Date(1700000000000 + s * 1000).toISOString(),
          payload: { text: `body ${s}` },
        })),
        lastSequence: log.total,
        nextCursor: last,
        hasMore: last < log.total,
      }));
      return;
    }
    log.statusRequests = (log.statusRequests ?? 0) + 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ run: { id: 'run_1', status: log.runStatus ?? 'RUNNING' }, skills: [] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

async function harness(log: Partial<EventLog> = {}, opts: { bodies?: boolean } = {}) {
  const full: EventLog = { total: 10, pageSize: 1000, requests: [], failAfter: null, ...log };
  const child = await fakeChild(full);
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  registry.add({ id: 'studio', baseUrl: child.url, credentialRef: 'lan-ref' });
  if (opts.bodies) db.prepare("UPDATE hosts SET mirror_bodies = 1 WHERE id = 'studio'").run();
  const bindings = new BindingStore(db);
  const dispatch: DispatchDeps = {
    registry, bindings,
    child: createChildClient({ timeoutMs: 1500 }),
    resolveToken: () => 'secret-value',
  };
  const { binding } = await submitRun(dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'x' } });
  const mirrorDeps: EventMirrorDeps = { db, bindings, registry, child: dispatch.child, resolveToken: dispatch.resolveToken };
  return { log: full, child, db, bindings, dispatch, mirrorDeps, fleetRunId: binding.fleetRunId };
}

test('mirroring stores metadata and leaves payloads out by default', async () => {
  const h = await harness();
  try {
    const r = await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    assert.equal(r.inserted, 10);
    assert.equal(r.cursor, 10);
    const rows = h.db.prepare('SELECT payload FROM fleet_events WHERE payload IS NOT NULL').all();
    assert.equal(rows.length, 0, 'section 8: metadata only by default, otherwise Fleet becomes a second transcript');
    const page = listMirroredEvents(h.db, h.fleetRunId, 0, 100);
    assert.equal(page.events.length, 10);
    assert.equal(page.events[0].payload, undefined);
    assert.equal(page.events[1].type, 'run.log');
  } finally { await h.child.close(); h.db.close(); }
});

test('bodies are mirrored only when the host opted in', async () => {
  const h = await harness({}, { bodies: true });
  try {
    await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    const page = listMirroredEvents(h.db, h.fleetRunId, 0, 100);
    assert.deepEqual(page.events[0].payload, { text: 'body 1' });
  } finally { await h.child.close(); h.db.close(); }
});

test('a truncated page resumes from nextCursor and skips nothing', async () => {
  // The bug this guards: paging from lastSequence. With 25 events in pages of 4, a client that resumes from
  // the run's true maximum after the first page jumps straight past events 5..25.
  const h = await harness({ total: 25, pageSize: 4 });
  try {
    const r = await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    assert.ok(r.hasMore, 'the child still had more than one page');
    const seqs = (h.db.prepare('SELECT sequence FROM fleet_events ORDER BY sequence').all() as unknown as { sequence: number }[])
      .map((x) => Number(x.sequence));
    assert.equal(seqs.length, 20, 'four pages of four, then the per-call page cap stops it');
    assert.equal(seqs[0], 1);
    assert.equal(seqs[seqs.length - 1], 20);
    // No gaps: a skipped sequence is invisible in a count-only assertion.
    for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1, `gap at ${seqs[i]}`);

    // Finish the log on the next call, resuming from the stored cursor.
    const r2 = await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    assert.equal(r2.cursor, 25);
    assert.equal(r2.inserted, 5);
    const all = h.db.prepare('SELECT sequence FROM fleet_events ORDER BY sequence').all();
    assert.equal(all.length, 25, 'every event present exactly once');
  } finally { await h.child.close(); h.db.close(); }
});

test('re-mirroring is a no-op rather than a duplicate', async () => {
  const h = await harness();
  try {
    await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    const again = await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    assert.equal(again.inserted, 0, 'nothing new since the cursor');
    const n = (h.db.prepare('SELECT COUNT(*) AS n FROM fleet_events').get() as unknown as { n: number }).n;
    assert.equal(n, 10, 'the child log was mirrored once, not twice');
  } finally { await h.child.close(); h.db.close(); }
});

test('a failed read leaves the cursor where the last good event was', async () => {
  const h = await harness({ total: 20, pageSize: 5, failAfter: 10 });
  try {
    const r = await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    assert.equal(r.cursor, 10, 'the cursor must stop at the last event actually stored');
    assert.equal(h.bindings.state(h.fleetRunId)!.cursor, 10);

    // The child recovers; mirroring continues from the stored cursor with no gap and no repeat.
    h.log.failAfter = null;
    const r2 = await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    assert.equal(r2.inserted, 10);
    assert.equal(r2.cursor, 20);
    const seqs = (h.db.prepare('SELECT sequence FROM fleet_events ORDER BY sequence').all() as unknown as { sequence: number }[])
      .map((x) => Number(x.sequence));
    assert.equal(new Set(seqs).size, 20);
    assert.equal(seqs[0], 1);
    assert.equal(seqs[19], 20);
  } finally { await h.child.close(); h.db.close(); }
});

test('a child that will not advance the cursor cannot spin the mirror', async () => {
  // A stuck cursor would otherwise loop until the process is killed. The mirror must give up and keep what
  // it has.
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runId: 'run_1', status: 'QUEUED' }));
      return;
    }
    // Answers every event read with the same first page and a cursor that never moves.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      events: [{ id: 'ev_1', runId: 'run_1', type: 'run.log', sequence: 1, timestamp: 't', payload: {} }],
      lastSequence: 100, nextCursor: 0, hasMore: true,
    }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const { db } = openFleetDb(':memory:');
  try {
    const registry = new HostRegistry(db);
    registry.add({ id: 'studio', baseUrl: `http://127.0.0.1:${port}`, credentialRef: 'lan-ref' });
    const bindings = new BindingStore(db);
    const child = createChildClient({ timeoutMs: 1500 });
    await submitRun({ registry, bindings, child, resolveToken: () => 's' },
      { hostId: 'studio', ownerId: 'alice', requested: { task: 'x' } });
    const id = bindings.list('*')[0].fleetRunId;
    const r = await mirrorEvents({ db, bindings, registry, child, resolveToken: () => 's' }, id);
    assert.equal(r.pages, 1, 'it stopped after the first page instead of looping');
    assert.equal(r.hasMore, false);
  } finally {
    await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    db.close();
  }
});

test('mirroring does not overwrite a status reconciliation decided', async () => {
  const h = await harness();
  try {
    h.bindings.recordState({
      fleetRunId: h.fleetRunId, status: 'RUNNING', cursor: 0,
      lastSeenAt: '2020-01-01T00:00:00.000Z', lastError: 'stale because the host flapped',
    });
    await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    const state = h.bindings.state(h.fleetRunId)!;
    assert.equal(state.cursor, 10, 'the cursor advanced');
    assert.equal(state.status, 'RUNNING', 'status belongs to reconciliation, not to the mirror');
    assert.equal(state.lastSeenAt, '2020-01-01T00:00:00.000Z');
    assert.equal(state.lastError, 'stale because the host flapped');
  } finally { await h.child.close(); h.db.close(); }
});

test('reading mirrored events back uses the same cursor contract', async () => {
  const h = await harness({ total: 10 });
  try {
    await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    const first = listMirroredEvents(h.db, h.fleetRunId, 0, 4);
    assert.equal(first.events.length, 4);
    assert.equal(first.nextCursor, 4);
    assert.equal(first.hasMore, true);
    const second = listMirroredEvents(h.db, h.fleetRunId, first.nextCursor, 100);
    assert.equal(second.events[0].sequence, 5, 'resuming from nextCursor continues rather than repeats');
    assert.equal(second.hasMore, false, 'the final partial page must not claim more');
    assert.equal(listMirroredEvents(h.db, 'fr_nonexistent', 0, 10).events.length, 0);
  } finally { await h.child.close(); h.db.close(); }
});

test('mirrored events are cache: dropping them costs a re-read, not data', async () => {
  const h = await harness();
  try {
    await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    h.db.prepare('DELETE FROM fleet_events').run();
    h.bindings.setCursor(h.fleetRunId, 0);
    const r = await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    assert.equal(r.inserted, 10, 'the child still has everything, so the cache is rebuildable');
  } finally { await h.child.close(); h.db.close(); }
});

test('a crash between storing events and advancing the cursor cannot duplicate them', async () => {
  // The window this covers: events are written, then Fleet dies before the cursor write lands. The next
  // process resumes from the OLD cursor and reads the same window again. Without INSERT OR IGNORE that is a
  // primary-key violation inside a timer, and the mirror would fail on every sweep thereafter.
  const h = await harness();
  try {
    await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    h.bindings.setCursor(h.fleetRunId, 0); // as if the cursor write had been lost
    const again = await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    assert.equal(again.inserted, 0, 'every re-read event was already present');
    const n = (h.db.prepare('SELECT COUNT(*) AS n FROM fleet_events').get() as unknown as { n: number }).n;
    assert.equal(n, 10, 'no duplicates and no gaps after replaying the window');
  } finally { await h.child.close(); h.db.close(); }
});

test('a Run that finished before the first sweep still gets its log mirrored', async () => {
  // The bug this guards was found end-to-end, not by a unit test: reconciliation skipped terminal bindings
  // outright, so a short Run that completed between two sweeps had its status recorded and its events dropped
  // forever. Fleet could say a Run had FAILED and never show why.
  const h = await harness({ total: 6, runStatus: 'FAILED' });
  try {
    await sweepOnce(h.dispatch, { events: h.mirrorDeps });
    const page = listMirroredEvents(h.db, h.fleetRunId, 0, 100);
    assert.equal(page.events.length, 6, 'the ending of a Run is the part an operator most needs to see');
    assert.equal(h.bindings.state(h.fleetRunId)!.status, 'FAILED');
    assert.equal(h.bindings.state(h.fleetRunId)!.eventsDrained, true);
  } finally { await h.child.close(); h.db.close(); }
});

test('a drained terminal Run stops costing event reads', async () => {
  const h = await harness({ total: 6, runStatus: 'COMPLETED' });
  try {
    await sweepOnce(h.dispatch, { events: h.mirrorDeps });
    const after = h.log.requests.length;
    assert.ok(after > 0, 'the first pass read the log');
    for (let i = 0; i < 4; i++) await sweepOnce(h.dispatch, { events: h.mirrorDeps });
    assert.equal(h.log.requests.length, after, 'a finished, drained log is not re-read every sweep');
  } finally { await h.child.close(); h.db.close(); }
});

test('a live Run keeps being read and never marks itself drained', async () => {
  const h = await harness({ total: 6, runStatus: 'RUNNING' });
  try {
    await sweepOnce(h.dispatch, { events: h.mirrorDeps });
    assert.equal(h.bindings.state(h.fleetRunId)!.eventsDrained, true, 'the log was read to its end');
    // More events appear; the next pass must pick them up even though the log was drained before.
    h.log.total = 9;
    h.log.runStatus = 'RUNNING';
    const r = await mirrorEvents(h.mirrorDeps, h.fleetRunId);
    assert.equal(r.inserted, 3, 'new events after a drain are still found');
    assert.equal(h.bindings.state(h.fleetRunId)!.cursor, 9);
  } finally { await h.child.close(); h.db.close(); }
});

test('a terminal Run whose log read failed is tried again rather than abandoned', async () => {
  // The gap behind the drain flag. Skipping terminal bindings outright meant one failed event read was
  // permanent: the status said FAILED, the log was empty, and nothing would ever ask the child again.
  const h = await harness({ total: 6, runStatus: 'FAILED', failAfter: 0 });
  try {
    await sweepOnce(h.dispatch, { events: h.mirrorDeps });
    assert.equal(h.bindings.state(h.fleetRunId)!.status, 'FAILED');
    assert.equal(listMirroredEvents(h.db, h.fleetRunId, 0, 10).events.length, 0);
    assert.match(h.bindings.state(h.fleetRunId)!.lastError!, /events unreadable/);
    assert.equal(h.bindings.state(h.fleetRunId)!.eventsDrained, false, 'nothing was drained');

    // The child recovers. A later pass must still owe this Run its log -- and owing it must not reopen the
    // status question, or "retry the events" quietly becomes "re-read everything" and the terminal skip stops
    // meaning anything. Sampled here, while the Run is terminal AND still owes the log; once the log lands the
    // Run is drained and a later pass takes the skip path instead, which would prove nothing.
    const statusReads = h.log.statusRequests ?? 0;
    h.log.failAfter = null;
    await sweepOnce(h.dispatch, { events: h.mirrorDeps });
    const page = listMirroredEvents(h.db, h.fleetRunId, 0, 10);
    assert.equal(page.events.length, 6, 'the log arrived on a later pass');
    assert.equal(h.bindings.state(h.fleetRunId)!.status, 'FAILED', 'and the settled status was not disturbed');
    assert.equal(h.log.statusRequests ?? 0, statusReads,
      'a terminal Run that owes events must not cost another status read');
  } finally { await h.child.close(); h.db.close(); }
});

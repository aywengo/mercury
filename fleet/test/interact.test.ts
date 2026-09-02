import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openFleetDb } from '../db.ts';
import { HostRegistry } from '../registry.ts';
import { BindingStore } from '../bindings.ts';
import { createChildClient } from '../child.ts';
import { submitRun, DispatchError, type DispatchDeps } from '../dispatch.ts';
import { cancelRun, retryRun, sendInput } from '../interact.ts';

interface Behaviour {
  /** HTTP status each verb answers; 0 means drop the socket (transport failure). */
  input?: number; cancel?: number; retry?: number;
  retryRunId?: string;
  seen: string[];
  bodies: unknown[];
}

async function fakeChild(b: Behaviour): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    const verb = parts[parts.length - 1] ?? '';
    b.seen.push(`${req.method} ${verb}`);
    const answer = () => {
      const status = b[verb as 'input' | 'cancel' | 'retry'] ?? 200;
      if (status === 0) { req.socket.destroy(); return; }
      if (status >= 400) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'run is already terminal' }));
        return;
      }
      if (req.method === 'POST' && verb === 'runs') {
        // The create envelope, distinct from every verb below. A fake that answers this with the wrong shape
        // makes the harness itself wrong in the same way as the code, and then nothing is proven.
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runId: 'run_1', status: 'QUEUED' }));
        return;
      }
      res.writeHead(verb === 'retry' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(verb === 'retry'
        ? JSON.stringify({ runId: b.retryRunId ?? 'run_new', status: 'QUEUED', retryOf: 'run_1' })
        : verb === 'cancel'
          ? JSON.stringify({ runId: 'run_1', status: 'CANCELLED' })
          : JSON.stringify({ ok: true }));
    };
    if (req.method === 'POST' && (req.headers['content-length'] ?? '0') !== '0') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => { b.bodies.push(raw ? JSON.parse(raw) : null); answer(); });
      return;
    }
    answer();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

async function harness(behaviour: Behaviour = { seen: [], bodies: [] }) {
  const child = await fakeChild(behaviour);
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  registry.add({ id: 'studio', baseUrl: child.url, credentialRef: 'lan-ref' });
  const bindings = new BindingStore(db);
  const dispatch: DispatchDeps = {
    registry, bindings,
    child: createChildClient({ timeoutMs: 800 }),
    resolveToken: () => 'secret-value',
  };
  const { binding } = await submitRun(dispatch, { hostId: 'studio', ownerId: 'alice', requested: { task: 'x' } });
  const ins = db.prepare('INSERT INTO fleet_events (fleet_run_id, sequence, type, timestamp, payload) VALUES (?,?,?,?,?)');
  for (let i = 1; i <= 3; i++) ins.run(binding.fleetRunId, i, 'run.log', '2026-01-01T00:00:00.000Z', null);
  bindings.setCursor(binding.fleetRunId, 3, true);
  return { behaviour, child, db, bindings, dispatch, id: binding.fleetRunId };
}

const err = async (fn: () => Promise<unknown>): Promise<DispatchError> => {
  try { await fn(); } catch (e) { return e as DispatchError; }
  throw new Error('expected a rejection');
};

test('input is forwarded to the child verbatim', async () => {
  const h = await harness();
  try {
    const out = await sendInput(h.dispatch, h.id, { answer: 'yes, deploy it' });
    assert.equal(out.unknown, false);
    // bodies[0] is the Run creation from the harness; the input is the next POST.
    assert.deepEqual(h.behaviour.bodies.at(-1), { input: { answer: 'yes, deploy it' } });
  } finally { await h.child.close(); h.db.close(); }
});

test('an unconfirmed input is reported as unconfirmed, not delivered', async () => {
  const h = await harness({ input: 0, seen: [], bodies: [] });
  try {
    const out = await sendInput(h.dispatch, h.id, 'go');
    assert.equal(out.unknown, true);
    assert.match(out.note!, /unconfirmed/);
  } finally { await h.child.close(); h.db.close(); }
});

test('a successful cancel records the status the child reported', async () => {
  const h = await harness();
  try {
    const out = await cancelRun(h.dispatch, h.id);
    assert.equal(out.status, 'CANCELLED');
    assert.equal(h.bindings.state(h.id)!.status, 'CANCELLED');
  } finally { await h.child.close(); h.db.close(); }
});

test('an unconfirmed cancel is NOT recorded as cancelled', async () => {
  // The expensive mistake: telling an operator a Run stopped when it is still running and spending money.
  const h = await harness({ cancel: 0, seen: [], bodies: [] });
  try {
    h.bindings.recordState({ fleetRunId: h.id, status: 'RUNNING', cursor: 3, lastSeenAt: null, lastError: null });
    const out = await cancelRun(h.dispatch, h.id);
    assert.equal(out.unknown, true);
    assert.equal(h.bindings.state(h.id)!.status, 'RUNNING', 'the last known status stands');
    assert.match(out.note!, /reconciliation/);
  } finally { await h.child.close(); h.db.close(); }
});

test('a child refusal is a client error carrying the child reason', async () => {
  const h = await harness({ cancel: 409, seen: [], bodies: [] });
  try {
    const e = await err(() => cancelRun(h.dispatch, h.id));
    assert.equal(e.status, 400);
    assert.match(e.message, /run is already terminal/);
  } finally { await h.child.close(); h.db.close(); }
});

test('retry follows the binding to the new child Run and clears the mirror', async () => {
  const h = await harness({ retryRunId: 'run_second', seen: [], bodies: [] });
  try {
    const out = await retryRun(h.dispatch, h.id);
    assert.equal(out.childRunId, 'run_second');
    assert.equal(h.bindings.get(h.id)!.childRunId, 'run_second');
    assert.match(out.note!, /superseded/);
    // The mirror is keyed on the child's sequence, and the new Run restarts at 1.
    const n = (h.db.prepare('SELECT COUNT(*) AS n FROM fleet_events').get() as unknown as { n: number }).n;
    assert.equal(n, 0, 'the previous Run events must not be served as the new Run log');
    const state = h.bindings.state(h.id)!;
    assert.equal(state.cursor, 0);
    assert.equal(state.eventsDrained, false, 'the new log has not been read yet');
    assert.equal(state.status, 'QUEUED');
  } finally { await h.child.close(); h.db.close(); }
});

test('an unconfirmed retry leaves the binding untouched and says so loudly', async () => {
  // The dangerous case: the child may have created a Run Fleet never learned about. Silently keeping the old
  // binding would look like nothing happened.
  const h = await harness({ retry: 0, seen: [], bodies: [] });
  try {
    const before = h.bindings.get(h.id)!.childRunId;
    const out = await retryRun(h.dispatch, h.id);
    assert.equal(out.unknown, true);
    assert.equal(h.bindings.get(h.id)!.childRunId, before, 'no silent rebind');
    assert.match(out.note!, /may exist that Fleet has not bound/);
  } finally { await h.child.close(); h.db.close(); }
});

test('acting on a Run with no child yet is refused rather than guessed', async () => {
  const h = await harness({ input: 0, cancel: 0, retry: 0, seen: [], bodies: [] });
  try {
    // Force a pending binding: dispatch that never got an answer.
    h.bindings.createPending({ fleetRunId: 'fr_pending_1', hostId: 'studio', ownerId: 'alice', requested: {} });
    const e = await err(() => cancelRun(h.dispatch, 'fr_pending_1'));
    assert.equal(e.status, 409);
    assert.match(e.message, /no child Run yet/);
  } finally { await h.child.close(); h.db.close(); }
});

test('an unknown Fleet Run is a 404', async () => {
  const h = await harness();
  try {
    const e = await err(() => sendInput(h.dispatch, 'fr_nope', 'x'));
    assert.equal(e.status, 404);
  } finally { await h.child.close(); h.db.close(); }
});

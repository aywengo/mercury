import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { openFleetDb } from '../db.ts';
import { HostRegistry } from '../registry.ts';
import { BindingStore } from '../bindings.ts';
import { startEventStream } from '../stream.ts';

/** A response stand-in that records what the stream tried to send and how it finished. */
function fakeRes(): {
  res: ServerResponse; frames: string[]; ended: () => boolean; destroyed: () => boolean;
  blockWrites: () => void;
} {
  const ee = new EventEmitter() as any;
  const frames: string[] = [];
  let ended = false;
  let destroyed = false;
  let blocked = false;
  ee.write = (chunk: string) => {
    if (blocked) return false;
    frames.push(String(chunk));
    return true;
  };
  ee.end = () => { ended = true; };
  ee.destroy = () => { destroyed = true; };
  ee.flushHeaders = () => {};
  ee.writableEnded = false;
  Object.defineProperty(ee, 'writableEnded', { get: () => ended });
  return { res: ee as ServerResponse, frames, ended: () => ended, destroyed: () => destroyed,
           blockWrites: () => { blocked = true; } };
}

function seeded() {
  const { db } = openFleetDb(':memory:');
  const registry = new HostRegistry(db);
  registry.add({ id: 'studio', baseUrl: 'http://127.0.0.1:1', credentialRef: 'r' });
  const bindings = new BindingStore(db);
  db.prepare(
    `INSERT INTO fleet_runs (fleet_run_id, host_id, owner_id, child_run_id, requested, created_at)
     VALUES ('fr_1', 'studio', 'alice', 'run_1', '{}', ?)`,
  ).run(new Date().toISOString());
  bindings.recordState({ fleetRunId: 'fr_1', status: 'RUNNING', cursor: 0, lastSeenAt: null, lastError: null });
  const ins = db.prepare('INSERT INTO fleet_events (fleet_run_id, sequence, type, timestamp, payload) VALUES (?,?,?,?,?)');
  for (let i = 1; i <= 3; i++) ins.run('fr_1', i, 'run.log', '2026-01-01T00:00:00.000Z', null);
  return { db, bindings };
}

test('a throwing read ends the stream instead of taking the process down', async () => {
  // A throw inside a setInterval callback is an uncaught exception, not a failed request: one bad read would
  // kill the service and every other open stream with it. The timer body has to be wrapped.
  const { db, bindings } = seeded();
  const f = fakeRes();
  let errors: unknown[] = [];
  let endReason = '';
  const handle = startEventStream(f.res, {
    db, bindings, fleetRunId: 'fr_1', pollIntervalMs: 20,
    onError: (e) => errors.push(e), onEnd: (r) => { endReason = r; },
  });
  assert.equal(f.frames.length > 0, true, 'the backlog went out first');
  // Close the database out from under the stream: the next poll throws, exactly as it would during a race
  // with shutdown.
  db.close();
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(errors.length > 0, 'the failure was reported rather than swallowed');
  assert.equal(handle.closed, true, 'the stream stopped rather than retrying a dead handle forever');
  assert.equal(endReason, 'read failed');
});

test('a subscriber that stops reading is destroyed, not gracefully ended', async () => {
  // Ending lets the kernel keep buffering a transcript nobody will read, and the event whose write returned
  // false is not yet in the cursor, so a reconnect could receive it twice.
  const { db, bindings } = seeded();
  const f = fakeRes();
  f.blockWrites();
  let reason = '';
  const handle = startEventStream(f.res, {
    db, bindings, fleetRunId: 'fr_1', pollIntervalMs: 20, onEnd: (r) => { reason = r; },
  });
  assert.equal(handle.closed, true);
  assert.equal(f.destroyed(), true, 'the socket is torn down');
  assert.equal(f.ended(), false, 'and not left buffering a graceful end');
  assert.equal(reason, 'backpressure');
  db.close();
});

test('end() throwing on a destroyed socket does not escape teardown', async () => {
  const { db, bindings } = seeded();
  const f = fakeRes();
  (f.res as any).end = () => { throw new Error('socket destroyed'); };
  let threw = false;
  try {
    const handle = startEventStream(f.res, { db, bindings, fleetRunId: 'fr_1', pollIntervalMs: 20 });
    handle.stop();
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'a socket already gone is not an error worth propagating');
  db.close();
});

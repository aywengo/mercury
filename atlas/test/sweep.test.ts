/**
 * The maintenance sweep (#562).
 *
 * Atlas shipped three retention methods with no caller for any of them, so the tables grew without bound
 * while the code read as though a policy were in force. These tests pin which halves got wired and, more
 * importantly, the half that must NEVER be wired without a protocol change.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.ts';
import { createRedactor } from '../redact.ts';
import { NoteStore } from '../notes.ts';
import { startMaintenanceSweep } from '../sweep.ts';
import type { AtlasConfig } from '../config.ts';

const IDENTITY = 'github.com/aywengo/mercury';
const BOUNDS = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidenceItems: 8 };

function harness() {
  const db = openDatabase(':memory:');
  const store = new NoteStore(db, BOUNDS as never, createRedactor([]));
  const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const log = {
    info: (msg: string, fields?: Record<string, unknown>) => logs.push({ level: 'info', msg, fields }),
    error: (msg: string, fields?: Record<string, unknown>) => logs.push({ level: 'error', msg, fields }),
  };
  const config = {
    sweepIntervalMs: 60_000,
    staleCandidateAgeMs: 1_000,
    idempotencyRetentionMs: 1_000,
  } as unknown as AtlasConfig;
  store.createProject({ id: 'p', name: 'p', repoIdentities: [IDENTITY], promotionPolicy: null });
  const contribute = (claim: string, host = 'host-a', key = 'k') => {
    const r = store.contribute('p', host, [{
      kind: 'fact', scope: 'project', claim, evidence: [],
      provenance: { source: 'agent-reported', hostId: host, runId: `run-${claim}`, agent: 'primeagent', harnessVersion: '1.0.0', recordedAt: new Date().toISOString() },
      repoIdentity: IDENTITY,
    } as never], key, 500) as unknown as Record<string, string>[];
    return r[0]!.accepted!;
  };
  // retireStaleCandidates() requires BOTH that the note stopped being updated AND that no source arrived
  // after the cutoff, so ageing only `notes` leaves the second condition holding and the sweep correctly
  // finds nothing to do. Age both to model a genuinely stale note.
  const age = (noteId: string) => {
    db.prepare("UPDATE notes SET updated_at = '2020-01-01T00:00:00.000Z' WHERE note_id = ?").run(noteId);
    db.prepare("UPDATE note_sources SET recorded_at = '2020-01-01T00:00:00.000Z' WHERE note_id = ?").run(noteId);
  };
  return { db, store, log, logs, config, contribute, age };
}

test('the sweep retires stale uncorroborated candidates', () => {
  const h = harness();
  const noteId = h.contribute('a convention nobody re-confirmed');
  assert.equal(h.store.getNote('p', noteId)!.note.tier, 'candidate');
  const sweep = startMaintenanceSweep({ store: h.store, config: h.config, log: h.log });
  try {
    const out = sweep.runOnce();
    // staleCandidateAgeMs is 1s and the note was written moments ago, so the first pass may legitimately
    // find nothing. Drive time forward the way the query reads it: re-age the row.
    h.age(noteId);
    const second = sweep.runOnce();
    assert.equal(out.retired, 0, 'nothing should be stale on the first pass');
    assert.equal(second.retired, 1);
    assert.equal(h.store.getNote('p', noteId)!.note.tier, 'retired');
  } finally { sweep.stop(); }
});

test('retiring through the sweep is visible to replicas, because it emits a seq row', () => {
  // This is the property that makes the sweep safe to run at all, and the reason the delete half was
  // removed instead. A replica advances by cursor; if retirement produced no seq row it would never land.
  const h = harness();
  const noteId = h.contribute('a convention nobody re-confirmed');
  const before = h.store.feed('p', 0, 'all', { limit: 100 });
  h.age(noteId);
  const sweep = startMaintenanceSweep({ store: h.store, config: h.config, log: h.log });
  try { sweep.runOnce(); } finally { sweep.stop(); }
  const after = h.store.feed('p', 0, 'all', { limit: 100 });
  assert.ok(after.nextSeq > before.nextSeq,
    `the retirement produced no new seq (${before.nextSeq} -> ${after.nextSeq}), so a replica advancing by cursor could never learn of it`);
  const entry = after.notes.find((x) => x.noteId === noteId);
  assert.ok(entry, 'the retirement is not in the feed at all');
  assert.equal(entry.tier, 'retired');
});

test('the sweep prunes expired idempotency keys', () => {
  const h = harness();
  h.contribute('a claim', 'host-a', 'key-to-expire');
  const live = h.db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get() as { n: number };
  assert.ok(live.n > 0, 'precondition: a key was recorded');
  h.db.prepare("UPDATE idempotency_keys SET created_at = '2020-01-01T00:00:00.000Z'").run();
  const sweep = startMaintenanceSweep({ store: h.store, config: h.config, log: h.log });
  try {
    const out = sweep.runOnce();
    assert.ok(out.idempotencyKeys >= 1);
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get() as { n: number }).n, 0);
  } finally { sweep.stop(); }
});

test('the sweep never deletes a note, retired or otherwise', () => {
  // Atlas retains retired notes indefinitely. Deleting produces no seq row, so a replica advancing by
  // cursor would keep serving a note Atlas had destroyed with nothing to reconcile against. Pinned here so
  // re-adding a bare DELETE fails a test rather than shipping a replication hole.
  const h = harness();
  const noteId = h.contribute('a retired note that must survive');
  h.store.retire('p', noteId, 'operator', 'superseded');
  h.db.prepare("UPDATE notes SET updated_at = '2000-01-01T00:00:00.000Z' WHERE note_id = ?").run(noteId);
  const sweep = startMaintenanceSweep({ store: h.store, config: h.config, log: h.log });
  try { sweep.runOnce(); sweep.runOnce(); } finally { sweep.stop(); }
  assert.ok(h.store.getNote('p', noteId), 'the retired note was deleted; replicas can never learn of it');
  assert.equal(h.store.getNote('p', noteId)!.note.tier, 'retired');
});

test('a throw inside a sweep pass is logged and does not stop later passes', () => {
  // A throw inside a setInterval callback is an uncaught exception, not a failed tick: it would take the
  // process down and end every future sweep with it.
  const h = harness();
  const original = h.store.retireStaleCandidates.bind(h.store);
  let calls = 0;
  (h.store as unknown as { retireStaleCandidates: (ms: number) => string[] }).retireStaleCandidates = (ms: number) => {
    calls++;
    if (calls === 1) throw new Error('simulated lock failure');
    return original(ms);
  };
  const sweep = startMaintenanceSweep({ store: h.store, config: h.config, log: h.log });
  try {
    assert.doesNotThrow(() => sweep.runOnce(), 'the first pass threw and escaped the sweep');
    const second = sweep.runOnce();
    assert.equal(typeof second.retired, 'number', 'the second pass did not run');
    assert.ok(h.logs.some((l) => l.level === 'error' && l.msg.includes('sweep failed')),
      'the failure was swallowed silently instead of logged');
  } finally { sweep.stop(); }
});

test('stop() clears the timer so the process is not held open by the sweep', () => {
  const h = harness();
  const sweep = startMaintenanceSweep({ store: h.store, config: h.config, log: h.log });
  sweep.stop();
  // A second stop must be harmless: close() can race with a shutdown path that already stopped it.
  assert.doesNotThrow(() => sweep.stop());
});

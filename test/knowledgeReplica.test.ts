/**
 * The replica and its cursor (docs/knowledge-base.md 8.3).
 *
 * Every test here is about one thing: the replica must never be the reason a Run is told something false.
 * A stale replica costs freshness, which is survivable. A replica that lost a note, rolled a note back,
 * or advanced past a note it never stored costs correctness, and no amount of later pulling fixes it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db/database.ts';
import { ReplicaStore } from '../src/knowledge/replica.ts';
import { knowledgeStatus } from '../src/knowledge/status.ts';
import type { Note } from '../src/knowledge/types.ts';
import type { KnowledgeConfig } from '../src/config.ts';

const CFG: KnowledgeConfig = {
  atlas: { url: 'http://atlas:1', token: 't', project: 'mercury', hostId: 'h', caFile: null, adminToken: null },
  inject: true, packMaxBytes: 1, pushIntervalMs: 1, pushBatch: 1, pullIntervalMs: 1, outboxAlertDepth: 1,
  bounds: { maxNotesPerRun: 1, maxClaimBytes: 1, maxDetailBytes: 1, maxEvidence: 1, harvestTimeoutMs: 1 },
};

function note(over: Partial<Note> & { noteId: string; seq: number }): Note {
  return {
    revision: 1, projectId: 'mercury', kind: 'fact', scope: 'project', claim: `claim ${over.noteId}`,
    evidence: [], tier: 'promoted', corroboration: { runs: 1, harnesses: 1, hosts: 1 },
    provenance: { source: 'agent-reported', hostId: 'host-a', recordedAt: '2026-01-01T00:00:00.000Z' },
    ...over,
  } as Note;
}

test('the cursor is null until a pull commits, and never-pulled is not the same as zero', () => {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  assert.equal(rep.getCursor('mercury'), null, 'no row means never pulled');

  // An empty page still advances the cursor. A project whose sequence moved only through promotions and
  // retirements this host does not carry would otherwise be re-requested from zero on every tick, forever.
  rep.applyBatch('mercury', [], 7, '2026-01-02T00:00:00.000Z');
  assert.equal(rep.getCursor('mercury'), 7);
  assert.equal(rep.count('mercury'), 0);
});

test('the cursor advances only with the notes it describes', () => {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  rep.applyBatch('mercury', [note({ noteId: 'a', seq: 3 })], 3, '2026-01-02T00:00:00.000Z');
  assert.equal(rep.getCursor('mercury'), 3);
  assert.equal(rep.count('mercury'), 1);

  // A lower nextSeq must not rewind. Two pulls racing would otherwise move the cursor backwards and
  // re-deliver a range the replica already holds.
  rep.applyBatch('mercury', [], 1, '2026-01-03T00:00:00.000Z');
  assert.equal(rep.getCursor('mercury'), 3, 'the cursor is a high-water mark, not a last-seen value');
});

test('a replayed page cannot roll a note back to an older revision', () => {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  rep.applyBatch('mercury', [note({ noteId: 'a', seq: 10, revision: 4, claim: 'the corrected claim' })], 10, '2026-01-02T00:00:00.000Z');
  // A page that overlaps because a previous pull died after committing but before advancing.
  const res = rep.applyBatch('mercury', [note({ noteId: 'a', seq: 5, revision: 1, claim: 'the stale claim' })], 10, '2026-01-03T00:00:00.000Z');
  assert.equal(res.skipped, 1);
  const [row] = rep.promoted('mercury');
  assert.equal(row!.revision, 4, 'the newer revision survives a replay');
  assert.equal(row!.claim, 'the corrected claim');
});

test('a retirement removes the note from what selection may read, and keeps the row', () => {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  rep.applyBatch('mercury', [note({ noteId: 'a', seq: 1 })], 1, '2026-01-02T00:00:00.000Z');
  assert.equal(rep.count('mercury'), 1);

  // Section 11.2: the promoted feed carries transitions OUT of promoted as well.
  rep.applyBatch('mercury', [note({ noteId: 'a', seq: 2, tier: 'retired' })], 2, '2026-01-03T00:00:00.000Z');
  assert.equal(rep.count('mercury'), 0, 'a retired note must not reach a pack');
  const rows = db.prepare('SELECT tier FROM knowledge_replica WHERE note_id = ?').all('a') as { tier: string }[];
  assert.equal(rows.length, 1, 'the row is kept, so a later pull that re-promotes it updates rather than duplicates');
  assert.equal(rows[0]!.tier, 'retired');
});

test('a contested note stays contested through the replica', () => {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  rep.applyBatch('mercury', [note({ noteId: 'a', seq: 1, contested: true })], 1, '2026-01-02T00:00:00.000Z');
  const [row] = rep.promoted('mercury');
  assert.equal(row!.contested, true,
    'a pack that shows one side of an open disagreement as settled is worse than a pack that omits it');
});

test('maxSeq reports the replica position, and null when it is empty', () => {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  assert.equal(rep.maxSeq('mercury'), null);
  rep.applyBatch('mercury', [note({ noteId: 'a', seq: 4 }), note({ noteId: 'b', seq: 9 })], 9, '2026-01-02T00:00:00.000Z');
  assert.equal(rep.maxSeq('mercury'), 9);
});

test('status distinguishes never-pulled from pulled-and-empty', () => {
  const fresh = openDatabase(':memory:');
  const never = knowledgeStatus(fresh, CFG);
  assert.equal(never.replica.cursor, null, 'never reached Atlas');
  assert.equal(never.replica.notes, 0);

  const pulled = openDatabase(':memory:');
  new ReplicaStore(pulled).applyBatch('mercury', [], 12, '2026-01-02T00:00:00.000Z');
  const done = knowledgeStatus(pulled, CFG);
  assert.equal(done.replica.cursor, 12, 'reached Atlas and found nothing promoted');
  assert.equal(done.replica.notes, 0);
  assert.notEqual(never.replica.cursor, done.replica.cursor,
    'these two need different operator actions, so they must not render identically');
});

test('clear removes both the notes and the cursor, so a rebind starts from bootstrap', () => {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  rep.applyBatch('mercury', [note({ noteId: 'a', seq: 3 })], 3, '2026-01-02T00:00:00.000Z');
  assert.equal(rep.clear('mercury'), 1);
  assert.equal(rep.getCursor('mercury'), null,
    'a stale cursor with an empty replica would page from the middle and never bootstrap');
});

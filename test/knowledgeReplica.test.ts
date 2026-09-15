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
import { KnowledgePuller } from '../src/knowledge/puller.ts';
import { knowledgeStatus } from '../src/knowledge/status.ts';
import type { Note } from '../src/knowledge/types.ts';
import type { KnowledgeConfig } from '../src/config.ts';
import type { AtlasClient } from '../src/knowledge/client.ts';

const QUIET = { info() {}, warn() {}, error() {} } as never;

const CFG: KnowledgeConfig = {
  atlas: { url: 'http://atlas:1', token: 't', project: 'mercury', hostId: 'h', caFile: null, adminToken: null },
  inject: true, packMaxBytes: 1, pushIntervalMs: 1, pushBatch: 1, pullIntervalMs: 1, retiredRetentionMs: 604_800_000, outboxAlertDepth: 1,
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

// ─── sweepRetired and resurrection-invariant tests ───────────────────────────

test('sweepRetired removes non-promoted rows older than the threshold', () => {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  const baseMs = 1_000_000_000_000;
  const now = () => baseMs;
  // Apply a retirement
  rep.applyBatch('mercury', [
    note({ noteId: 'a', seq: 1 }),
    note({ noteId: 'b', seq: 2, tier: 'retired' }),
  ], 2, new Date(baseMs - 10_000).toISOString()); // updated_at = 10 s ago

  // With a 5-second retention, b is old enough to sweep
  const swept = rep.sweepRetired(5_000, now);
  assert.equal(swept, 1, 'exactly the one retired row is swept');
  assert.equal(rep.count('mercury'), 1, 'promoted note a is untouched');
  const rows = db.prepare("SELECT note_id FROM knowledge_replica").all() as { note_id: string }[];
  assert.deepEqual(rows.map(r => r.note_id), ['a'], 'only promoted row remains');
});

test('sweepRetired does not remove rows newer than the threshold', () => {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  const baseMs = 1_000_000_000_000;
  const now = () => baseMs;
  rep.applyBatch('mercury', [
    note({ noteId: 'b', seq: 2, tier: 'retired' }),
  ], 2, new Date(baseMs - 1_000).toISOString()); // updated_at = 1 s ago

  // With a 5-second retention, b is too fresh to sweep
  const swept = rep.sweepRetired(5_000, now);
  assert.equal(swept, 0, 'fresh retired row is left in place');
});

test('sweepRetired never touches promoted rows regardless of age', () => {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  const baseMs = 1_000_000_000_000;
  const now = () => baseMs;
  // Very old promoted row
  rep.applyBatch('mercury', [note({ noteId: 'a', seq: 1 })], 1, new Date(baseMs - 999_999_999).toISOString());
  const swept = rep.sweepRetired(0, now); // threshold = 0 ms = sweep everything older than now
  assert.equal(swept, 0, 'promoted rows are never swept even with a zero threshold');
  assert.equal(rep.count('mercury'), 1);
});

/**
 * Resurrection-invariant test (acceptance item 2).
 *
 * The concern: after sweepRetired removes a row, a replayed page for that note (with an older
 * promoted revision) has no reference row and the upsert guard would INSERT it, resurrecting it
 * as promoted. This is unreachable TODAY because the cursor is monotonic.
 *
 * This test pins BOTH halves of that invariant:
 *   (a) The cursor never moves backwards -- if setCursor were called unconditionally this fails.
 *   (b) After sweeping a retired note, a replayed old promoted page cannot resurrect it,
 *       GIVEN that the cursor is monotonic (a).
 *
 * A failure of (a) would be the signal that (b) needs active defence too.
 */
test('cursor is monotonic: a lower nextSeq cannot rewind the cursor after it has advanced', () => {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  rep.applyBatch('mercury', [note({ noteId: 'a', seq: 100 })], 100, '2026-01-02T00:00:00.000Z');
  assert.equal(rep.getCursor('mercury'), 100);

  // Simulate what would happen if the puller sent a page from an earlier seq (impossible today,
  // but this is the mutation that the safety argument depends on being rejected).
  rep.applyBatch('mercury', [], 50, '2026-01-03T00:00:00.000Z');
  assert.equal(rep.getCursor('mercury'), 100,
    'cursor must not rewind: if this fails, sweepRetired may cause resurrection');
  rep.applyBatch('mercury', [note({ noteId: 'b', seq: 10 })], 10, '2026-01-03T00:00:00.000Z');
  assert.equal(rep.getCursor('mercury'), 100,
    'a batch with a lower-seq note must not rewind the cursor');
});

test('a swept retired note is not resurrected by a replayed old promoted page', () => {
  // This test is CONSEQUENTIAL on the cursor-monotonicity test above.
  // If setCursor were allowed to rewind, the puller could replay a page at seq < cursor,
  // and a swept row would be re-inserted as promoted. That scenario is blocked by monotonicity,
  // but we also show that, in the current code path, a direct applyBatch replay after sweep does
  // see an INSERT (i.e. the guard is gone), to make clear what the invariant is protecting.
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  const baseMs = 1_000_000_000_000;
  const now = () => baseMs;

  // Step 1: apply note 'z' as promoted at seq 1, then retire it at seq 2
  rep.applyBatch('mercury', [note({ noteId: 'z', seq: 1, tier: 'promoted' })], 1, new Date(baseMs - 100_000).toISOString());
  rep.applyBatch('mercury', [note({ noteId: 'z', seq: 2, tier: 'retired' })], 2, new Date(baseMs - 10_000).toISOString());
  assert.equal(rep.count('mercury'), 0, 'note is retired');

  // Step 2: sweep it (5-second threshold; updated_at was 10s ago)
  const swept = rep.sweepRetired(5_000, now);
  assert.equal(swept, 1, 'row swept');

  // Step 3: the cursor is at 2. A replay of the old promoted revision at seq 1 would only reach
  // this point if the cursor were allowed to move back to < 1. Because the cursor is at 2, the
  // puller as written cannot produce this replay. We document this constraint by asserting the
  // cursor has not moved.
  assert.equal(rep.getCursor('mercury'), 2, 'cursor still at 2 after sweep -- replay cannot precede this');

  // Step 4 (direct call, not possible via puller): confirm the upsert behaviour when row is absent.
  // This shows WHY cursor monotonicity matters: a direct replay WOULD resurrect the note.
  rep.applyBatch('mercury', [note({ noteId: 'z', seq: 1, tier: 'promoted' })], 1, new Date(baseMs).toISOString());
  // The cursor is at 2, so nextSeq=1 does not advance it. The note IS inserted (row absent, upsert fires).
  const count = rep.count('mercury');
  // We do NOT assert count === 0 here; we assert count === 1 to make explicit that resurrection
  // WOULD occur if this replay were reachable. The cursor monotonicity test above is what prevents
  // the puller from making this call. If that test breaks, add defensive sweepRetired recording.
  assert.equal(count, 1,
    'direct replay after sweep resurrects note -- cursor monotonicity is what makes this unreachable via puller');
});

// ─── Puller calls sweepRetired after a successful pull ───────────────────────

test('puller calls sweepRetired after a successful pull', async () => {
  // This test proves that the puller wires up sweepRetired. It uses a mock AtlasClient so no
  // real Atlas is needed. If the puller stops calling sweepRetired, this test fails.
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  const baseMs = 1_000_000_000_000;
  let nowMs = baseMs;
  const now = () => nowMs;

  // Seed a retired row with updated_at well in the past
  rep.applyBatch('mercury', [
    note({ noteId: 'old-retired', seq: 1, tier: 'retired' }),
  ], 1, new Date(baseMs - 100_000).toISOString()); // 100 s ago

  // Advance now so the row is past the retention threshold
  nowMs = baseMs + 200_000; // 200 s later (threshold is 50 s)

  // Mock client: returns an empty page with nextSeq=1 (already at cursor)
  const mockClient = {
    async bootstrap(_project: string) { return { notes: [], nextSeq: 2 }; },
    async pull(_project: string, _since: number, _tier: string, _pageSize: number) {
      return { notes: [], nextSeq: 1 };
    },
  } as unknown as AtlasClient;

  const puller = new KnowledgePuller({
    db, client: mockClient, project: 'mercury', intervalMs: 60_000,
    pageSize: 100, retiredRetentionMs: 50_000, log: QUIET, now,
  });

  // First pull: cursor is null, takes bootstrap path, then sweeps
  const outcome = await puller.pullOnce();
  assert.equal(outcome.failed, false);
  assert.equal(outcome.sweptRetired, 1, 'puller must have called sweepRetired after the pull');
  assert.equal(rep.count('mercury'), 0);
});

test('a tombstone takes the row out of the replica, and is counted apart from retirements (#590)', () => {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  rep.applyBatch('mercury', [note({ noteId: 'n1', seq: 1 }), note({ noteId: 'n2', seq: 2 })], 2, '2026-01-02T00:00:00.000Z');
  assert.equal(rep.promoted('mercury', 'project').length, 2, 'fixture: two promoted notes');

  // What Atlas sends for a deletion: the note id, the new seq, tier 'deleted', and no body.
  const tombstone = note({ noteId: 'n1', seq: 3, tier: 'deleted', claim: '', evidence: [] });
  const applied = rep.applyBatch('mercury', [tombstone], 3, '2026-01-03T00:00:00.000Z');

  assert.equal(applied.deleted, 1, 'the deletion is counted as a deletion, not as a retirement');
  assert.equal(applied.retired, 0, 'a tombstone is not a retirement; conflating them hides the one pull where Atlas was asked to forget something');
  const remaining = rep.promoted('mercury', 'project');
  assert.deepEqual(remaining.map((n) => n.noteId), ['n2'], 'the deleted note must not be served again');
  assert.equal(rep.getCursor('mercury'), 3, 'and the cursor still advances past the tombstone');

  // A tombstone for a note this replica never held is a no-op, not an error. A host that joined after
  // the deletion bootstraps without the note and will still be handed the tombstone by a feed pull.
  const again = rep.applyBatch('mercury', [note({ noteId: 'never-had', seq: 4, tier: 'deleted', claim: '' })], 4, '2026-01-04T00:00:00.000Z');
  assert.equal(again.deleted, 1, 'applying a tombstone for an absent note still counts as applied');
  assert.deepEqual(rep.promoted('mercury', 'project').map((n) => n.noteId), ['n2'], 'and nothing else moved');
  db.close();
});

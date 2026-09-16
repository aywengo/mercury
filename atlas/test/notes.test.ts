import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.ts';
import { NoteStore } from '../notes.ts';
import { createRedactor } from '../redact.ts';
import type { ContributionResult, NoteContribution } from '../types.ts';

/**
 * Narrow a ContributionResult by which arm it is.
 *
 * The result is a closed union, so `result.accepted` does not typecheck without a guard. Repeating
 * `if ('accepted' in result)` at every assertion would bury the thing under test, and casting the whole
 * array to `any[]` would let a renamed arm pass silently -- which is the one mistake this file is meant
 * to catch.
 */
function pick(result: ContributionResult | undefined, key: 'accepted' | 'duplicate' | 'rejected'): string | undefined {
  return result && key in result ? (result as unknown as Record<string, string>)[key] : undefined;
}


function makeContribution(overrides: Partial<NoteContribution> = {}): NoteContribution {
  return {
    projectId: 'test-project',
    kind: 'fact',
    scope: 'project',
    claim: 'test claim',
    evidence: [],
    contradicts: [],
    provenance: {
      source: 'agent-reported',
      hostId: 'host-1',
      runId: 'run-1',
      agent: 'prime',
      harnessVersion: '1.0.0',
      recordedAt: new Date().toISOString(),
    },
    repoIdentity: 'github.com/test/repo',
    ...overrides,
  };
}

test('notes: createProject', () => {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const redactor = createRedactor([]);
  const store = new NoteStore(db, bounds, redactor);
  
  const project = store.createProject({
    id: 'test-project',
    name: 'Test Project',
    repoIdentities: ['github.com/test/repo'],
  });
  
  assert.equal(project.id, 'test-project');
  assert.equal(project.name, 'Test Project');
  assert.deepEqual(project.repoIdentities, ['github.com/test/repo']);
  
  db.close();
});

test('notes: contribution acceptance', () => {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const redactor = createRedactor([]);
  const store = new NoteStore(db, bounds, redactor);
  
  store.createProject({
    id: 'test-project',
    name: 'Test Project',
    repoIdentities: ['github.com/test/repo'],
  });
  
  // First contribution should be accepted
  const contrib1 = makeContribution();
  const results1 = store.contribute('test-project', 'host-1', [contrib1], undefined, 500);
  
  assert.equal(results1.length, 1);
  assert.ok(pick(results1[0], 'accepted'));
  
  db.close();
});

test('notes: deduplication', () => {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const redactor = createRedactor([]);
  const store = new NoteStore(db, bounds, redactor);
  
  store.createProject({
    id: 'test-project',
    name: 'Test Project',
    repoIdentities: ['github.com/test/repo'],
  });
  
  // First contribution
  const contrib1 = makeContribution();
  const result1 = store.contribute('test-project', 'host-1', [contrib1], undefined, 500);
  assert.ok(pick(result1[0], 'accepted'));
  const noteId = pick(result1[0], 'accepted');
  
  // Same claim from another host: should be duplicate
  const contrib2 = makeContribution({
    provenance: { ...contrib1.provenance, hostId: 'host-2', runId: 'run-2' }
  });
  const result2 = store.contribute('test-project', 'host-2', [contrib2], undefined, 500);
  
  assert.equal(result2.length, 1);
  assert.ok(pick(result2[0], 'duplicate'));
  assert.equal(pick(result2[0], 'duplicate'), noteId);
  
  db.close();
});

test('notes: batch over limit is rejected', () => {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const redactor = createRedactor([]);
  const store = new NoteStore(db, bounds, redactor);
  
  store.createProject({
    id: 'test-project',
    name: 'Test Project',
    repoIdentities: ['github.com/test/repo'],
  });
  
  // Create a batch larger than the limit
  const contribs = [makeContribution(), makeContribution({ claim: 'claim 2' })];
  const results = store.contribute('test-project', 'host-1', contribs, undefined, 1);
  
  // All should be rejected with over-batch-limit
  for (const result of results) {
    assert.ok(pick(result, 'rejected'));
    assert.equal(pick(result, 'rejected'), 'over-batch-limit');
  }
  
  db.close();
});

test('notes: unknown-project is rejected', () => {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const redactor = createRedactor([]);
  const store = new NoteStore(db, bounds, redactor);
  
  // Don't create any project
  
  const contrib = makeContribution();
  const results = store.contribute('unknown-project', 'host-1', [contrib], undefined, 500);
  
  assert.equal(results.length, 1);
  assert.ok(pick(results[0], 'rejected'));
  assert.equal(pick(results[0], 'rejected'), 'unknown-project');
  
  db.close();
});

test('notes: repo-not-in-project is rejected', () => {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const redactor = createRedactor([]);
  const store = new NoteStore(db, bounds, redactor);
  
  store.createProject({
    id: 'test-project',
    name: 'Test Project',
    repoIdentities: ['github.com/test/repo'],
  });
  
  // Contribution with repo not in project
  const contrib = makeContribution({
    repoIdentity: 'github.com/other/repo'
  });
  const results = store.contribute('test-project', 'host-1', [contrib], undefined, 500);
  
  assert.equal(results.length, 1);
  assert.ok(pick(results[0], 'rejected'));
  assert.equal(pick(results[0], 'rejected'), 'repo-not-in-project');
  
  db.close();
});

test('notes: secret-detected is rejected', () => {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const redactor = createRedactor(['supersecret']);
  const store = new NoteStore(db, bounds, redactor);
  
  store.createProject({
    id: 'test-project',
    name: 'Test Project',
    repoIdentities: ['github.com/test/repo'],
  });
  
  // Contribution containing a secret
  const contrib = makeContribution({
    claim: 'here is supersecret in the claim'
  });
  const results = store.contribute('test-project', 'host-1', [contrib], undefined, 500);
  
  assert.equal(results.length, 1);
  assert.ok(pick(results[0], 'rejected'));
  assert.equal(pick(results[0], 'rejected'), 'secret-detected');
  
  db.close();
});

test('notes: feed returns promoted notes', () => {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const redactor = createRedactor([]);
  const store = new NoteStore(db, bounds, redactor);
  
  store.createProject({
    id: 'test-project',
    name: 'Test Project',
    repoIdentities: ['github.com/test/repo'],
  });
  
  // Contribute a repo-record (lands promoted)
  const contrib = makeContribution({
    provenance: { ...makeContribution().provenance, source: 'repo-record' }
  });
  store.contribute('test-project', 'host-1', [contrib], undefined, 500);
  
  // Feed should return the promoted note
  const feed = store.feed('test-project', 0, 'promoted', { limit: 100 });
  assert.ok(feed.notes.length > 0);
  assert.equal(feed.notes[0]?.tier, 'promoted');
  
  db.close();
});

test('notes: bootstrap returns promoted notes', () => {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const redactor = createRedactor([]);
  const store = new NoteStore(db, bounds, redactor);
  
  store.createProject({
    id: 'test-project',
    name: 'Test Project',
    repoIdentities: ['github.com/test/repo'],
  });
  
  // Contribute a repo-record (lands promoted)
  const contrib = makeContribution({
    provenance: { ...makeContribution().provenance, source: 'repo-record' }
  });
  store.contribute('test-project', 'host-1', [contrib], undefined, 500);
  
  // Bootstrap should return the promoted notes
  const bootstrap = store.bootstrap('test-project');
  assert.ok(bootstrap.notes.length > 0);
  assert.ok(bootstrap.nextSeq > 0);
  
  db.close();
});

test('notes: getNote retrieves details', () => {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const redactor = createRedactor([]);
  const store = new NoteStore(db, bounds, redactor);
  
  store.createProject({
    id: 'test-project',
    name: 'Test Project',
    repoIdentities: ['github.com/test/repo'],
  });
  
  const contrib = makeContribution();
  const result = store.contribute('test-project', 'host-1', [contrib], undefined, 500);
  const noteId = pick(result[0], 'accepted');
  assert.ok(noteId);
  
  const detail = store.getNote('test-project', noteId);
  assert.ok(detail);
  assert.equal(detail?.note.noteId, noteId);
  assert.equal(detail?.note.claim, contrib.claim);
  
  db.close();
});

/**
 * #552 -- an admin batch retried with the same idempotency key.
 *
 * The insert coalesced a null host to 'admin' because the column is part of a PRIMARY KEY and SQL NULLs
 * are never equal, so storing NULL would let every admin retry re-count corroboration. The two reads kept
 * querying with the raw `hostId`, and `contributor = NULL` matches no row. So an admin retry missed its own
 * cached response, re-evaluated, and then violated the key on insert: a 500 that repeats forever.
 *
 * That is not a slow path. The host pusher derives its key from the batch deterministically by design, so
 * a lost acknowledgement means the retry is the normal case, and `recordFailure()` keeps the rows and
 * retries the same key with exponential backoff. The operator's only symptom was `last_push_error` and a
 * growing outbox.
 */
function makeAdminStore() {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const store = new NoteStore(db, bounds, createRedactor([]));
  store.createProject({ id: 'test-project', name: 'Test Project', repoIdentities: ['github.com/test/repo'] });
  return { db, store };
}

test('admin retry with the same idempotency key replays instead of throwing', () => {
  const { db, store } = makeAdminStore();
  const contrib = makeContribution({ provenance: { ...makeContribution().provenance, source: 'operator', hostId: '' } });

  const first = store.contribute('test-project', null, [contrib], 'admin-key-1', 500);
  assert.ok(pick(first[0], 'accepted'), 'the first admin batch must be accepted');

  // Before the fix this threw `UNIQUE constraint failed: idempotency_keys.contributor, ...key`.
  const retry = store.contribute('test-project', null, [contrib], 'admin-key-1', 500);
  assert.deepEqual(retry, first, 'a retry must replay the recorded response, not re-evaluate the batch');

  // And it must stay replayable: the host backs off and retries the same key until it gets an ack.
  assert.deepEqual(store.contribute('test-project', null, [contrib], 'admin-key-1', 500), first);

  db.close();
});

test('admin retry does not re-count corroboration or consume a seq', () => {
  const { db, store } = makeAdminStore();
  const contrib = makeContribution({ provenance: { ...makeContribution().provenance, source: 'operator', hostId: '' } });

  store.contribute('test-project', null, [contrib], 'admin-key-1', 500);
  const seqAfterFirst = db.prepare('SELECT seq FROM project_seq WHERE project_id = ?').get('test-project') as { seq: number };
  const sourcesAfterFirst = (db.prepare('SELECT COUNT(*) AS n FROM note_sources').get() as { n: number }).n;

  store.contribute('test-project', null, [contrib], 'admin-key-1', 500);
  store.contribute('test-project', null, [contrib], 'admin-key-1', 500);

  const seqAfterRetry = db.prepare('SELECT seq FROM project_seq WHERE project_id = ?').get('test-project') as { seq: number };
  const sourcesAfterRetry = (db.prepare('SELECT COUNT(*) AS n FROM note_sources').get() as { n: number }).n;

  assert.equal(seqAfterRetry.seq, seqAfterFirst.seq,
    'a replayed batch consumed a sequence number, which is the exact re-count the key exists to prevent');
  assert.equal(sourcesAfterRetry, sourcesAfterFirst,
    'a replayed batch attributed the note to its contributor again');

  db.close();
});

test('a contributor retry still replays (the fix must not change the working path)', () => {
  const { db, store } = makeAdminStore();
  const contrib = makeContribution();

  const first = store.contribute('test-project', 'host-1', [contrib], 'host-key-1', 500);
  const retry = store.contribute('test-project', 'host-1', [contrib], 'host-key-1', 500);
  assert.deepEqual(retry, first);

  db.close();
});

test('the same key from an admin and a host are different entries', () => {
  const { db, store } = makeAdminStore();
  const contrib = makeContribution();

  const asAdmin = store.contribute('test-project', null, [contrib], 'shared-key', 500);
  const asHost = store.contribute('test-project', 'host-1', [contrib], 'shared-key', 500);

  // Two different contributors, so two independent batches. Collapsing them would make a host's first
  // batch look like a replay of an admin's and silently drop the host's attribution.
  assert.ok(pick(asAdmin[0], 'accepted') || pick(asAdmin[0], 'duplicate'));
  assert.ok(pick(asHost[0], 'accepted') || pick(asHost[0], 'duplicate'));
  const keys = (db.prepare('SELECT contributor FROM idempotency_keys WHERE key = ?').all('shared-key') as { contributor: string }[])
    .map((r) => r.contributor)
    .sort();
  assert.deepEqual(keys, ['admin', 'host-1']);

  db.close();
});

// --- deletion tombstones (#590) ---------------------------------------------------------------
//
// A note used to be undeletable. A bare DELETE produces no `seq` row, and a replica advances by cursor,
// so every host that had already received the note would have gone on serving text Atlas was asked to
// destroy, permanently, with nothing to reconcile against. The `deleted` tier is the fix, and the
// property that makes it a fix rather than a cosmetic change is narrow enough to be worth stating
// before the tests: the deletion has to arrive in the SAME feed, in seq order, or it is not a deletion
// a replica can see. Test 2 below is the one that would fail if the tier were added to the schema but
// left out of the feed query, and it is the reason the others are allowed to be smaller.

function tombstoneFixture(claim = 'npm run test:atlas is the focused suite') {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const store = new NoteStore(db, bounds, createRedactor([]));
  store.createProject({ id: 'test-project', name: 'Test Project', repoIdentities: ['github.com/test/repo'] });
  // repo-record lands promoted, so one contribute() gives a note in the tier replicas actually hold.
  store.contribute('test-project', 'host-1',
    [makeContribution({ claim, detail: 'the why', evidence: [{ type: 'issue', url: 'https://x/1' }] ,
      provenance: { ...makeContribution().provenance, source: 'repo-record' } })], undefined, 500);
  const before = store.feed('test-project', 0, 'promoted', { limit: 100 });
  return { db, store, noteId: before.notes[0]!.noteId, seqBefore: before.notes[0]!.seq, cursor: before.nextSeq };
}

test('deletion: writes a sequence-bearing tombstone and empties the note body', () => {
  const { db, store, noteId, seqBefore } = tombstoneFixture();
  const tomb = store.deleteNote('test-project', noteId, 'admin', 'secret in the claim');
  assert.ok(tomb, 'the deletion must return the note it wrote');
  assert.equal(tomb.tier, 'deleted');
  // The sequence number is the entire mechanism. Without a fresh seq the tombstone is invisible to a
  // replica that has already paged past the note, which is every replica that matters.
  assert.ok(tomb.seq > seqBefore, `tombstone seq ${tomb.seq} must exceed the note's ${seqBefore}`);
  assert.equal(tomb.claim, '', 'a tombstone must not carry the claim it was created to remove');
  assert.equal(tomb.detail, undefined, 'nor the detail');
  assert.deepEqual(tomb.evidence, [], 'nor the evidence');
  // The audit trail survives: section 12 keeps promotions indefinitely, and "what did Mercury believe
  // here in March" has to stay answerable after the body is gone.
  const detail = store.getNote('test-project', noteId)!;
  assert.equal(detail.note.tier, 'deleted');
  const transitions = (db.prepare('SELECT from_tier, to_tier, reason FROM promotions WHERE note_id = ? ORDER BY seq')
    .all(noteId) as unknown as { from_tier: string; to_tier: string; reason: string }[]);
  // Spread into a plain object: node:sqlite returns rows with a null prototype, and deepStrictEqual
  // compares prototypes, so a row that matches field for field still fails it.
  assert.deepEqual({ ...transitions.at(-1)! }, { from_tier: 'promoted', to_tier: 'deleted', reason: 'secret in the claim' });
  db.close();
});

test('deletion: the promoted feed carries the tombstone, so a replica learns to forget', () => {
  const { db, store, noteId, cursor } = tombstoneFixture();
  // A replica that has already caught up. Everything it will ever learn is past this cursor.
  const beforeDelete = store.feed('test-project', cursor, 'promoted', { limit: 100 });
  assert.equal(beforeDelete.notes.length, 0, 'fixture: the replica is caught up before the deletion');

  store.deleteNote('test-project', noteId, 'admin', 'retired then deleted');

  const after = store.feed('test-project', cursor, 'promoted', { limit: 100 });
  assert.equal(after.notes.length, 1, 'the deletion must appear in the promoted feed');
  assert.equal(after.notes[0]!.noteId, noteId);
  assert.equal(after.notes[0]!.tier, 'deleted');
  assert.ok(after.nextSeq > cursor, 'and it must advance the cursor, or a replica re-reads it forever');
  db.close();
});

test('deletion: a deleted note does not hold its claim hostage', () => {
  const { db, store, noteId } = tombstoneFixture('the release branch is cut from the tag');
  store.deleteNote('test-project', noteId, 'admin', 'wrong in the first revision');
  // The live-claim index is partial and excludes `deleted`. If it did not, this contribution would hit
  // SQLITE_CONSTRAINT_UNIQUE and deletion would be permanent in the direction nobody asked for: one
  // delete, and that claim could never be re-earned by anyone, ever again.
  // hostId comes from the token binding and the body must agree with it (section 11.4), so a second
  // host has to say so in its provenance too -- otherwise this fails on host-mismatch and proves nothing.
  const again = store.contribute('test-project', 'host-2',
    [makeContribution({ claim: 'the release branch is cut from the tag',
      provenance: { ...makeContribution().provenance, hostId: 'host-2' } })], undefined, 500);
  assert.ok(pick(again[0], 'accepted'), `a re-earned claim must be accepted, got ${JSON.stringify(again)}`);
  db.close();
});

test('deletion: requires a reason, and is idempotent', () => {
  const { db, store, noteId } = tombstoneFixture();
  assert.throws(() => store.deleteNote('test-project', noteId, 'admin', '   '),
    /reason/, 'a deletion with no reason is indistinguishable from a bug at 3am');
  const first = store.deleteNote('test-project', noteId, 'admin', 'secret');
  const second = store.deleteNote('test-project', noteId, 'admin', 'secret');
  assert.equal(second?.seq, first?.seq, 'a second deletion must not burn another sequence number');
  assert.equal(store.getNote('other', 'nope'), null);
  db.close();
});

test('deletion: the note history served by getNote() carries no text either (#590)', () => {
  // The tombstone revision is emptied by transition(), but the revisions BEFORE it are immutable and
  // still hold the original text, and getNote() returns all of them to anyone who can read the project.
  // Without the read-time scrub this assertion is the difference between "the knowledge does not
  // survive" and "the knowledge is one GET away". Proven by mutation: removing the scrub fails here
  // and nowhere else in the file.
  const claim = 'the release branch is cut from the tag';
  const { db, store, noteId } = tombstoneFixture(claim);
  store.deleteNote('test-project', noteId, 'admin', 'secret in the claim');

  const detail = store.getNote('test-project', noteId);
  assert.ok(detail, 'a deleted note stays readable as a record that it existed');
  assert.equal(detail.note.tier, 'deleted');
  assert.ok(detail.revisions.length >= 2, 'the history must still be there, or this proves nothing');
  for (const rev of detail.revisions) {
    assert.equal(rev.note.claim, '', `revision ${rev.revision} still serves the claim text`);
    assert.equal(rev.note.detail, undefined, `revision ${rev.revision} still serves the detail text`);
  }
  // Identity and audit trail survive; only the knowledge goes.
  const tomb = detail.revisions.find((r) => r.note.tier === 'deleted')!;
  assert.ok(tomb.note.noteId, 'a scrubbed revision must still identify itself');
  assert.ok(tomb.createdAt, 'and still say when it happened');
});

test('retirement: the history stays readable, which is what separates it from deletion (#590)', () => {
  // Section 12 draws the line here on purpose: a retired note keeps its text so a reader can find out
  // what Mercury believed before the decision. If this test ever fails, the two tiers have collapsed
  // into one and the distinction the spec spends words on is gone from the code.
  const claim = 'the release branch is cut from the tag';
  const { db, store, noteId } = tombstoneFixture(claim);
  store.retire('test-project', noteId, 'admin', 'superseded by the new build guide');

  const detail = store.getNote('test-project', noteId);
  assert.equal(detail!.note.tier, 'retired');
  assert.ok(detail!.revisions.some((r) => r.note.claim === claim),
    'a retired note must still serve what it said');
});

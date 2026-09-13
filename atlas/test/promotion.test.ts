/**
 * Promotion, corroboration and sequence (docs/knowledge-base.md sections 11.2, 12 and 13).
 *
 * `notes.test.ts` covers the happy paths of the store. This file covers the rules that were broken
 * when the store was first written, and the ones that cannot be seen by reading a single call:
 *
 * - Section 12 promotes a note when it accumulates corroboration, and corroboration accumulates
 *   through the DUPLICATE path. A check placed only on insert therefore fires at the note's first and
 *   least-corroborated moment and never again. That was a real bug, and a note that crossed its
 *   threshold on its third host stayed a candidate forever with no error anywhere.
 * - `transition` runs inside the contribution's transaction. It used to open its own, so every
 *   auto-promotion threw `cannot start a transaction within a transaction` and the note stayed a
 *   candidate. Test 1 below fails on both defects at once.
 * - Corroboration is derived, never stored, so there is no column that can drift from the count it
 *   would cache. The only way to prove that is to change the underlying rows and watch the number move.
 * - The per-project sequence is gapless, including across promotions, which consume a seq without
 *   writing a notes row.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, tx } from '../db.ts';
import { createRedactor } from '../redact.ts';
import { NoteStore, type PromotionPolicy } from '../notes.ts';

const BOUNDS = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
const IDENTITY = 'github.com/aywengo/mercury';
const AUTO: PromotionPolicy = { auto: { minRuns: 2, minDistinctHarnessesOrHosts: 2, kinds: ['fact', 'convention', 'command', 'pitfall'] } };

interface Harness {
  store: NoteStore;
  db: ReturnType<typeof openDatabase>;
  project(policy?: PromotionPolicy | null): string;
  note(claim: string, opts?: { host?: string; run?: string; agent?: string; kind?: string; source?: string; evidence?: unknown[] }): Record<string, unknown>;
  send(projectId: string, notes: Record<string, unknown>[], key: string, host?: string): Record<string, string>[];
  tierOf(projectId: string, noteId: string): string;
}

function setup(): Harness {
  const db = openDatabase(':memory:');
  const store = new NoteStore(db, BOUNDS, createRedactor(['hunter2secret']));
  let n = 0;
  return {
    store, db,
    project(policy: PromotionPolicy | null = AUTO) {
      const id = `p${++n}`;
      store.createProject({ id, name: id, repoIdentities: [IDENTITY], promotionPolicy: policy });
      return id;
    },
    note(claim, opts = {}) {
      return {
        kind: opts.kind ?? 'fact',
        scope: 'project',
        claim,
        ...(opts.evidence ? { evidence: opts.evidence } : {}),
        provenance: {
          source: opts.source ?? 'agent-reported',
          hostId: opts.host ?? 'host-a',
          runId: opts.run ?? `run-${Math.random().toString(36).slice(2)}`,
          agent: opts.agent ?? 'primeagent',
          harnessVersion: '1.0.0',
          recordedAt: new Date().toISOString(),
        },
        repoIdentity: IDENTITY,
      };
    },
    send(projectId, notes, key, host = 'host-a') {
      return store.contribute(projectId, host, notes, key, 500) as unknown as Record<string, string>[];
    },
    tierOf(projectId, noteId) {
      const detail = store.getNote(projectId, noteId);
      if (!detail) throw new Error(`no note ${noteId}`);
      return detail.note.tier;
    },
  };
}

test('auto-promotion fires when corroboration crosses the threshold on a DUPLICATE contribution', () => {
  const h = setup();
  const p = h.project();
  const claim = 'the integration suite needs docker compose up first';

  const first = h.send(p, [h.note(claim, { host: 'host-a', run: 'r1' })], 'k1');
  const noteId = first[0]!.accepted!;
  assert.equal(h.tierOf(p, noteId), 'candidate', 'a lone agent-reported note is a candidate');

  // A second host, a different harness. This is the duplicate path: the note already exists, only a
  // source is added. Section 12's threshold is now met, and the ONLY way it fires is if the duplicate
  // path re-checks the policy.
  const second = h.send(p, [h.note(claim, { host: 'host-b', run: 'r2', agent: 'hermes' })], 'k2', 'host-b');
  assert.ok('duplicate' in second[0]!, `expected a duplicate, got ${JSON.stringify(second[0])}`);
  assert.equal(h.tierOf(p, noteId), 'promoted', 'crossing the threshold on a duplicate must promote');
});

test('auto-promotion does NOT fire when the corroboration is one host running one harness', () => {
  const h = setup();
  const p = h.project();
  const claim = 'regenerate the client with npm run codegen after editing the openapi spec';
  const first = h.send(p, [h.note(claim, { host: 'host-a', run: 'r1' })], 'k1');
  const noteId = first[0]!.accepted!;
  // Two runs, so minRuns is satisfied, but one host and one harness: the policy's second condition is
  // what stops a single machine from promoting its own habits into shared knowledge.
  h.send(p, [h.note(claim, { host: 'host-a', run: 'r2' })], 'k2');
  assert.equal(h.tierOf(p, noteId), 'candidate', 'one host must not be able to promote its own convention');
  assert.equal(h.store.corroboration(noteId).runs, 2, 'the corroboration did accumulate; only promotion is withheld');
});

test('a project with auto-promotion disabled never promotes on its own', () => {
  const h = setup();
  const p = h.project(null);
  const claim = 'never promote anything automatically on this project';
  const noteId = h.send(p, [h.note(claim, { host: 'host-a', run: 'r1' })], 'k1')[0]!.accepted!;
  h.send(p, [h.note(claim, { host: 'host-b', run: 'r2', agent: 'hermes' })], 'k2', 'host-b');
  assert.equal(h.tierOf(p, noteId), 'candidate', 'a null policy makes every promotion a human act');
});

test('a repo-record note lands promoted, because git review already happened', () => {
  const h = setup();
  const p = h.project();
  const noteId = h.send(p, [h.note('all money math uses integer minor units', {
    source: 'repo-record',
    evidence: [{ type: 'repo-file', repo: IDENTITY, path: 'docs/adr/0002-money.md', sha: 'a1b2c3d' }],
  })], 'k1')[0]!.accepted!;
  assert.equal(h.tierOf(p, noteId), 'promoted');
});

test('corroboration is derived from sources, so there is no cached number that can drift', () => {
  const h = setup();
  const p = h.project();
  const claim = 'the lease-expiry test is timing sensitive and flakes under load';
  const noteId = h.send(p, [h.note(claim, { host: 'host-a', run: 'r1' })], 'k1')[0]!.accepted!;
  h.send(p, [h.note(claim, { host: 'host-b', run: 'r2', agent: 'hermes' })], 'k2', 'host-b');
  assert.deepEqual(h.store.corroboration(noteId), { runs: 2, hosts: 2, harnesses: 2 });

  // Remove one host's evidence directly. If the count were a column on `notes`, it would still say 2.
  tx(h.db, () => { h.db.prepare('DELETE FROM note_sources WHERE host_id = ?').run('host-b'); });
  assert.deepEqual(h.store.corroboration(noteId), { runs: 1, hosts: 1, harnesses: 1 },
    'the count must follow the rows, because section 12 promotes on it');
});

test('replaying an idempotency key answers identically and does not corroborate twice', () => {
  const h = setup();
  const p = h.project();
  const notes = [h.note('run one test file with node --test test/x.test.ts', { host: 'host-a', run: 'r1' })];
  const first = h.send(p, notes, 'lost-ack');
  const replay = h.send(p, notes, 'lost-ack');
  assert.deepEqual(replay, first, 'a lost acknowledgement must return the original answers');
  assert.equal(h.store.corroboration(first[0]!.accepted!).runs, 1,
    'a retry must not look like a second Run agreeing');
});

test('a body that claims a different host than its token is refused, not silently corrected', () => {
  const h = setup();
  const p = h.project();
  const results = h.send(p, [h.note('misconfigured host claims to be someone else', { host: 'host-victim' })], 'k1', 'host-a');
  assert.deepEqual(results, [{ rejected: 'host-mismatch' }]);
});

test('a retired note still appears in the promoted feed so replicas drop it, but not in bootstrap', () => {
  const h = setup();
  const p = h.project();
  const noteId = h.send(p, [h.note('every amount is stored in minor units', { source: 'repo-record', evidence: [{ type: 'repo-file', repo: IDENTITY, path: 'docs/adr/1.md', sha: 'a1b2c3d' }] })], 'k1')[0]!.accepted!;
  assert.equal(h.tierOf(p, noteId), 'promoted');

  h.store.retire(p, noteId, 'operator', 'superseded by a later decision record');

  // A replica that already applied the promotion has to be TOLD it was withdrawn. Filtering retired
  // notes out of the promoted feed would leave them injected forever on every host that pulled first.
  const promoted = h.store.feed(p, 0, 'promoted', { limit: 100 });
  assert.deepEqual(promoted.notes.map((n) => n.noteId), [noteId], 'the retirement must reach subscribers');
  assert.equal(h.tierOf(p, noteId), 'retired');

  // A brand-new replica bootstraps from scratch and must not receive it.
  assert.deepEqual(h.store.bootstrap(p).notes.map((n) => n.noteId), [], 'bootstrap must exclude retired notes');
});

test('promotion and retirement require a reason', () => {
  const h = setup();
  const p = h.project();
  const noteId = h.send(p, [h.note('a candidate that needs a human reason', {})], 'k1')[0]!.accepted!;
  assert.throws(() => h.store.promote(p, noteId, 'operator', ''), /reason/i, 'an empty promotion reason must be refused');
  assert.throws(() => h.store.promote(p, noteId, 'operator', '   '), /reason/i, 'whitespace is not a reason');
  h.store.promote(p, noteId, 'operator', 'reviewed on the call');
  assert.throws(() => h.store.retire(p, noteId, 'operator', ''), /reason/i);
});

test('a contest flags both notes and leaves both in their tiers', () => {
  const h = setup();
  const p = h.project();
  const a = h.send(p, [h.note('use a single database file for everything', { source: 'repo-record', evidence: [{ type: 'repo-file', repo: IDENTITY, path: 'docs/adr/2.md', sha: 'a1b2c3d' }] })], 'ka')[0]!.accepted!;
  const b = h.send(p, [h.note('split the queue into its own database file', { source: 'repo-record', evidence: [{ type: 'repo-file', repo: IDENTITY, path: 'docs/adr/3.md', sha: 'e4f5a6b' }] })], 'kb')[0]!.accepted!;

  assert.equal(h.store.contest(p, a, b, 'operator'), true);
  // Read the flag back through getNote rather than a private helper: `contested` is part of the wire
  // shape, so this asserts the same thing a subscriber sees.
  assert.equal(h.store.getNote(p, a)!.note.contested, true);
  assert.equal(h.store.getNote(p, b)!.note.contested, true, 'both sides of a contest are flagged, not just the first reported');
  assert.equal(h.tierOf(p, a), 'promoted', 'a contest is not a verdict');
  assert.equal(h.tierOf(p, b), 'promoted');
});

test('the per-project sequence is gapless and never reused across transitions', () => {
  const h = setup();
  const p = h.project();
  const first = h.send(p, [h.note('first fact for the sequence test', {})], 'k1')[0]!.accepted!;
  const second = h.send(p, [h.note('second fact for the sequence test', {})], 'k2')[0]!.accepted!;

  // A transition re-stamps the note with a fresh seq on purpose: that is how a subscriber polling
  // `since` learns that a note it already holds changed tier. So the notes table shows the LATEST seq
  // per note, and the values consumed by the two notes' insertions are no longer visible there.
  h.store.promote(p, first, 'operator', 'reviewed');
  h.store.retire(p, second, 'operator', 'wrong');

  const consumed = (): number => Number(
    (h.db.prepare('SELECT seq FROM project_seq WHERE project_id = ?').get(p) as { seq: number }).seq,
  );
  // Two insertions and two transitions consumed four values, and nothing was reused. If the allocator
  // derived the next value from MAX(seq) over `notes` it would hand out a used number here, and a
  // replica would silently treat a later note as already seen -- a gap no one can see from the feed.
  assert.equal(consumed(), 4, 'two inserts and two transitions consumed four sequence values');

  const third = h.send(p, [h.note('third fact, allocated after a transition', {})], 'k3')[0]!.accepted!;
  assert.equal(consumed(), 5, 'the next note continues the sequence rather than reusing a value');

  const all = h.store.feed(p, 0, 'all', { limit: 100 });
  const seqs = all.notes.map((n) => n.seq);
  assert.equal(new Set(seqs).size, seqs.length, 'no two notes share a seq');
  assert.equal(Math.max(...seqs), 5);
  assert.equal(all.nextSeq, 5);
  assert.equal(h.store.bootstrap(p).nextSeq, 5, 'bootstrap hands the caller a cursor it can continue from');
});

test('retireStaleCandidates retires notes nobody re-confirmed and spares recently corroborated ones', () => {
  const h = setup();
  // Auto-promotion off, so the second host's corroboration cannot promote the note out of the tier the
  // sweep operates on. This test is about retention, and mixing the two policies would hide a defect in
  // either one behind the other.
  const p = h.project(null);
  const stale = h.send(p, [h.note('an old note nobody ever repeated', {})], 'k1')[0]!.accepted!;
  const corroborated = h.send(p, [h.note('an old note a second host confirmed last week', {})], 'k2')[0]!.accepted!;
  h.send(p, [h.note('an old note a second host confirmed last week', { host: 'host-b', agent: 'hermes' })], 'k3', 'host-b');

  // Backdate the note and the FIRST host's evidence, leaving the second host's evidence at now. The
  // sweep's rule is "no source recorded since the cutoff", so this note has fallen out of use.
  const ancient = '2020-01-01T00:00:00.000Z';
  tx(h.db, () => {
    h.db.prepare("UPDATE notes SET updated_at = ? WHERE note_id = ?").run(ancient, stale);
    h.db.prepare('UPDATE note_sources SET recorded_at = ? WHERE note_id = ?').run(ancient, stale);
    h.db.prepare('UPDATE notes SET updated_at = ? WHERE note_id = ?').run(ancient, corroborated);
  });

  const retired = h.store.retireStaleCandidates(1000 * 60 * 60 * 24);
  assert.ok(retired.includes(stale), 'a candidate with no recent confirmation is retired');
  assert.ok(!retired.includes(corroborated), 'a note somebody confirmed inside the window is kept');
  assert.equal(h.tierOf(p, corroborated), 'candidate');
});

// The sweep above keys on "has any source been recorded recently", not on "did two hosts ever agree".
// Those readings of section 12 differ for a note corroborated by three hosts in 2020 and never touched
// again: the first retires it, the second keeps it forever. The implementation takes the first, which
// is defensible -- a claim no host has re-confirmed in a year is stale even if three once agreed -- but
// it is a reading, not the only one, and it is worth deciding deliberately rather than by inheritance.

// --- Issue #551: a retired note must not be a permanent dedup sink ---

test('a claim contributed after retirement is accepted fresh, not silently swallowed as a duplicate', () => {
  // This is the core regression. On main, contributing X after X is retired returns
  // `{ duplicate: retiredNoteId }`, the outbox row is deleted, and the claim is lost.
  // After the fix, the answer is `{ accepted: newNoteId }` and the note is a new candidate.
  const h = setup();
  const p = h.project();
  const claim = 'run docker compose up before the integration suite';

  const first = h.send(p, [h.note(claim, { host: 'host-a', run: 'r1' })], 'k1');
  const originalId = first[0]!.accepted!;
  assert.equal(h.tierOf(p, originalId), 'candidate');

  h.store.retire(p, originalId, 'system:retention', 'stale');
  assert.equal(h.tierOf(p, originalId), 'retired');

  // Contribute from two new hosts on different harnesses; policy is minRuns 2 / minDistinctHarnessesOrHosts 2.
  const second = h.send(p, [h.note(claim, { host: 'host-b', run: 'r2', agent: 'hermes' })], 'k2', 'host-b');
  assert.ok('accepted' in second[0]!, `expected accepted, got ${JSON.stringify(second[0])}`);
  const newId = second[0]!.accepted!;
  assert.notEqual(newId, originalId, 'a fresh note gets a new id, the retired one stays as history');

  const third = h.send(p, [h.note(claim, { host: 'host-c', run: 'r3', agent: 'primeagent' })], 'k3', 'host-c');
  assert.ok('duplicate' in third[0]!, `expected duplicate on 3rd, got ${JSON.stringify(third[0])}`);

  // Policy satisfied: 2 runs, 2 distinct harnesses. The note must have been promoted.
  assert.equal(h.tierOf(p, newId), 'promoted', 'the re-contributed note must promote once the policy threshold is met');

  // It must appear in bootstrap and in the promoted feed.
  const boot = h.store.bootstrap(p);
  assert.ok(boot.notes.some((n) => n.noteId === newId), 'bootstrap must serve the re-promoted note');

  const feed = h.store.feed(p, 0, 'promoted', { limit: 100 });
  assert.ok(feed.notes.some((n) => n.noteId === newId), 'promoted feed must serve the re-promoted note');
});

test('a repo-record contribution after retirement is accepted and lands promoted, not duplicate', () => {
  // Before the fix: `existing` matched the retired note; `addSource` added a source to it;
  // `autoPromote` returned false because the note is not a candidate; answer was `duplicate`.
  // After the fix: the query skips retired notes; `insertNote` is called; source is repo-record,
  // so the note lands promoted immediately.
  const h = setup();
  const p = h.project();
  const claim = 'all money arithmetic uses integer minor units';
  const evidence = [{ type: 'repo-file', repo: IDENTITY, path: 'docs/adr/0002-money.md', sha: 'a1b2c3d' }];

  // First: land as a candidate from an agent, then retire it.
  const first = h.send(p, [h.note(claim, { host: 'host-a', run: 'r1' })], 'k1');
  const originalId = first[0]!.accepted!;
  h.store.retire(p, originalId, 'operator', 'superseded');

  // Now contribute the same claim as repo-record (e.g., an accepted decision record merged later).
  const second = h.send(p, [h.note(claim, { source: 'repo-record', evidence })], 'k2');
  assert.ok('accepted' in second[0]!, `expected accepted, got ${JSON.stringify(second[0])}`);
  const newId = second[0]!.accepted!;
  assert.equal(h.tierOf(p, newId), 'promoted',
    'a repo-record note bypasses the candidate queue regardless of retirement history');

  // Bootstrap serves it; no stale reference to the retired note.
  const boot = h.store.bootstrap(p);
  assert.ok(boot.notes.some((n) => n.noteId === newId), 'bootstrap must serve the newly promoted repo-record note');
});

test('the existing retirement test still passes: feed carries the retirement, bootstrap excludes it', () => {
  // This is a copy of the "a retired note still appears in the promoted feed" test to confirm
  // the fix to issue #551 did not break the existing retirement path.
  const h = setup();
  const p = h.project();
  const noteId = h.send(p, [h.note('every amount is stored in minor units (regression guard)', {
    source: 'repo-record',
    evidence: [{ type: 'repo-file', repo: IDENTITY, path: 'docs/adr/1.md', sha: 'a1b2c3d' }],
  })], 'k1')[0]!.accepted!;
  assert.equal(h.tierOf(p, noteId), 'promoted');

  h.store.retire(p, noteId, 'operator', 'superseded by a later decision record');

  const promoted = h.store.feed(p, 0, 'promoted', { limit: 100 });
  assert.deepEqual(promoted.notes.map((n) => n.noteId), [noteId], 'the retirement must reach feed subscribers');
  assert.equal(h.tierOf(p, noteId), 'retired');
  assert.deepEqual(h.store.bootstrap(p).notes.map((n) => n.noteId), [], 'bootstrap must exclude retired notes');
});

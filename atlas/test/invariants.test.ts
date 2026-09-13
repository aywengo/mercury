/**
 * Two invariants that were broken in the first working version of the store.
 *
 * Both were found in review rather than by the suite that claimed to cover them, which is the reason
 * this file exists: a test that exercises inserts and tier transitions does not cover the sequence rule,
 * it covers a third of it. And a redaction test that only checks the write path proves the write path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.ts';
import { createRedactor } from '../redact.ts';
import { NoteStore } from '../notes.ts';
import type { ContributionResult } from '../types.ts';

const BOUNDS = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
const IDENTITY = 'github.com/aywengo/mercury';

function store(redactorSecrets: string[] = []) {
  const db = openDatabase(':memory:');
  const s = new NoteStore(db, BOUNDS, createRedactor(redactorSecrets));
  s.createProject({ id: 'p', name: 'p', repoIdentities: [IDENTITY], promotionPolicy: { auto: null } });
  return { db, s };
}

function contribution(claim: string, runId: string): Record<string, unknown> {
  return {
    kind: 'fact', scope: 'project', claim, evidence: [],
    provenance: { source: 'agent-reported', hostId: 'host-a', runId, agent: 'primeagent', harnessVersion: '1.0.0', recordedAt: new Date().toISOString() },
    repoIdentity: IDENTITY,
  };
}


/** Narrow a ContributionResult by which arm it is; the result is a closed union. */
function pick(result: ContributionResult | undefined, key: 'accepted' | 'duplicate' | 'rejected'): string | undefined {
  return result && key in result ? (result as unknown as Record<string, string>)[key] : undefined;
}

test('contesting two notes gives them distinct sequence values', () => {
  const { db, s } = store();
  const a = pick(s.contribute('p', 'host-a', [contribution('the queue and the run table share one database file', 'r1')], 'k1', 500)[0], 'accepted')!;
  const b = pick(s.contribute('p', 'host-a', [contribution('the queue lives in its own database file', 'r2')], 'k2', 500)[0], 'accepted')!;
  assert.equal(s.contest('p', a, b, 'operator'), true);

  const seqA = s.getNote('p', a)!.note.seq;
  const seqB = s.getNote('p', b)!.note.seq;
  assert.notEqual(seqA, seqB, 'two notes must not share a seq');

  // The failure this guards is not a duplicate number in the abstract. A replica pages with a limit, so
  // it reads one note at seq N, stores N as its cursor, and then asks for `seq > N`. If the second note
  // also sits at N it is excluded by that comparison and never arrives -- not corrupted, just absent,
  // on the replicas that page in small batches.
  const first = s.feed('p', 0, 'all', { limit: 1 });
  assert.equal(first.notes.length, 1);
  const rest = s.feed('p', first.nextSeq, 'all', { limit: 100 });
  const seen = new Set([...first.notes, ...rest.notes].map((n) => n.noteId));
  assert.ok(seen.has(a) && seen.has(b), 'a paging replica must be able to reach both contested notes');
});

test('a secret declared after a note was stored is not readable from that note', () => {
  const lateSecret = 'ghp_lateresecretvalue0123456789ab';
  const { db, s } = store([]);
  const claim = `rotate the token ${lateSecret} in the deploy secrets`;
  const noteId = pick(s.contribute('p', 'host-a', [contribution(claim, 'r1')], 'k1', 500)[0], 'accepted')!;
  assert.ok(noteId, 'the note is accepted: nothing was a declared secret when it landed');

  // A new store over the same database, with the secret now declared. This is the whole point of the
  // read-time pass: the operator edited ATLAS_SECRETS and restarted, and the stored text is unchanged.
  const after = new NoteStore(db, BOUNDS, createRedactor([lateSecret]));

  const detail = after.getNote('p', noteId)!;
  assert.ok(!detail.note.claim.includes(lateSecret), 'getNote must not hand back a declared secret');
  assert.match(detail.note.claim, /\[REDACTED|redacted/i, 'the value is replaced, not silently dropped');

  const feed = after.feed('p', 0, 'all', { limit: 10 });
  assert.ok(!JSON.stringify(feed.notes).includes(lateSecret), 'the replication feed must not carry it either');

  const boot = after.bootstrap('p');
  assert.ok(!JSON.stringify(boot.notes).includes(lateSecret), 'bootstrap must not carry it');

  // The history is part of the read. Covering only the current revision would leak through revision 1.
  assert.ok(!JSON.stringify(detail.revisions).includes(lateSecret), 'older revisions are reads too');
});

test('a redaction pass on read does not rewrite what is stored', () => {
  const lateSecret = 'ghp_anothersecretvalue0123456789';
  const { db, s } = store([]);
  const claim = `the deploy key is ${lateSecret}`;
  const noteId = pick(s.contribute('p', 'host-a', [contribution(claim, 'r1')], 'k1', 500)[0], 'accepted')!;

  const after = new NoteStore(db, BOUNDS, createRedactor([lateSecret]));
  after.getNote('p', noteId);
  after.feed('p', 0, 'all', { limit: 10 });

  // Redaction is a view, not a migration. If reads wrote back, declaring a secret would destroy the
  // audit trail, and a secret declared by mistake would be unrecoverable from the database that is
  // supposed to be the record.
  const raw = db.prepare('SELECT note_json FROM note_revisions WHERE note_id = ? ORDER BY revision').all(noteId) as unknown as { note_json: string }[];
  assert.ok(raw.length >= 1);
  assert.ok(raw.every((r) => r.note_json.includes(lateSecret)), 'the stored revision keeps the original text');
});

test('contesting does not persist a redacted revision', () => {
  const lateSecret = 'ghp_contestednotekey0123456789abc';
  const { db, s } = store([]);
  const noteId = pick(s.contribute('p', 'host-a', [contribution(`the release signing key is ${lateSecret}`, 'r1')], 'k1', 500)[0], 'accepted')!;
  const other = pick(s.contribute('p', 'host-a', [contribution('an unrelated promoted fact', 'r2')], 'k2', 500)[0], 'accepted')!;

  const after = new NoteStore(db, BOUNDS, createRedactor([lateSecret]));
  assert.equal(after.contest('p', noteId, other, 'operator'), true);

  // The contest writes a NEW revision for each note. Building that revision from the read projection
  // would fold the redaction into the record permanently, which is a write performed by a read.
  const raw = db.prepare('SELECT note_json FROM note_revisions WHERE note_id = ? ORDER BY revision').all(noteId) as unknown as { note_json: string }[];
  assert.ok(raw.length >= 2, 'the contest bumped the revision');
  assert.ok(raw[raw.length - 1]!.note_json.includes(lateSecret), 'the new revision still holds the original text');
  assert.ok(!after.getNote('p', noteId)!.note.claim.includes(lateSecret), 'and reads still redact it');
});

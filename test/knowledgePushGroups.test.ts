/**
 * One pass, two token classes (docs/knowledge-base.md sections 11.1 and 11.4).
 *
 * A batch that mixes sources is the normal case, not an edge: an operator writes a convention while Runs
 * are producing notes, and both are sitting in the same outbox. The first version of this sent only the
 * non-operator half and left the rest for the next tick. That was not data loss, and it is exactly the
 * kind of defect that survives review, because the two things it got wrong were both invisible:
 *
 * - the outcome reported `attempted` for rows that were never sent, so a log line claimed a note went
 *   out when it had not; and
 * - the pass stamped a successful push timestamp while a note was still queued, which is the field an
 *   operator reads to decide the outbox is healthy.
 *
 * These tests pin the counters and the retention, not just "it eventually drains".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db/database.ts';
import { OutboxStore } from '../src/knowledge/outbox.ts';
import { KnowledgePusher } from '../src/knowledge/pusher.ts';
import type { AtlasClient } from '../src/knowledge/client.ts';
import type { NoteContribution } from '../src/knowledge/types.ts';

const QUIET = { info() {}, warn() {}, error() {} } as never;

function note(claim: string, source: 'agent-reported' | 'operator'): NoteContribution {
  return {
    projectId: 'mercury', kind: 'fact', scope: 'project', claim, evidence: [],
    provenance: {
      source, hostId: 'host-a', recordedAt: new Date().toISOString(),
      ...(source === 'operator' ? {} : { runId: 'r1', agent: 'primeagent', harnessVersion: '1.0.0' }),
    },
  };
}

interface Sent { token: string; claims: string[] }

/** A client that records what it was asked to send and accepts everything. */
function accepting(token: string, sent: Sent[]): AtlasClient {
  return {
    pushBatch: async (_project: string, notes: NoteContribution[]) => {
      sent.push({ token, claims: notes.map((n) => n.claim) });
      return { results: notes.map((_n, i) => ({ accepted: `note_${i}` }) as { accepted: string }) };
    },
  } as unknown as AtlasClient;
}

/** A client that always fails, to exercise a half-failed pass. */
function refusing(token: string, sent: Sent[]): AtlasClient {
  return {
    pushBatch: async (_project: string, notes: NoteContribution[]) => {
      sent.push({ token, claims: notes.map((n) => n.claim) });
      throw new Error(`${token} is unreachable`);
    },
  } as unknown as AtlasClient;
}

function pusherFor(db: ReturnType<typeof openDatabase>, client: AtlasClient, adminClient?: AtlasClient): KnowledgePusher {
  return new KnowledgePusher({
    outbox: new OutboxStore(db), client, ...(adminClient ? { adminClient } : {}),
    project: 'mercury', intervalMs: 1000, batch: 100, log: QUIET,
  });
}

test('a mixed batch is delivered in ONE pass, under two tokens', async () => {
  const db = openDatabase(':memory:');
  const outbox = new OutboxStore(db);
  // Insertion order is what takeBatch uses, so the ordinary note goes first to prove the split is by
  // source rather than by position.
  outbox.insert([{ runId: 'run-1', contribution: note('an ordinary note', 'agent-reported') }]);
  outbox.insert([{ runId: null, contribution: note('an operator note', 'operator') }]);

  const sent: Sent[] = [];
  const outcome = await pusherFor(db, accepting('contributor', sent), accepting('admin', sent)).pushOnce();

  assert.equal(outcome.failed, false);
  assert.equal(outcome.accepted, 2, 'both notes are delivered by the same pass');
  assert.equal(outbox.depth(), 0, 'nothing is left behind for a later tick');
  assert.deepEqual(sent.map((s) => s.token).sort(), ['admin', 'contributor'], 'each half went under its own token');
  assert.deepEqual(sent.find((s) => s.token === 'admin')!.claims, ['an operator note'],
    'only the operator note may be sent under the admin token');
  assert.deepEqual(sent.find((s) => s.token === 'contributor')!.claims, ['an ordinary note'],
    'a Run note must never ride the admin token, or the token split is decorative');
});

test('attempted counts what was sent, not what was read', async () => {
  const db = openDatabase(':memory:');
  const outbox = new OutboxStore(db);
  outbox.insert([{ runId: 'run-1', contribution: note('one', 'agent-reported') }]);
  outbox.insert([{ runId: 'run-2', contribution: note('two', 'agent-reported') }]);
  const sent: Sent[] = [];
  const outcome = await pusherFor(db, accepting('contributor', sent)).pushOnce();
  assert.equal(outcome.attempted, 2);
  assert.equal(outcome.accepted + outcome.duplicate + outcome.rejected, outcome.attempted,
    'every attempted row is classified; an unclassified row means a row nobody accounted for');
});

test('an operator note with no admin token is retained with a cause that names the variable', async () => {
  const db = openDatabase(':memory:');
  const outbox = new OutboxStore(db);
  outbox.insert([{ runId: null, contribution: note('an operator note', 'operator') }]);
  const sent: Sent[] = [];
  const outcome = await pusherFor(db, accepting('contributor', sent)).pushOnce();

  assert.equal(outcome.failed, true);
  assert.match(outcome.lastError ?? '', /MERCURY_ATLAS_ADMIN_TOKEN/, 'the cause must be actionable, not "transport error"');
  assert.equal(outbox.depth(), 1, 'the note is kept, not dropped');
  assert.equal(sent.length, 0, 'nothing was sent under a token that could not authorise it');
  assert.equal(new OutboxStore(db).getState('push_failures_total'), '1');
});

test('a failure in one group does not undo a delivery in the other', async () => {
  const db = openDatabase(':memory:');
  const outbox = new OutboxStore(db);
  outbox.insert([{ runId: 'run-1', contribution: note('delivered note', 'agent-reported') }]);
  outbox.insert([{ runId: null, contribution: note('undeliverable note', 'operator') }]);

  const sent: Sent[] = [];
  const outcome = await pusherFor(db, accepting('contributor', sent), refusing('admin', sent)).pushOnce();

  // Deleting a row that Atlas already accepted because a DIFFERENT row failed would itself be data loss,
  // so the pass is per-group rather than all-or-nothing.
  assert.equal(outcome.accepted, 1, 'the note Atlas accepted stays accepted');
  assert.equal(outcome.failed, true, 'and the pass still reports the failure it had');
  const left = outbox.takeBatch(10).map((r) => r.contribution.claim);
  assert.deepEqual(left, ['undeliverable note'], 'only the undelivered row is retained');
});

test('a pass that delivered nothing does not stamp a successful push', async () => {
  const db = openDatabase(':memory:');
  const outbox = new OutboxStore(db);
  outbox.insert([{ runId: null, contribution: note('an operator note', 'operator') }]);
  const sent: Sent[] = [];
  await pusherFor(db, accepting('contributor', sent)).pushOnce();
  // `last_push_at` is what an operator reads as "the pusher is working". Stamping it on a pass that sent
  // nothing would make a permanently-stuck outbox look healthy.
  assert.equal(new OutboxStore(db).getState('last_push_at'), null,
    'no successful timestamp without a successful delivery');
  assert.ok(new OutboxStore(db).getState('last_push_error'), 'the failure is what gets recorded');
});

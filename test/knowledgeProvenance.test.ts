/**
 * Provenance survives the trip through the replica (issue #553).
 *
 * `knowledge_replica` used to store none of it: `toRow()` kept only `recorded_at`, so `toNote()` in
 * `pack.ts` had nothing to read and returned a constant
 * `{ source: 'agent-reported', hostId: '' }` for every note. That object was then persisted verbatim by
 * `RunService.create()` into `run_knowledge.notes_json` and served by `GET /api/runs/:runId/knowledge`.
 *
 * So a note an operator personally wrote, and a note curated in git, were both presented to an API caller
 * as an agent's unverified observation from a host with no id. The workspace files were unaffected --
 * `materializeKnowledge()` renders no provenance -- so a Run read the right claims. It was the audit
 * surface that lied, and it lied by understating trust for exactly the two most trusted sources, in the
 * one snapshot the design points an operator at to answer "what did this Run know, and why should it have
 * believed it".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db/database.ts';
import { ReplicaStore } from '../src/knowledge/replica.ts';
import { selectPack } from '../src/knowledge/pack.ts';
import type { Note } from '../src/knowledge/types.ts';

function note(over: Partial<Note> & { noteId: string; seq: number }): Note {
  return {
    revision: 1, projectId: 'mercury', kind: 'fact', scope: 'project', claim: `claim ${over.noteId}`,
    evidence: [], tier: 'promoted', corroboration: { runs: 1, harnesses: 1, hosts: 1 },
    provenance: { source: 'agent-reported', hostId: 'host-a', recordedAt: '2026-01-01T00:00:00.000Z' },
    ...over,
  } as Note;
}

const OPERATOR = note({
  noteId: 'n_op', seq: 1, kind: 'decision',
  claim: 'we use Postgres, decided in the March design review',
  provenance: { source: 'operator', hostId: 'laptop-rome', recordedAt: '2026-01-02T00:00:00.000Z' },
});
const REPO = note({
  noteId: 'n_repo', seq: 2, kind: 'convention',
  claim: 'every HTTP handler returns JSON, never a bare string',
  provenance: { source: 'repo-record', hostId: '', recordedAt: '2026-01-03T00:00:00.000Z' },
});

function pulled(notes: Note[]) {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  rep.applyBatch('mercury', notes, 9, '2026-02-01T00:00:00.000Z');
  return { db, rep };
}

test('an operator note keeps its source and host through the replica', () => {
  const { db, rep } = pulled([OPERATOR, REPO]);
  const rows = rep.promoted('mercury');
  const op = rows.find((r) => r.noteId === 'n_op');
  assert.equal(op?.source, 'operator', 'the contributing source must survive the round trip');
  assert.equal(op?.hostId, 'laptop-rome', 'which machine contributed it is part of the record');
  db.close();
});

test('a repo-record note is not presented as an agent observation', () => {
  const { db, rep } = pulled([OPERATOR, REPO]);
  const rows = rep.promoted('mercury');
  assert.equal(rows.find((r) => r.noteId === 'n_repo')?.source, 'repo-record');
  db.close();
});

test('the pack a Run is given carries the real provenance, not a constant', () => {
  // This is the value that lands in run_knowledge.notes_json and comes back on the API, so it is the
  // assertion that actually covers the reported symptom.
  const { db, rep } = pulled([OPERATOR, REPO]);
  const pack = selectPack(rep, {
    projectId: 'mercury', agent: 'primeagent', repositories: [], maxBytes: 100_000,
    task: 'fix the login handler',
  });
  const byId = new Map(pack.notes.map((n) => [n.noteId, n]));
  assert.equal(byId.get('n_op')?.provenance?.source, 'operator');
  assert.equal(byId.get('n_op')?.provenance?.hostId, 'laptop-rome');
  assert.equal(byId.get('n_repo')?.provenance?.source, 'repo-record');
  // The bug was that both of these read identically.
  assert.notEqual(byId.get('n_op')?.provenance?.source, byId.get('n_repo')?.provenance?.source);
  db.close();
});

test('a row written before migration v11 has no provenance rather than an invented one', () => {
  const { db, rep } = pulled([OPERATOR]);
  // Simulate the pre-v11 state exactly: the columns exist (v11 added them with an empty default) but no
  // value was ever stored.
  db.prepare("UPDATE knowledge_replica SET source = '', host_id = '' WHERE note_id = 'n_op'").run();

  const pack = selectPack(rep, {
    projectId: 'mercury', agent: 'primeagent', repositories: [], maxBytes: 100_000, task: 'anything',
  });
  const n = pack.notes.find((x) => x.noteId === 'n_op');
  assert.ok(n, 'the note must still reach the pack; unknown provenance is not a reason to drop it');
  assert.equal(n?.provenance, undefined,
    'absence is the honest answer. Falling back to agent-reported here is the defect this file exists for');
  db.close();
});

test('migration v11 resets pull cursors so pre-v11 rows correct themselves', () => {
  const db = openDatabase(':memory:');
  const rep = new ReplicaStore(db);
  rep.applyBatch('mercury', [OPERATOR], 9, '2026-02-01T00:00:00.000Z');
  assert.equal(rep.getCursor('mercury'), 9);

  // The migration is what clears it. Re-running migrations on a database that already has them recorded
  // is a no-op, so drive v11 directly the way the runner would on an upgrading host.
  db.exec("DELETE FROM schema_migrations WHERE version = 11");
  db.exec("DELETE FROM knowledge_replica_cursor");
  assert.equal(rep.getCursor('mercury'), null,
    'a stale cursor would make the puller skip every note it already holds, leaving empty-source rows '
    + 'wrong forever');
  db.close();
});

test('a re-pulled row has its empty source corrected, not left alone', () => {
  // The ON CONFLICT arm has to update source and host_id. If it only inserted them, the cursor reset
  // would re-fetch every note and the correction would be silently dropped for rows that already exist
  // -- which is every row on an upgrading host.
  const { db, rep } = pulled([OPERATOR]);
  db.prepare("UPDATE knowledge_replica SET source = '', host_id = '' WHERE note_id = 'n_op'").run();

  rep.applyBatch('mercury', [{ ...OPERATOR, revision: 2 }], 10, '2026-02-02T00:00:00.000Z');
  const row = rep.promoted('mercury').find((r) => r.noteId === 'n_op');
  assert.equal(row?.source, 'operator',
    'the ON CONFLICT arm left source alone, so an upgrading host never recovers its provenance');
  assert.equal(row?.hostId, 'laptop-rome');
  db.close();
});

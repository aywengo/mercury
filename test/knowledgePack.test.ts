/**
 * Pack selection (docs/knowledge-base.md 9.1).
 *
 * The property under test is determinism, not cleverness. Selection has no relevance model on purpose, so
 * what is testable is that the same replica, task and request always produce the same pack, in the same
 * order, with the same hash -- and that when the budget bites it bites in a way that does not depend on
 * which unrelated notes happen to be present.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db/database.ts';
import { ReplicaStore } from '../src/knowledge/replica.ts';
import { packHashOf, pathTokens, selectPack } from '../src/knowledge/pack.ts';
import { repoIdentity } from '../src/knowledge/identity.ts';
import type { Note, NoteKind } from '../src/knowledge/types.ts';

const HASH = repoIdentity('https://github.com/aywengo/mercury.git')!.hash;
const OTHER = repoIdentity('https://github.com/aywengo/other.git')!.hash;

function note(over: Partial<Note> & { noteId: string; seq: number }): Note {
  return {
    revision: 1, projectId: 'mercury', kind: 'fact' as NoteKind, scope: 'project',
    claim: `claim for ${over.noteId}`, evidence: [], tier: 'promoted',
    corroboration: { runs: 1, harnesses: 1, hosts: 1 },
    provenance: { source: 'agent-reported', hostId: 'host-a', recordedAt: '2026-01-01T00:00:00.000Z' },
    ...over,
  } as Note;
}

function replicaWith(notes: Note[]): ReplicaStore {
  const rep = new ReplicaStore(openDatabase(':memory:'));
  if (notes.length) rep.applyBatch('mercury', notes, Math.max(...notes.map((n) => n.seq)), '2026-01-02T00:00:00.000Z');
  return rep;
}

const REQ = { projectId: 'mercury', agent: 'primeagent', repositories: ['https://github.com/aywengo/mercury.git'], maxBytes: 1_000_000 };

test('scope specificity orders path before repository before project before agent', () => {
  const rep = replicaWith([
    note({ noteId: 'n-agent', seq: 1, scope: 'agent:primeagent', corroboration: { runs: 99, harnesses: 9, hosts: 9 } }),
    note({ noteId: 'n-project', seq: 2, scope: 'project', corroboration: { runs: 99, harnesses: 9, hosts: 9 } }),
    note({ noteId: 'n-repo', seq: 3, scope: `repo:${HASH}`, corroboration: { runs: 99, harnesses: 9, hosts: 9 } }),
    note({ noteId: 'n-path', seq: 4, scope: `repo:${HASH}#src/knowledge`, corroboration: { runs: 0, harnesses: 0, hosts: 1 } }),
  ]);
  const pack = selectPack(rep, { ...REQ, task: 'touch up src/knowledge/pack.ts' });
  assert.deepEqual(pack.notes.map((n) => n.noteId), ['n-path', 'n-repo', 'n-project', 'n-agent'],
    'specificity outranks corroboration; a note about this exact directory beats a famous note about nothing in particular');
});

test('convention and pitfall precede other kinds at equal specificity, whatever the corroboration', () => {
  const rep = replicaWith([
    note({ noteId: 'n-fact', seq: 1, kind: 'fact', corroboration: { runs: 500, harnesses: 4, hosts: 4 } }),
    note({ noteId: 'n-pitfall', seq: 2, kind: 'pitfall', corroboration: { runs: 1, harnesses: 1, hosts: 1 } }),
    note({ noteId: 'n-conv', seq: 3, kind: 'convention', corroboration: { runs: 1, harnesses: 1, hosts: 1 } }),
    note({ noteId: 'n-cmd', seq: 4, kind: 'command', corroboration: { runs: 900, harnesses: 9, hosts: 9 } }),
  ]);
  const ids = selectPack(rep, { ...REQ, task: 'fix the build' }).notes.map((n) => n.noteId);
  assert.deepEqual(ids.slice(0, 2), ['n-conv', 'n-pitfall'],
    'what stops a Run doing the wrong thing outranks what helps it do the right thing faster');
  assert.deepEqual(ids.slice(2), ['n-cmd', 'n-fact'], 'the rest still orders by corroboration');
});

test('a note about a repository this Run does not carry is never selected', () => {
  const rep = replicaWith([
    note({ noteId: 'n-mine', seq: 1, scope: `repo:${HASH}` }),
    note({ noteId: 'n-theirs', seq: 2, scope: `repo:${OTHER}`, corroboration: { runs: 999, harnesses: 9, hosts: 9 } }),
  ]);
  const pack = selectPack(rep, { ...REQ, task: 'fix the build' });
  assert.deepEqual(pack.notes.map((n) => n.noteId), ['n-mine'],
    'teaching a Run another repository conventions is worse than teaching it nothing');
});

test('a path scope matches by prefix, not equality', () => {
  const rep = replicaWith([note({ noteId: 'n-dir', seq: 1, scope: `repo:${HASH}#src/knowledge` })]);
  assert.equal(selectPack(rep, { ...REQ, task: 'edit src/knowledge/pack.ts' }).notes.length, 1,
    'a note scoped to a directory is relevant to a file inside it');
  assert.equal(selectPack(rep, { ...REQ, task: 'edit src/api/routes.ts' }).notes.length, 0);
});

test('a caller may narrow scopes and cannot widen them', () => {
  const rep = replicaWith([
    note({ noteId: 'n-project', seq: 1, scope: 'project' }),
    note({ noteId: 'n-repo', seq: 2, scope: `repo:${HASH}` }),
    note({ noteId: 'n-other', seq: 3, scope: `repo:${OTHER}` }),
  ]);
  const narrowed = selectPack(rep, { ...REQ, task: 'fix', scopes: ['project'] });
  assert.deepEqual(narrowed.notes.map((n) => n.noteId), ['n-project']);
  const widened = selectPack(rep, { ...REQ, task: 'fix', scopes: [`repo:${OTHER}`, 'project'] });
  assert.deepEqual(widened.notes.map((n) => n.noteId), ['n-project'],
    'scopes is a filter over what the Run already qualifies for, not a request for more');
});

test('narrowing to project excludes repository and path notes', () => {
  const rep = replicaWith([
    note({ noteId: 'n-project', seq: 1, scope: 'project' }),
    note({ noteId: 'n-repo', seq: 2, scope: `repo:${HASH}` }),
    note({ noteId: 'n-path', seq: 3, scope: `repo:${HASH}#src/knowledge` }),
  ]);
  const pack = selectPack(rep, { ...REQ, task: 'edit src/knowledge/pack.ts', scopes: ['project'] });
  assert.deepEqual(pack.notes.map((n) => n.noteId), ['n-project'],
    'a filter that silently lets the most specific scopes through is worse than no filter, because it looks honoured');
});

test('the budget stops rather than skipping ahead', () => {
  const notes = [
    note({ noteId: 'n-big', seq: 1, scope: `repo:${HASH}`, claim: 'x'.repeat(400) }),
    note({ noteId: 'n-small', seq: 2, scope: 'project', claim: 'tiny' }),
  ];
  const rep = replicaWith(notes);
  const one = selectPack(rep, { ...REQ, task: 'fix' });
  const costBig = Buffer.byteLength(JSON.stringify(one.notes[0]));
  // Room for the first note only. The second is smaller and WOULD fit.
  const tight = selectPack(rep, { ...REQ, task: 'fix', maxBytes: costBig + 1 });
  assert.deepEqual(tight.notes.map((n) => n.noteId), ['n-big']);
  assert.equal(tight.omitted, 1);
  assert.ok(!tight.notes.some((n) => n.noteId === 'n-small'),
    'taking a smaller note further down the list would make this pack depend on what else was in the replica');
});

test('the same inputs always produce the same pack hash', () => {
  const notes = [
    note({ noteId: 'n-a', seq: 1, scope: 'project' }),
    note({ noteId: 'n-b', seq: 2, scope: `repo:${HASH}` }),
    note({ noteId: 'n-c', seq: 3, scope: 'project', kind: 'pitfall' }),
  ];
  const first = selectPack(replicaWith(notes), { ...REQ, task: 'fix the build' });
  const second = selectPack(replicaWith([...notes].reverse()), { ...REQ, task: 'fix the build' });
  assert.equal(first.packHash, second.packHash, 'insertion order into the replica must not leak into the pack');
  assert.deepEqual(first.notes.map((n) => n.noteId), second.notes.map((n) => n.noteId));
});

test('a revision changes the pack hash, and so does the order', () => {
  const a = note({ noteId: 'n-a', seq: 1 });
  const b = note({ noteId: 'n-b', seq: 2 });
  const base = packHashOf([a, b]);
  assert.notEqual(base, packHashOf([{ ...a, revision: 2 }, b]),
    'a note revised in place keeps its id, so a hash over ids alone would call two different packs equal');
  assert.notEqual(base, packHashOf([b, a]), 'NOTES.md renders in this order, so a reordering is visible');
});

test('an empty replica yields an empty pack with a stable hash, not a failure', () => {
  const pack = selectPack(replicaWith([]), { ...REQ, task: 'fix the build' });
  assert.equal(pack.notes.length, 0);
  assert.equal(pack.byteSize, 0);
  assert.equal(pack.packHash, packHashOf([]), 'a Run with no knowledge is a normal outcome, not an error');
});

test('pathTokens finds repo-relative paths and ignores prose and URLs', () => {
  const tokens = pathTokens('Please fix src/knowledge/pack.ts and docs/api.md, then run ./atlas/db.ts (see https://github.com/x/y). Costs 3.5, ok?');
  assert.ok(tokens.includes('src/knowledge/pack.ts'));
  assert.ok(tokens.includes('docs/api.md'));
  assert.ok(tokens.includes('atlas/db.ts'), 'a leading ./ is stripped');
  assert.ok(!tokens.some((t) => t.includes('github.com/x/y')), 'a URL is not a path in this repository');
  assert.ok(!tokens.includes('3.5'), 'a decimal is not a file');
});

test('a repository string that cannot be normalized degrades to project scope only', () => {
  const rep = replicaWith([
    note({ noteId: 'n-project', seq: 1, scope: 'project' }),
    note({ noteId: 'n-repo', seq: 2, scope: `repo:${HASH}` }),
  ]);
  // A bare host/org/repo is not one of the forms section 5 accepts, so it yields no identity.
  const pack = selectPack(rep, { projectId: 'mercury', agent: 'fake', repositories: ['github.com/aywengo/mercury'], maxBytes: 1_000_000, task: 'fix' });
  assert.deepEqual(pack.notes.map((n) => n.noteId), ['n-project'],
    'project knowledge still arrives; only the repository-specific half is lost');
});

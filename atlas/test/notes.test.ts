import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.ts';
import { NoteStore } from '../notes.ts';
import { createRedactor } from '../redact.ts';
import type { NoteContribution } from '../types.ts';

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
  assert.ok(results1[0]?.accepted);
  
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
  assert.ok(result1[0]?.accepted);
  const noteId = result1[0]?.accepted;
  
  // Same claim from another host: should be duplicate
  const contrib2 = makeContribution({
    provenance: { ...contrib1.provenance, hostId: 'host-2', runId: 'run-2' }
  });
  const result2 = store.contribute('test-project', 'host-2', [contrib2], undefined, 500);
  
  assert.equal(result2.length, 1);
  assert.ok(result2[0]?.duplicate);
  assert.equal(result2[0]?.duplicate, noteId);
  
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
    assert.ok(result.rejected);
    assert.equal(result.rejected, 'over-batch-limit');
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
  assert.ok(results[0]?.rejected);
  assert.equal(results[0]?.rejected, 'unknown-project');
  
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
  assert.ok(results[0]?.rejected);
  assert.equal(results[0]?.rejected, 'repo-not-in-project');
  
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
  assert.ok(results[0]?.rejected);
  assert.equal(results[0]?.rejected, 'secret-detected');
  
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
  const noteId = result[0]?.accepted;
  assert.ok(noteId);
  
  const detail = store.getNote('test-project', noteId);
  assert.ok(detail);
  assert.equal(detail?.note.noteId, noteId);
  assert.equal(detail?.note.claim, contrib.claim);
  
  db.close();
});

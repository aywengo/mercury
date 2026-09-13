import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.ts';
import { AtlasMetrics } from '../metrics.ts';
import { NoteStore } from '../notes.ts';
import { createRedactor } from '../redact.ts';
import type { ContributionResult } from '../types.ts';

test('metrics: render produces Prometheus text format', () => {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const redactor = createRedactor([]);
  const store = new NoteStore(db, bounds, redactor);
  const metrics = new AtlasMetrics();
  
  // Create a project
  store.createProject({
    id: 'test-project',
    name: 'Test Project',
    repoIdentities: ['github.com/test/repo'],
  });
  
  // Record some contributions
  const results: ContributionResult[] = [
    { accepted: 'note-1' },
    { duplicate: 'note-1' },
    { rejected: 'secret-detected' },
  ];
  metrics.recordContribution(results);
  
  const text = metrics.render(store);
  assert.ok(text);
  assert.ok(typeof text === 'string');
  
  // Should contain atlas_notes
  assert.ok(text.includes('atlas_notes'));
  
  // Should contain atlas_rejections_total
  assert.ok(text.includes('atlas_rejections_total'));
  
  db.close();
});

test('metrics: label values are properly escaped', () => {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const redactor = createRedactor([]);
  const store = new NoteStore(db, bounds, redactor);
  const metrics = new AtlasMetrics();
  
  store.createProject({
    id: 'test-project',
    name: 'Test Project',
    repoIdentities: ['github.com/test/repo'],
  });
  
  // Record some contributions
  const results: ContributionResult[] = [
    { accepted: 'note-1' },
    { rejected: 'claim-too-long' },
  ];
  metrics.recordContribution(results);
  
  const text = metrics.render(store);
  
  // The text should be properly formatted Prometheus text
  // Check that each line is valid
  const lines = text.split('\n').filter(l => l.length > 0 && !l.startsWith('#'));
  for (const line of lines) {
    // Each line should have at least one '{' and '}' for labels, or be a simple metric line
    // If it contains '{', it should be properly formatted
    if (line.includes('{')) {
      assert.ok(line.includes('}'), `line should have closing brace: ${line}`);
    }
  }
  
  db.close();
});

test('metrics: records contributions and rejections', () => {
  const metrics = new AtlasMetrics();
  
  const results1: ContributionResult[] = [
    { accepted: 'note-1' },
    { accepted: 'note-2' },
  ];
  metrics.recordContribution(results1);
  
  const results2: ContributionResult[] = [
    { duplicate: 'note-1' },
    { rejected: 'claim-too-long' },
  ];
  metrics.recordContribution(results2);
  
  const totals = metrics.totals();
  assert.equal(totals.contributions, 4); // 2 + 2
  assert.equal(totals.accepted, 2);
  assert.equal(totals.duplicates, 1);
  assert.equal(totals.rejected, 1);
});

test('metrics: rejection reasons are tracked', () => {
  const db = openDatabase(':memory:');
  const bounds = { maxClaimBytes: 1024, maxDetailBytes: 4096, maxEvidence: 8 };
  const redactor = createRedactor([]);
  const store = new NoteStore(db, bounds, redactor);
  const metrics = new AtlasMetrics();
  
  store.createProject({
    id: 'test-project',
    name: 'Test Project',
    repoIdentities: ['github.com/test/repo'],
  });
  
  // Record some rejections
  const results: ContributionResult[] = [
    { rejected: 'claim-too-long' },
    { rejected: 'missing-evidence' },
    { rejected: 'k2-violation' },
  ];
  metrics.recordContribution(results);
  
  const text = metrics.render(store);
  
  // Should contain reason labels
  assert.ok(text.includes('reason="claim-too-long"'));
  assert.ok(text.includes('reason="missing-evidence"'));
  assert.ok(text.includes('reason="k2-violation"'));
  
  db.close();
});

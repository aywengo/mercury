/**
 * Tier-1 harvest (docs/knowledge-base.md 7.1, 7.5, 8.1).
 *
 * The agent wrote this file, so everything here treats it as untrusted input going into a store that is
 * replicated to every host and outlives the workspace. The properties worth proving are the refusal ones:
 * a harvester that is generous here has written the agent's mistake into everyone's future context.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { harvestNotes } from '../src/knowledge/harvest.ts';
import { DEFAULT_BOUNDS, type KnowledgeBounds } from '../src/knowledge/validation.ts';
import { createRedactor } from '../src/domain/redact.ts';
import { tempDir } from './helpers.ts';

const BOUNDS: KnowledgeBounds = { ...DEFAULT_BOUNDS };

function workspaceWith(content: string | null): string {
  const dir = tempDir('mercury-harvest-');
  if (content === null) return dir;
  mkdirSync(join(dir, '.mercury'), { recursive: true });
  writeFileSync(join(dir, '.mercury/notes.jsonl'), content);
  return dir;
}

function harvest(content: string | null, over: { bounds?: KnowledgeBounds; secrets?: string[]; now?: () => number } = {}) {
  return harvestNotes({
    workspacePath: workspaceWith(content),
    bounds: over.bounds ?? BOUNDS,
    redactor: createRedactor(over.secrets ?? []),
    provenance: { hostId: 'host-a', runId: 'run-1', agent: 'primeagent', harnessVersion: '1.0.0' },
    recordedAt: '2026-01-02T00:00:00.000Z',
    ...(over.now ? { now: over.now } : {}),
  });
}

const GOOD = '{"kind":"command","scope":"project","claim":"Run one test file with node --test test/x.test.ts"}';

test('an absent file is normal, not a failure', () => {
  const r = harvest(null);
  assert.equal(r.absent, true);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected.length, 0, 'a Run that learned nothing must not look like a Run that broke something');
});

test('a valid line becomes a contribution carrying the host provenance the agent cannot set', () => {
  const r = harvest(`${GOOD}\n`);
  assert.equal(r.accepted.length, 1);
  const c = r.accepted[0]!;
  assert.equal(c.provenance.source, 'agent-reported');
  assert.equal(c.provenance.hostId, 'host-a');
  assert.equal(c.provenance.runId, 'run-1');
  assert.equal(c.claim, 'Run one test file with node --test test/x.test.ts');
});

test('a note cannot promote itself by naming its own tier or id', () => {
  // The agent controls only kind/scope/claim/detail/evidence/contradicts. Anything else it supplies is
  // ignored rather than merged, or a Run could teach the system to mark its own note promoted.
  const r = harvest('{"kind":"fact","scope":"project","claim":"x","tier":"promoted","noteId":"note_deadbeef","seq":999}\n');
  assert.equal(r.accepted.length, 1);
  const c = r.accepted[0!] as unknown as Record<string, unknown>;
  assert.equal(c.tier, undefined, 'tier is Atlas\'s to assign');
  assert.equal(c.noteId, undefined, 'a caller-chosen noteId would let one Run overwrite another note');
  assert.equal(c.seq, undefined);
});

test('a long claim is rejected, never truncated', () => {
  const long = 'x'.repeat(2000);
  const r = harvest(`{"kind":"fact","scope":"project","claim":"${long}"}\n`, { bounds: { ...BOUNDS, maxClaimBytes: 1024 } });
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected[0]!.reason, 'claim-too-long',
    'a truncated claim is a different claim, and a different claim stored as if it were the original is worse than no claim');
});

test('the per-Run cap drops the remainder with ONE rejection, not one per line', () => {
  const lines = Array.from({ length: 7 }, (_, i) => `{"kind":"fact","scope":"project","claim":"note ${i}"}`).join('\n');
  const r = harvest(`${lines}\n`, { bounds: { ...BOUNDS, maxNotesPerRun: 3 } });
  assert.equal(r.accepted.length, 3);
  const overLimit = r.rejected.filter((x) => x.reason === 'over-limit');
  assert.equal(overLimit.length, 1, '500 identical events would bury the 3 real rejections');
  assert.equal(overLimit[0]!.detail, '4');
});

test('a secret in a claim is refused outright, not stored with stars', () => {
  const r = harvest('{"kind":"fact","scope":"project","claim":"deploy with token sk-live-abcdef123456"}\n', {
    secrets: ['sk-live-abcdef123456'],
  });
  assert.equal(r.accepted.length, 0,
    'a note is retained far longer than a workspace and replicated to every host; a redacted secret is still a stored secret');
  assert.equal(r.rejected[0]!.reason, 'secret-detected');
});

test('a secret in the detail is caught too', () => {
  const r = harvest('{"kind":"fact","scope":"project","claim":"how to deploy","detail":"use sk-live-abcdef123456"}\n', {
    secrets: ['sk-live-abcdef123456'],
  });
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected[0]!.reason, 'secret-detected');
});

test('a K2-violating note is refused with the rule that fired', () => {
  // K2 is the rule against harness-specific instructions that would break another harness.
  const r = harvest('{"kind":"convention","scope":"project","claim":"load the project notes with --skill mercury-knowledge before committing"}\n');
  assert.equal(r.accepted.length, 0, r.rejected.map((x) => `${x.reason}:${x.detail ?? ''}`).join(','));
  assert.equal(r.rejected[0]!.reason, 'k2-violation');
});

test('a malformed line is refused without stopping the lines after it', () => {
  const r = harvest(`not json at all\n${GOOD}\n{"kind":"fact"}\n`);
  assert.equal(r.accepted.length, 1, 'one bad line must not discard the good ones');
  const reasons = r.rejected.map((x) => x.reason);
  assert.ok(reasons.includes('malformed-json'));
  // `kind` is checked before `scope` and before `claim`, so a record with only a kind fails on scope.
  assert.ok(reasons.includes('invalid-scope'), reasons.join(','));
});

test('the wall-clock bound keeps what was parsed and drops the rest', () => {
  // A clock that advances past the timeout after the second line.
  let calls = 0;
  const now = () => { calls += 1; return calls <= 3 ? 0 : 99_000; };
  const lines = Array.from({ length: 5 }, (_, i) => `{"kind":"fact","scope":"project","claim":"note ${i}"}`).join('\n');
  const r = harvest(`${lines}\n`, { bounds: { ...BOUNDS, harvestTimeoutMs: 10 }, now });
  assert.ok(r.timedOut, 'the timeout is reported rather than silently truncating');
  assert.ok(r.accepted.length >= 1, 'what was already parsed is kept');
  assert.ok(r.accepted.length < 5, 'and the rest is dropped');
});

test('blank lines and trailing newlines are not notes', () => {
  const r = harvest(`\n\n${GOOD}\n\n`);
  assert.equal(r.linesSeen, 1);
  assert.equal(r.accepted.length, 1);
});

test('a decision with no evidence is refused for the missing evidence, not generically', () => {
  const r = harvest('{"kind":"decision","scope":"project","claim":"we use sqlite"}\n');
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected[0]!.reason, 'missing-evidence');
  assert.equal(r.rejected[0]!.detail, 'decision', 'the author needs to know which kind demanded evidence');
});

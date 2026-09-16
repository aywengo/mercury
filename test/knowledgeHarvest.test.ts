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

import { harvestNotes, maxHarvestBytes } from '../src/knowledge/harvest.ts';
import { validateDraft } from '../src/knowledge/validation.ts';
import { EVIDENCE_TYPES, EVIDENCE_REQUIRED_KINDS, NOTE_KINDS } from '../src/knowledge/types.ts';
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

test('a file larger than the bounds can justify is refused without being read', () => {
  // The first line is a perfectly good note, and it is refused anyway. That is the point: no set of
  // notes legal under these bounds fits in this many bytes, so reading the file could only ever
  // produce rejections -- and the read itself is synchronous work on the worker's event loop, which is
  // the one thing the wall-clock bound cannot interrupt because that bound is checked between lines.
  const ceiling = maxHarvestBytes(BOUNDS);
  const r = harvest(`${GOOD}\n${'x'.repeat(ceiling)}\n`);
  assert.equal(r.accepted.length, 0, 'a valid line inside an impossible file is still refused');
  assert.equal(r.rejected.length, 1, 'one rejection for the file, not one per line');
  assert.equal(r.rejected[0]!.reason, 'over-limit');
  assert.equal(r.rejected[0]!.line, 0, 'the rejection is about the file, so it names no line');
  assert.match(r.rejected[0]!.detail ?? '', /ceiling/, 'and says what the limit was');
});

test('the ceiling is derived from the bounds, not fixed', () => {
  // Tightening the bounds has to shrink what the harvester is willing to read, or the ceiling is a
  // second, unrelated limit that an operator cannot reason about from the variables they set.
  const tight: KnowledgeBounds = { ...BOUNDS, maxNotesPerRun: 1, maxClaimBytes: 64, maxDetailBytes: 64, maxEvidence: 1 };
  assert.ok(maxHarvestBytes(tight) < maxHarvestBytes(BOUNDS));
  const r = harvest(`${GOOD}\n${'y'.repeat(maxHarvestBytes(tight))}\n`, { bounds: tight });
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected[0]!.reason, 'over-limit');
});

test('a file the bounds can justify is read normally', () => {
  const r = harvest(`${GOOD}\n`);
  assert.equal(r.accepted.length, 1, 'the guard must not become a tax on ordinary harvests');
  assert.equal(r.rejected.length, 0);
});

// --- the contribution instructions are a contract with the validator ---------------------------
//
// #589 observed six real Runs in which not one agent wrote a note, and the write path turned out to be
// correct: nothing was broken, nothing was written. The only invitation an agent gets is the prose below
// the notes in its pack. Two things make prose like that fail quietly, and both were true here: the
// evidence shapes it documented were not the shapes the validator accepts, and it described the schema
// without ever showing a line an agent could copy. These tests pin the instructions to the code, so the
// document cannot drift from the validator again without a failure.

import { renderNotesMd, NOTE_EXAMPLE_LINE } from '../src/knowledge/materialize.ts';

function instructions(): string {
  return renderNotesMd('proj-1', 'a'.repeat(32), []);
}

test('the example note shown to agents is accepted by the harvester', () => {
  // Read the example out of the rendered pack rather than importing the constant, so the test proves
  // what an agent actually sees. A constant that validates while the renderer mangles it is not a fix.
  const rendered = instructions();
  // Non-greedy to the closing fence rather than [^`]+: a claim is allowed to contain inline code, and
  // the example below does, so a backtick-terminated character class cannot span it.
  const fence = rendered.match(/```json\n([\s\S]+?)\n```/);
  assert.ok(fence, 'the instructions must show a complete example, not only a field list');
  assert.equal(fence[1], NOTE_EXAMPLE_LINE, 'the rendered example must be the exported one');

  const r = harvest(`${fence[1]}\n`);
  assert.equal(r.rejected.length, 0, `the example agents are told to copy was refused: ${JSON.stringify(r.rejected)}`);
  assert.equal(r.accepted.length, 1);
});

test('every evidence shape the instructions document is a shape the validator accepts', () => {
  const documented = [...instructions().matchAll(/\{"type":"([a-z-]+)"((?:,"[a-zA-Z]+":\.\.\.)*)\}/g)];
  const types = documented.map((m) => m[1]);
  // Against the closed vocabulary, not against a list repeated here: a type documented nowhere, or a
  // real type the instructions stopped mentioning, is the same class of defect as a wrong field.
  assert.deepEqual([...types].sort(), [...EVIDENCE_TYPES].sort(),
    `instructions document ${JSON.stringify(types)} but the vocabulary is ${JSON.stringify(EVIDENCE_TYPES)}`);

  for (const m of documented) {
    const [, type, rest] = m;
    const keys = [...rest.matchAll(/"([a-zA-Z]+)":\.\.\./g)].map((k) => k[1]);
    const ref: Record<string, unknown> = { type };
    for (const k of keys) ref[k] = k === 'seq' ? 1 : k === 'url' ? 'https://example.com/x/1' : 'x';
    const v = validateDraft({ kind: 'fact', scope: 'project', claim: 'a claim', evidence: [ref] });
    // if/fail rather than assert.ok(v.ok, `...${v.reason}`): `reason` exists only on the rejected arm,
    // and the message is the whole value of this test, so it has to be readable when it fires.
    if (!v.ok) {
      assert.fail(`documented evidence shape {"type":"${type}",${keys.join(',')}} is rejected: ${v.reason}`);
    }
  }
});

test('the invitation is tied to finishing the task, not left as an open conditional', () => {
  // "If you learn something durable" is satisfied by a model that never pauses to ask. The observed
  // failure was an agent that read this section, used the note in it, and wrote nothing at all.
  assert.match(instructions(), /Before you report the task done/,
    'the contribution step needs a checkpoint, not only a condition');
});

test('every kind the instructions document is a kind the validator accepts', () => {
  // The evidence shapes above have been pinned to the validator since this file existed, and the kind
  // list sitting three lines above them was NOT pinned -- so the same class of defect survived the fix
  // that fixed it. The instructions named `preference`, which the validator rejects as invalid-kind,
  // and omitted `artifact-pointer`, which it accepts. An agent that wrote the documented kind got a
  // rejection naming nothing that would have told it why.
  const text = instructions();
  const clause = text.match(/`kind` is one of ([^.]+)\./);
  assert.ok(clause, 'the instructions must carry a kind list this test can read');
  const documented = [...clause[1]!.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).sort();
  assert.deepEqual(documented, [...NOTE_KINDS].sort(),
    `instructions document ${JSON.stringify(documented)} but the vocabulary is ${JSON.stringify([...NOTE_KINDS].sort())}`);
});

test('the kinds that need evidence say so in the instructions', () => {
  // A pitfall or decision written without evidence is refused with `missing-evidence`. Telling an agent
  // the vocabulary but not which members of it need a citation guarantees rejections it cannot diagnose.
  const text = instructions();
  for (const kind of EVIDENCE_REQUIRED_KINDS) {
    assert.ok(text.includes(kind), `the instructions never mention the kind ${kind}`);
  }
  assert.match(text, /refused\n?without at least one evidence entry|without at least one evidence entry/,
    'the instructions must say which kinds require evidence');
});

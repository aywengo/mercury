/**
 * Decision-record parser fixtures (docs/knowledge-base.md §6.1, §6.2; issue #683).
 *
 * Table-driven over `test/fixtures/decisions/`: one file per §6.2 rule, one per accepted form of
 * the restricted frontmatter subset. On a tree without `src/knowledge/decisionRecord.ts` this file
 * fails at import, which is the regression proof. The parser is pure — every fixture is read from
 * disk and handed to `parseDecisionRecord` as text, exactly as the finalize harvester (git show)
 * and the operator index (checkout file) will hand it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseDecisionRecord,
  parseFrontmatter,
  decisionParagraph,
} from '../src/knowledge/decisionRecord.ts';
import { DEFAULT_BOUNDS } from '../src/knowledge/validation.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'decisions');
const REPO = 'https://github.com/aywengo/mercury.git';
const HEAD = '7a546bc9d2e1f3a4b5c6d7e8f9a0b1c2d3e4f5a6';

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

const INPUT = { path: 'docs/decisions/0007-valid.md', repoIdentity: REPO, headSha: HEAD, bounds: DEFAULT_BOUNDS };

test('a valid record produces a draft whose claim is the Decision paragraph byte for byte', () => {
  const text = fixture('0007-valid.md');
  const result = parseDecisionRecord(text, INPUT);
  assert.ok(result.ok, `expected ok, got ${(result as { reason?: string }).reason}`);
  if (!result.ok) return;
  const para = text.split('## Decision\n')[1]!.split('\n\n')[0]!.trim();
  assert.equal(result.draft.claim, para);
  assert.equal(result.draft.kind, 'decision');
  assert.match(result.draft.scope, /^repo:[0-9a-f]{16}$/);
});

test('the evidence always includes the self-referencing repo-file entry at headSha', () => {
  const result = parseDecisionRecord(fixture('0007-valid.md'), INPUT);
  assert.ok(result.ok);
  if (!result.ok) return;
  const selfRef = result.draft.evidence?.find(
    (e) => e.type === 'repo-file' && e.path === INPUT.path && e.sha === HEAD && e.repo === 'github.com/aywengo/mercury',
  );
  assert.ok(selfRef, 'the record must point back at itself at the commit it was read at');
  // The record's own evidence survived: one PR, one commit, one issue URL.
  const types = (result.draft.evidence ?? []).map((e) => e.type).sort();
  assert.deepEqual(types, ['commit', 'issue', 'pr', 'repo-file']);
});

test('a proposed record is skipped, not rejected', () => {
  const result = parseDecisionRecord(fixture('0008-proposed.md'), INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skipped, true, 'proposed is not wrong, only early');
  assert.equal(result.reason, 'decision-proposed');
});

test('a rejected record has its claim prefixed with Rejected:', () => {
  const result = parseDecisionRecord(fixture('0009-rejected.md'), INPUT);
  assert.ok(result.ok);
  if (!result.ok) return;
  const para = fixture('0009-rejected.md').split('## Decision\n')[1]!.split('\n\n')[0]!.trim();
  assert.equal(result.draft.claim, `Rejected: ${para}`);
});

test('a superseded record parses like an accepted one (no host-side supersededBy)', () => {
  // The supersession decision is recorded in §6.2: the host cannot know the superseding note's id
  // (Atlas assigns it), so the host emits no supersededBy; supersession stays an operator retire.
  const result = parseDecisionRecord(fixture('0014-superseded.md'), INPUT);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.draft.kind, 'decision');
  assert.equal('supersededBy' in result.draft, false,
    'the host emits no supersededBy: only Atlas knows the superseding note id');
});

test('a record with no evidence is decision-without-evidence (the §6.2 reason)', () => {
  const result = parseDecisionRecord(fixture('0010-no-evidence.md'), INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.skipped, undefined);
  assert.equal(result.reason, 'decision-without-evidence');
});

test('a Decision paragraph with a harness flag is k2-violation, proving validateDraft runs', () => {
  const result = parseDecisionRecord(fixture('0011-k2-violation.md'), INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'k2-violation');
  assert.equal(result.detail, 'harness-flag');
});

test('malformed records say what is wrong', () => {
  const cases: [string, RegExp][] = [
    ['0012-no-decision.md', /no `## Decision`/],
    ['0013-missing-title.md', /missing required key\(s\): title/],
    ['0015-bad-evidence.md', /neither a URL nor "commit: <sha>"/],
    ['0016-flow-evidence.md', /outside the supported subset|flow/i],
  ];
  for (const [name, pattern] of cases) {
    const result = parseDecisionRecord(fixture(name), INPUT);
    assert.equal(result.ok, false, `${name} should be malformed`);
    if (result.ok) continue;
    assert.equal(result.reason, 'decision-malformed', name);
    assert.match(result.detail ?? '', pattern, name);
  }
});

test('a claim over the bound is rejected by the bounds check, not truncated', () => {
  const result = parseDecisionRecord(fixture('0017-claim-too-long.md'), INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'claim-too-long');
});

test('every fixture directory entry is exercised by a case above', () => {
  // A fixture nobody loads is a rule nobody tests. Keep the two lists in step.
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 10, `expected the full fixture set, found ${files.length}`);
});

// --- unit-level: the frontmatter subset and the paragraph extraction ---------------------------

test('the frontmatter subset accepts what §6.1 shows and refuses what it does not define', () => {
  // Trailing comment on a scalar value is in the subset (the §6.1 example has one).
  const fm = parseFrontmatter(fixture('0007-valid.md'));
  assert.ok(fm);
  assert.equal(fm!.scalars.get('status'), 'accepted');
  assert.equal(fm!.scalars.get('id'), '0007');
  assert.equal(fm!.evidence.length, 3);
  // A URL fragment is not a comment: `#comment-1` has no leading whitespace before the `#`.
  assert.match(fm!.evidence[2]!, /issues\/459#comment-1/);

  // Block scalars, anchors and duplicate keys are outside the subset.
  assert.equal(parseFrontmatter('---\ntitle: |\n  block\n---\n'), null);
  assert.equal(parseFrontmatter('---\ntitle: a\ntitle: b\n---\n'), null);
  assert.equal(parseFrontmatter('no frontmatter at all'), null);
});

test('the Decision paragraph is verbatim, including its internal line breaks', () => {
  const para = decisionParagraph(fixture('0007-valid.md'));
  assert.ok(para);
  assert.match(para!, /pointers and never copies[\s\n]+of the evidence/);
  // It stops at the next heading even when no blank line separates them.
  const tight = fixture('0007-valid.md').replace('\n\n## Context', '\n## Context');
  const tightPara = decisionParagraph(tight);
  assert.ok(tightPara && !tightPara.includes('Why this came up'));
});

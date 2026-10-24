// The §14 bounds review as a test-backed checklist (docs/bots-bounds-review.md; B4, #915).
//
// The review is only worth having if it cannot drift from the design or from the suite:
//
//   - every §12 configuration row and every §14 numbered bound in the design must have a checklist
//     row, and no row may name a bound the design does not have;
//   - every `test:` row must name a test that exists in this suite, by file and exact title;
//   - every configuration row covered by the shared fixture test must still have its own negative
//     fixture in test/botConfig.test.ts;
//   - the §15.5 mutation phrases must still be in the design, and the two mutations that are
//     provable today must name the tests that caught them;
//   - a row for code that does not exist yet must say `deferred: B<n> (#…)` — the review may not
//     claim the brain is tested before B3 writes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DESIGN = readFileSync(join(ROOT, 'docs', 'dispatcher-bot-design.md'), 'utf8');
const REVIEW = readFileSync(join(ROOT, 'docs', 'bots-bounds-review.md'), 'utf8');
const CONFIG_TESTS = readFileSync(join(ROOT, 'test', 'botConfig.test.ts'), 'utf8');

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The design's §12 table: one row per documented configuration field. */
function designConfigFields(): string[] {
  const section = DESIGN.slice(DESIGN.indexOf('## 12. Configuration reference'), DESIGN.indexOf('## 13. Doctor'));
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!);
}

/** The design's §14 numbered bounds. */
function designSecurityBounds(): number[] {
  const section = DESIGN.slice(DESIGN.indexOf('## 14. Security model'), DESIGN.indexOf('## 15. Testing strategy'));
  return [...section.matchAll(/^(\d+)\. \*\*(.+?)\*\*/gm)].map((m) => Number(m[1]));
}

/** The §15.5 mutations, each with the phrase the design uses for it. */
const MUTATIONS: Array<{ id: string; phrase: string }> = [
  { id: 'M1', phrase: 'the idempotency-key derivation' },
  { id: 'M2', phrase: 'the `maxDispatchesPerHour` cap' },
  { id: 'M3', phrase: 'the redact-before-egress call' },
  { id: 'M4', phrase: 'the answer allowlist check' },
  { id: 'M5', phrase: 'the own-Run check on `input` actions' },
  { id: 'M6', phrase: 'the non-terminal `singleFlight` check' },
];

interface ReviewRow {
  id: string;
  bound: string;
  coverage: string;
}

/** Rows of the review's markdown tables whose first cell is a bound id. Escaped `\|` stays in-cell. */
function reviewRows(): ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const line of REVIEW.split('\n')) {
    if (!line.startsWith('| §')) continue;
    const cells = line.slice(1, -1)
      .replace(/\\\|/g, '\u0000')
      .split('|')
      .map((c) => c.replace(/\u0000/g, '|').trim());
    assert.equal(cells.length, 3, `review row has ${cells.length} cells, expected 3: ${line}`);
    rows.push({ id: cells[0]!.replace(/`/g, ''), bound: cells[1]!, coverage: cells[2]! });
  }
  return rows;
}

/** Exact test titles in one test file, with source escapes removed. */
function testTitles(file: string): string[] {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const titles: string[] = [];
  const re = /^test\(\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1/gm;
  for (const m of source.matchAll(re)) {
    titles.push(norm(m[2]!.replace(/\\(['"\\])/g, '$1')));
  }
  return titles;
}

const ROWS = reviewRows();
const BY_ID = new Map(ROWS.map((r) => [r.id, r]));

test('the design sources parse: §12 fields, §14 bounds and §15.5 mutations are all found', () => {
  assert.equal(designConfigFields().length, 25, 'the §12 table changed shape; update the review and this count');
  assert.equal(designSecurityBounds().length, 9, 'the §14 list changed shape; update the review and this count');
  const section15 = DESIGN.slice(DESIGN.indexOf('## 15. Testing strategy'), DESIGN.indexOf('## 16. Open decisions'));
  for (const m of MUTATIONS) {
    assert.ok(norm(section15).includes(norm(m.phrase)), `§15.5 no longer names the mutation "${m.phrase}"`);
  }
});

test('every design bound has exactly one review row, and no row invents a bound', () => {
  const expected = [
    ...designConfigFields().map((f) => `§12 ${f}`),
    ...designSecurityBounds().map((n) => `§14-${n}`),
    ...MUTATIONS.map((m) => `§15.5 ${m.id}`),
  ].sort();
  assert.deepEqual([...BY_ID.keys()].sort(), expected, 'the review and the design disagree about which bounds exist');
  assert.equal(ROWS.length, BY_ID.size, 'a bound has more than one row');
});

test('every `test:` row names a real test by file and exact title', () => {
  for (const row of ROWS) {
    if (!row.coverage.startsWith('test:')) continue;
    const parts = row.coverage.split(/;\s*(?=test:\s)/);
    for (const part of parts) {
      const m = /^test:\s*(test\/[A-Za-z0-9_.-]+\.test\.ts)\s+—\s+([\s\S]+)$/.exec(part.trim());
      assert.ok(m, `${row.id}: unparsable coverage "${part}" (expected "test: <file> — <title>")`);
      const [, file, title] = m!;
      assert.ok(testTitles(file!).includes(norm(title!)),
        `${row.id}: ${file} has no test titled "${norm(title!)}" — a renamed or deleted test silently drops this bound`);
    }
  }
});

test('rows for code that does not exist yet are deferred, with the milestone and its issues', () => {
  // The exact expectation is derived from the design's own scope: triggers are B2, the brain is
  // B3, and §14 items 1-4/6/8 all describe brain or observer behaviour.
  const deferred: Record<string, RegExp> = {};
  for (const field of designConfigFields()) {
    if (field.startsWith('triggers')) deferred[`§12 ${field}`] = /^deferred: B2 \(#907–#909\)/;
    if (field.startsWith('brain')) deferred[`§12 ${field}`] = /^deferred: B3 \(#912\)/;
  }
  for (const n of designSecurityBounds()) {
    if (n === 3) deferred[`§14-${n}`] = /^deferred: B2 \(#907–#909\)/;
    if ([1, 2, 4, 6, 8].includes(n)) deferred[`§14-${n}`] = /^deferred: B3 \(#912\)/;
  }
  for (const id of ['M2', 'M3', 'M4', 'M5']) deferred[`§15.5 ${id}`] = /^deferred: B3 \(#912\)/;
  for (const [id, pattern] of Object.entries(deferred)) {
    const row = BY_ID.get(id);
    assert.ok(row, `${id} is missing from the review`);
    assert.match(row!.coverage, pattern, `${id} must be marked deferred with its milestone and issues`);
  }
  // The other direction: a bound whose code ships today must not be waved off as deferred.
  for (const row of ROWS) {
    if (deferred[row.id]) continue;
    assert.ok(row.coverage.startsWith('test:'), `${row.id} ships today, so it needs a test, not "${row.coverage}"`);
  }
});

test('every configuration row covered by the fixture test still has its negative fixture', () => {
  // One fixture case per field: `field: /<path>/` is the assertion that the error names the field.
  const fixtures: Record<string, string> = {
    'description': 'field: /description/',
    'api.url': 'field: /api\\.url/',
    'api.timeoutMs': 'field: /api\\.timeoutMs/',
    'schedule.tasks[].name': 'field: /schedule\\.tasks\\[0\\]\\.name/',
    'schedule.tasks[].cron': 'field: /schedule\\.tasks\\[0\\]\\.cron/',
    'schedule.tasks[].tz': 'field: /schedule\\.tasks\\[0\\]\\.tz/',
    'schedule.tasks[].template': 'field: /schedule\\.tasks\\[0\\]\\.template/',
    'schedule.tasks[].singleFlight': 'field: /schedule\\.tasks\\[0\\]\\.singleFlight/',
    'schedule.tasks[].onMiss': 'field: /schedule\\.tasks\\[0\\]\\.onMiss/',
  };
  for (const [field, needle] of Object.entries(fixtures)) {
    const row = BY_ID.get(`§12 ${field}`);
    assert.ok(row, `§12 ${field} is missing from the review`);
    assert.ok(row!.coverage.includes('test/botConfig.test.ts — fixture set'),
      `§12 ${field} is covered by the shared fixture test, so its row must say so`);
    assert.ok(CONFIG_TESTS.includes(needle),
      `§12 ${field}: test/botConfig.test.ts no longer has the negative fixture "${needle}"`);
  }
});

test('the two provable mutations name the tests that caught them', () => {
  // §15.5 M1 and M6 were applied to the scheduler by hand; the review records the failing tests.
  const m1 = BY_ID.get('§15.5 M1')!;
  assert.ok(m1.coverage.includes('onMiss collapse fires once keyed to the newest MISSED scheduled minute'));
  assert.ok(m1.coverage.includes('onMiss run fires once per missed interval capped at maxCatchUp'));
  const m6 = BY_ID.get('§15.5 M6')!;
  assert.ok(m6.coverage.includes('singleFlight skips NEEDS_INPUT (and every non-terminal status), dispatches on terminal'));
  // The evidence block is what makes the claim auditable; it must stay in the review.
  assert.match(REVIEW, /### Mutation evidence/);
  assert.match(REVIEW, /M6\*\* — `runIsNonTerminal` narrowed to `QUEUED \|\| RUNNING`/);
});

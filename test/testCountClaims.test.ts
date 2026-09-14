/**
 * Documents that describe the CURRENT test suite must not quote how many tests it has.
 *
 * Issue #580. Measured by running the suites, not by counting declarations:
 * `docs/daemon-agent-sessions.md` said 12 where `test/daemonAgentAdapter.test.ts` runs 36; its own §5.1
 * said 57 (18+35+4) where the three files run 58 (18+36+4); `fleet/README.md` said 187 where
 * `npm run test:fleet` reports 202; `docs/fleet-e2e-design.md` said 191 across 19 files where it is 202
 * across 20; `docs/agent-adapters.md` said 10 and 22 where those files run 21 and 26.
 *
 * The daemon document is the instructive one. It was maintained -- §5.1 was rewritten with a total and a
 * per-file breakdown when the suite was rebuilt, and was already wrong by one within a few changes. A
 * carefully maintained count is still a count nobody runs. The counts were removed rather than refreshed,
 * because refreshing installs the same defect with fresher digits.
 *
 * Forward-looking estimates are exempt and stay: `**Effort:** M (adapter + mock fixture + ~10 tests)` is a
 * plan about code that does not exist yet, not a claim about a suite. The `~` is what distinguishes them,
 * so the exemption keys on it rather than on the surrounding sentence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Each file is read through its own statically resolvable call. That is not stylistic: the CI guard that
 * enforces "every test reading a docs file runs in docs-contract" resolves paths by reading the arguments of
 * readFileSync calls. A loop over an array of path strings is invisible to it, so the suite would look
 * docs-free, get left out of docs-contract, and then never run on the markdown-only PRs it exists to guard.
 */
const DAEMON = readFileSync(join(import.meta.dirname, '..', 'docs', 'daemon-agent-sessions.md'), 'utf8');
const ADAPTERS = readFileSync(join(import.meta.dirname, '..', 'docs', 'agent-adapters.md'), 'utf8');
const FLEET_E2E = readFileSync(join(import.meta.dirname, '..', 'docs', 'fleet-e2e-design.md'), 'utf8');
const FLEET_README = readFileSync(join(import.meta.dirname, '..', 'fleet', 'README.md'), 'utf8');

const CURRENT_STATE_DOCS: Record<string, string> = {
  'docs/daemon-agent-sessions.md': DAEMON,
  'docs/agent-adapters.md': ADAPTERS,
  'docs/fleet-e2e-design.md': FLEET_E2E,
  'fleet/README.md': FLEET_README,
};

/*
 * Two shapes, both in the form the offenders actually took:
 *
 *   `12 tests` / `187 tests` / `12 additional tests`
 *   `12 pass, 0 fail`
 *
 * Word-spelled numbers are included because the real offender this change removed was the phrase
 * "twelve tests" -- a count written out in prose, in a section heading, survived for months while the
 * suite tripled. A guard that only reads digits would have let it back in.
 *
 * One intervening adjective is allowed ("12 passing tests") because that is how someone rewords a count
 * after a reviewer objects to the bare form. Two or more is prose about something else.
 *
 * Deliberately excluded after they produced false positives: a bare `N files` matched `0600 file`, and a
 * bare `N pass` matched the heading "### 4.2 Pass `queue` to `createApp`". The `191 tests across 19 files`
 * case is still caught, by its first half. A leading ~ marks a forward-looking estimate, which is allowed.
 */
/*
 * `one` is deliberately absent. Every "one test" in the corpus this guard covers means "a single test"
 * ("the gap is not one test is missing", "caught by at least one test"), never "the suite has one test".
 * Including it made the guard fire on prose three times in one file, and a guard that cries wolf gets
 * widened away. A suite-size claim spelled "one" is not a thing that happens here.
 */
const WORDNUM = String.raw`\d{1,4}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:-(?:one|two|three|four|five|six|seven|eight|nine))?|hundred(?:\s+thousand)?`
const COUNT = new RegExp(
  String.raw`(?<!~)\b(?:${WORDNUM})\s+(?:[a-z]+\s+)?tests?\b`
  + String.raw`|(?<!~)\b(?:${WORDNUM})\s+pass,\s*\d+\s+fail\b`,
  'gi',
);
// The bare "N pass" form, matched case-sensitively so the heading "4.2 Pass `queue`" cannot satisfy it.
const PASS_FORM = new RegExp(String.raw`(?<!~)\b(?:${WORDNUM})\s+pass\b`, 'g');

test('docs describing the current suite do not quote its size', () => {
  const offenders: string[] = [];
  for (const [rel, text] of Object.entries(CURRENT_STATE_DOCS)) {
    for (const m of [...text.matchAll(COUNT), ...text.matchAll(PASS_FORM)]) {
      const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index + m[0].length)).trim();
      offenders.push(`${rel}: "${m[0]}" :: ${line.slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [],
    `these quote a suite size that nothing keeps true:\n${offenders.join('\n')}\n`
    + 'Name the test files instead -- that is the part that stays useful. `npm run test:fleet` is the check '
    + 'for a number. Forward-looking estimates are fine and stay marked with ~.');
});

test('the estimate exemption actually exempts, and the count does not', () => {
  // Without this the exemption could be widened until it swallows the real case.
  assert.equal('Effort: M (adapter + mock fixture + ~10 tests)'.match(COUNT), null,
    'a ~estimate was flagged; the exemption is what keeps the guard from being weakened away');
  assert.ok('the suite reports 187 tests'.match(COUNT), 'a bare count was NOT flagged -- guard is inert');
  assert.ok('12 tests, 12 pass, 0 fail'.match(COUNT), 'the pass form was not flagged');
  assert.ok('191 tests across 19 files'.match(COUNT), 'the fleet-e2e form was not flagged');
  // The two shapes deliberately excluded, pinned so nobody re-adds them and calls the noise "coverage".
  assert.equal('### 4.2 Pass `queue` to `createApp`'.match(COUNT), null, 'a section heading was flagged');
  assert.equal('credentials live in a 0600 file'.match(COUNT), null, 'a file permission was flagged');
  // Word-spelled numbers, and one intervening adjective. The phrase this guard exists to stop was
  // "twelve tests" -- spelled out, in a heading, and it survived a tripling of the suite.
  for (const s of ['twelve tests', '12 passing tests', 'twelve daemon tests', 'all 36 tests pass',
                   'the suite has 187 tests', '12 tests, 12 pass, 0 fail']) {
    assert.ok(s.match(COUNT), `"${s}" was not flagged`);
  }
  assert.ok('twelve pass, 0 fail'.match(COUNT), 'the spelled-out pass/fail triple was not flagged');
  // Idiomatic "one test" means "a single test", never "the suite has one test".
  for (const s of ['the gap is not one test is missing', 'caught by at least one test',
                   'One test in the first draft was wrong']) {
    assert.equal(s.match(COUNT), null, `"${s}" is prose about a single test, not a suite size`);
    assert.equal(s.match(PASS_FORM), null, `"${s}" matched the pass form`);
  }
  assert.ok('all twelve pass'.match(PASS_FORM), 'bare spelled "N pass" was not flagged');
  // The tens the first pass omitted, and hyphenated compounds. "twenty-one tests" evaded until the
  // hyphen was handled: `twenty\s+` cannot match across it, and the trailing `one tests` is exempt.
  for (const s of ['sixty tests', 'seventy tests', 'eighty tests', 'ninety tests', 'twenty-one tests',
                   'ninety-nine tests', 'one hundred tests', 'a hundred tests']) {
    assert.ok(s.match(COUNT), `"${s}" was not flagged`);
  }
});
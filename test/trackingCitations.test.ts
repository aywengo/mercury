/**
 * A citation that says "tracked in #N" has to say what state that tracking is in.
 *
 * This is the third pass at the same defect. #562 was cited as live tracking after it closed (#583); #575
 * was closed and both `docs/status.md` and `docs/goals.md` went on describing it as the place the work is
 * tracked and where "the open decision" lives. In each case a reader follows the link, finds a closed issue,
 * and cannot tell whether the limitation was fixed, rejected, or dropped -- and the honest answer, "deliberately
 * left undone and nothing owns it", is the one the sentence hides.
 *
 * #583 pinned the single #562 citation and said in its comment that it could not do more, because deciding
 * whether "Tracked in [#N]" is a lie needs GitHub and this suite runs offline. That bound was honest and it
 * was also narrower than necessary. The suite cannot learn an issue's state. What it CAN insist on is that the
 * document declares one: every citation must state its tracking state, so a closed issue cannot quietly keep
 * posing as live tracking, and a new citation written without a state fails the same way.
 *
 * The state has to be predicated of the ISSUE. The first version of this guard accepted any "open" or
 * "closed" nearby, and passed both real defects -- `docs/status.md` said "where the open decision is", and
 * `docs/goals.md` said "along with the open question of". Both describe the decision, not the issue, and both
 * let the exact bug through.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Read explicitly rather than by looping a directory: the CI guard that requires every docs-reading test to
// run in docs-contract resolves paths out of readFileSync arguments, and a loop is invisible to it. The sweep
// below adds coverage; these two lines give the suite a trigger.
const STATUS = readFileSync(join(import.meta.dirname, '..', 'docs', 'status.md'), 'utf8');
const GOALS = readFileSync(join(import.meta.dirname, '..', 'docs', 'goals.md'), 'utf8');

/*
 * The citation itself. Link text may say "issue #575" rather than "#575", and "Follow-up in" is capitalised
 * at the start of a sentence -- both defeated the first version.
 */
const CITATION = /(?:\btracked in|\btracked under|\bfollow[\s-]up in)\s*\[[^\]]*?#(\d+)\]/gi;

/*
 * A tracking state, predicated of the CITED ISSUE. Two things this has to survive, both found by review:
 *
 *  - "the open question" / "the open decision" -- a state word about a nearby noun, not the issue;
 *  - "the chapter is closed but tracked in [#575]" / "tracked in [#575] and the PR is closed" -- a state word
 *    about a DIFFERENT subject in the same sentence. A bare `is closed` branch accepted both, which is the
 *    very defect the guard exists to catch, relocated one clause away.
 *
 * So the state must attach to the citation: either it names the issue number, or it is a relative clause
 * immediately following the link, or it is one of the two unambiguous phrases that need no subject at all.
 */
const STATE_AFTER = /^\s*(?:,\s*|\s+)which\s+(?:is|remains|was|stays|now)\s+(?:open|closed)/i;
const STATE_TIGHT = /^\s*(?:is|remains|was|stays|now)\s+(?:open|closed)|\s*\((?:open|closed)\)/i;
const STATE_BEFORE = /(?:\b(?:open|closed)\s+issue\s*)$/i;
const NAMED = /(?:\b(?:open|closed)\s+issue\s*#?\d*|#\d+\s+(?:is|remains)\s+(?:open|closed))/i;
const SUBJECTLESS = /not\s+currently\s+tracked|no\s+open\s+issue|nothing\s+currently\s+tracks/i;

/** Text from the citation to the end of its sentence, and from the sentence start to the citation. */
function windows(text: string, at: number, end: number): { before: string; after: string } {
  const from = Math.max(0, text.lastIndexOf('. ', at) + 2);
  const stop = text.indexOf('. ', end);
  const sentEnd = stop === -1 ? Math.min(text.length, end + 240) : stop + 1;
  return { before: text.slice(from, at), after: text.slice(end, sentEnd) };
}

function unqualified(text: string, label: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(CITATION)) {
    const at = m.index ?? 0;
    let end = at + m[0].length;
    // A markdown link's URL follows the text: `[#575](https://...)`. Without stepping over it the "after"
    // window starts inside the parentheses and a following ", which is closed" is never seen.
    if (text[end] === '(') {
      const close = text.indexOf(')', end);
      if (close !== -1) end = close + 1;
    }
    const { before, after } = windows(text, at, end);
    const sentence = (before + m[0] + after).replace(/\s+/g, ' ');
    const attached = STATE_AFTER.test(after)
      || STATE_TIGHT.test(after)
      || STATE_BEFORE.test(before.replace(/\s+$/, ' '))
      || NAMED.test(sentence)
      || SUBJECTLESS.test(sentence);
    if (!attached) bad.push(`${label} #${m[1]}: ...${sentence.slice(-150)}`);
  }
  return bad;
}

test('every "tracked in [#N]" citation states its tracking state', () => {
  const found = [...unqualified(STATUS, 'docs/status.md'), ...unqualified(GOALS, 'docs/goals.md')];
  assert.deepEqual(found, [],
    `these citations do not say whether the issue is open or closed:\n${found.join('\n')}\n`
    + 'Say "which is closed, so nothing currently tracks it", or "the open issue #N". A citation that omits '
    + 'the state reads as live tracking forever.');
});

test('a state word about anything other than the cited issue does not qualify the citation', () => {
  // Every string below is a real attack an earlier version accepted. They stay as fixtures because "the guard
  // is too generous" is invisible unless the generous cases are pinned.
  const must_flag = [
    'The chapter is closed but tracked in [#575](https://example.com/issues/575).',
    'The work is tracked in [#575](https://example.com/issues/575) and the PR is closed.',
    'The unbuilt half is tracked in [#575](https://example.com/issues/575), where the open decision is pending.',
    'They are tracked in [#575](https://example.com/issues/575), along with the open question of it.',
    'They are tracked in [#575](https://example.com/issues/575). It was closed in another issue.',
    'They are tracked in [issue #575](https://example.com/issues/575).',
    'Follow-up in [#575](https://example.com/issues/575) for the rest.',
  ];
  for (const s of must_flag) {
    assert.equal(unqualified(s, 'fixture').length, 1, `accepted a citation with no state on the issue:\n  ${s}`);
  }

  // And the forms that must pass, so the guard cannot be satisfied merely by being strict.
  const must_pass = [
    'It was tracked in [#575](https://example.com/issues/575), which is closed, so nothing currently tracks it.',
    'It is tracked in [#575](https://example.com/issues/575) (open) for the rest.',
    'It is tracked in the open issue #575 ([#575](https://example.com/issues/575)).',
    'It is tracked in [#575](https://example.com/issues/575), which remains open.',
    'It is tracked in [#575](https://example.com/issues/575) and is not currently tracked elsewhere.',
  ];
  for (const s of must_pass) {
    assert.deepEqual(unqualified(s, 'fixture'), [], `rejected a properly qualified citation:\n  ${s}`);
  }
});

test('the sweep covers every markdown file, not only the two read above', () => {
  // Defence in depth. These files are read through a directory walk, so the CI path guard cannot see them and
  // a docs-only PR touching one of them may not run this suite; the two explicit reads above are what carry
  // the trigger. Coverage here is real whenever the job runs at all.
  const root = join(import.meta.dirname, '..');
  const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
    .flatMap((d) => d.isDirectory() ? walk(`${dir}/${d.name}`) : (d.name.endsWith('.md') ? [`${dir}/${d.name}`] : []));
  const files = [...walk('docs'), 'ARCHITECTURE.md', 'README.md'];
  const found = files.flatMap((f) => unqualified(readFileSync(join(root, f), 'utf8'), f));
  assert.deepEqual(found, [], `unqualified tracking citations:\n${found.join('\n')}`);
});
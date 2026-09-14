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
 * The citation itself. Three shapes the first versions missed: link text may say "issue #575" rather than
 * "#575"; "Follow-up in" is capitalised at the start of a sentence; and prose says "tracked in the open issue
 * [#575]" with words between the verb and the link, which a pattern demanding `[` immediately after "in"
 * never matched at all -- a silent coverage hole, worse than a false positive because nothing fails.
 */
const CITATION = /(?:\btracked in|\btracked under|\bfollow[\s-]up in)\s+(?:[^\s][^\[\]]{0,40}?)?\[[^\]]*?#(\d+)\]/gi;

/*
 * A tracking state, predicated of the CITED ISSUE. Four things this has to survive, every one of them found
 * by review rather than by thought:
 *
 *  - "the open question" / "the open decision" -- a state word about a nearby noun;
 *  - "the chapter is closed but tracked in [#575]" -- a state word about a different SUBJECT;
 *  - "While #576 is closed, tracked in [#575]" -- a state word about a different ISSUE;
 *  - "this is not currently tracked elsewhere, but tracked in [#575]" -- a subjectless state phrase that
 *    belongs to another clause entirely.
 *
 * So: the state must either name THIS issue's number, or sit immediately after the link, or be one of the
 * subjectless phrases and also sit after the link. A `#` is not a word character, so `\b` before `#575`
 * never matches -- the anchor is an explicit boundary instead.
 */
const stateFor = (num: string) => new RegExp(
  String.raw`(?:^|[\s,;:(])#${num}\s*(?:is|remains|was|stays|now)\s+(?:open|closed)`
  + String.raw`|(?:^|[\s,;:(])(?:open|closed)\s+issue\s+#${num}\b`, 'i');
const STATE_AFTER = /^\s*(?:,\s*|\s+|;\s*)?(?:which\s+)?(?:is|remains|was|stays|now)\s+(?:open|closed)/i;
const STATE_PAREN = /^\s*\((?:open|closed)\)/i;
const STATE_BEFORE = /(?:\b(?:open|closed)\s+issue\s*)$/i;
const SUBJECTLESS_AFTER = /^(?:[^\n]{0,60}?)?\b(?:not\s+currently\s+tracked|no\s+open\s+issue|nothing\s+currently\s+tracks)\b/i;

/** Text from the citation to the end of its sentence, and from the sentence start to the citation. */
function windows(text: string, at: number, end: number): { before: string; wide: string; after: string } {
  // lastIndexOf returns -1 when there is no earlier sentence, and -1 + 2 is 1 -- which silently chopped the
  // first character off every sentence at the start of a paragraph, hiding a state written there.
  const prev = text.lastIndexOf('. ', at);
  const from = prev === -1 ? 0 : prev + 2;
  // One sentence back as well. `#575 is open. Tracked in [#575](...)` states the state in the PRECEDING
  // sentence, which is ordinary prose and was missed. Safe to widen because the only check that reads this
  // wider window is the number-specific one: it requires this issue's own number, so a neighbouring
  // sentence about a different issue cannot satisfy it.
  // Search BEFORE the sentence start, not before the citation: searching from the citation lands on the
  // same boundary and yields the same window, which is how this first appeared to work and did nothing.
  // `from - 2` steps past the boundary itself. Slicing to `from` leaves the same ". " at the end of the
  // slice, lastIndexOf finds it again, and the wide window silently equals the narrow one.
  const prior = text.slice(0, Math.max(0, from - 2));
  const back = prior.lastIndexOf('. ');
  const wideFrom = back === -1 ? 0 : back + 2;
  const stop = text.indexOf('. ', end);
  const sentEnd = stop === -1 ? Math.min(text.length, end + 240) : stop + 1;
  return { before: text.slice(from, at), wide: text.slice(wideFrom, at), after: text.slice(end, sentEnd) };
}

function unqualified(text: string, label: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(CITATION)) {
    const num = m[1];
    const at = m.index ?? 0;
    let end = at + m[0].length;
    // A markdown link's URL follows the text: `[#575](https://...)`. Without stepping over it the "after"
    // window starts inside the parentheses and a following ", which is closed" is never seen.
    // Step over the link target. Nested brackets (`[[#575]](url)`) are not valid markdown, but they are
    // easy to type, and stopping at the `]` would leave the state clause outside the window.
    let scan = end;
    while (text[scan] === ']') scan++;
    if (text[scan] === '(') {
      const close = text.indexOf(')', scan);
      if (close !== -1) end = close + 1;
    }
    const { before, wide, after } = windows(text, at, end);
    const attached = STATE_AFTER.test(after)
      || STATE_PAREN.test(after)
      || STATE_BEFORE.test((before + m[0].slice(0, Math.max(0, m[0].indexOf('[')))).replace(/\s+$/, ' '))
      // The matched span is part of the context: "tracked in the open issue #575 ([#575](...))" puts the
      // state INSIDE the match, so searching only the text around it rejects a correct sentence.
      || stateFor(num).test(`${wide} ${m[0]} ${after}`)
      || SUBJECTLESS_AFTER.test(after);
    if (!attached) bad.push(`${label} #${num}: ...${(before + m[0] + after).replace(/\s+/g, ' ').slice(-150)}`);
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
    // A state belonging to a DIFFERENT issue must not qualify this citation.
    'While #576 is closed, tracked in [#575](https://example.com/issues/575) for the rest.',
    '#576 is closed, but tracked in [#575](https://example.com/issues/575) as a note.',
    // A subjectless state phrase belonging to another clause must not qualify it either.
    'This is not currently tracked elsewhere, but tracked in [#575](https://example.com/issues/575).',
    'Nothing currently tracks the workaround, but tracked in [#575](https://example.com/issues/575).',
    'The PR, which is closed, referenced tracked in [#575](https://example.com/issues/575).',
    'It was tracked in [#575](https://example.com/issues/575); now the branch is closed.',
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
    // `#` is not a word character, so an earlier `\b` anchor made this reject a sentence that states the
    // state plainly. Pinned because a false positive here teaches contributors to avoid the rule.
    '#575 is open; tracked in [#575](https://example.com/issues/575).',
    'It is tracked in the open issue #575 ([#575](https://example.com/issues/575)).',
    'See the open issue #575, tracked in [#575](https://example.com/issues/575) for details.',
    'Tracked in [#575](https://example.com/issues/575) (closed); see the linked PR.',
    // A state in the PRECEDING sentence is ordinary prose, not an evasion.
    '#575 is open. Tracked in [#575](https://example.com/issues/575) for the rest.',
    'The daemon work landed. #575 is closed. It is tracked in [#575](https://example.com/issues/575).',
  ];
  for (const s of must_pass) {
    assert.deepEqual(unqualified(s, 'fixture'), [], `rejected a properly qualified citation:\n  ${s}`);
  }
});

test('the one accepted imprecision is recorded, not forgotten', () => {
  // Review found that `PR #575 is closed, tracked in [#575]` is accepted: the state is about a pull request
  // that happens to carry the same number. It is left accepted, for a reason rather than by omission --
  // GitHub numbers issues and pull requests from ONE sequence, so in this repository #575 is an issue and
  // there is no PR #575 to be talking about. The sentence cannot refer to two different objects, so there is
  // nothing for the guard to disambiguate. Verified against the API rather than assumed.
  //
  // Pinned as ACCEPTED so that if this ever starts failing, whoever changes the guard learns the reasoning
  // was load-bearing and re-checks the namespace claim instead of quietly tightening the pattern.
  const ambiguous = 'PR #575 is closed, tracked in [#575](https://example.com/issues/575).';
  assert.deepEqual(unqualified(ambiguous, 'fixture'), [],
    'this now rejects a sentence that cannot occur on GitHub; if the namespace assumption changed, revisit it');
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
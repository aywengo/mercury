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

const CITATION = /(?:\b[Tt]racked in|\btracked under|\bfollow[\s-]up in)\s*\[#(\d+)\]/g;

/*
 * A tracking state, predicated of the issue. Deliberately does not accept a bare "open"/"closed" -- see the
 * header. "not currently tracked" and "no open issue" are states too: they are what a closed citation with no
 * replacement should say.
 */
const STATE = new RegExp([
  String.raw`(?:it|this|the issue|which)\s+(?:is|remains|was|stays|now)\s+(?:open|closed)`,
  String.raw`\b(?:open|closed)\s+issue\s*#?\d*`,
  String.raw`\((?:open|closed)\)`,
  String.raw`\bis\s+(?:open|closed)\b`,
  String.raw`not\s+currently\s+tracked`,
  String.raw`no\s+open\s+issue`,
].join('|'), 'i');

/** The sentence containing the match, tolerant of the line wrapping prose actually gets. */
function sentence(text: string, at: number, end: number): string {
  const from = Math.max(0, text.lastIndexOf('. ', at) + 2);
  const stop = text.indexOf('. ', end);
  return text.slice(from, stop === -1 ? Math.min(text.length, end + 240) : stop + 1).replace(/\s+/g, ' ');
}

function offenders(text: string, label: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(CITATION)) {
    const s = sentence(text, m.index ?? 0, (m.index ?? 0) + m[0].length);
    if (!STATE.test(s)) bad.push(`${label} #${m[1]}: ...${s.slice(-150)}`);
  }
  return bad;
}

test('every "tracked in [#N]" citation states its tracking state', () => {
  const found = [...offenders(STATUS, 'docs/status.md'), ...offenders(GOALS, 'docs/goals.md')];
  assert.deepEqual(found, [],
    `these citations do not say whether the issue is open or closed:\n${found.join('\n')}\n`
    + 'Say "which is closed, so nothing currently tracks it", or "the open issue #N". A citation that omits '
    + 'the state reads as live tracking forever.');
});

test('the guard rejects a state predicated of something other than the issue', () => {
  // Positive control for the exact wording that defeated the first version.
  const defeated = 'The unbuilt half is tracked in [#999](https://example.com/issues/999), where the open '
    + 'decision is whether to build it.';
  assert.ok(!STATE.test(sentence(defeated, 22, 80)),
    'the state pattern matched "the open decision", which describes the decision and not the issue');
  const fixed = 'The unbuilt half was tracked in [#999](https://example.com/issues/999), which is closed, '
    + 'so nothing currently tracks it.';
  assert.ok(STATE.test(sentence(fixed, 26, 84)), 'the corrected form is not accepted either');
});

test('the sweep covers every markdown file, not only the two read above', () => {
  // Defence in depth. These files are read through a directory walk, so the CI path guard cannot see them and
  // a docs-only PR touching one of them may not run this suite; the two explicit reads above are what carry
  // the trigger. Coverage here is real whenever the job runs at all.
  const root = join(import.meta.dirname, '..');
  const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
    .flatMap((d) => d.isDirectory() ? walk(`${dir}/${d.name}`) : (d.name.endsWith('.md') ? [`${dir}/${d.name}`] : []));
  const files = [...walk('docs'), 'ARCHITECTURE.md', 'README.md'];
  const found = files.flatMap((f) => offenders(readFileSync(join(root, f), 'utf8'), f));
  assert.deepEqual(found, [], `unqualified tracking citations:\n${found.join('\n')}`);
});
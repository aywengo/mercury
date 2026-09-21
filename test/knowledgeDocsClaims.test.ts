/**
 * Claims in `docs/knowledge-base.md` that the code has moved past.
 *
 * The document is a spec, and a spec gets implemented from. Section 10's compatibility matrix is the row a
 * contributor reads to decide whether work on a harness is possible, and for a while it said Hermes "cannot
 * complete any Run through Mercury today" on the strength of a skill-namespace failure that #520 had already
 * fixed and #507 had already observed on a real binary. The document's own status header said the Hermes row
 * "was measured rather than assumed". One file, two answers, and the stale one was in the place someone
 * looking for a blocker would read.
 *
 * These assertions are deliberately about relationships rather than exact wording, in the style of
 * `releaseDocs.test.ts`: the matrix must not resurrect a disproved blocker, and where it describes something
 * measured it must name the evidence. Rewriting the prose stays allowed; quietly re-widening the claim does
 * not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOC = readFileSync(join(import.meta.dirname, '../docs/knowledge-base.md'), 'utf8');

/** The `hermes` row of the section 10 compatibility matrix, or null when the row is gone. */
function hermesRow(): string | null {
  const row = DOC.split('\n').find((l) => /^\|\s*`hermes`/.test(l));
  return row ?? null;
}

test('the matrix does not resurrect the disproved Hermes blocker', () => {
  // #520 fixed the skill-namespace failure and #507 observed the fix on Hermes v0.21.2 (Run
  // run_f3a4e81644be4081). Any sentence that says Hermes cannot run at all is now false, whatever it
  // attributes the blockage to, so the guard is on the claim rather than on the old reason.
  const disproved = [
    /cannot complete any Run/i,
    /nothing about knowledge is testable/i,
    /untestable until Teams Phase/i,
  ];
  for (const claim of disproved) {
    assert.ok(!claim.test(DOC),
      `docs/knowledge-base.md still asserts a disproved Hermes blocker: ${claim}`);
  }
});

test('the hermes row cites the measurement it is based on', () => {
  const row = hermesRow();
  assert.ok(row, 'the section 10 matrix must still carry a hermes row');
  // The row is allowed to be negative -- Hermes really does not read .mercury/knowledge/NOTES.md, and
  // §9.4 does block writing a tracked AGENTS.md. What it may not be is unmeasured.
  assert.match(row, /#541|#507|#520/,
    'the hermes row must point at the issue or run that measured it, not at an assumption');
  assert.match(row, /run_f3a4e81644be4081|v0\.21\.2/,
    'the row must name the binary or run the measurement came from');
  // The distinction the whole of #541 is about: one channel absent, another present.
  assert.match(row, /AGENTS\.md/,
    'the row must mention the AGENTS.md channel, which is the finding #541 added');
});

test('the matrix and the status header agree about Hermes', () => {
  // The original defect was not that the row was pessimistic. It was that the header said the row had been
  // measured while the row itself still described a fixed bug as a live blocker. If either side changes,
  // this fails until they are reconciled.
  const headerClaimsMeasured = /Hermes row was measured rather than assumed/i.test(DOC);
  const rowCitesEvidence = /#541|#507|#520/.test(hermesRow() ?? '');
  assert.equal(headerClaimsMeasured, rowCitesEvidence,
    'the status header and the hermes matrix row disagree: the header says the row was measured '
    + `(header=${headerClaimsMeasured}, row cites evidence=${rowCitesEvidence})`);
});

// --- docs/status.md: one knowledge section, and the Hermes claim matches the tree ------------------
//
// Two sections describing the same subsystem were added to `docs/status.md` in a single day, by two
// different PRs from the same author, and prose review caught neither. The second was written after an audit
// that read the file from a working tree on another branch, so it "found" a gap that did not exist on the
// default branch. The result was not merely redundant: the older section still said the Hermes `AGENTS.md`
// channel was "tracked separately" after #541 had merged it, so the page carried two opposite answers and the
// stale one came first.

const STATUS = readFileSync(join(import.meta.dirname, '../docs/status.md'), 'utf8');

/** Every `### Knowledge base...` heading in the status page. */
function knowledgeHeadings(): string[] {
  return STATUS.split('\n').filter((l) => /^###\s+Knowledge base/.test(l));
}

test('status.md describes the knowledge base in exactly one section', () => {
  const heads = knowledgeHeadings();
  assert.equal(heads.length, 1,
    `docs/status.md has ${heads.length} knowledge-base sections (${heads.join(' | ')}). `
    + 'Two sections describing one subsystem drift apart and eventually contradict each other; merge them.');
});

test('status.md does not claim the Hermes AGENTS.md channel is still pending', () => {
  // #541 merged it. The phrasing that survived in the duplicate section was "tracked separately", which reads
  // as "not built yet" and was the concrete contradiction the duplicate produced.
  const hermes = STATUS.split('\n').filter((l) => /AGENTS\.md/.test(l)).join('\n');
  assert.ok(hermes.length > 0, 'the status page no longer mentions the Hermes AGENTS.md channel at all');
  assert.doesNotMatch(hermes, /tracked separately|is tracked in|not yet built|remains blocked/,
    'the status page describes the Hermes AGENTS.md channel as unfinished; #541 merged it');
});

test('status.md names the Hermes channel as measured rather than assumed', () => {
  // The whole reason the channel exists is a measurement on a real binary. A page that drops the evidence
  // invites a reader to re-litigate it, which is how the original "blocked" row survived so long.
  const hermes = STATUS.split('\n').filter((l) => /AGENTS\.md/.test(l)).join('\n');
  assert.match(hermes, /measured|v0\.21\.2/,
    'the Hermes channel claim lost its evidence marker; state the version it was measured on');
});


/*
 * A closed issue cited as live tracking.
 *
 * Sweeping every `issues/<n>` reference in the markdown on main and checking each against the API turned up
 * sixty-odd references, the overwhelming majority to closed issues -- which is normal, most are history
 * ("#55 found this"). Exactly one was phrased as ONGOING tracking, and it was this one: the Atlas deletion limitation
 * ended "Tracked in [#562]". #562 is closed; it landed the sweep and deliberately left deletion out because
 * safe deletion needs a sequence-bearing tombstone, a replication-protocol change.
 *
 * The sentence was not false about the limitation -- Atlas still never deletes. It was false about the
 * bookkeeping, which is the part a reader acts on: they follow the link, find it closed, and cannot tell
 * whether the limitation was fixed, rejected or dropped. The honest answer is "deliberately left undone, for
 * this reason, and nothing tracks it", which is what the page now says.
 *
 * The bound, stated rather than hidden. This pins ONE citation and cannot do more: deciding whether
 * "Tracked in [#N]" is a lie requires GitHub, and this suite runs offline. A first draft of this guard
 * banned the phrasing outright and immediately failed on "Tracked in [#575]" -- which is correct, because
 * #575 is open. A guard that forbids legitimate prose is deleted rather than narrowed, so it checks the
 * citation that was wrong and says so.
 */

/** The sentence around the #562 citation, spanning its line breaks. */
function atlasDeletionPassage(): string {
  const at = STATUS.indexOf('issues/562');
  assert.notEqual(at, -1, 'the #562 citation disappeared; the reasoning for not deleting lives there');
  return STATUS.slice(Math.max(0, STATUS.lastIndexOf('\n-', at)), at + 400);
}

test('the Atlas deletion limitation says what #562 did, not that it is being tracked', () => {
  const passage = atlasDeletionPassage();
  assert.doesNotMatch(passage, /\bTracked in\s*\[#562\]/,
    '#562 is closed; citing it as live tracking leaves a reader unable to tell if the limitation was '
    + 'fixed, rejected or dropped');
  assert.match(passage, /closed/, 'the passage no longer says #562 is closed');
  // #590 specified the tombstone and shipped it, so the deletion path now HAS an owner and a state.
  // The assertion inverted rather than disappeared: what the reader must still be able to tell is
  // whether the work is tracked, and the answer changed from "nothing tracks it" to "this shipped".
  assert.match(passage, /\[#590\]/,
    'the tombstone that made deletion possible is the substance of this limitation; a reader cannot '
    + 'reconstruct why Atlas can delete but does not without it');
  assert.match(passage, /\[#590\][^)]*\)\s*is closed/,
    'citing #590 without its state is the exact ambiguity this guard was written against');
  assert.doesNotMatch(passage, /not currently tracked|no open issue|needs a tombstone/,
    'the tombstone shipped; leaving this phrasing in would tell a reader to go file the issue that '
    + 'is already closed');
});

test('the closed-issue guard can actually fail', () => {
  // Positive control: the exact phrasing this guard exists to catch, applied to the real passage.
  const reintroduced = atlasDeletionPassage().replace(/\[#562\][^.]*\./,
    'Tracked in [#562](https://github.com/aywengo/mercury/issues/562).');
  assert.match(reintroduced, /\bTracked in\s*\[#562\]/,
    'the pattern no longer matches the phrasing it was written for');
  assert.doesNotMatch(atlasDeletionPassage(), /\bTracked in\s*\[#562\]/, 'the real document already trips it');
});

/**
 * Section 16 is the build order the next several weeks get planned from. A sentence there that
 * describes a shipped prerequisite as unbuilt does not merely read stale: it sends someone to build
 * a thing that already exists, or to wait on a dependency that already landed. Two of its sentences
 * were exactly that (issue #591) -- Phase 4 waited on Teams Phase -1, which shipped as #520, and
 * Phase 5 waited on capability advertisement, which `/api/agents` has served since #519 and #521.
 *
 * The guards are on the dependency claims, not on the nouns. "Teams Phase -1" is still in the
 * document, in the sentence that says Phase 4 no longer waits on it, and a guard that banned the
 * phrase would have failed on the fix. Same lesson as the #562 guard above.
 */

/** Section 16 alone, so a phrase elsewhere in a 100 KB spec cannot trip it or hide from it. */
function section16(): string {
  const from = DOC.indexOf('## 16. Phase order');
  const to = DOC.indexOf('## 17.', from);
  assert.notEqual(from, -1, 'section 16 disappeared; the phase order is what Phase 4 is planned from');
  assert.notEqual(to, -1, 'section 16 no longer ends before section 17; the slice below would be unbounded');
  return DOC.slice(from, to);
}

/** Dependency claims that are false today, each with what makes it false. */
const STALE_PREREQUISITES: [RegExp, string][] = [
  [/may wait\s+on\s+Teams Phase/i,
   'Teams Phase -1 landed as #520 and Hermes completed run_f3a4e81644be4081 through Mercury'],
  [/capability\s+advertisement[\s\S]{0,240}?\bdoes not exist\b/i,
   '/api/agents has advertised capabilities since #519 and #521, and /healthz has carried api since #518'],
];

test('section 16 does not describe a shipped prerequisite as unbuilt', () => {
  const s16 = section16();
  for (const [claim, why] of STALE_PREREQUISITES) {
    assert.doesNotMatch(s16, claim, `section 16 still asserts a prerequisite that has landed (${claim}). ${why}`);
  }
});

test('the corrected sentences survive the guard', () => {
  // Must-pass. Without these the guard could be satisfied only by deleting the evidence, which is the
  // wrong direction: the section has to keep naming what it depends on and what it no longer does.
  const s16 = section16();
  assert.match(s16, /no longer depends on\s+Teams Phase -1/,
    'the section should say plainly that the old dependency is gone, not go silent about it');
  assert.match(s16, /#520/, 'the sentence that clears the dependency must cite what landed instead');
  assert.match(s16, /run_f3a4e81644be4081/,
    'the second-harness claim must point at the Run that measured it, as the rest of the section does');
  assert.match(s16, /self-declaration|unverified/,
    'the narrower truth about capability advertisement is that the knowledge flag is unverified; say that');
});

test('phase 4 is split, and the deferred half carries its reason', () => {
  // A phase that bundles a built mechanism with an unbuilt speculative one gets gated as a unit, so
  // the built half cannot be proven until someone builds the half nobody has shown is needed.
  const s16 = section16();
  assert.match(s16, /^4b\. \*\*Tier 2 \(deferred\)\.\*\*/m,
    'Phase 4 must stay split so auto-promotion can be proven without tier 2');
  const tier2 = s16.slice(s16.indexOf('4b. **Tier 2'));
  assert.match(tier2, /deliberately/,
    'a deferral without a reason reads as an oversight, and the next reader rebuilds it');
  assert.match(tier2, /#589|record that Run/,
    'the deferral must name the observation that would end it');
  assert.match(s16.slice(s16.indexOf('4. **Auto-promotion'), s16.indexOf('4b.')), /#589/,
    'auto-promotion is gated on the real-harness observation, so the section must say so');
});

test('the section 16 guard can actually fail', () => {
  // Positive control, in the style of the #562 guard: reintroduce each claim into the real section and
  // require the pattern to catch it. A guard nobody has seen fail is a guess about a guard.
  const s16 = section16();
  const reintroduced = [
    s16.replace(/no longer depends on\s+Teams Phase -1/, 'may wait on Teams Phase -1'),
    s16.replace(/advertisement is not the blocker it was described as/, 'advertisement does not exist yet'),
  ];
  reintroduced.forEach((text, i) => {
    const [claim] = STALE_PREREQUISITES[i];
    assert.match(text, claim, `pattern ${claim} no longer matches the claim it was written for`);
    assert.doesNotMatch(s16, claim, 'the real document already trips this guard');
  });
});


/**
 * Issue #589: section 16's Phase 2 gate read "Proven by a real Run whose output depends on a promoted
 * note" and cited no Run. The sentence was true of the plumbing and unverifiable as written, and it sat
 * there while the only evidence was two Node scripts registered through `LocalAgentRegistry`. Section 10
 * had already set the standard -- it asks for a Run id per row and cites `run_f3a4e81644be4081` for Hermes
 * -- so the gate now meets the same bar.
 *
 * Two guards, because they fail differently. The phrasing guard is vacuous when the phrase is absent, and
 * that is correct: a guard that demanded the phrase would force the document to keep a sentence it had
 * outgrown, which is how such guards get deleted. The load-bearing one is on the gate itself -- Phase 2
 * must name a Run, in any wording, forever.
 */
const RUN_ID = /run_[0-9a-f]{8,}/;

/** Section 16's Phase 2 entry, up to Phase 3. */
function phase2Entry(text: string): string {
  const from = text.indexOf('2. **Replica and injection on PrimeAgent.**');
  assert.notEqual(from, -1, 'section 16 Phase 2 was renamed; the gate guard below no longer guards anything');
  const to = text.indexOf('3. **Tier 1.**', from);
  assert.notEqual(to, -1, 'Phase 3 heading not found; the Phase 2 slice would be unbounded');
  return text.slice(from, to);
}

test('the Phase 2 gate names the Runs it is proven by', () => {
  const p2 = phase2Entry(DOC);
  assert.match(p2, RUN_ID,
    'Phase 2 is the phase that shows the plumbing carries water, and for a while its gate asserted that a '
    + 'real Run showed this while citing none. A gate nobody can check is a gate that gets skipped.');
});

test('a real-Run claim names the Run beside it', () => {
  // Vacuous when the phrase is absent, which is fine -- see the note above.
  const re = /(?:proven|observed|demonstrated)\s+by\s+a\s+real\s+Run/gi;
  let m: RegExpExecArray | null;
  let seen = 0;
  while ((m = re.exec(DOC)) !== null) {
    seen += 1;
    // 500 chars is generous on purpose: the gate sentence names the note and the command before it reaches
    // the id, and a tighter window would reject honest prose that does cite its evidence.
    assert.match(DOC.slice(m.index, m.index + 500), RUN_ID,
      `"${m[0]}" is an unsourced claim. Section 10's standard applies: name the Run or do not say a real `
      + 'Run proved it.');
  }
  void seen;
});

test('both guards can actually fail', () => {
  // Positive control 1: strip the Run ids from Phase 2 and require the gate guard to catch it.
  const stripped = phase2Entry(DOC).replace(/run_[0-9a-f]{8,}/g, 'a Run');
  assert.ok(stripped !== phase2Entry(DOC), 'Phase 2 cites no Run ids, so the control cannot be built');
  assert.doesNotMatch(stripped, RUN_ID, 'the control did not remove every id');
  assert.ok(!RUN_ID.test(stripped), 'the gate guard has nothing to catch');

  // Positive control 2: reintroduce the exact pre-#589 sentence and require the phrasing guard to catch it.
  const reintroduced = DOC.replace('2. **Replica and injection on PrimeAgent.**',
    '2. **Replica and injection on PrimeAgent.** Proven by a real Run whose output depends on a promoted '
    + 'note, a note that names a command the agent would not otherwise have found, and a transcript '
    + 'showing it used. Everything before this is plumbing; this is the phase that shows the plumbing '
    + 'carries water. The rest of this entry is filler added so the window below reaches a sentence '
    + 'boundary rather than an id belonging to something else, which is the failure mode a too-wide '
    + 'window has, and it goes on long enough that no Run id appears within five hundred characters '
    + 'of the claim being tested here in this document by this control.');
  assert.notEqual(reintroduced, DOC, 'the control did not match; update it before trusting this test');
  const claimAt = reintroduced.indexOf('Proven by a real Run');
  assert.ok(claimAt >= 0);
  assert.ok(!RUN_ID.test(reintroduced.slice(claimAt, claimAt + 500)),
    'the window let the reintroduced uncited claim pass, so the guard is too wide to be useful');
});

// --- A-0: the phase status header and section 16 must agree about what is implemented ----------
//
// The header said "phases 0 to 3 implemented" for weeks after section 16 recorded Phase 4 as
// observed with named Runs. Neither sentence was wrong alone; together they were, and the stale
// one was the first thing a reader saw. The same failure shape as the Hermes row above: one
// subsystem, two answers, the stale one upstream.

/** The highest phase number section 16 marks as observed or proven. */
function highestObservedPhase(text: string): number {
  const from = text.indexOf('## 16. Phase order');
  const to = text.indexOf('## 17.', from);
  assert.notEqual(from, -1, 'section 16 disappeared; the header guard has nothing to compare against');
  assert.notEqual(to, -1, 'section 17 heading not found; the slice would be unbounded');
  const s16 = text.slice(from, to);
  // Phase entries look like "4. **Auto-promotion -- observed.**" or "3b. ... -- observed."
  let highest = -1;
  // Optional leading whitespace: sub-phase entries (3b.) and any future reformatted entry may be
  // indented inside the numbered list; anchoring at column 0 would silently miss them.
  for (const m of s16.matchAll(/^\s*\d+b?\. \*\*[^*]*?(?:--|—)\s*(?:observed|proven)\b/gm)) {
    const n = parseInt(m[0], 10);
    if (n > highest) highest = n;
  }
  return highest;
}

/** The phase count the status header claims, e.g. "phases 0 to 4 implemented" -> 4. */
function headerTopPhase(text: string): number {
  const m = text.match(/Status: \*\*phases 0 to (\d+) implemented/);
  assert.ok(m, 'the status header no longer states an implemented-phase range in the expected form');
  return parseInt(m[1], 10);
}

test('the status header\'s highest phase agrees with the highest phase section 16 marks observed', () => {
  const observed = highestObservedPhase(DOC);
  assert.ok(observed >= 0, 'section 16 marks no phase observed; reconcile the header guard');
  const claimed = headerTopPhase(DOC);
  assert.equal(claimed, observed,
    `the status header claims phases 0 to ${claimed} implemented, but the highest phase `
    + `section 16 marks observed is ${observed}. One of them is stale; fix the prose, not the guard.`);
});

// --- A-0: section 16 must not call Fleet knowledge work unbuilt while the tree reads it ---------
//
// Phase 6 listed FLEET_ATLAS_URL, the dashboard section and the soft placement signal as future
// work after #615 shipped the reader and fleet/config.ts already read the variable. A reader
// planning from section 16 alone would rebuild the reader.

test('section 16 does not describe FLEET_ATLAS_URL as unbuilt while fleet/config.ts reads it', () => {
  const s16 = section16();
  const fleetConfig = readFileSync(join(import.meta.dirname, '../fleet/config.ts'), 'utf8');
  const readsIt = /FLEET_ATLAS_URL/.test(fleetConfig);
  if (!readsIt) return; // variable removed: the guard's premise is gone, nothing to hold
  // The phase 6 entry may say the reader shipped; it may not list the variable as pending work.
  const pending = s16.match(/\bFLEET_ATLAS_URL\b[^.]*\./g) ?? [];
  for (const sentence of pending) {
    assert.doesNotMatch(sentence, /future|pending|not built|not yet|first lands|is built then/i,
      `section 16 still lists FLEET_ATLAS_URL as work to do ("${sentence.trim()}") while `
      + 'fleet/config.ts reads it. Update the prose, not the guard.');
  }
});

// The corrected phase 6 must keep naming the evidence for what shipped (the guard above is a
// does-not-match; this one keeps the correction from decaying into silence).
test('the section 16 phase 6 correction survives', () => {
  const s16 = section16();
  assert.match(s16, /#615/,
    'phase 6 mentions the Fleet reader without the issue that shipped it');
  assert.match(s16, /FLEET_KNOWLEDGE_STALE_MS/,
    'phase 6 mentions the soft placement signal without the variable that turns it on');
});

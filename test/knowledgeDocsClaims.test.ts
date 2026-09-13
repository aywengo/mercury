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

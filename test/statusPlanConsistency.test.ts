/**
 * `docs/status.md` summarises the same PRs `PLAN.md` tracks per issue, and the two drift apart.
 *
 * The 2026-10-18 refresh found three shapes of the same defect, all of them invisible to every
 * existing guard because each one is *plausible prose* rather than a broken link or a bad citation:
 *
 * - the at-a-glance table still called W-3 (#934) and B2-0 (#959) "in review" after both merged,
 *   because `PLAN.md` -- the per-issue record -- had already moved on and nothing compared them;
 * - a whole workstream (A2A, `docs/a2a-design.md`, #986-#990) was filed without a row on the page
 *   that answers "where is Mercury as a whole?";
 * - a limitation ("Workflow refusal codes over HTTP") outlived the PR that fixed it, and #934's
 *   own review round is what fixed it, so the page was describing the very code it shipped.
 *
 * The suite runs offline, so the guards compare the two documents and the source tree against each
 * other rather than asking GitHub. `PLAN.md` is updated by the PR that closes each issue (CI
 * enforces it), which makes it the local source of truth for "is this PR merged?".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Read explicitly rather than by looping a directory: the CI guard that requires every docs-reading
// test to run in docs-contract resolves paths out of readFileSync arguments, and a loop is invisible
// to it. The sweep below adds coverage; these lines give the suite a trigger.
const STATUS = readFileSync(join(import.meta.dirname, '..', 'docs', 'status.md'), 'utf8');
const PLAN = readFileSync(join(import.meta.dirname, '..', 'PLAN.md'), 'utf8');
const ROUTES = readFileSync(join(import.meta.dirname, '..', 'src', 'api', 'routes.ts'), 'utf8');
const A2A_DESIGN = readFileSync(join(import.meta.dirname, '..', 'docs', 'a2a-design.md'), 'utf8');

/** `| #issue | title | state | PR |` -- the one row shape PLAN.md uses for every issue. */
const PLAN_ROW = /^\|\s*#(\d+)\s*\|.*?\|(.*?)\|(.*?)\|\s*$/gm;

/**
 * The PR numbers of every `done` row. A `done` row's PR is the one that closed the issue, so it is
 * merged by construction: PLAN.md rule 2 says the closing PR writes that row, and CI fails a pull
 * request whose closing issues are not `done` with that PR's number.
 */
function mergedPrNumbers(plan: string): Set<number> {
  const merged = new Set<number>();
  for (const m of plan.matchAll(PLAN_ROW)) {
    if (m[2].trim() !== 'done') continue;
    for (const p of m[3].matchAll(/#(\d+)/g)) merged.add(Number(p[1]));
  }
  return merged;
}

/**
 * Every merged-PR number `status.md` describes as "in review".
 *
 * The association has to be *adjacent*, not a window. A window is the obvious implementation and it
 * is wrong: the sentence this refresh wrote -- "Merge what is in review: artifact redaction (#965).
 * W-3 (#934) and B2-0 (#959) merged 2026-10-18." -- puts two merged PRs within 90 characters of the
 * words while saying the opposite about them, and a window guard fails on the correction. Only two
 * shapes actually assert "in review": `#N in review` and `in review, #N` / `in review (#N)`.
 *
 * Deduplicated: the same PR can be described twice, and a caller wants the offending PRs.
 */
const IN_REVIEW_BEFORE = /#(\d+)\s+(?:PR\s+)?in review/gi;
const IN_REVIEW_AFTER = /in review\s*[,;([]?\s*#(\d+)/gi;

function inReviewMentions(text: string, merged: Set<number>): Set<string> {
  const offenders = new Set<string>();
  for (const re of [IN_REVIEW_BEFORE, IN_REVIEW_AFTER]) {
    for (const m of text.matchAll(re)) {
      const n = Number(m[1]);
      if (merged.has(n)) {
        const at = Math.max(0, m.index - 60);
        offenders.add(`#${n}: ...${text.slice(at, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim()}`);
      }
    }
  }
  return offenders;
}

test('the PLAN.md row parser sees the real tracker, not an empty match set', () => {
  // Without this the first guard passes on a regex that stopped matching -- the failure mode that
  // makes a guard worthless.
  const merged = mergedPrNumbers(PLAN);
  assert.ok(merged.size > 30, `expected many merged PRs, parsed ${merged.size}`);
  assert.ok(merged.has(934) && merged.has(959), 'the two PRs this refresh fixed must be in the set');
});

test('status.md never calls a merged PR "in review"', () => {
  const offenders = inReviewMentions(STATUS, mergedPrNumbers(PLAN));
  assert.deepEqual([...offenders], [], `merged PRs described as in review:\n${[...offenders].join('\n')}`);
});

test('the guard can actually fail, and does not fire on the corrected sentence', () => {
  // Pin the detector in both directions. A guard that catches everything is as useless as one that
  // catches nothing: the second sample is the real correction this refresh wrote, and it must pass.
  const merged = mergedPrNumbers(PLAN);
  const defective = '| **X** | shipped | B2-0 in review, #959; W-3: PR #934 in review |';
  const corrected = '1. **Merge what is in review:** artifact redaction (#965). W-3 (#934) and B2-0 (#959) merged 2026-10-18.';
  assert.deepEqual(
    [...inReviewMentions(defective, merged)].map((s) => Number(s.slice(1, s.indexOf(':')))).sort(),
    [934, 959],
  );
  assert.deepEqual([...inReviewMentions(corrected, merged)], []);
});

test('status.md names the A2A workstream and links a design doc that exists', () => {
  // A filed workstream with no row is the second shape: the summary page silently loses it.
  assert.ok(
    existsSync(join(import.meta.dirname, '..', 'docs', 'a2a-design.md')),
    'docs/a2a-design.md must exist',
  );
  assert.match(A2A_DESIGN, /#986/, 'the design doc names its A0 issue set');
  const row = STATUS.split('\n').find((l) => l.startsWith('| **A2A integration**'));
  assert.ok(row, 'the at-a-glance table must carry an A2A integration row');
  assert.match(row!, /a2a-design\.md/, 'the row must link the design doc');
  assert.match(row!, /#986/, 'the row must name the filed issue set');
});

test('status.md does not describe the workflow refusal codes as missing', () => {
  // The third shape: a limitation outliving its fix. #934's review round made the codes survive
  // `sendError`, so the page must not claim the serializer drops them. Cross-checked against the
  // source, so removing the source fix does not silently re-legalise the claim.
  assert.match(
    ROUTES,
    /Workflow errors carry the stable refusal codes/,
    'src/api/routes.ts must still carry the refusal codes; if it stopped, restore the status.md limitation instead',
  );
  assert.doesNotMatch(STATUS, /Workflow refusal codes over HTTP/);
  assert.doesNotMatch(STATUS, /error serializer currently returns only/);
});

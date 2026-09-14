/**
 * Claims in `ARCHITECTURE.md`'s implementation-status headers.
 *
 * `AGENTS.md` sends a reader to `ARCHITECTURE.md` for "architecture and full spec", and the file has
 * exactly two status headers -- §30 and §31 -- so those lines are what a newcomer concludes from. Both
 * carried a count of source files and passing tests, quoted from 2026-08-26 and never updated. Against a
 * tree with 72 `src/*.ts` files and 1093 core tests they read "32 source files, 112 passing tests": off by
 * 2.25x and roughly 10x, with nothing asserting either number. Issue #577.
 *
 * The counts were the smaller problem. §30 also listed "cross-process event push" as remaining work, when
 * `docs/cross-process-event-push.md` opens by stating Stages 0 and 1 are implemented and merged, with the
 * measured latency stop condition met. A reader hunting for blockers was pointed at solved, hardened code.
 *
 * So these assertions are about the two failure modes that recur -- an unasserted count, and a stale
 * "not built yet" -- rather than about wording.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ARCH = readFileSync(join(import.meta.dirname, '..', 'ARCHITECTURE.md'), 'utf8');
const XPUSH = readFileSync(join(import.meta.dirname, '..', 'docs', 'cross-process-event-push.md'), 'utf8');

/**
 * The status headers are the blockquote under each section heading, and they are what a reader concludes
 * from. The rest of the file legitimately mentions counts -- a transcript of the original mission run, and
 * the daemon adapter's mock-test count that docs/status.md relies on -- so the guard is scoped to the
 * headers rather than to the whole document.
 */
function statusHeaders(src: string): string[] {
  return src.split('\n').filter((l) => /^>\s+\*\*(Implementation status|Status)/.test(l));
}

test('ARCHITECTURE.md status headers do not quote file or test counts', () => {
  const headers = statusHeaders(ARCH);
  assert.ok(headers.length >= 2, `expected the §30 and §31 status headers, found ${headers.length}`);
  const hits = headers.filter((l) => /\d+\s+(source files|passing tests|tests)\b/.test(l));
  assert.deepEqual(hits, [],
    'a status header quotes a count that nothing asserts. It will drift -- these reached "112 passing '
    + 'tests" against a suite of over a thousand. Drop the number, or add a test that checks it.');
});

test('ARCHITECTURE.md has no placeholder links', () => {
  // `[.](.)` survived in both status headers: a link whose target is the current directory, which reads as
  // a citation and resolves to nothing useful.
  const hits = ARCH.split('\n').filter((l) => /\[[^\]]*\]\(\.{1,2}[/)]/.test(l));
  assert.deepEqual(hits, [],
    `ARCHITECTURE.md has a link pointing at "." -- a placeholder that was never filled in: ${hits.map((h) => h.trim().slice(0, 60)).join(' | ')}`);
});

test('ARCHITECTURE.md does not list cross-process event push as unbuilt', () => {
  // Only valid while the design doc says otherwise; if a future change regresses delivery to unbuilt, this
  // assertion fails together with that document's status line, which is the pairing that matters.
  assert.match(XPUSH, /Stages 0 and 1 are \*\*implemented and merged\*\*/,
    'the cross-process design doc no longer says Stages 0-1 are merged; re-read it before changing §30');
  const remaining = /Remaining work is explicitly scoped below \(([^)]*)\)/.exec(ARCH);
  assert.ok(remaining, '§30 no longer has the "Remaining work is explicitly scoped below (...)" sentence; update this test');
  assert.ok(!/cross-process/i.test(remaining[1]),
    `"cross-process event push" is back in the remaining-work list (${remaining[1]}) while the design doc `
    + 'says Stages 0-1 are merged. Multi-host scale is the part still open, and it is blocked on storage.');
  assert.match(ARCH, /cross-process-event-push\.md/,
    '§30 should point at the document that carries the real stage status rather than summarising it here');
});

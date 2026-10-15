// The nightly-next driver (N1-3, #740): rung selection via the N1-1 selector, claim handoff,
// and the never-asks exit-path discipline. All I/O injected — no network.

import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { runNext, finishIssue, blockIssue, blockedAlready, proposeIssue, sourceKeyOf, setProposedRecordPath, PROPOSED_RECORD_PATH, type NextIo } from '../.agents/skills/nightly/next.ts';
import type { GhIssue, LabelEvent } from '../.agents/skills/nightly/select.ts';

const REPO = 'aywengo/mercury';
const ENV = { GH_TOKEN: 'test-token' };

function issue(over: Partial<GhIssue> & { number: number }): GhIssue {
  return { title: `issue ${over.number}`, user: { login: 'someone' }, labels: [], created_at: '2026-09-20T00:00:00Z', ...over } as GhIssue;
}

/** A recording io: list returns the given issues; timeline returns per-issue events; everything
 * else is recorded. postLabel returns `newly` (true = 2xx claim, false = 422). */
function ioWith(issues: GhIssue[], timelines: Record<number, LabelEvent[]>, opts: { newly?: boolean; listStatus?: number } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let newly = opts.newly ?? true;
  // Label claims made through postLabel become timeline events (the selector verifies claim
  // ownership through the timeline's final actor, #801 round 3).
  const claimEvents = new Map<number, LabelEvent[]>();
  const io: NextIo = {
    async get(path) {
      calls.push({ method: 'GET', path });
      if (path.startsWith(`/repos/${REPO}/issues?`)) {
        return { body: issues, status: opts.listStatus ?? 200, link: null };
      }
      const tl = path.match(/\/issues\/(\d+)\/timeline/);
      if (tl) return { body: [...(timelines[Number(tl[1])] ?? []), ...(claimEvents.get(Number(tl[1])) ?? [])], status: 200, link: null };
      const single = path.match(new RegExp(`^/repos/${REPO.replace('/', '\\/')}/issues/(\\d+)$`));
      if (single) {
        const found = issues.find((i) => i.number === Number(single[1]));
        return { body: found ?? null, status: found ? 200 : 404 };
      }
      return { body: [], status: 200 };
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      return { body: {}, status: 201 };
    },
    async postLabel(path, body) {
      calls.push({ method: 'POST-LABEL', path, body });
      const m = path.match(/\/issues\/(\d+)\/labels$/);
      if (m) {
        const n = Number(m[1]);
        claimEvents.set(n, [...(claimEvents.get(n) ?? []), { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: (body as { labels: string[] }).labels[0] } } as unknown as LabelEvent]);
      }
      return newly;
    },
    async deleteLabel(path) {
      calls.push({ method: 'DELETE', path });
      return true;
    },
    async patch(path, body) {
      calls.push({ method: 'PATCH', path, body });
      return { body: {}, status: 200 };
    },
  };
  return { io, calls, setNewly: (v: boolean) => { newly = v; } };
}

const READY_EVENT: LabelEvent = { event: 'labeled', label: { name: 'nightly:ready' }, actor: { login: 'aywengo' } } as unknown as LabelEvent;

test('rung 1: a trusted nightly:ready issue is selected, claimed, and handed to the fix-loop', async () => {
  const issues = [issue({ number: 10, labels: [{ name: 'nightly:ready' }] })];
  const { io, calls } = ioWith(issues, { 10: [READY_EVENT] });
  const out = await runNext(io, ENV, { repo: REPO, dryRun: false });
  assert.equal(out.rung, 1);
  assert.equal(out.issue, 10);
  assert.equal(out.action, 'fix-loop', 'the agent runs the issue-fix-loop on the claimed issue');
  const claim = calls.find((c) => c.method === 'POST-LABEL' && c.path.endsWith('/labels'));
  assert.ok(claim, 'nightly:in-progress claimed before handoff');
  assert.deepEqual((claim!.body as { labels: string[] }).labels, ['nightly:in-progress']);
});

test('rung 2: a trusted enhancement issue is chosen and handed to the fix-loop (#800)', async () => {
  const issues = [issue({ number: 20, user: { login: 'aywengo' }, labels: [{ name: 'enhancement' }] })];
  const { io, calls } = ioWith(issues, {});
  const out = await runNext(io, ENV, { repo: REPO, dryRun: false });
  assert.equal(out.rung, 2);
  assert.equal(out.issue, 20);
  assert.equal(out.action, 'fix-loop', 'a feature request runs the same issue-fix-loop as a bug');
  assert.ok(calls.some((c) => c.method === 'POST-LABEL'));
});

test('a stale nightly:in-progress claim is reset through runNext (deleteLabel forwarded, #800)', async () => {
  const staleClaimed = issue({ number: 21, user: { login: 'aywengo' }, labels: [{ name: 'nightly:in-progress' }] });
  const staleEvent = { event: 'labeled', actor: { login: 'mercury-nightly' }, label: { name: 'nightly:in-progress' }, created_at: '2026-09-27T21:00:00Z' } as unknown as LabelEvent;
  const { io, calls } = ioWith([staleClaimed], { 21: [staleEvent] });
  const out = await runNext(io, ENV, { repo: REPO, dryRun: false });
  assert.equal(out.issue, 21, 'the stale-claimed issue is selected');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/labels/nightly%3Ain-progress')),
    'the stale claim is removed via NextIo.deleteLabel');
  assert.ok(calls.some((c) => c.method === 'POST-LABEL'), 'then claimed fresh');
});

test('rung 3: a new @aywengo issue is chosen when no trusted work exists', async () => {
  const issues = [issue({ number: 20, user: { login: 'aywengo' } })];
  const { io, calls } = ioWith(issues, {});
  const out = await runNext(io, ENV, { repo: REPO, dryRun: false });
  assert.equal(out.rung, 3);
  assert.equal(out.issue, 20);
  assert.equal(out.action, 'fix-loop');
  assert.ok(calls.some((c) => c.method === 'POST-LABEL'));
});

test('rung 4: open issues but nothing eligible → draft-proposals, no claim', async () => {
  const issues = [issue({ number: 30, user: { login: 'someone' }, labels: [{ name: 'help wanted' }] })];
  const { io, calls } = ioWith(issues, {});
  const out = await runNext(io, ENV, { repo: REPO, dryRun: false });
  assert.equal(out.rung, 4);
  assert.equal(out.action, 'draft-proposals', 'rung 4 drafts nightly:proposed issues and never implements');
  assert.equal(out.issue, undefined);
  assert.equal(calls.filter((c) => c.method === 'POST-LABEL').length, 0, 'rung 4 claims nothing');
});

test("rung 'none': zero open issues → no-op, zero writes", async () => {
  const { io, calls } = ioWith([], {});
  const out = await runNext(io, ENV, { repo: REPO, dryRun: false });
  assert.equal(out.rung, 'none');
  assert.equal(out.action, 'no-op');
  assert.equal(calls.filter((c) => c.method.startsWith('POST')).length, 0);
});

test('dry-run selects but never claims', async () => {
  const issues = [issue({ number: 10, labels: [{ name: 'nightly:ready' }] })];
  const { io, calls } = ioWith(issues, { 10: [READY_EVENT] });
  const out = await runNext(io, ENV, { repo: REPO, dryRun: true });
  assert.equal(out.rung, 1);
  assert.equal(calls.filter((c) => c.method === 'POST-LABEL').length, 0, 'no claim in dry-run');
});

test('a label the selector cannot verify (no timeline actor) never reaches rung 1', async () => {
  const issues = [issue({ number: 11, labels: [{ name: 'nightly:ready' }] })];
  // Timeline says the ready label was applied by someone else:
  const { io } = ioWith(issues, { 11: [{ event: 'labeled', label: { name: 'nightly:ready' }, actor: { login: 'not-aywengo' } } as unknown as LabelEvent] });
  const out = await runNext(io, ENV, { repo: REPO, dryRun: false });
  assert.equal(out.rung, 4, 'untrusted ready falls through to proposals');
  assert.equal(out.action, 'draft-proposals');
});

test('finish removes nightly:in-progress (the success exit path)', async () => {
  const { io, calls } = ioWith([], {});
  const out = await finishIssue(io, { repo: REPO, issue: 10 });
  assert.equal(out.removed, true);
  const del = calls.find((c) => c.method === 'DELETE');
  assert.ok(del);
  assert.match(del!.path, /issues\/10\/labels\/nightly%3Ain-progress$/);
});

test('blocked labels, comments the question, and removes the claim — the Run never asks', async () => {
  const { io, calls } = ioWith([], {});
  const out = await blockIssue(io, { repo: REPO, issue: 12, reason: 'Which of two presets should win?' });
  assert.equal(out.newlyLabeled, true);
  // An idempotent retry (label already present) reports newlyLabeled: false, not a failure:
  const { io: io2, setNewly } = ioWith([], {});
  setNewly(false);
  const out2 = await blockIssue(io2, { repo: REPO, issue: 12, reason: 'Which of two presets should win?' });
  assert.equal(out2.newlyLabeled, false);
  assert.equal(out2.removed, true);
  assert.equal(out.commented, true);
  assert.equal(out.removed, true);
  const order = calls.map((c) => c.method);
  assert.ok(order.indexOf('POST-LABEL') < order.indexOf('POST'), 'label before comment (crash-safe ordering)');
  assert.ok(order.indexOf('POST') < order.indexOf('DELETE'), 'claim removed last');
  const comment = calls.find((c) => c.method === 'POST' && c.path.endsWith('/comments'));
  assert.ok(comment);
  assert.match(String((comment!.body as { body: string }).body), /Which of two presets should win\?/);
  const del = calls.find((c) => c.method === 'DELETE')!;
  assert.match(del.path, /nightly%3Ain-progress$/);
});

test('blocked refuses an empty reason (a blocked exit without a question is a silent stall)', async () => {
  const { io } = ioWith([], {});
  await assert.rejects(() => blockIssue(io, { repo: REPO, issue: 12, reason: '   ' }), /--reason/);
});

test('blockedAlready reads the label state for idempotent retries', async () => {
  const { io } = ioWith([issue({ number: 12, labels: [{ name: 'nightly:blocked' }] })], {});
  assert.equal(await blockedAlready(io, { repo: REPO, issue: 12 }), true);
  const { io: io2 } = ioWith([issue({ number: 13 })], {});
  assert.equal(await blockedAlready(io2, { repo: REPO, issue: 13 }), false);
});

test('a failed comment POST keeps the claim and fails hard (blocked = label + question)', async () => {
  const { io, calls } = ioWith([], {});
  // Override post to return a 503:
  const failingIo: NextIo = { ...io, async post() { return { body: {}, status: 503 }; } };
  await assert.rejects(
    () => blockIssue(failingIo, { repo: REPO, issue: 14, reason: 'Which preset wins?' }),
    /question comment was not accepted/,
  );
  // The claim is NOT removed:
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0, 'the claim stays for a retry');
  assert.equal(calls.filter((c) => c.method === 'POST-LABEL').length, 1, 'the label was applied first');
});

test('exit paths validate the repo too (they interpolate it into API paths)', async () => {
  const { io } = ioWith([], {});
  // 'no-slash' fails the owner/name shape in every entry point:
  await assert.rejects(() => finishIssue(io, { repo: 'no-slash', issue: 1 }), /owner\/name/);
  await assert.rejects(() => blockIssue(io, { repo: 'no-slash', issue: 1, reason: 'x' }), /owner\/name/);
  await assert.rejects(() => runNext(io, ENV, { repo: 'no-slash', dryRun: false }), /owner\/name/);
});

test('a non-2xx read fails loud instead of surfacing as a parse error', async () => {
  const issues = [issue({ number: 10, labels: [{ name: 'nightly:ready' }] })];
  const { io } = ioWith(issues, {});
  const failingIo: NextIo = {
    ...io,
    async get(path) {
      if (path.startsWith(`/repos/${REPO}/issues?`)) return { body: 'oops', status: 500, link: null };
      return { body: [], status: 200, link: null };
    },
  };
  await assert.rejects(() => runNext(failingIo, ENV, { repo: REPO, dryRun: false }), /GET .* -> 500/);
});

test('a 422 that is NOT already-exists fails hard (a blocked exit must not proceed label-less)', async () => {
  // The real transport maps only already_exists 422s to false; simulate the throw via postLabel.
  const { io, calls } = ioWith([], {});
  const ioBad: NextIo = {
    ...io,
    async postLabel() { throw new Error('POST /labels -> 422 validation failed: Invalid request'); },
  };
  await assert.rejects(
    () => blockIssue(ioBad, { repo: REPO, issue: 15, reason: 'Needs a human decision' }),
    /422 validation failed/,
  );
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0, 'no claim release without the label');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments')).length, 0, 'no comment without the label');
});

test('repo validation refuses dot-LEADING segments like octo-org/.github (strict shared regex, #769)', async () => {
  // The old loose mirror accepted it; e2e/report already refused dot-leading segments. One strict
  // regex everywhere now: a repo named '.github' is refused by the nightly scripts (the nightly
  // never targets such a repo, and '..' must never reach a URL segment).
  const { io, calls } = ioWith([], {});
  await assert.rejects(
    () => runNext(io, ENV, { repo: 'octo-org/.github', dryRun: true }),
    /repo must be exactly owner\/name/,
  );
  assert.equal(calls.filter((c) => c.method.startsWith('POST')).length, 0);
});

test('repo validation refuses a non owner/name value', async () => {
  const { io } = ioWith([], {});
  await assert.rejects(() => runNext(io, ENV, { repo: 'no-slash', dryRun: false }), /owner\/name/);
});


test('blocked exit: the body marker is written ONLY for issues the nightly identity filed (#770)', async () => {
  const nightlyFiled = [{ ...issue({ number: 20, user: { login: 'mercury-nightly' } }), body: 'defect report body' } as unknown as GhIssue];
  const userFiled = [{ ...issue({ number: 21, user: { login: 'aywengo' } }), body: 'a human wrote this' } as unknown as GhIssue];
  // nightly-filed: the body is patched with the trailing invisible marker, original body preserved.
  const a = ioWith(nightlyFiled, {});
  await blockIssue(a.io, { repo: REPO, issue: 20, reason: 'Which retry policy?' });
  const patchA = a.calls.find((c) => c.method === 'PATCH');
  assert.ok(patchA, 'nightly-filed issue gets the body marker');
  const bodyA = String((patchA!.body as { body: string }).body);
  assert.ok(bodyA.startsWith('defect report body'), 'existing body preserved');
  assert.match(bodyA, /<!-- nightly:blocking-question\nWhich retry policy\?\n-->$/, 'trailing marker');
  // user-filed: no PATCH at all (the nightly must not edit user-authored bodies).
  const b = ioWith(userFiled, {});
  await blockIssue(b.io, { repo: REPO, issue: 21, reason: 'Which retry policy?' });
  assert.equal(b.calls.find((c) => c.method === 'PATCH'), undefined, 'user-authored body untouched');
  // A second blocked exit REPLACES the prior marker instead of stacking.
  const twice = ioWith([{ ...issue({ number: 20, user: { login: 'mercury-nightly' } }), body: 'defect report body\n\n<!-- nightly:blocking-question\nold question\n-->' } as unknown as GhIssue], {});
  await blockIssue(twice.io, { repo: REPO, issue: 20, reason: 'newer question' });
  const patchTwice = twice.calls.find((c) => c.method === 'PATCH')!;
  const bodyTwice = String((patchTwice.body as { body: string }).body);
  assert.ok(!bodyTwice.includes('old question'), 'prior marker replaced');
  assert.ok(bodyTwice.includes('newer question'));
  // A failed body patch does not fail the blocked exit (the comment remains the source of truth).
  const failing = ioWith(nightlyFiled, {});
  const failingIo: NextIo = { ...failing.io, async patch() { throw new Error('network gone'); } };
  const out = await blockIssue(failingIo, { repo: REPO, issue: 20, reason: 'still blocked' });
  assert.equal(out.commented, true, 'the blocked exit survives a body-marker failure');
});
// ---- rung 4: the guarded propose exit (#881) ----

/** Every propose test gets its own record file: the guard persists across processes, so a
 * shared real path would leak state between tests (and against a real nightly Run's file). */
function pt(name: string, fn: () => Promise<void> | void): void {
  test(name, () => withRecordDir(fn));
}

/** An io for propose tests: a fixed issue-listing (state=all) plus recorded writes. `listStatus`
 * fakes a broken search; `listPages` lets a test drive the page-cap path. */
/** A search-shape io: GET /search/issues returns hits for the key query and/or title query
 * (decoded from the `q` parameter); every hit is then confirmed via GET /repos/.../issues/<n>.
 * `searchStatus`/`incomplete` simulate the fail-closed paths; `deep` makes the matching hit
 * reachable only past `listPagesCap` pages of the KEY query (the #928 review's page-cap
 * scenario, which the old list scan could never reach). */
/** A throwaway workspace for record tests: the persistent propose record is path-scoped, so
 * each test points PROPOSED_RECORD_PATH into a temp dir and restores the real path after. */
let recordDir: string | null = null;
function recordFile(): string { return recordDir ?? ''; }
function withRecordDir(fn: () => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'nightly-propose-'));
  const file = join(home, 'nightly-proposals.json');
  recordDir = file;
  setProposedRecordPath(file);
  return Promise.resolve(fn()).finally(() => {
    setProposedRecordPath(null);
    recordDir = null;
    rmSync(home, { recursive: true, force: true });
  });
}

function proposeIo(existing: { number: number; title: string; body?: string | null }[] = [], opts: { listStatus?: number; searchStatus?: number; incomplete?: boolean; searchHits?: { keyQuery?: { number: number }[]; titleQuery?: { number: number }[] }; deep?: number } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const singleIssue = new Map<number, { number: number; title: string; body?: string | null }>();
  for (const it of existing) singleIssue.set(it.number, it);
  let keyPage = 0;
  const io: NextIo = {
    async get(path) {
      calls.push({ method: 'GET', path });
      if (path.startsWith('/search/issues?')) {
        if (opts.searchStatus !== undefined) return { body: {}, status: opts.searchStatus };
        if (opts.incomplete) return { body: { items: [], incomplete_results: true }, status: 200 };
        const q = decodeURIComponent(path).match(/q=([^&]+)/)?.[1] ?? '';
        const isKeyQuery = q.includes(KEY) && q.includes('Source key');
        const hits = isKeyQuery ? (opts.searchHits?.keyQuery ?? []) : (opts.searchHits?.titleQuery ?? []);
        if (isKeyQuery && opts.deep !== undefined) {
          keyPage++;
          // Pre-hit pages are FULL (100 items) so the scan continues to the next page.
          if (keyPage < opts.deep) return { body: { items: Array.from({ length: 100 }, (_, i) => ({ number: 10_000 + i })), total_count: 10_100, incomplete_results: false }, status: 200 };
          if (keyPage > 10) return { body: { items: Array.from({ length: 100 }, (_, i) => ({ number: 20_000 + i })), total_count: 20_100, incomplete_results: false }, status: 200 };
          return { body: { items: hits, total_count: hits.length, incomplete_results: false }, status: 200 };
        }
        return { body: { items: hits, total_count: hits.length, incomplete_results: false }, status: 200 };
      }
      const single = path.match(new RegExp(`^/repos/${REPO.replace('/', '\\/')}/issues/(\\d+)$`));
      if (single) {
        const found = singleIssue.get(Number(single[1])) ?? null;
        return { body: found, status: found ? 200 : 404 };
      }
      return { body: null, status: 404 };
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      const m = path.match(new RegExp(`^/repos/${REPO.replace('/', '\\/')}/issues$`));
      if (m) {
        const b = body as { title: string; body: string };
        singleIssue.set(999, { number: 999, title: b.title, body: b.body });
        return { body: { number: 999 }, status: 201 };
      }
      return { body: {}, status: 201 };
    },
    async postLabel() { calls.push({ method: 'POST-LABEL', path: '(labels)' }); return true; },
    async deleteLabel() { return true; },
  };
  return { io, calls };
}

const KEY = 'docs/crew/roadmap.md#8-phase-4';
const TITLE = 'Crew Phase 4: per-run MCP foundation';

pt('propose: an open issue carrying the source key blocks creation and is reported (#881 ac1)', async () => {
    const { io, calls } = proposeIo([{ number: 875, title: 'a differently-worded title', body: `stuff\n\nSource key: ${KEY}\n<!-- nightly-source: ${KEY} -->` }],
    { searchHits: { keyQuery: [{ number: 875 }] } });
  const out = await proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: 'body' });
  assert.equal(out.created, false);
  assert.equal(out.existing, 875);
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path.endsWith('/issues')), 'nothing was filed');
});

pt('propose: the key match is confirmed via the hidden marker on the re-read body', async () => {
    // Search matched on the visible line; the confirmation re-read finds the hidden marker.
  const { io, calls } = proposeIo([{ number: 875, title: 'x', body: `Source key: ${KEY}\n<!-- nightly-source: ${KEY} -->` }],
    { searchHits: { keyQuery: [{ number: 875 }] } });
  const out = await proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: 'body' });
  assert.equal(out.existing, 875);
  assert.ok(calls.some((c) => c.path.endsWith('/issues/875')), 'the hit was confirmed by re-reading the body');
});

pt('propose: a search hit that does NOT confirm on re-read does not block filing', async () => {
    // Stale/noisy index: search returns a hit, but the body carries a different key and a
  // different title — the exact confirmation keeps filing unblocked.
  const { io, calls } = proposeIo([{ number: 880, title: 'unrelated', body: '<!-- nightly-source: docs/other.md#x -->' }],
    { searchHits: { keyQuery: [{ number: 880 }], titleQuery: [] } });
  const out = await proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: 'the draft' });
  assert.equal(out.created, true);
  assert.equal(out.issue, 999);
});

pt('propose: a CLOSED issue with the key also blocks (a declined proposal is not re-proposed) (#881 ac2)', async () => {
    const { io, calls } = proposeIo([{ number: 860, title: 'old title', body: `Source key: ${KEY}\n<!-- nightly-source: ${KEY} -->` }],
    { searchHits: { keyQuery: [{ number: 860 }] } });
  const out = await proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: 'body' });
  assert.equal(out.created, false);
  assert.equal(out.existing, 860);
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

pt('propose: an exact-title match without a marker blocks (pre-fix drafts like #867) (#881 ac3)', async () => {
    const { io, calls } = proposeIo([{ number: 867, title: ` ${TITLE} `, body: 'no marker here' }],
    { searchHits: { keyQuery: [], titleQuery: [{ number: 867 }] } });
  const out = await proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: 'body' });
  assert.equal(out.created, false);
  assert.equal(out.existing, 867);
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

pt('propose: a match reachable only past 10 pages of search results is still found (#928 review)', async () => {
    // The old list scan threw "exceeded 10 pages" here and failed closed forever; the search
  // path is bounded by what can match, so the duplicate is still caught.
  const { io, calls } = proposeIo([{ number: 875, title: 'x', body: `Source key: ${KEY}\n<!-- nightly-source: ${KEY} -->` }],
    { searchHits: { keyQuery: [{ number: 875 }] }, deep: 10 });
  const out = await proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: 'body' });
  assert.equal(out.created, false);
  assert.equal(out.existing, 875);
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

pt('propose: no match files the issue with the visible key line AND the hidden marker, then labels it', async () => {
    const { io, calls } = proposeIo([{ number: 1, title: 'unrelated', body: 'nope' }]);
  const out = await proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: 'the draft' });
  assert.equal(out.created, true);
  assert.equal(out.issue, 999);
  const create = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'));
  assert.ok(create, 'the issue was created');
  const body = (create!.body as { body: string }).body;
  assert.equal(sourceKeyOf(body), KEY, 'the filed body carries the hidden marker');
  assert.ok(body.includes(`Source key: ${KEY}`), 'the filed body carries the visible key line (search-indexable)');
  const label = calls.find((c) => c.method === 'POST-LABEL');
  assert.ok(label, 'nightly:proposed is added');
});

pt('propose: a failed search fails closed - nothing is filed (#881 ac4)', async () => {
    const { io, calls } = proposeIo([], { searchStatus: 502 });
  await assert.rejects(
    () => proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: 'body' }),
    /dedupe search failed/,
  );
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

pt('propose: incomplete_results fails closed (a truncated index must never read as "no match") (#928 review)', async () => {
    const { io, calls } = proposeIo([], { incomplete: true });
  await assert.rejects(
    () => proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: 'body' }),
    /incomplete_results/,
  );
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

pt('propose: empty source or title is rejected before any request', async () => {
    const { io, calls } = proposeIo();
  await assert.rejects(() => proposeIssue(io, { repo: REPO, source: '  ', title: TITLE, body: 'b' }), /non-empty --source/);
  await assert.rejects(() => proposeIssue(io, { repo: REPO, source: KEY, title: '', body: 'b' }), /non-empty --title/);
  assert.ok(!calls.some((c) => c.method === 'GET'), 'no search even started');
});

pt('propose: a source key with a space is refused (it could never be read back by sourceKeyOf) (#928 review)', async () => {
    const { io, calls } = proposeIo();
  await assert.rejects(
    () => proposeIssue(io, { repo: REPO, source: 'docs/a.md#head with space', title: TITLE, body: 'b' }),
    /key outside it can never dedupe/i,
  );
  assert.ok(!calls.some((c) => c.method === 'GET'), 'refused before any request');
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

pt('propose: a body that already carries a source marker is refused, not double-marked (#928 review)', async () => {
    const { io, calls } = proposeIo([]);
  await assert.rejects(
    () => proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: `draft\n\n<!-- nightly-source: docs/other.md#x -->` }),
    /already carries/,
  );
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

pt('propose: the record persists across CLI processes - a second process does not re-file even without a search hit (#946 review)', async () => {
      // Each documented `next.ts propose` invocation is a separate Node process, so the guard
    // cannot be process-local: the two calls below share only the FILE, never the io object.
    // Search finds nothing (index lag within the same night), so the first call files #999.
    const first = proposeIo([]);
    const out1 = await proposeIssue(first.io, { repo: REPO, source: KEY, title: TITLE, body: 'the draft' });
    assert.equal(out1.created, true);
    // A fresh io in a "second process": search still finds nothing (not indexed yet).
    const second = proposeIo([]);
    const out2 = await proposeIssue(second.io, { repo: REPO, source: KEY, title: TITLE, body: 'the draft again' });
    assert.equal(out2.created, false, 'the second process must not re-file');
    assert.equal(out2.existing, 999);
    assert.equal(out2.sameRun, true);
    assert.ok(!second.calls.some((c) => c.method === 'POST'), 'nothing was re-filed');
    // An unrecorded key is not blocked: it still goes to search and can file.
    const third = proposeIo([]);
    const out3 = await proposeIssue(third.io, { repo: REPO, source: 'docs/other.md#heading', title: TITLE, body: 'b' });
    assert.equal(out3.created, true, 'an unrecorded key is not blocked by the record');
    assert.ok(third.calls.some((c) => c.method === 'GET' && c.path.startsWith('/search/issues')), 'the unrecorded key went to search');

});

pt('propose: a corrupt or unreadable record file fails closed - nothing is filed (#946 review)', async () => {
      const record = recordFile();
    writeFileSync(record, '{not json');
    const { io, calls } = proposeIo([]);
    await assert.rejects(
      () => proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: 'b' }),
      /fail closed/,
    );
    assert.ok(!calls.some((c) => c.method === 'POST'), 'nothing was filed');
    // A record that is not an object fails closed too.
    writeFileSync(record, '[1,2]');
    const { io: io2, calls: calls2 } = proposeIo([]);
    await assert.rejects(
      () => proposeIssue(io2, { repo: REPO, source: KEY, title: TITLE, body: 'b' }),
      /not a JSON object/,
    );
    assert.ok(!calls2.some((c) => c.method === 'POST'));

});

pt('propose: a record without the key, or a non-positive number, does not block (#946 review)', async () => {
      writeFileSync(recordFile(), JSON.stringify({ [`${REPO}#${KEY}`]: 0, [`${REPO}#docs/other.md#h`]: 'junk' }));
    const { io, calls } = proposeIo([]);
    const out = await proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: 'b' });
    assert.equal(out.created, true, 'a junk record entry is a miss, not a block');
    assert.ok(calls.some((c) => c.method === 'GET' && c.path.startsWith('/search/issues')));

});

test('sourceKeyOf: extracts the key, tolerates absent bodies, ignores other markers', () => {
  assert.equal(sourceKeyOf(`x\n<!-- nightly-source: docs/a.md#1-head -->\n`), 'docs/a.md#1-head');
  assert.equal(sourceKeyOf(null), null);
  assert.equal(sourceKeyOf('<!-- some-other-marker: x -->'), null);
});

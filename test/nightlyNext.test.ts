// The nightly-next driver (N1-3, #740): rung selection via the N1-1 selector, claim handoff,
// and the never-asks exit-path discipline. All I/O injected — no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runNext, finishIssue, blockIssue, blockedAlready, type NextIo } from '../.agents/skills/nightly/next.ts';
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

// ---- rung-4 propose exit: mechanical dedupe (#881) ----

import { proposeIssue, findExistingProposal, sourceMarker } from '../.agents/skills/nightly/next.ts';

const KEY = 'docs/crew/roadmap.md#8-phase-4';
const TITLE = 'Crew Phase 4: per-run MCP foundation';
const BODY = `## Source\n\n\`${KEY}\`\n\n${sourceMarker(KEY)}\n\nScope text.`;

/** A minimal io whose issue list is a flat array (pagination never exercised in these tests). */
function proposeIo(all: unknown, opts: { listStatus?: number; postStatus?: number } = {}) {
  const posts: { path: string; body?: unknown }[] = [];
  const io = {
    async get(path: string) {
      if (path.startsWith(`/repos/${REPO}/issues?state=all`)) {
        return { body: all, status: opts.listStatus ?? 200, link: null };
      }
      return { body: null, status: 200 };
    },
    async post(path: string, body: unknown) {
      posts.push({ path, body });
      return { body: { number: 42 }, status: opts.postStatus ?? 201 };
    },
    async postLabel() { return true; },
    async deleteLabel() { return true; },
  } as unknown as NextIo;
  return { io, posts };
}

test('propose: an open issue with the same source key blocks creation (acceptance 1)', async () => {
  const { io, posts } = proposeIo([{ number: 875, title: TITLE, body: `text\n${sourceMarker(KEY)}\n` }]);
  const out = await proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: BODY });
  assert.equal(out.created, false);
  assert.equal(out.checkRan, true);
  assert.deepEqual(out.existing, [{ number: 875, matched: 'source' }]);
  assert.equal(posts.length, 0, 'nothing is posted');
});

test('propose: a CLOSED issue with the source key also blocks (acceptance 2)', async () => {
  const { io, posts } = proposeIo([{ number: 500, title: 'other title', state: 'closed', body: `${sourceMarker(KEY)}` }]);
  const out = await proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: BODY });
  assert.equal(out.created, false);
  assert.deepEqual(out.existing, [{ number: 500, matched: 'source' }]);
  assert.equal(posts.length, 0);
});

test('propose: an exact-title match without a marker also blocks (acceptance 3, pre-fix drafts)', async () => {
  const { io, posts } = proposeIo([{ number: 867, title: TITLE, body: 'Why this, now...' }]);
  const out = await proposeIssue(io, { repo: REPO, source: 'docs/x.md#y', title: TITLE, body: BODY });
  assert.equal(out.created, false);
  assert.deepEqual(out.existing, [{ number: 867, matched: 'title' }]);
  assert.equal(posts.length, 0);
});

test('propose: a failed search fails closed — no issue, checkRan false (acceptance 4)', async () => {
  for (const listStatus of [500, 200]) {
    const { io, posts } = proposeIo('not an array', { listStatus });
    const out = await proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: BODY });
    assert.equal(out.created, false);
    assert.equal(out.checkRan, false);
    assert.equal(posts.length, 0);
  }
});

test('propose: no match files the issue labeled nightly:proposed with the marker in the body', async () => {
  const { io, posts } = proposeIo([{ number: 1, title: 'unrelated', body: 'nothing here' }]);
  const out = await proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: BODY });
  assert.equal(out.created, true);
  assert.equal(out.number, 42);
  const post = posts[0];
  assert.ok(post.path.endsWith('/issues'));
  assert.equal((post.body as { labels: string[] }).labels[0], 'nightly:proposed');
  assert.ok((post.body as { body: string }).body.includes(sourceMarker(KEY)));
});

test('propose: a body without the source marker is refused before any write', async () => {
  const { io, posts } = proposeIo([]);
  await assert.rejects(
    proposeIssue(io, { repo: REPO, source: KEY, title: TITLE, body: 'no marker here' }),
    /nightly-source/,
  );
  assert.equal(posts.length, 0);
});

test('findExistingProposal: a truncated page list fails closed (capped search, acceptance 4)', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `t${i}`, body: '' }));
  const { io } = proposeIo(full);
  assert.equal(await findExistingProposal(io, REPO, { source: KEY, title: TITLE }), null);
});

// ---- propose exit (rung-4 mechanical dedupe, #881) ----

test('findExistingProposal: non-2xx and capped searches return null (fail closed)', async () => {
  const bad = { async get() { return { body: [], status: 500 }; } } as unknown as NextIo;
  assert.equal(await findExistingProposal(bad, REPO, { source: 'd.md#h', title: 'T' }), null);
  const throws = { async get() { throw new Error('transport'); } } as unknown as NextIo;
  assert.equal(await findExistingProposal(throws, REPO, { source: 'd.md#h', title: 'T' }), null);
});

test('proposeIssue: no match creates the issue labeled nightly:proposed with the marker', async () => {
  const posts: unknown[] = [];
  const io = {
    async get() { return { body: [], status: 200, link: null }; },
    async post(path: string, body: unknown) { posts.push({ path, body }); return { body: { number: 901 }, status: 201 }; },
    async postLabel() { return true; },
    async deleteLabel() { return true; },
  } as unknown as NextIo;
  const out = await proposeIssue(io, { repo: REPO, source: 'docs/crew/roadmap.md#9-phase-5', title: 'Crew Phase 5', body: `## Source\n\n${sourceMarker('docs/crew/roadmap.md#9-phase-5')}\n` });
  assert.deepEqual({ created: out.created, number: out.number, checkRan: out.checkRan }, { created: true, number: 901, checkRan: true });
  assert.equal((posts[0] as { body: { labels: string[] } }).body.labels[0], 'nightly:proposed');
});

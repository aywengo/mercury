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
  const io: NextIo = {
    async get(path) {
      calls.push({ method: 'GET', path });
      if (path.startsWith(`/repos/${REPO}/issues?`)) {
        return { body: issues, status: opts.listStatus ?? 200, link: null };
      }
      const tl = path.match(/\/issues\/(\d+)\/timeline/);
      if (tl) return { body: timelines[Number(tl[1])] ?? [], status: 200, link: null };
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
      return newly;
    },
    async deleteLabel(path) {
      calls.push({ method: 'DELETE', path });
      return true;
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

test('rung 2: a new @aywengo issue is chosen when no trusted work exists', async () => {
  const issues = [issue({ number: 20, user: { login: 'aywengo' } })];
  const { io, calls } = ioWith(issues, {});
  const out = await runNext(io, ENV, { repo: REPO, dryRun: false });
  assert.equal(out.rung, 2);
  assert.equal(out.issue, 20);
  assert.equal(out.action, 'fix-loop');
  assert.ok(calls.some((c) => c.method === 'POST-LABEL'));
});

test('rung 3: open issues but nothing eligible → draft-proposals, no claim', async () => {
  const issues = [issue({ number: 30, user: { login: 'someone' }, labels: [{ name: 'help wanted' }] })];
  const { io, calls } = ioWith(issues, {});
  const out = await runNext(io, ENV, { repo: REPO, dryRun: false });
  assert.equal(out.rung, 3);
  assert.equal(out.action, 'draft-proposals', 'rung 3 drafts nightly:proposed issues and never implements');
  assert.equal(out.issue, undefined);
  assert.equal(calls.filter((c) => c.method === 'POST-LABEL').length, 0, 'rung 3 claims nothing');
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
  assert.equal(out.rung, 3, 'untrusted ready falls through to proposals');
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

test('repo validation accepts dot-segment names like octo-org/.github (aligned with select.ts)', async () => {
  const { io, calls } = ioWith([], {});
  const out = await runNext(io, ENV, { repo: 'octo-org/.github', dryRun: true });
  assert.equal(out.rung, 'none');
  assert.equal(calls.filter((c) => c.method.startsWith('POST')).length, 0);
});

test('repo validation refuses a non owner/name value', async () => {
  const { io } = ioWith([], {});
  await assert.rejects(() => runNext(io, ENV, { repo: 'no-slash', dryRun: false }), /owner\/name/);
});

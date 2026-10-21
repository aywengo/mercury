import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blockIssue, statedFindingCounts, type NextIo } from '../.agents/skills/nightly/next.ts';

// ---- fixtures (#860) ----

const PR = 842;
const HEAD = 'sha-head-2';

interface Recorded { labelPosts: number; comments: string[]; labelDeletes: number; patches: { path: string; body: unknown }[] }

function makeIo(opts: {
  reviewThreads: { totalCount: number; pageInfo?: { hasNextPage: boolean }; nodes: unknown[] } | null;
  reviewsStatus?: number;
  threadsStatus?: number;
  pulls?: { body: unknown; status: number };
  /** The commit the last Copilot review was submitted against; defaults to the PR head. */
  reviewCommit?: string;
}): { io: NextIo; log: Recorded } {
  const log: Recorded = { labelPosts: 0, comments: [], labelDeletes: 0, patches: [] };
  const io: NextIo = {
    async get(path: string) {
      if (path.endsWith(`/pulls/${PR}`)) {
        if (opts.pulls) return { body: opts.pulls.body, status: opts.pulls.status };
        return { body: { number: PR, head: { sha: HEAD } }, status: 200, link: null };
      }
      if (path.includes(`/pulls/${PR}/reviews`)) {
        const status = opts.reviewsStatus ?? 200;
        if (status !== 200) return { body: null, status, link: null };
        return { body: [{ user: { login: 'copilot-pull-request-reviewer[bot]' }, commit_id: opts.reviewCommit ?? HEAD, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-05T00:44:00Z' }], status: 200, link: null };
      }
      return { body: { number: 860, user: { login: 'aywengo' }, body: 'issue body', labels: [] }, status: 200, link: null };
    },
    async post(path: string, body: unknown) {
      if (path.endsWith('/comments')) log.comments.push((body as { body: string }).body);
      return { body: {}, status: 201 };
    },
    async postLabel(path: string) {
      log.labelPosts++;
      return true;
    },
    async deleteLabel() {
      log.labelDeletes++;
      return true;
    },
    async postJson(path: string) {
      if (path === '/graphql') {
        const status = opts.threadsStatus ?? 200;
        if (status !== 200 || opts.reviewThreads === null) return { body: null, status };
        return { status: 200, body: { data: { repository: { pullRequest: { reviewThreads: opts.reviewThreads } } } } };
      }
      return { body: {}, status: 200 };
    },
    async patch(path: string, body: unknown) {
      log.patches.push({ path, body });
      return { body: {}, status: 200 };
    },
  };
  return { io, log };
}

// Two CURRENT-head Copilot findings plus noise that must NOT appear: resolved, outdated,
// older-commit and foreign-author threads.
function threadNodes(): unknown[] {
  return [
    { isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer' }, body: 'presetStore single-preset contract violated\nmore detail', path: 'src/presets/store.ts', originalLine: 42, originalCommit: { oid: HEAD } }] } },
    { isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer[bot]' }, body: 'retry drops the workflow snapshot', path: 'src/worker/drive.ts', originalLine: 7, originalCommit: { oid: HEAD } }] } },
    { isResolved: true, isOutdated: false, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer' }, body: 'already fixed', path: 'src/a.ts', originalLine: 1, originalCommit: { oid: HEAD } }] } },
    { isResolved: false, isOutdated: true, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer' }, body: 'stale round-1 finding', path: 'src/b.ts', originalLine: 2, originalCommit: { oid: 'old' } }] } },
    { isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer' }, body: 'older round', path: 'src/c.ts', originalLine: 3, originalCommit: { oid: 'sha-head-1' } }] } },
    { isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'random-human' }, body: 'not copilot', path: 'src/d.ts', originalLine: 4, originalCommit: { oid: HEAD } }] } },
  ];
}

test('blocked --pr derives the current-head findings and appends them to the question (#860)', async () => {
  const { io, log } = makeIo({ reviewThreads: { totalCount: 6, pageInfo: { hasNextPage: false }, nodes: threadNodes() } });
  const res = await blockIssue(io, { repo: 'aywengo/mercury', issue: 860, reason: 'review-round cap reached', pr: PR });
  assert.equal(res.commented, true);
  assert.equal(log.labelPosts, 1, 'the blocked label is still applied');
  assert.equal(log.labelDeletes, 1, 'the in-progress claim is still released');
  assert.equal(log.comments.length, 1);
  const body = log.comments[0]!;
  assert.match(body, /- head: sha-head-2/);
  assert.match(body, /- open findings on this head: 2/);
  assert.match(body, /src\/presets\/store\.ts:42 — presetStore single-preset contract violated/);
  assert.match(body, /src\/worker\/drive\.ts:7 — retry drops the workflow snapshot/);
  // Fail the old recalled behavior: resolved/outdated/older-head/foreign threads never appear.
  assert.doesNotMatch(body, /already fixed|stale round-1|older round|not copilot/);
});

test('blocked --pr refuses a stated count that differs from the derived one, posting NOTHING (#860)', async () => {
  const { io, log } = makeIo({ reviewThreads: { totalCount: 6, pageInfo: { hasNextPage: false }, nodes: threadNodes() } });
  await assert.rejects(
    () => blockIssue(io, { repo: 'aywengo/mercury', issue: 860, reason: 'PR has 11 open findings', pr: PR }),
    /11[\]\s][\s\S]*2 open Copilot/,
  );
  assert.equal(log.labelPosts, 0, 'the label must NOT be applied when the count is refused');
  assert.equal(log.comments.length, 0, 'no comment with a wrong number');
});

test('blocked --pr accepts a reason with no stated count and one with the matching count', async () => {
  const nodes = threadNodes();
  const { io, log } = makeIo({ reviewThreads: { totalCount: 6, pageInfo: { hasNextPage: false }, nodes } });
  await blockIssue(io, { repo: 'aywengo/mercury', issue: 860, reason: 'review-round cap reached', pr: PR });
  assert.equal(log.comments.length, 1);
  const { io: io2, log: log2 } = makeIo({ reviewThreads: { totalCount: 6, pageInfo: { hasNextPage: false }, nodes } });
  await blockIssue(io2, { repo: 'aywengo/mercury', issue: 860, reason: '2 open findings remain; how should the preset store contract be shaped?', pr: PR });
  assert.equal(log2.comments.length, 1);
});

test('blocked --pr fails closed: a capped thread query appends could-not-derive and still blocks (#860)', async () => {
  const { io, log } = makeIo({ reviewThreads: { totalCount: 6, pageInfo: { hasNextPage: true }, nodes: [] } });
  const res = await blockIssue(io, { repo: 'aywengo/mercury', issue: 860, reason: 'review-round cap reached', pr: PR });
  assert.equal(res.commented, true);
  assert.equal(log.labelPosts, 1);
  assert.match(log.comments[0]!, /could NOT be derived/);
  assert.doesNotMatch(log.comments[0]!, /open findings on this head: \d/);
});

test('blocked --pr fails closed on a non-200 thread query too (#860)', async () => {
  const { io, log } = makeIo({ reviewThreads: null, threadsStatus: 500 });
  const res = await blockIssue(io, { repo: 'aywengo/mercury', issue: 860, reason: 'review-round cap reached', pr: PR });
  assert.equal(res.commented, true);
  assert.equal(log.labelPosts, 1);
  assert.match(log.comments[0]!, /could NOT be derived/);
});

test('blocked --pr with an unreadable PR throws before any write (#860)', async () => {
  const { io, log } = makeIo({ reviewThreads: { totalCount: 2, pageInfo: { hasNextPage: false }, nodes: [] }, pulls: { body: null, status: 404 } });
  await assert.rejects(
    () => blockIssue(io, { repo: 'aywengo/mercury', issue: 860, reason: 'cap reached', pr: PR }),
    /could not read PR/,
  );
  assert.equal(log.labelPosts, 0);
  assert.equal(log.comments.length, 0);
});

test('statedFindingCounts: narrow - prose numbers (issue/PR numbers) never trip the refusal', () => {
  assert.deepEqual(statedFindingCounts('see issue #809 and PR #842'), []);
  assert.deepEqual(statedFindingCounts('11 open findings'), [11]);
  assert.deepEqual(statedFindingCounts('11 unresolved copilot findings remain'), [11]);
  assert.deepEqual(statedFindingCounts('open findings: 3 on the head'), [3]);
  assert.deepEqual(statedFindingCounts('no counts here'), []);
});

// ---- Copilot review round 4 on PR #966: the three open findings ----

test('blocked --pr: a reason that names the PR after its count is not refused (#966)', async () => {
  const { io, log } = makeIo({ reviewThreads: { totalCount: 6, pageInfo: { hasNextPage: false }, nodes: threadNodes() } });
  // "2 open findings on PR #842": the old count regexes read 842 as a second count and refused.
  await blockIssue(io, { repo: 'aywengo/mercury', issue: 860, reason: '2 open findings on PR #842; how should the store contract be shaped?', pr: PR });
  assert.equal(log.comments.length, 1, 'the matching count is accepted and the hand-off is posted');
  assert.equal(log.labelPosts, 1);
  assert.match(log.comments[0]!, /- open findings on this head: 2/);
});

test('blocked --pr: the head line shows the FETCHED PR head, not the reviewed commit (#966)', async () => {
  // The review was submitted on sha-head-1; the PR has since advanced to HEAD (sha-head-2).
  const { io, log } = makeIo({ reviewThreads: { totalCount: 6, pageInfo: { hasNextPage: false }, nodes: threadNodes() }, reviewCommit: 'sha-head-1' });
  await blockIssue(io, { repo: 'aywengo/mercury', issue: 860, reason: 'review-round cap reached', pr: PR });
  const body = log.comments[0]!;
  assert.match(body, /- head: sha-head-2/, 'the current head is the fetched head');
  assert.match(body, /- last Copilot review: sha-head-1 at 2026-10-05T00:44:00Z/, 'the reviewed commit keeps its own line');
  assert.doesNotMatch(body, /- head: sha-head-1/);
});

test('blocked --pr: the head line still shows the fetched head when no Copilot review exists (#966)', async () => {
  const { io, log } = makeIo({ reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }, reviewsStatus: 200 });
  // Strip the Copilot review: only the PR-head read remains.
  const get = io.get;
  io.get = async (path: string) => (path.includes(`/pulls/${PR}/reviews`) ? { body: [], status: 200, link: null } : get(path));
  await blockIssue(io, { repo: 'aywengo/mercury', issue: 860, reason: 'review-round cap reached', pr: PR });
  const body = log.comments[0]!;
  assert.match(body, /- head: sha-head-2/, 'never "unknown" while the head was fetched');
  assert.match(body, /- last Copilot review: none/);
});

test('blocked --pr: a failed reviews read fails closed instead of reporting an authoritative count (#966)', async () => {
  // A non-JSON 502 body arrives as `body: null`; the thread query succeeds. Reading that as an
  // empty review list made the hand-off authoritative ("no last Copilot review", a derived count).
  const { io, log } = makeIo({ reviewThreads: { totalCount: 6, pageInfo: { hasNextPage: false }, nodes: threadNodes() }, reviewsStatus: 502 });
  const res = await blockIssue(io, { repo: 'aywengo/mercury', issue: 860, reason: 'review-round cap reached', pr: PR });
  assert.equal(res.commented, true);
  assert.equal(log.labelPosts, 1, 'the issue is still labeled nightly:blocked');
  const body = log.comments[0]!;
  assert.match(body, /could NOT be derived/);
  assert.doesNotMatch(body, /open findings on this head: \d/);
  assert.doesNotMatch(body, /last Copilot review: none/);
});

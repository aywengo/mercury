// The morning digest (N1-4, #741): assemble the night's data, file one nightly:report issue,
// close yesterday's. All I/O injected — no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runReport, collectBlocked, collectRunsStopped, collectFailedRuns, collectFlakes, flakesInWindow, blockingQuestion, questionFromBody, defaultNight, collectIssuesCommented, nightWindow, NIGHT_END, scanNightRuns, unpushedCommitsFrom, loadedSkillVersion, compareVersions, staleSkillsNote, runMatchesRepo, collectRunsWithoutTerminalCall, type ReportIo, type NightRun } from '../.agents/skills/nightly/report.ts';
import { recordRunClaim, recordRunTerminal } from '../.agents/skills/nightly/shared.ts';
import { localDateString } from '../.agents/skills/nightly/e2e.ts';
import { tempDir } from './helpers.ts';

const REPO = 'aywengo/mercury';
const ENV = { GH_TOKEN: 'test-token' };

// Fixture deadlines built from LOCAL wall-clock values, never hard-coded UTC instants:
// collectRunsStopped compares notAfter via the process's LOCAL calendar date, so a fixed
// '...T04:00:00Z' changes meaning per host timezone (CI runs TZ=UTC). Local 06:00 on the
// 26th is the §4.3 window end on that night in every timezone; local 06:00 on the 25th is
// always the WRONG night.
const NA26 = new Date('2026-09-26T06:00:00').toISOString();
const NA25 = new Date('2026-09-25T06:00:00').toISOString();

interface Recorded { method: string; path: string; body?: unknown }

function ioWith(opts: {
  searchItems?: Record<string, unknown[]>;
  issues?: { number: number; title: string; body?: string; labels?: { name: string }[]; pull_request?: unknown }[];
  comments?: Record<number, { body: string; created_at?: string }[]>;
  timedOutRuns?: { id: string; task: string; status: string; constraints?: { notAfter?: string } }[];
  notAfterRunIds?: string[];
  mercury?: boolean;
} = {}): { io: ReportIo; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const io: ReportIo = {
    async get(path) {
      calls.push({ method: 'GET', path });
      if (path.startsWith('/search/issues?')) {
        const q = decodeURIComponent(path);
        for (const [needle, items] of Object.entries(opts.searchItems ?? {})) {
          if (q.includes(needle)) return { body: { items }, status: 200 };
        }
        return { body: { items: [] }, status: 200 };
      }
      if (path.includes('/issues?labels=nightly%3Ablocked')) {
        return { body: (opts.issues ?? []).filter((i) => i.labels?.some((l) => l.name === 'nightly:blocked')), status: 200 };
      }
      if (path.includes('/issues?labels=nightly%3Areport')) {
        // Yesterday's open report:
        return { body: opts.issues?.filter((i) => i.labels?.some((l) => l.name === 'nightly:report')) ?? [], status: 200 };
      }
      const c = path.match(/\/issues\/(\d+)\/comments/);
      if (c) return { body: opts.comments?.[Number(c[1])] ?? [], status: 200 };
      return { body: [], status: 200 };
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      return { body: { number: 900 }, status: 201 };
    },
    async patch(path, body) {
      calls.push({ method: 'PATCH', path, body });
      return { body: {}, status: 200 };
    },
    ...(opts.mercury ? {
      mercury: {
        async get(path) {
          calls.push({ method: 'MGET', path });
          if (path.startsWith('/api/runs?')) return { body: { runs: opts.timedOutRuns ?? [] }, status: 200 };
          const id = path.match(/\/api\/runs\/([^/]+)\/events/)?.[1];
          const events = id && opts.notAfterRunIds?.includes(id)
            ? [{ type: 'run.timed_out', payload: { runId: 'r', reason: 'not-after' } }]
            : [];
          return { body: { events, nextCursor: events.length > 0 ? 5 : 0, hasMore: false }, status: 200 };
        },
      },
    } : {}),
  };
  return { io, calls };
}

test('the digest files one issue with all sections and closes yesterday\'s report', async () => {
  const { io, calls } = ioWith({
    searchItems: {
      'is:pr created': [{ number: 700, title: 'a PR', html_url: 'u1' }],
      'is:issue created': [{ number: 701, title: 'a bug', html_url: 'u2', user: { login: 'mercury-nightly' } }],
      'is:issue updated': [{ number: 702, title: 'older issue', html_url: 'u3' }],
    },
    issues: [
      { number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] },
      { number: 501, title: 'blocked thing', labels: [{ name: 'nightly:blocked' }] },
    ],
    comments: {
      501: [{ body: '**Blocking question:** Which preset wins?' }],
    },
  });
  // The commented section reads the repo-level since listing (one call), not per-issue pages.
  // The comment timestamp is INSIDE the night window of the HOST zone (derived via nightWindow,
  // not hard-coded UTC: a fixed instant falls outside the local [00:00,06:00) window on
  // non-UTC hosts).
  const winForFixture = nightWindow('2026-09-26');
  const inWindow = new Date(winForFixture.startMs + 30 * 60_000).toISOString();
  const io2: ReportIo = {
    ...io,
    async get(path) {
      if (path.includes('/issues/comments?since=')) {
        return { body: [{ body: 'a nightly comment', created_at: inWindow, issue_url: 'https://api.github.com/repos/aywengo/mercury/issues/702' }], status: 200 };
      }
      return io.get(path);
    },
  };
  const out = await runReport(io2, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(out.issue, 900);
  assert.equal(out.closedPrevious, 500, 'yesterday\'s report is closed');
  assert.equal(out.prs.length, 1);
  assert.equal(out.issuesFiled.length, 1);
  assert.equal(out.issuesFiled[0]!.author, 'mercury-nightly');
  assert.equal(out.issuesCommented.length, 1);
  assert.equal(out.blocked.length, 1);
  assert.equal(out.blocked[0]!.question, 'Which preset wins?');
  const created = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'))!;
  const body = String((created.body as { body: string }).body);
  assert.match(body, /# nightly report — 2026-09-26/);
  assert.match(body, /## PRs opened/);
  assert.match(body, /\[a PR\]\(<u1>\)/);
  assert.match(body, /## Blocked .nightly:blocked, waiting on a human./);
  assert.match(body, /Which preset wins\?/);
  assert.match(body, /## Runs stopped by notAfter/);
  assert.match(body, /## Flakes/);
  const closed = calls.filter((c) => c.method === 'PATCH');
  assert.equal(closed.length, 1);
  assert.match(closed[0]!.path, /issues\/500$/);
  assert.deepEqual((created.body as { labels: string[] }).labels, ['nightly:report']);
});

test('searches cover the §4.3 night window [00:00, 06:00) local as UTC instants (not the UTC day)', async () => {
  const { io, calls } = ioWith({});
  await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: true });
  const searches = calls.filter((c) => c.method === 'GET' && c.path.startsWith('/search/issues?')).map((c) => decodeURIComponent(c.path));
  assert.equal(searches.length, 3);
  // Expected endpoints derived the same way the implementation derives them: local midnight and
  // local 06:00 of the night, as ISO instants with a +00:00 offset. The window must be an
  // instant range (a UTC-day qualifier would miss the hours between local and UTC midnight) -
  // and it must END at 06:00 local (§4.3), not at the next midnight, so tonight's ladder work
  // is reported this morning and 06:00 deadline stops are observable.
  const toIso = (wall: string): string => new Date(wall).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  // The upper bound is one second BEFORE 06:00 local (inclusive ranges): the boundary instant
  // itself belongs to no nightly activity window.
  const win = `${toIso('2026-09-26T00:00:00')}..${new Date(new Date('2026-09-26T06:00:00').getTime() - 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00')}`;
  for (const q of searches) {
    // commented:<range> is unsupported by GitHub search (verified live); the commented section
    // candidates come from the supported updated:<range> search instead.
    assert.ok(q.includes(`created:${win}`) || q.includes(`updated:${win}`), `local-window: ${q}`);
    assert.ok(!q.includes('created:2026-09-26&'), `no UTC-day qualifier: ${q}`);
    assert.ok(!q.includes('commented:'), `no unsupported commented qualifier: ${q}`);
  }
});

test('a failed Mercury runs listing degrades the section to empty instead of failing the digest', async () => {
  let listingCalls = 0;
  const io: ReportIo = {
    mercury: {
      async get(path) {
        if (path.startsWith('/api/runs?')) {
          listingCalls += 1;
          return { body: { message: 'internal error' }, status: 500 };
        }
        return { body: { events: [] }, status: 200 };
      },
    },
    async get() { return { body: [], status: 200 }; },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  const stopped = await collectRunsStopped(io.mercury!, '2026-09-26');
  assert.deepEqual(stopped, []);
  assert.equal(listingCalls, 1, 'one attempt, no crash');
});

test('dry-run assembles everything and writes nothing', async () => {
  const { io, calls } = ioWith({
    searchItems: { 'is:pr created': [{ number: 700, title: 'a PR', html_url: 'u1' }] },
  });
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: true });
  assert.equal(out.issue, undefined);
  assert.equal(out.prs.length, 1);
  assert.equal(calls.filter((c) => c.method === 'POST' || c.method === 'PATCH').length, 0);
});

test('empty night: every section says none, the issue still files', async () => {
  const { io, calls } = ioWith({});
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(out.issue, 900);
  assert.equal(out.prs.length, 0);
  const created = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'))!;
  const body = String((created.body as { body: string }).body);
  assert.match(body, /_none_/);
});

test('runs stopped by notAfter: scoped to the report night, reason event required', async () => {
  const { io } = ioWith({
    mercury: true,
    timedOutRuns: [
      { id: 'run_a', task: 'nightly-next', status: 'TIMED_OUT', constraints: { notAfter: NA25 } },
      { id: 'run_b', task: 'nightly-e2e', status: 'TIMED_OUT', constraints: { notAfter: NA26 } },
      { id: 'run_c', task: 'nightly-next', status: 'TIMED_OUT', constraints: { notAfter: NA26 } },
    ],
    notAfterRunIds: ['run_b'], // run_c: right night but max-duration stop; run_a: wrong night
  });
  const stopped = await collectRunsStopped(io.mercury!, '2026-09-26');
  assert.deepEqual(stopped, [{ runId: 'run_b', task: 'nightly-e2e', status: 'TIMED_OUT' }]);
});

test('the reason is read from MercuryEvent.payload (the real API shape), not .data', async () => {
  const { io } = ioWith({
    mercury: true,
    timedOutRuns: [
      { id: 'run_p', task: 'nightly-e2e', status: 'TIMED_OUT', constraints: { notAfter: NA26 } },
    ],
    notAfterRunIds: ['run_p'],
  });
  const stopped = await collectRunsStopped(io.mercury!, '2026-09-26');
  assert.deepEqual(stopped, [{ runId: 'run_p', task: 'nightly-e2e', status: 'TIMED_OUT' }]);

  // A run whose timed_out event carries the reason in a different field is NOT reported: the
  // fixture used by earlier drafts (data.reason) would have masked a real bug here.
  const io2: ReportIo = {
    mercury: {
      async get(path) {
        if (path.startsWith('/api/runs?')) {
          return { body: { runs: [{ id: 'run_d', task: 'x', status: 'TIMED_OUT', constraints: { notAfter: NA26 } }] }, status: 200 };
        }
        return { body: { events: [{ type: 'run.timed_out', data: { reason: 'not-after' } }] }, status: 200 };
      },
    },
    async get() { return { body: [], status: 200 }; },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  const stopped2 = await collectRunsStopped(io2.mercury!, '2026-09-26');
  assert.deepEqual(stopped2, [], 'a data-shaped reason is not the Mercury API contract');
});

test('a run.timed_out event past the first events page is still found (nextCursor walk)', async () => {
  const calls: string[] = [];
  const eventsPages: Record<string, { body: unknown; status: number }> = {
    '/api/runs/run_long/events': { body: { events: Array.from({ length: 1000 }, () => ({ type: 'log', data: {} })), nextCursor: 1000, hasMore: true }, status: 200 },
    '/api/runs/run_long/events?after=1000': { body: { events: [{ type: 'run.timed_out', payload: { runId: 'r', reason: 'not-after' } }], nextCursor: 1005, hasMore: false }, status: 200 },
  };
  const io: ReportIo = {
    mercury: {
      async get(path) {
        calls.push(path);
        if (path.startsWith('/api/runs?')) {
          return { body: { runs: [{ id: 'run_long', task: 'nightly-next', status: 'TIMED_OUT', constraints: { notAfter: NA26 } }] }, status: 200 };
        }
        const page = eventsPages[path];
        if (page) return page;
        return { body: { events: [] }, status: 200 };
      },
    },
    async get() { return { body: [], status: 200 }; },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  const stopped = await collectRunsStopped(io.mercury!, '2026-09-26');
  assert.deepEqual(stopped, [{ runId: 'run_long', task: 'nightly-next', status: 'TIMED_OUT' }]);
  assert.ok(calls.some((c) => c.includes('after=1000')), 'the walk resumed from nextCursor');
});

test('without Mercury config the runs section is empty, not faked', async () => {
  const { io } = ioWith({});
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: true });
  assert.deepEqual(out.runsStopped, []);
});

test('blocked collection attaches the latest blocking question', async () => {
  const { io } = ioWith({
    issues: [{ number: 501, title: 'blocked thing', labels: [{ name: 'nightly:blocked' }] }],
    comments: { 501: [{ body: 'unrelated' }, { body: '**Blocking question:** the real question' }] },
  });
  const blocked = await collectBlocked(io, REPO);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.question, 'the real question');
});

test('blocked question: the LAST **Blocking question:** marker wins across pages', async () => {
  // Build an io whose comments API pages: page 1 has 100 comments (full page, no marker at the
  // end), page 2 has the newest marker.
  const page1 = Array.from({ length: 100 }, (_, k) => ({ body: k === 0 ? '**Blocking question:** old question' : `noise ${k}` }));
  const calls: Recorded[] = [];
  const io: ReportIo = {
    async get(path) {
      calls.push({ method: 'GET', path });
      if (path.includes('/comments')) {
        if (/[?&]page=1(?=&|$)/.test(path)) {
          return {
            body: page1,
            status: 200,
            link: '<https://api.github.com/repos/x/y/issues/501/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repos/x/y/issues/501/comments?per_page=100&page=2>; rel="last"',
          };
        }
        return { body: [{ body: '**Blocking question:** newest question' }], status: 200 };
      }
      if (path.includes('/issues?labels=')) return { body: [{ number: 501, title: 'blocked thing' }], status: 200 };
      return { body: [], status: 200 };
    },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  const blocked = await collectBlocked(io, REPO);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.question, 'newest question');
  // The Link-header discovery must SKIP straight to the last page: no page-walk through
  // intermediate pages (page=1 then page=2 only).
  const commentPages = calls.filter((c) => c.path.includes('/comments')).map((c) => c.path);
  assert.ok(commentPages.length <= 2, `bounded scan: ${commentPages.length} requests`);
});

test('the digest is created BEFORE yesterday\'s close (a create failure never leaves zero reports)', async () => {
  const order: string[] = [];
  const { io: base } = ioWith({
    issues: [{ number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] }],
  });
  const io: ReportIo = {
    async get(path) {
      const r = await base.get(path);
      if (path.includes('/issues?labels=nightly%3Areport')) order.push('list-prev');
      return r;
    },
    async post(path) {
      order.push('create-digest');
      return { body: { number: 900 }, status: 201 };
    },
    async patch(path) {
      order.push('close-prev');
      return { body: {}, status: 200 };
    },
  };
  await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  const created = order.indexOf('create-digest');
  const closed = order.indexOf('close-prev');
  assert.ok(created !== -1 && closed !== -1);
  assert.ok(created < closed, `digest create (${created}) must precede the close (${closed})`);
});

test('flakes come from the e2e flake-clock state file', () => {
  const dir = tempDir('mercury-report-test-');
  mkdirSync(join(dir, 'mercury/nightly'), { recursive: true });
  writeFileSync(
    join(dir, 'mercury/nightly/e2e-flakes.json'),
    JSON.stringify({
      fp1: { test: 'lease expires early', error: 'e', nights: ['2026-09-24', '2026-09-25'] },
      fp2: { test: 'another flake', error: 'e', nights: ['2026-09-20'] },
    }),
  );
  const flakes = collectFlakes({ XDG_STATE_HOME: dir }, '2026-09-26');
  assert.equal(flakes.length, 2);
  assert.equal(flakes[0]!.fingerprint, 'fp1', 'most recent night first');
});

test('a retry reuses the same-night digest (idempotent create, no duplicate)', async () => {
  const order: string[] = [];
  const { io: base } = ioWith({
    issues: [
      { number: 700, title: 'nightly report — 2026-09-26', labels: [{ name: 'nightly:report' }] },
      { number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] },
    ],
  });
  const io: ReportIo = {
    async get(path) { const r = await base.get(path); order.push('GET ' + path.slice(0, 40)); return r; },
    async post(path, body) { order.push('POST ' + path); return { body: { number: 901 }, status: 201 }; },
    async patch(path) { order.push('PATCH ' + path); return { body: {}, status: 200 }; },
  };
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(out.issue, 700, 'the existing same-night digest is reused');
  assert.equal(out.closedPrevious, 500, "yesterday's is still closed");
  assert.ok(!order.some((o) => o.startsWith('POST')), 'no create happens when the same-night report exists');
});

test('a same-night digest from a concurrent run is NEVER closed', async () => {
  const { io } = ioWith({
    issues: [
      { number: 701, title: 'nightly report — 2026-09-26', labels: [{ name: 'nightly:report' }] }, // concurrent
      { number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] },
    ],
  });
  const closedPaths: string[] = [];
  const failingClose: ReportIo = {
    ...io,
    async post(path, body) { return { body: { number: 902 }, status: 201 }; },
    async patch(path) { closedPaths.push(path); return { body: {}, status: 200 }; },
  };
  await runReport(failingClose, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.deepEqual(closedPaths, ['/repos/aywengo/mercury/issues/500'], 'only the OTHER night\'s report is closed');
});

test('a 2xx create without a parseable number fails hard BEFORE closing yesterday\'s report', async () => {
  const order: string[] = [];
  const { io: base } = ioWith({
    issues: [{ number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] }],
  });
  const io: ReportIo = {
    async get(path) {
      const r = await base.get(path);
      if (path.includes('/issues?labels=nightly%3Areport')) order.push('list-prev');
      return r;
    },
    async post() {
      order.push('create-digest');
      return { body: null, status: 201 }; // 2xx but unparsable: no number
    },
    async patch(path) {
      order.push('close-prev');
      return { body: {}, status: 200 };
    },
  };
  await assert.rejects(
    () => runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false }),
    /no usable issue number/,
  );
  assert.equal(order.filter((o) => o === 'close-prev').length, 0, 'nothing is closed when the new digest is unidentifiable');
});

test('collectFlakes filters nights to <= the report night (a backfill shows no future dates)', () => {
  const dir = tempDir('mercury-report-test2-');
  mkdirSync(join(dir, 'mercury/nightly'), { recursive: true });
  writeFileSync(
    join(dir, 'mercury/nightly/e2e-flakes.json'),
    JSON.stringify({
      fp1: { test: 'lease flake', error: 'e', nights: ['2026-09-24', '2026-09-28'] },
      fp2: { test: 'future-only flake', error: 'e', nights: ['2026-09-30'] },
    }),
  );
  const flakes = collectFlakes({ XDG_STATE_HOME: dir }, '2026-09-26');
  assert.deepEqual(flakes, [{ fingerprint: 'fp1', test: 'lease flake', nights: ['2026-09-24'] }], 'future nights are filtered out; future-only entries disappear');
});

test('a FAILED close is not claimed: closedPrevious stays unset (JSON tells the truth)', async () => {
  const { io } = ioWith({
    issues: [{ number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] }],
  });
  const failingClose: ReportIo = {
    ...io,
    async patch() {
      return { body: { message: 'validation failed' }, status: 422 }; // close rejected
    },
  };
  const out = await runReport(failingClose, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(out.issue, 900);
  assert.equal(out.closedPrevious, undefined, 'a 422 close is NOT recorded as closed');
});

test('localDateString is what the test env defaults to (UTC-rollover rule shared with e2e.ts)', () => {
  // Pins the contract: the CLI default night comes from localDateString (local calendar day),
  // not toISOString (UTC day) - a 00:05 local fire belongs to the local day.
  assert.match(localDateString(), /^\d{4}-\d{2}-\d{2}$/);
});

test('exactly 100 comments with no marker: the fallback takes the TRUE last comment', async () => {
  const pages: { body: string }[][] = [
    Array.from({ length: 100 }, (_, k) => ({ body: `noise ${k}` })), // full page, no marker
    [], // next page is empty: the caller must remember page 1's last comment
  ];
  const io: ReportIo = {
    async get(path) {
      if (path.includes('/comments?')) {
        const m = /[?&]page=(\d+)/.exec(path);
        const page = m ? Number(m[1]) : 1;
        return { body: pages[page - 1] ?? [], status: 200 };
      }
      return { body: [], status: 200 };
    },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  const q = await blockingQuestion(io, REPO, 502);
  assert.equal(q, 'noise 99', 'fallback reads the last comment of the last NON-EMPTY page');
});

test('a >1000-comment thread: the scan jumps to the Link-header last page (newest marker found)', async () => {
  const requested: number[] = [];
  const io: ReportIo = {
    async get(path) {
      if (path.includes('/comments')) {
        const m = /[?&]page=(\d+)/.exec(path);
        const page = m ? Number(m[1]) : 1;
        requested.push(page);
        if (page === 1) {
          return {
            body: [{ body: '**Blocking question:** stale question' }],
            status: 200,
            link: '<https://api.github.com/repos/x/y/issues/502/comments?per_page=100&page=7>; rel="next", <https://api.github.com/repos/x/y/issues/502/comments?per_page=100&page=7>; rel="last"',
          };
        }
        if (page === 7) return { body: [{ body: '**Blocking question:** newest question' }], status: 200 };
        return { body: [], status: 200 };
      }
      return { body: [], status: 200 };
    },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  const q = await blockingQuestion(io, REPO, 502);
  assert.equal(q, 'newest question', 'the newest marker on the last page wins over the stale one on page 1');
  // The question is written by our own nightly-next: page 1 plus the Link LAST page is enough.
  assert.deepEqual(requested, [1, 7], 'page 1 then the last page - no multi-page walk');
});

test('a page-1 marker is still seen when the thread grows past the scanned tail', async () => {
  const io: ReportIo = {
    async get(path) {
      if (path.includes('/comments')) {
        const m = /[?&]page=(\d+)/.exec(path);
        const page = m ? Number(m[1]) : 1;
        if (page === 1) {
          return {
            body: [{ body: '**Blocking question:** the only question' }],
            status: 200,
            link: '<https://api.github.com/repos/x/y/issues/503/comments?per_page=100&page=9>; rel="last"',
          };
        }
        return { body: [{ body: 'chatter' }], status: 200 };
      }
      return { body: [], status: 200 };
    },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  const q = await blockingQuestion(io, REPO, 503);
  assert.equal(q, 'the only question', 'a page-1 marker beats the fallback chatter even on long threads');
});

test('a 2xx search response with an unexpected body fails with a targeted error', async () => {
  const io: ReportIo = {
    async get() { return { body: null, status: 200 }; }, // parse failure -> null body
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  await assert.rejects(
    () => runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: true }),
    /unexpected body \(expected \{items/,
  );
});

test('a 2xx Mercury runs response with an unparsable payload degrades the section, not the digest', async () => {
  const io: ReportIo = {
    mercury: {
      async get(path) {
        if (path.startsWith('/api/runs?')) return { body: null, status: 200 }; // invalid JSON -> null
        return { body: { events: [] }, status: 200 };
      },
    },
    async get() { return { body: [], status: 200 }; },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  const stopped = await collectRunsStopped(io.mercury!, '2026-09-26');
  assert.deepEqual(stopped, []);
});

test('a backfill never closes a NEWER report (it does close strictly older digests)', async () => {
  const { io } = ioWith({
    issues: [
      { number: 600, title: 'nightly report — 2026-09-26', labels: [{ name: 'nightly:report' }] }, // NEWER than the backfill night
      { number: 500, title: 'nightly report — 2026-09-20', labels: [{ name: 'nightly:report' }] }, // older: closed
    ],
  });
  const closedPaths: string[] = [];
  const backfill: ReportIo = {
    ...io,
    async post() { return { body: { number: 903 }, status: 201 }; },
    async patch(path) { closedPaths.push(path); return { body: {}, status: 200 }; },
  };
  await runReport(backfill, ENV, { repo: REPO, night: '2026-09-25', dryRun: false });
  assert.equal(closedPaths.length, 1, 'exactly the older digest closes');
  assert.match(closedPaths[0]!, /issues\/500$/, 'the newer report is never closed');
});
test('a 2xx Mercury events response with an unparsable payload skips the run, not the digest', async () => {
  const io: ReportIo = {
    mercury: {
      async get(path) {
        if (path.startsWith('/api/runs?')) {
          return { body: { runs: [{ id: 'run_bad', task: 'x', status: 'TIMED_OUT', constraints: { notAfter: NA26 } }] }, status: 200 };
        }
        return { body: null, status: 200 }; // invalid events JSON -> null
      },
    },
    async get() { return { body: [], status: 200 }; },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  const stopped = await collectRunsStopped(io.mercury!, '2026-09-26');
  assert.deepEqual(stopped, []);
});

test('a PR carrying the nightly:report label is never a digest candidate', async () => {
  const { io } = ioWith({
    issues: [
      { number: 710, title: 'nightly report — 2026-09-26', labels: [{ name: 'nightly:report' }], pull_request: { url: 'u' } },
      { number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] },
    ],
  });
  let created = 0;
  const io2: ReportIo = {
    ...io,
    async post() { created += 1; return { body: { number: 904 }, status: 201 }; },
  };
  const out = await runReport(io2, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(created, 1, 'the PR is not reused as the digest');
  assert.equal(out.issue, 904);
  assert.equal(out.closedPrevious, 500, 'the real previous-night issue still closes');
});

test('a 2xx blocked listing with an unexpected body fails with a targeted error (no silent empty)', async () => {
  const io: ReportIo = {
    async get(path) {
      if (path.includes('labels=nightly%3Ablocked')) return { body: null, status: 200 };
      return { body: [], status: 200 };
    },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  await assert.rejects(
    () => collectBlocked(io, REPO),
    /unexpected body \(expected an issue array\)/,
  );
});

test('backfill-added nights are sorted chronologically (max night is the sort key)', () => {
  const dir = tempDir('mercury-report-test3-');
  mkdirSync(join(dir, 'mercury/nightly'), { recursive: true });
  writeFileSync(
    join(dir, 'mercury/nightly/e2e-flakes.json'),
    JSON.stringify({
      fp_backfilled: { test: 'backfilled', error: 'e', nights: ['2026-09-26', '2026-09-24'] }, // appended out of order
      fp_normal: { test: 'normal', error: 'e', nights: ['2026-09-25'] },
    }),
  );
  const flakes = collectFlakes({ XDG_STATE_HOME: dir }, '2026-09-26');
  assert.equal(flakes[0]!.fingerprint, 'fp_backfilled', 'max night 2026-09-26 sorts first despite the unsorted list');
  assert.equal(flakes[0]!.nights.join(','), '2026-09-26,2026-09-24', 'the displayed list keeps its stored order (only the sort key changed)');
});

test('a 2xx open-report listing with an unexpected body fails BEFORE any write', async () => {
  const io: ReportIo = {
    async get(path) {
      if (path.includes('labels=nightly%3Areport')) return { body: null, status: 200 }; // invalid JSON -> null
      return { body: { items: [] }, status: 200 };
    },
    async post() { return { body: { number: 905 }, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  let posted = false;
  const spy: ReportIo = { ...io, async post(path, body) { posted = true; return io.post(path, body); } };
  await assert.rejects(
    () => runReport(spy, ENV, { repo: REPO, night: '2026-09-26', dryRun: false }),
    /unexpected body \(expected an issue array\)/,
  );
  assert.equal(posted, false, 'no duplicate is created when the listing is unreadable');
});

test('an impossible calendar date is rejected before any read or write', async () => {
  const { io, calls } = ioWith({});
  await assert.rejects(
    () => runReport(io, ENV, { repo: REPO, night: '2026-02-30', dryRun: false }),
    /not a real calendar date/,
  );
  assert.equal(calls.length, 0, 'no requests happen for an impossible night');
  await assert.rejects(
    () => runReport(io, ENV, { repo: REPO, night: '2026-9-6', dryRun: false }),
    /night must be YYYY-MM-DD/,
  );
});

test('a CLOSED same-night digest is reused (all-states lookup), not duplicated', async () => {
  const { io: base } = ioWith({
    issues: [
      { number: 690, title: 'nightly report — 2026-09-26', labels: [{ name: 'nightly:report' }] }, // closed by an operator
      { number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] },
    ],
  });
  const stateAll: ReportIo = {
    ...base,
    async get(path) {
      const r = await base.get(path);
      if (path.includes('state=all')) {
        // All-states listing: include the closed same-night issue (state field).
        return { body: [
          { number: 690, title: 'nightly report — 2026-09-26', state: 'closed' },
          { number: 500, title: 'nightly report — 2026-09-25', state: 'open' },
        ], status: 200 };
      }
      return r;
    },
    async post() { return { body: { number: 906 }, status: 201 }; },
  };
  let created = 0;
  const spy: ReportIo = { ...stateAll, async post(path, body) { created += 1; return stateAll.post(path, body); } };
  const out = await runReport(spy, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(created, 0, 'no duplicate is created when the closed same-night digest exists');
  assert.equal(out.issue, 690);
});

test('user-controlled titles are Markdown-escaped in the digest body', async () => {
  const { io } = ioWith({
    searchItems: {
      'is:pr created': [{ number: 710, title: 'x](https://evil.example) and ![img](y', html_url: 'https://github.com/aywengo/mercury/pull/710' }],
    },
  });
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: true });
  assert.match(out.prs[0]!.title!, /x\]\(https:\/\/evil\.example\)/);
  const { io: io2, calls } = ioWith({
    searchItems: {
      'is:pr created': [{ number: 710, title: 'x](https://evil.example)', html_url: 'https://github.com/aywengo/mercury/pull/710' }],
    },
  });
  await runReport(io2, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  const created = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'))!;
  const body = String((created.body as { body: string }).body);
  // The brackets/parens are escaped: the link cannot be broken out of.
  assert.ok(!body.includes('[x](https://evil.example)'), 'the raw injection is gone');
  assert.ok(body.includes('x\\]\\(https://evil.example\\)'), 'the title is escaped');
});

test('collectRunsStopped survives a transport error on the listing or on one run\'s events', async () => {
  const notAfter = new Date(Date.now()).toISOString();
  // The notAfter must land on the report night (local date of today).
  const night = localDateString(new Date());
  const na = new Date(night + 'T06:00:00');
  const { io: listingIo } = ioWith({});
  const listingFails: ReportIo = {
    ...listingIo,
    mercury: {
      async get() { throw new Error('ECONNRESET'); },
    },
  };
  const out = await collectRunsStopped(listingFails.mercury!, night);
  assert.deepEqual(out, [], 'a listing transport error degrades to an empty section');
  // Per-run events failure: the listing works, the events fetch throws - the run is skipped,
  // the digest is not failed.
  const { io: evIo } = ioWith({
    timedOutRuns: [{ id: 'runX', task: 'build docs', status: 'TIMED_OUT', constraints: { notAfter: na.toISOString() } }],
    notAfterRunIds: ['runX'],
    mercury: true,
  });
  let eventsAsked = 0;
  const evFails: ReportIo = {
    ...evIo,
    mercury: {
      async get(path) {
        if (path.includes('/events')) { eventsAsked += 1; throw new Error('fetch timeout'); }
        return evIo.mercury!.get(path);
      },
    },
  };
  const out2 = await collectRunsStopped(evFails.mercury!, night);
  assert.ok(eventsAsked >= 1, 'the events endpoint was reached');
  assert.deepEqual(out2, [], 'an events transport error skips the run instead of failing');
});

test('run task text is sanitized inside inline-code spans', async () => {
  const night = localDateString(new Date());
  const na = new Date(night + 'T06:00:00');
  const { io } = ioWith({
    timedOutRuns: [{ id: 'runX', task: 'evil`\n## injected list', status: 'TIMED_OUT', constraints: { notAfter: na.toISOString() } }],
    notAfterRunIds: ['runX'],
    mercury: true,
  });
  const stopped = await collectRunsStopped(io.mercury!, night);
  assert.equal(stopped.length, 1);
  // The digest body renders the sanitized task through a full run.
  const { io: io3, calls: calls3 } = ioWith({
    searchItems: {},
    timedOutRuns: [{ id: 'runX', task: 'evil`\n## injected', status: 'TIMED_OUT', constraints: { notAfter: na.toISOString() } }],
    notAfterRunIds: ['runX'],
    mercury: true,
  });
  await runReport(io3, ENV, { repo: REPO, night, dryRun: false });
  const created = calls3.find((c) => c.method === 'POST' && c.path.endsWith('/issues'))!;
  const body = String((created.body as { body: string }).body);
  // The flattened text may legitimately CONTAIN '## injected' mid-line inside the code span;
  // the injection invariant is that no NEW LINE starts with it (a real heading/list injection).
  assert.ok(!body.includes('\n## injected'), 'no injected heading line exists');
  assert.ok(!body.includes('evil`'), 'the backtick delimiter is stripped');
  assert.ok(body.includes('`runX` — `evil ## injected`'), 'task text is a single sanitized code span');
});

test('a malformed 2xx comment-page body is an unreadable question, not a crash', async () => {
  const io: ReportIo = {
    async get(path) {
      if (path.includes('/comments')) {
        const m = /[?&]page=(\d+)/.exec(path);
        const page = m ? Number(m[1]) : 1;
        // Page 1 is an OBJECT (with a Link header advertising last=2); page 2 is an array
        // of junk entries plus one valid comment.
        if (page === 1) {
          return {
            body: { message: 'proxy error page' },
            status: 200,
            link: '<https://api.github.com/repos/x/y/issues/502/comments?per_page=100&page=2>; rel="last"',
          };
        }
        return { body: [null, 'nope', { body: '**Blocking question:** real question' }], status: 200 };
      }
      return { body: [], status: 200 };
    },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  const q = await blockingQuestion(io, REPO, 502);
  assert.equal(q, 'real question', 'malformed entries are skipped, valid ones still scanned');
});

test('the CLI default night is the COMPLETED prior night (05:40 fire vs 06:00 cutoff)', () => {
  // The scheduled fire is 05:40 local, BEFORE the 06:00 notAfter end: defaulting to "today"
  // would query a window that is still open (post-report activity swallowed, today's 06:00
  // stops missing from every later report). The default must be yesterday.
  const now = new Date('2026-09-27T05:40:00'); // LOCAL 05:40
  assert.equal(defaultNight(now), '2026-09-26');
  // A fire just after local midnight (00:05) also reports the completed night: 00:05 on the
  // 1st reports the night that ended at 06:00 of the previous month-day.
  const justAfterMidnight = new Date('2026-10-01T00:05:00');
  assert.equal(defaultNight(justAfterMidnight), '2026-09-30');
  // Equivalence with the documented expression, pinned against the host clock:
  assert.equal(defaultNight(), defaultNight(new Date()));
});

test('closes EVERY open digest older than the night (failed-close self-heal) and never a newer one', async () => {
  const { io: base } = ioWith({
    issues: [
      { number: 440, title: 'nightly report — 2026-09-21', labels: [{ name: 'nightly:report' }] }, // stale (failed close)
      { number: 480, title: 'nightly report — 2026-09-24', labels: [{ name: 'nightly:report' }] }, // stale
      { number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] }, // prevNight
      { number: 600, title: 'nightly report — 2026-09-26', labels: [{ name: 'nightly:report' }] }, // SAME night: not closed
      { number: 700, title: 'nightly report — 2026-09-27', labels: [{ name: 'nightly:report' }] }, // NEWER: not closed
      { number: 470, title: 'postmortem notes — 2026-09-24', labels: [{ name: 'nightly:report' }] }, // lookalike title
    ],
  });
  const patched: number[] = [];
  let createSeen = false;
  const io: ReportIo = {
    async get(path) {
      if (path.includes('state=all')) return { body: [], status: 200 };
      if (path.includes('state=open') && !path.includes('nightly%3Ablocked')) {
        return createSeen ? { body: [{ number: 900, title: 'nightly report — 2026-09-26' }], status: 200 } : base.get(path);
      }
      return base.get(path);
    },
    async post() { createSeen = true; return { body: { number: 900 }, status: 201 }; },
    async patch(path) { patched.push(Number(/issues\/(\d+)$/.exec(path)![1])); return { body: {}, status: 200 }; },
  };
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(out.issue, 900);
  assert.deepEqual(patched.sort((a, b) => a - b), [440, 480, 500],
    'every strictly-older digest closes (self-healing failed closes); same-night/newer/lookalike never');
});
test('an unrelated nightly:report title that merely ends in a retry date is NOT closed', async () => {
  const { io: base } = ioWith({
    issues: [
      { number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] },
      { number: 470, title: 'postmortem notes — 2026-09-24', labels: [{ name: 'nightly:report' }] }, // same suffix, different prefix
    ],
  });
  const patched: number[] = [];
  let createSeen = false;
  const io: ReportIo = {
    async get(path) {
      if (path.includes('state=all')) return { body: [], status: 200 };
      if (path.includes('state=open') && !path.includes('nightly%3Ablocked')) {
        return createSeen ? { body: [{ number: 900, title: 'nightly report — 2026-09-26' }], status: 200 } : base.get(path);
      }
      return base.get(path);
    },
    async post() { createSeen = true; return { body: { number: 900 }, status: 201 }; },
    async patch(path) { patched.push(Number(/issues\/(\d+)$/.exec(path)![1])); return { body: {}, status: 200 }; },
  };
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(out.issue, 900);
  assert.deepEqual(patched.sort((a, b) => a - b), [500], 'only the exact prevNight title is closed; the lookalike stays open');
});

test('the CLI rejects a flag present without its value (strict flag parsing)', async () => {
  // The CLI block only runs when the module is the entry point; spawn it for real.
  const { execFileSync } = await import('node:child_process');
  // Resolve relative to THIS test file: CI checks out the repo at a different path, so a
  // hard-coded /Users/... path cannot exist there.
  const script = new URL('../.agents/skills/nightly/report.ts', import.meta.url).pathname;
  const run = (args: string[]): { output: string; status: number } => {
    try {
      const stdout = execFileSync(process.execPath, [script, ...args], {
        env: { ...process.env, GH_TOKEN: 'unused' },
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { output: stdout, status: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number; message?: string };
      return { output: `${err.stdout ?? ''}${err.stderr ?? err.message ?? String(e)}`, status: err.status ?? 1 };
    }
  };
  // `--night` followed by another flag: an error, never a silent default to the prior night.
  const r1 = run(['--night', '--repo', 'aywengo/mercury']);
  assert.notEqual(r1.status, 0);
  assert.match(r1.output, /--night requires a value/);
  // `--repo` without a value is the same class of error (offline: fails before any request).
  const r2 = run(['--repo', '--dry-run']);
  assert.notEqual(r2.status, 0);
  assert.match(r2.output, /--repo requires a value/);
});

test('non-string comment bodies are skipped, not crashed on', async () => {
  const io: ReportIo = {
    async get(path) {
      if (path.includes('/comments')) {
        return { body: [{ body: null }, { body: 42 }, { nobody: true }, { body: '**Blocking question:** the question' }], status: 200 };
      }
      return { body: [], status: 200 };
    },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  const q = await blockingQuestion(io, REPO, 502);
  assert.equal(q, 'the question', 'null/number/missing bodies are skipped; the string body wins');
});

test('an oversized digest is truncated under the GitHub issue-body budget', async () => {
  // 900 PRs with long titles: far past what 65,536 allows once escaped.
  const bigTitle = 'x'.repeat(80);
  const items = Array.from({ length: 900 }, (_, k) => ({ number: k + 1, title: bigTitle, html_url: `https://github.com/aywengo/mercury/pull/${k + 1}` }));
  const { io, calls } = ioWith({
    searchItems: { 'is:pr created': items },
  });
  await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  const created = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'))!;
  const body = String((created.body as { body: string }).body);
  assert.ok(body.length <= 65_536, `body must fit the GitHub limit (got ${body.length})`);
  assert.match(body, /omitted \(issue-body budget\)/, 'the truncation marker states the omitted count');
  // A small night still renders every section (no truncation markers anywhere).
  const { io: io2, calls: calls2 } = ioWith({});
  await runReport(io2, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  const created2 = calls2.find((c) => c.method === 'POST' && c.path.endsWith('/issues'))!;
  const body2 = String((created2.body as { body: string }).body);
  assert.ok(!body2.includes('omitted'), 'an empty night truncates nothing');
  assert.match(body2, /## Flakes/);
});

test('every section is budget-bound: a huge blocked list cannot blow the body limit', async () => {
  // 700 blocked issues with long questions - the blocked section alone exceeds the budget.
  const blocked = Array.from({ length: 700 }, (_, k) => ({
    number: k + 1,
    title: 'b'.repeat(70),
    question: 'q'.repeat(200),
  }));
  const { io, calls } = ioWith({
    issues: blocked.map((b) => ({ number: b.number, title: b.title, labels: [{ name: 'nightly:blocked' }] })),
    comments: Object.fromEntries(blocked.map((b) => [b.number, [{ body: `**Blocking question:** ${b.question}` }]])),
  });
  // blocked entries need the marker on the FIRST comment page; ioWith serves opts.comments for
  // /issues/:n/comments ✓. The blocked listing returns all labeled issues ✓.
  await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: true });
  // Dry-run only exposes prs; render the blocked section through a full run instead.
  const { io: io2, calls: calls2 } = ioWith({
    issues: blocked.map((b) => ({ number: b.number, title: b.title, labels: [{ name: 'nightly:blocked' }] })),
    comments: Object.fromEntries(blocked.map((b) => [b.number, [{ body: `**Blocking question:** ${b.question}` }]])),
  });
  await runReport(io2, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  const created = calls2.find((c) => c.method === 'POST' && c.path.endsWith('/issues'))!;
  const body = String((created.body as { body: string }).body);
  assert.ok(body.length <= 65_536, `body must fit the GitHub limit (got ${body.length})`);
  assert.match(body, /omitted \(issue-body budget\)/);
});

test('#1026: the section order is pinned (recovery sections before Claims released)', async () => {
  // #1026 item 5: the digestBody comment once claimed the two #1024 recovery sections render
  // "right after the claims-released list"; they render BEFORE it, and no test pinned the order.
  // The order is the (bounded) guarantee that the recovery data comes first when the shared
  // 60 KB issue-body budget is running out, so every section heading is asserted, in order.
  const { io, calls } = ioWith({});
  await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  const created = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'))!;
  const body = String((created.body as { body: string }).body);
  const order = [
    '## PRs opened',
    '## Issues filed',
    '## Issues commented',
    '## Runs that ended with unpushed commits',
    '## nightly-next Runs that never called finish/blocked',
    '## Claims released (Run ended with no PR and no comment)',
    '## Blocked (nightly:blocked, waiting on a human)',
    '## Runs stopped by notAfter (the 06:00 window end)',
    '## Runs that failed',
    '## Flakes (nightly-e2e clock)',
  ];
  let last = -1;
  for (const heading of order) {
    const idx = body.indexOf(heading);
    assert.ok(idx >= 0, `section renders: ${heading}`);
    assert.ok(idx > last, `${heading} must come after the previous section`);
    last = idx;
  }
});

test('a create returning 0/null/string is unidentifiable: hard error, nothing closed', async () => {
  for (const bad of [null, 0, '901', -5]) {
    const { io: base } = ioWith({
      issues: [{ number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] }],
    });
    const patched: number[] = [];
    const io: ReportIo = {
      ...base,
      async get(path) {
        if (path.includes('state=all')) return { body: [], status: 200 };
        return base.get(path);
      },
      async post() { return { body: { number: bad }, status: 201 }; },
      async patch(path) { patched.push(Number(/issues\/(\d+)$/.exec(path)![1])); return { body: {}, status: 200 }; },
    };
    await assert.rejects(
      () => runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false }),
      /no usable issue number/,
    );
    assert.deepEqual(patched, [], `nothing is closed for an unidentifiable create (case ${JSON.stringify(bad)})`);
  }
});

test('commented candidates paginate: the repo-level since listing finds window comments, and the result intersects the updated: candidates', async () => {
  const { io: base } = ioWith({
    searchItems: {
      'is:issue updated': [
        { number: 703, title: 'busy issue', html_url: 'u9' },
        { number: 704, title: 'quiet issue', html_url: 'u10' },
      ],
    },
  });
  const io: ReportIo = {
    ...base,
    async get(path) {
      if (path.includes('/issues/comments?since=')) {
        // One comment INSIDE the window on 703, one before it (filtered by created_at),
        // one on a non-candidate issue (dropped by the intersection).
        return { body: [
          { body: 'in window', created_at: '2026-09-26T02:30:00Z', issue_url: 'https://api.github.com/repos/aywengo/mercury/issues/703' },
          { body: 'too old', created_at: '2026-09-26T01:15:00Z', issue_url: 'https://api.github.com/repos/aywengo/mercury/issues/703' },
          { body: 'other issue', created_at: '2026-09-26T04:45:00Z', issue_url: 'https://api.github.com/repos/aywengo/mercury/issues/999' },
        ], status: 200 };
      }
      return base.get(path);
    },
  };
  const out = await collectIssuesCommented(
    io, REPO,
    [{ number: 703, title: 'busy issue', url: 'u9' }, { number: 704, title: 'quiet issue', url: 'u10' }],
    Date.parse('2026-09-26T00:00:00+00:00'), Date.parse('2026-09-26T23:59:59+00:00'),
  );
  assert.deepEqual(out.map((c) => c.number), [703], 'only the candidate with an in-window comment survives');
});

test('flake state with newlines/tampered nights cannot inject digest content', async () => {
  // The loader reads $XDG_STATE_HOME/mercury/nightly/e2e-flakes.json - write the tampered
  // fixture exactly there (review finding: the fixture previously wrote to the wrong path and
  // passed vacuously).
  const dir = tempDir('nightly-flakes-inject');
  const statePath = join(dir, 'mercury', 'nightly');
  mkdirSync(statePath, { recursive: true });
  writeFileSync(join(statePath, 'e2e-flakes.json'), JSON.stringify({
    fingerprintOf: { nights: ['2026-09-24', 'INJECTED\n## heading', 'not-a-date'], test: 'evil\n## injected heading' },
  }));
  const env = { ...ENV, XDG_STATE_HOME: dir };
  const { io: ioRun, calls } = ioWith({});
  await runReport(ioRun, env, { repo: REPO, night: '2026-09-26', dryRun: false });
  const created = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'))!;
  const body = String((created.body as { body: string }).body);
  assert.ok(!body.includes('\n## injected heading'), 'no injected heading line');
  assert.ok(!body.includes('INJECTED\n## heading'), 'the tampered night string is flattened or dropped');
});
test('repo validation refuses a non owner/name value', async () => {
  const { io } = ioWith({});
  await assert.rejects(() => runReport(io, ENV, { repo: 'no-slash', night: '2026-09-26', dryRun: true }), /owner\/name/);
});

test('defaultNight: at/after 06:00 local the window that just ended is TODAY; before it, yesterday', () => {
  const at = (wall: string): Date => new Date(wall);
  // Fire at 06:05 local (the bot config cron): today's window [00:00, 06:00) just ended.
  assert.equal(defaultNight(at('2026-09-27T06:05:00')), '2026-09-27');
  // Exactly at the boundary (06:00:00) the window is complete: today.
  assert.equal(defaultNight(at('2026-09-27T06:00:00')), '2026-09-27');
  // One minute before the boundary: the window has not ended; the completed window is yesterday's.
  assert.equal(defaultNight(at('2026-09-27T05:59:00')), '2026-09-26');
  // Mid-window fire (manual rerun at 03:00): still yesterday's completed window.
  assert.equal(defaultNight(at('2026-09-27T03:00:00')), '2026-09-26');
});

test('nightWindow: [00:00, 06:00) local instants with the boundary second excluded', () => {
  const win = nightWindow('2026-09-26');
  // Expected instants derived through the host zone exactly like the implementation (a hard
  // UTC wall would only hold on a UTC host; the contract is the LOCAL wall clock). The start
  // must be local midnight of the night and the end local 06:00 (one second subtracted).
  const localIso = (wall: string): string => new Date(wall).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  assert.equal(win.startIso, localIso('2026-09-26T00:00:00'));
  // The search upper bound: one second BEFORE local 06:00 (GitHub ranges are inclusive).
  assert.equal(win.endIso, new Date(new Date('2026-09-26T06:00:00').getTime() - 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00'));
  assert.equal(win.endMs - win.startMs, 6 * 3_600_000);
  assert.equal(NIGHT_END, '06:00');
  // The window is 6 LOCAL hours even across the DST switch nights (the local wall arithmetic
  // handles the zone; these are the §4.3 windows the bot config's notAfter enforces).
  const spring = nightWindow('2026-03-29');
  const autumn = nightWindow('2026-10-25');
  assert.ok(spring.endMs > spring.startMs);
  assert.ok(autumn.endMs > autumn.startMs);
});

test('the §4.3 window keeps 06:00-stopped runs observable: notAfter on the night local date matches', () => {
  // collectRunsStopped filters candidates by localDateString(notAfter) === night. With the
  // report firing at 06:05 covering the same local date, a run stopped AT 06:00:00 local on
  // that date is inside the report's coverage - the exact gap the 05:40 fire had.
  const win = nightWindow('2026-09-26');
  const stoppedAtDeadline = new Date('2026-09-26T06:00:00'); // local wall clock, host UTC in CI
  assert.ok(stoppedAtDeadline.getTime() >= win.startMs && stoppedAtDeadline.getTime() <= win.endMs,
    'the 06:00 stop instant is covered by the window range (endMs inclusive of the boundary)');
});


test('blocked question: the issue BODY marker wins with zero comment requests (#770)', async () => {
  const { io, calls } = ioWith({
    issues: [{ number: 502, title: 'nightly-filed blocked', body: 'defect body\n\n<!-- nightly:blocking-question\nWhich retry policy?\n-->', labels: [{ name: 'nightly:blocked' }] }],
  });
  const blocked = await collectBlocked(io, REPO);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.question, 'Which retry policy?');
  // The listing already carried the body: NO comment endpoint was hit.
  assert.equal(calls.filter((c) => c.path.includes('/comments')).length, 0, 'no comment reads for a body-marker issue');
});

test('blocked question: a hand-labeled issue without a body marker falls back to comment pages', async () => {
  const { io, calls } = ioWith({
    issues: [{ number: 503, title: 'hand-labeled', body: 'plain user body - no marker', labels: [{ name: 'nightly:blocked' }] }],
    comments: { 503: [{ body: 'unrelated' }, { body: '**Blocking question:** the comment question' }] },
  });
  const blocked = await collectBlocked(io, REPO);
  assert.equal(blocked[0]!.question, 'the comment question');
  assert.ok(calls.filter((c) => c.path.includes('/comments')).length > 0, 'comment scan ran');
});

test('questionFromBody: verbatim reason, whitespace-trimmed; empty or absent marker is undefined', () => {
  assert.equal(questionFromBody('body\n\n<!-- nightly:blocking-question\nWhy did rung 2 skip the preset?\n-->'), 'Why did rung 2 skip the preset?');
  assert.equal(questionFromBody('no marker'), undefined);
  assert.equal(questionFromBody('body\n\n<!-- nightly:blocking-question\n   \n-->'), undefined, 'empty reason is no question');
  // A stale marker followed by MORE body text is not the trailing marker: no false positive.
  assert.equal(questionFromBody('<!-- nightly:blocking-question\nx\n-->\n\nreal body text'), undefined);
});

// ---- #1001: claims the selector released tonight ----

test('collectClaimsReleased lists only in-window comments carrying the release marker (#1001)', async () => {
  const { collectClaimsReleased } = await import('../.agents/skills/nightly/report.ts');
  const { CLAIM_RELEASED_MARKER } = await import('../.agents/skills/nightly/shared.ts');
  const win = nightWindow('2026-09-26');
  const inWindow = new Date(win.startMs + 30 * 60_000).toISOString();
  const beforeWindow = new Date(win.startMs - 60_000).toISOString();
  const afterWindow = new Date(win.endMs + 60_000).toISOString();
  const paths: string[] = [];
  const io: ReportIo = {
    async get(path) {
      paths.push(path);
      return {
        body: [
          { body: `${CLAIM_RELEASED_MARKER}\nreleased`, created_at: inWindow, issue_url: 'https://api.github.com/repos/aywengo/mercury/issues/81' },
          // Same marker twice for one issue: listed once.
          { body: `${CLAIM_RELEASED_MARKER}\nreleased`, created_at: inWindow, issue_url: 'https://api.github.com/repos/aywengo/mercury/issues/81' },
          { body: 'just a comment', created_at: inWindow, issue_url: 'https://api.github.com/repos/aywengo/mercury/issues/82' },
          { body: `${CLAIM_RELEASED_MARKER}\nreleased`, created_at: beforeWindow, issue_url: 'https://api.github.com/repos/aywengo/mercury/issues/83' },
          { body: `${CLAIM_RELEASED_MARKER}\nreleased`, created_at: afterWindow, issue_url: 'https://api.github.com/repos/aywengo/mercury/issues/84' },
          { body: `${CLAIM_RELEASED_MARKER}\nreleased`, created_at: inWindow, issue_url: 'https://api.github.com/repos/aywengo/mercury/issues/80' },
        ],
        status: 200,
      };
    },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  const out = await collectClaimsReleased(io, REPO, win.startMs, win.endMs - 1000);
  assert.deepEqual(out, [{ number: 80 }, { number: 81 }], 'marker only, inside the window only, once per issue, ascending');
  assert.equal(paths.length, 1, 'one repo-level listing, no per-issue walk');
});

test('collectClaimsReleased degrades to what it read when the listing fails (#1001)', async () => {
  const { collectClaimsReleased } = await import('../.agents/skills/nightly/report.ts');
  const win = nightWindow('2026-09-26');
  const io: ReportIo = {
    async get() { return { body: { message: 'boom' }, status: 500 }; },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  assert.deepEqual(await collectClaimsReleased(io, REPO, win.startMs, win.endMs - 1000), [], 'an unreadable listing never fails the digest');
});

test('the digest renders the claims-released section (#1001)', async () => {
  const { runReport } = await import('../.agents/skills/nightly/report.ts');
  const win = nightWindow('2026-09-26');
  const inWindow = new Date(win.startMs + 30 * 60_000).toISOString();
  const { CLAIM_RELEASED_MARKER } = await import('../.agents/skills/nightly/shared.ts');
  const { io, calls } = ioWith({});
  const io2: ReportIo = {
    ...io,
    async get(path) {
      if (path.includes('/issues/comments?since=')) {
        return { body: [{ body: CLAIM_RELEASED_MARKER, created_at: inWindow, issue_url: 'https://api.github.com/repos/aywengo/mercury/issues/91' }], status: 200 };
      }
      return io.get(path);
    },
  };
  const res = await runReport(io2, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.deepEqual(res.claimsReleased, [{ number: 91 }]);
  // The digest issue is the POST to /issues: its body carries the new section.
  const digest = calls.find((c) => c.method === 'POST' && /\/issues$/.test(c.path));
  const body = (digest?.body as { body?: string } | undefined)?.body ?? '';
  assert.match(body, /## Claims released \(Run ended with no PR and no comment\)/);
  assert.match(body, /- #91/);
});

// ---- #964: the flake section is windowed, and legacy absolute paths are normalized ----------

/** Write a flake-clock state file into a fresh XDG_STATE_HOME and return the env carrying it. */
function flakeEnv(state: Record<string, { test: string; error: string; nights: string[] }>): NodeJS.ProcessEnv {
  const dir = tempDir('nightly-flake-window');
  const stateDir = join(dir, 'mercury', 'nightly');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'e2e-flakes.json'), JSON.stringify(state));
  return { ...ENV, XDG_STATE_HOME: dir };
}

/** The digest body the fake io received. */
function postedBody(calls: Recorded[]): string {
  return String((calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'))!.body as { body: string }).body);
}

test('#964: a one-night flake older than the window is not listed; the digest counts it once', async () => {
  // The literal entry from the issue: one flake night on 2026-09-29, still listed on 2026-10-15
  // and on every night since, so a reader was told every morning that a flake exists.
  const env = flakeEnv({
    '2cb878c3444c585a': {
      test: '/Users/roman/mercury-workspaces/worktrees/run_dab0bc9b41f54f27/e2e/knowledge.test.ts',
      error: 'Error: boom',
      nights: ['2026-09-29'],
    },
  });
  const { io, calls } = ioWith({});
  const out = await runReport(io, env, { repo: REPO, night: '2026-10-15', dryRun: false });

  assert.deepEqual(out.flakes, [], 'no flake line for an entry outside the window');
  assert.equal(out.flakesOlder, 1);
  const body = postedBody(calls);
  assert.doesNotMatch(body, /2cb878c3444c585a/, 'the stale fingerprint is not listed');
  assert.match(body, /older entries: 1/);
});

test('#964: a flake inside the window is still listed, with no "older" note', async () => {
  const env = flakeEnv({ fp_fresh: { test: 'e2e/knowledge.test.ts', error: 'Error: boom', nights: ['2026-10-10'] } });
  const { io, calls } = ioWith({});
  const out = await runReport(io, env, { repo: REPO, night: '2026-10-15', dryRun: false });

  assert.equal(out.flakes.length, 1);
  assert.equal(out.flakesOlder, 0);
  const body = postedBody(calls);
  assert.match(body, /fp_fresh/);
  assert.doesNotMatch(body, /older entries/, 'nothing was held back');
});

test('#964: the window is the last 14 nights, inclusive at both ends', async () => {
  const flakes = [
    { fingerprint: 'edge_in', test: 'a', nights: ['2026-10-02'] },
    { fingerprint: 'edge_out', test: 'b', nights: ['2026-10-01'] },
    { fingerprint: 'recurring', test: 'c', nights: ['2026-08-01', '2026-10-14'] },
  ];
  const { visible, older } = flakesInWindow(flakes, '2026-10-15');
  assert.deepEqual(visible.map((f) => f.fingerprint), ['edge_in', 'recurring'],
    'one night inside the window is enough, even for an entry that first flaked months ago');
  assert.equal(older, 1);
  // A short window makes the boundary explicit rather than relying on the constant's value:
  // 2 nights covers 2026-10-14..15, which drops the 10-02 entry and keeps the recurring one.
  const short = flakesInWindow(flakes, '2026-10-15', 2);
  assert.deepEqual(short.visible.map((f) => f.fingerprint), ['recurring']);
  assert.equal(short.older, 2);
});

test('#964: the digest shows the repo-relative test path, never the worktree path', async () => {
  // Entries recorded before #821's normalization still carry the absolute path of one Run's
  // checkout. The fingerprint never included it (fingerprintOf normalizes before hashing), so this
  // is the display half: normalize at report time, or the path stays in every digest forever.
  const env = flakeEnv({
    fp_legacy: {
      test: '/Users/roman/mercury-workspaces/worktrees/run_dab0bc9b41f54f27/e2e/knowledge.test.ts',
      error: 'Error: boom',
      nights: ['2026-10-14'],
    },
  });
  const { io, calls } = ioWith({});
  const out = await runReport(io, env, { repo: REPO, night: '2026-10-15', dryRun: false });

  assert.equal(out.flakes[0]!.test, 'e2e/knowledge.test.ts');
  const body = postedBody(calls);
  assert.match(body, /e2e\/knowledge\.test\.ts/);
  // The rule is about the FLAKE section, and #1024 narrowed it deliberately: the unpushed-commit
  // and missing-terminal sections name a worktree path on purpose, because the reader has to be
  // able to recover the work. This fixture has no such Run, so the assertion still holds here --
  // do not "restore" the rule for the whole digest.
  assert.doesNotMatch(body, /worktrees|\/Users\//, 'no machine path reaches the FLAKE section');
});

// ---- #1024: unpushed commits, missing terminal calls, loaded skill versions ----

/** A Mercury API double: `runs` for the night listing, `events` per run id, `healthz` version. */
function mercuryWith(opts: {
  runs: { id: string; task?: string; createdAt?: string; workspacePath?: string | null; repository?: { url?: string; localPath?: string } }[];
  events?: Record<string, { type: string; payload?: unknown }[]>;
  hostVersion?: string;
  failEventsFor?: string[];
}): NonNullable<ReportIo['mercury']> {
  // Mirrors the real endpoint (src/api/routes.ts GET /runs/:id/events): sequence numbers from 1,
  // `after` is exclusive, `limit` caps the page, and `lastSequence` is the run's true maximum. The
  // digest reads the TAIL via lastSequence, so a double that ignored those parameters would pass
  // while the production path missed every completion record.
  return {
    async get(path) {
      if (path === '/healthz') return { body: opts.hostVersion ? { ok: true, version: opts.hostVersion } : {}, status: 200 };
      if (path.startsWith('/api/runs?')) return { body: { runs: opts.runs }, status: 200 };
      const m = /\/api\/runs\/([^/]+)\/events(?:\?(.*))?$/.exec(path);
      if (!m) return { body: null, status: 404 };
      const id = m[1]!;
      if (opts.failEventsFor?.includes(id)) return { body: null, status: 500 };
      const all = (opts.events?.[id] ?? []).map((e, i) => ({ ...e, sequence: i + 1 }));
      const params = new URLSearchParams(m[2] ?? '');
      const after = Number(params.get('after') ?? 0) || 0;
      const limit = Math.min(Math.max(Number(params.get('limit') ?? 1000) || 1000, 1), 1000);
      const page = all.filter((e) => e.sequence > after).slice(0, limit);
      const nextCursor = page.length > 0 ? page[page.length - 1]!.sequence : after;
      const lastSequence = all.length;
      return { body: { events: page, lastSequence, nextCursor, hasMore: nextCursor < lastSequence }, status: 200 };
    },
  };
}

/** The night window's own instants, so the fixture is timezone-independent. */
function atInNight(night: string, hour = 1): string {
  const win = nightWindow(night);
  return new Date(win.startMs + hour * 3_600_000).toISOString();
}

test('#1024: scanNightRuns reads run.unpushed_commits and skill.completed, scoped to the night', async () => {
  const mercury = mercuryWith({
    runs: [
      { id: 'run_in', task: 'nightly-next', createdAt: atInNight('2026-09-26'), workspacePath: '/ws/run_in' },
      // Daytime work: outside the [00:00, 06:00) window, so it belongs to no night.
      { id: 'run_day', task: 'nightly-next', createdAt: atInNight('2026-09-26', 9), workspacePath: '/ws/run_day' },
    ],
    events: {
      run_in: [
        { type: 'skill.completed', payload: { skill: 'issue-fix-loop', version: '1.2.0' } },
        { type: 'run.unpushed_commits', payload: { branch: 'agent/run_in', commits: ['aaaa1111', 'bbbb2222'] } },
        { type: 'run.completed', payload: { commits: ['aaaa1111'] } },
      ],
    },
  });
  const runs = await scanNightRuns(mercury, '2026-09-26');
  assert.deepEqual(runs.map((r) => r.runId), ['run_in']);
  assert.deepEqual(runs[0]!.unpushed, { branch: 'agent/run_in', commits: ['aaaa1111', 'bbbb2222'] });
  assert.deepEqual(runs[0]!.skills, [{ skill: 'issue-fix-loop', version: '1.2.0' }]);
  assert.deepEqual(unpushedCommitsFrom(runs), [{ runId: 'run_in', branch: 'agent/run_in', commits: ['aaaa1111', 'bbbb2222'], workspacePath: '/ws/run_in' }]);
});

test('#1024: a Run whose events are unreadable is dropped, not fatal', async () => {
  const mercury = mercuryWith({
    runs: [{ id: 'run_bad', createdAt: atInNight('2026-09-26') }],
    failEventsFor: ['run_bad'],
  });
  const runs = await scanNightRuns(mercury, '2026-09-26');
  // The Run is still listed (its existence is a fact); it simply carries no record.
  assert.deepEqual(runs, [{ runId: 'run_bad', skills: [] }]);
});

test('#1024 acceptance 2: the report lists the Run with its worktree path (result JSON)', async () => {
  // The exact shape of the night that was missed: run_84a35e1f57ae4df4 committed and never pushed.
  const io: ReportIo = {
    async get(path) {
      if (path.startsWith('/search/issues?')) return { body: { items: [] }, status: 200 };
      if (path.includes('/issues/comments?since=')) return { body: [], status: 200 };
      return { body: [], status: 200 };
    },
    async post() { return { body: { number: 901 }, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
    mercury: mercuryWith({
      runs: [{ id: 'run_84a35e1f57ae4df4', task: 'nightly-next', createdAt: atInNight('2026-09-26'), workspacePath: '/Users/roman/mercury-workspaces/worktrees/run_84a35e1f57ae4df4' }],
      events: {
        run_84a35e1f57ae4df4: [{ type: 'run.unpushed_commits', payload: { branch: 'fix/issue-973-fleet-scheduler-client', commits: ['0bd8435d419fe921618dce07ea54386f80c8d1ee'] } }],
      },
    }),
  };
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: true });
  assert.deepEqual(out.unpushedCommits, [{
    runId: 'run_84a35e1f57ae4df4',
    branch: 'fix/issue-973-fleet-scheduler-client',
    commits: ['0bd8435d419fe921618dce07ea54386f80c8d1ee'],
    workspacePath: '/Users/roman/mercury-workspaces/worktrees/run_84a35e1f57ae4df4',
  }]);
});

test('#1024 acceptance 6: a clean night renders both new sections as none and no staleness note', async () => {
  const stateHome = tempDir('mercury-1024-clean-');
  const bodies: string[] = [];
  const io: ReportIo = {
    async get(path) {
      if (path.startsWith('/search/issues?')) return { body: { items: [] }, status: 200 };
      if (path.includes('/issues/comments?since=')) return { body: [], status: 200 };
      if (path.includes('/contents/')) {
        return { body: { encoding: 'base64', content: Buffer.from('---\nversion: 1.4.0\n---\n').toString('base64') }, status: 200 };
      }
      return { body: [], status: 200 };
    },
    async post(_path, body) { bodies.push((body as { body: string }).body); return { body: { number: 905 }, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
    mercury: mercuryWith({
      runs: [{ id: 'run_good', createdAt: atInNight('2026-09-26'), workspacePath: '/ws/run_good' }],
      events: { run_good: [{ type: 'skill.completed', payload: { skill: 'issue-fix-loop', version: '1.4.0' } }] },
    }),
  };
  const out = await runReport(io, { ...ENV, XDG_STATE_HOME: stateHome }, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.deepEqual(out.unpushedCommits, []);
  assert.deepEqual(out.runsWithoutTerminalCall, []);
  assert.equal(out.skillVersions!.stale, false);
  const body = bodies[0]!;
  assert.ok(!body.includes('**Stale skills.**'), 'no staleness warning when the loaded version matches main');
  assert.ok(body.includes('`issue-fix-loop` 1.4.0 loaded'), 'but the loaded procedure is still stated');
  assert.ok(body.includes('## Runs that ended with unpushed commits\n_none_'), 'the section still renders, empty');
  assert.ok(body.includes('## nightly-next Runs that never called finish/blocked\n_none_'));
});

test('#1024: the digest body carries both new sections with the recovery paths', async () => {
  const stateHome = tempDir('mercury-1024-state-');
  // The ledger is written by next.ts; here the claim is recorded directly, which is the same file
  // and the same shape the report reads.
  recordRunClaim({ XDG_STATE_HOME: stateHome, MERCURY_RUN_ID: 'run_noexit' }, {
    runId: 'run_noexit', issue: 1023, cwd: '/ws/run_noexit', at: new Date(nightWindow('2026-09-26').startMs + 3_600_000),
  });
  const bodies: string[] = [];
  const io: ReportIo = {
    async get(path) {
      if (path.startsWith('/search/issues?')) return { body: { items: [] }, status: 200 };
      if (path.includes('/issues/comments?since=')) return { body: [], status: 200 };
      return { body: [], status: 200 };
    },
    async post(_path, body) {
      bodies.push((body as { body: string }).body);
      return { body: { number: 902 }, status: 201 };
    },
    async patch() { return { body: {}, status: 200 }; },
    mercury: mercuryWith({
      runs: [{ id: 'run_unpushed', createdAt: atInNight('2026-09-26'), workspacePath: '/ws/run_unpushed' }],
      events: { run_unpushed: [{ type: 'run.unpushed_commits', payload: { branch: 'fix/thing', commits: ['abcdef1234567890'] } }] },
    }),
  };
  const out = await runReport(io, { ...ENV, XDG_STATE_HOME: stateHome }, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.deepEqual(out.runsWithoutTerminalCall, [{ runId: 'run_noexit', issue: 1023, cwd: '/ws/run_noexit' }]);
  const body = bodies[0]!;
  assert.ok(body.includes('## Runs that ended with unpushed commits'), 'the unpushed section is rendered');
  assert.ok(body.includes('`run_unpushed`'), 'the Run id is named');
  assert.ok(body.includes('`fix/thing`'), 'the branch is named');
  assert.ok(body.includes('`abcdef1`'), 'the commit is named');
  assert.ok(body.includes('/ws/run_unpushed'), 'the worktree is named, so the work is recoverable');
  assert.ok(body.includes('## nightly-next Runs that never called finish/blocked'), 'the missing-terminal section is rendered');
  assert.ok(body.includes('`run_noexit`') && body.includes('#1023'), 'the Run and its issue are named');
});

test('#1024: a terminal call removes the Run from the missing-terminal section', () => {
  const stateHome = tempDir('mercury-1024-state2-');
  const env = { XDG_STATE_HOME: stateHome };
  const at = new Date(nightWindow('2026-09-26').startMs + 3_600_000);
  recordRunClaim(env, { runId: 'run_done', issue: 7, at });
  recordRunClaim(env, { runId: 'run_silent', issue: 8, at });
  assert.equal(recordRunTerminal(env, 'run_done', 'finish'), true);
  assert.deepEqual(collectRunsWithoutTerminalCall(env, '2026-09-26').map((r) => r.runId), ['run_silent']);
});

test('#1024: a claim from another night is not this night\'s missing terminal call', () => {
  const stateHome = tempDir('mercury-1024-state3-');
  const env = { XDG_STATE_HOME: stateHome };
  recordRunClaim(env, { runId: 'run_yesterday', issue: 9, at: new Date(nightWindow('2026-09-25').startMs + 3_600_000) });
  assert.deepEqual(collectRunsWithoutTerminalCall(env, '2026-09-26'), []);
});

test('#1024: a corrupt ledger reads as empty, never as a crash', () => {
  const stateHome = tempDir('mercury-1024-state4-');
  mkdirSync(join(stateHome, 'mercury', 'nightly'), { recursive: true });
  writeFileSync(join(stateHome, 'mercury', 'nightly', 'run-ledger.json'), '{not json');
  assert.deepEqual(collectRunsWithoutTerminalCall({ XDG_STATE_HOME: stateHome }, '2026-09-26'), []);
});

test('#1024: a stale loaded skill version is stated in the digest\'s first line', async () => {
  const bodies: string[] = [];
  const io: ReportIo = {
    async get(path) {
      if (path.startsWith('/search/issues?')) return { body: { items: [] }, status: 200 };
      if (path.includes('/issues/comments?since=')) return { body: [], status: 200 };
      if (path.includes('/contents/.agents/skills/issue-fix-loop/SKILL.md')) {
        return { body: { encoding: 'base64', content: Buffer.from('---\nname: issue-fix-loop\nversion: 1.4.0\n---\n').toString('base64') }, status: 200 };
      }
      return { body: [], status: 200 };
    },
    async post(_path, body) { bodies.push((body as { body: string }).body); return { body: { number: 903 }, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
    mercury: mercuryWith({
      runs: [{ id: 'run_old', createdAt: atInNight('2026-09-26') }],
      events: { run_old: [{ type: 'skill.completed', payload: { skill: 'issue-fix-loop', version: '1.2.0' } }] },
      hostVersion: '0.2.1',
    }),
  };
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.deepEqual(out.skillVersions, { hostVersion: '0.2.1', skill: 'issue-fix-loop', loaded: '1.2.0', main: '1.4.0', stale: true });
  const lines = bodies[0]!.split('\n');
  assert.ok(lines[0]!.startsWith('# nightly report'), 'the heading stays first');
  assert.ok(lines[2]!.startsWith('**Stale skills.**'), 'the staleness note is the first content line');
  assert.ok(lines[2]!.includes('1.2.0') && lines[2]!.includes('1.4.0'), 'both versions are named');
  assert.ok(lines[2]!.includes('0.2.1'), 'the host version is named');
});

test('#1024: an up-to-date or unknown version says nothing', async () => {
  const sameNight = async (mainVersion: string | undefined, loaded: string | undefined) => {
    const io: ReportIo = {
      async get(path) {
        if (path.startsWith('/search/issues?')) return { body: { items: [] }, status: 200 };
        if (path.includes('/issues/comments?since=')) return { body: [], status: 200 };
        if (path.includes('/contents/')) {
          return mainVersion === undefined
            ? { body: null, status: 404 }
            : { body: { encoding: 'base64', content: Buffer.from(`---\nversion: ${mainVersion}\n---\n`).toString('base64') }, status: 200 };
        }
        return { body: [], status: 200 };
      },
      async post() { return { body: { number: 904 }, status: 201 }; },
      async patch() { return { body: {}, status: 200 }; },
      mercury: mercuryWith({
        runs: [{ id: 'run_v', createdAt: atInNight('2026-09-26') }],
        events: loaded === undefined ? {} : { run_v: [{ type: 'skill.completed', payload: { skill: 'issue-fix-loop', version: loaded } }] },
      }),
    };
    return await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: true });
  };
  assert.equal((await sameNight('1.4.0', '1.4.0')).skillVersions!.stale, false, 'equal versions are not stale');
  assert.equal((await sameNight('1.4.0', '1.10.0')).skillVersions!.stale, false, '1.10.0 is NEWER than 1.4.0');
  assert.equal((await sameNight(undefined, '1.2.0')).skillVersions!.stale, false, 'an unreadable main is not a claim of staleness');
  assert.equal((await sameNight('1.4.0', undefined)).skillVersions, undefined, 'no loaded version: no record at all');
  assert.equal(staleSkillsNote(undefined), undefined);
});

test('#1024: compareVersions is numeric per segment, not lexical', () => {
  assert.equal(compareVersions('1.10.0', '1.4.0'), 1);
  assert.equal(compareVersions('1.4.0', '1.4.0'), 0);
  assert.equal(compareVersions('1.2.0', '1.4.0'), -1);
  assert.equal(compareVersions('1.4', '1.4.0'), 0, 'a missing segment is 0');
});

test('#1024: the loaded version is the one most Runs reported (one odd Run cannot flip it)', () => {
  const runs: NightRun[] = [
    { runId: 'a', skills: [{ skill: 'issue-fix-loop', version: '1.4.0' }] },
    { runId: 'b', skills: [{ skill: 'issue-fix-loop', version: '1.4.0' }] },
    { runId: 'c', skills: [{ skill: 'issue-fix-loop', version: '1.2.0' }] },
    { runId: 'd', skills: [{ skill: 'other', version: '9.9.9' }] },
  ];
  assert.equal(loadedSkillVersion(runs, 'issue-fix-loop'), '1.4.0');
  // A tie resolves to the OLDER version: the header exists to surface staleness, not hide it.
  assert.equal(loadedSkillVersion([
    { runId: 'a', skills: [{ skill: 'issue-fix-loop', version: '1.4.0' }] },
    { runId: 'b', skills: [{ skill: 'issue-fix-loop', version: '1.2.0' }] },
  ], 'issue-fix-loop'), '1.2.0');
});

test('#1024 review r1: the ledger is scoped to the digest\'s repository', () => {
  // The ledger is one host-wide file; a digest is per-repo. Without the filter, a host running the
  // nightly loop for two repositories publishes B's un-finished Run in A's report.
  const stateHome = tempDir('mercury-ledger-repo-');
  const env = { XDG_STATE_HOME: stateHome };
  const at = new Date(nightWindow('2026-09-26').startMs + 3_600_000);
  recordRunClaim(env, { runId: 'run_a', issue: 1, cwd: '/ws/a', repo: 'aywengo/mercury', at });
  recordRunClaim(env, { runId: 'run_b', issue: 2, cwd: '/ws/b', repo: 'aywengo/other', at });
  recordRunClaim(env, { runId: 'run_legacy', issue: 3, cwd: '/ws/c', at }); // no repo field
  assert.deepEqual(collectRunsWithoutTerminalCall(env, '2026-09-26', 'aywengo/mercury').map((r) => r.runId), ['run_a', 'run_legacy']);
  assert.deepEqual(collectRunsWithoutTerminalCall(env, '2026-09-26', 'aywengo/other').map((r) => r.runId), ['run_b', 'run_legacy']);
  // An unscoped call keeps every entry (the CLI path that predates the argument).
  assert.equal(collectRunsWithoutTerminalCall(env, '2026-09-26').length, 3);
});

test('#1024 review r1: the run scan stops at the first page older than the night window', async () => {
  // The listing is newest-first. Paging past the window would walk the host's whole history and
  // still find nothing; the scan must stop, and it must still return the in-window Run.
  const pages: string[] = [];
  const mercury: NonNullable<ReportIo['mercury']> = {
    async get(path) {
      pages.push(path);
      if (path.startsWith('/api/runs?')) {
        return {
          body: {
            runs: [
              { id: 'run_new', createdAt: atInNight('2026-09-26'), workspacePath: '/ws/new' },
              { id: 'run_old', createdAt: atInNight('2026-09-20'), workspacePath: '/ws/old' },
            ],
            nextCursor: 'more',
          },
          status: 200,
        };
      }
      return { body: { events: [], hasMore: false }, status: 200 };
    },
  };
  const runs = await scanNightRuns(mercury, '2026-09-26');
  assert.deepEqual(runs.map((r) => r.runId), ['run_new']);
  assert.equal(pages.filter((p) => p.startsWith('/api/runs?')).length, 1, 'the older page is never requested');
});

test('#1024 review r2: completion records beyond page ten are still found (the tail, not the head)', async () => {
  // The records the digest needs are the LAST events of a Run: `skill.completed` and
  // `run.unpushed_commits` are appended in the completion transaction. The endpoint caps a page at
  // 1000, so a Run with 10,500 tool events would hide them behind ten pages of history -- the exact
  // Runs a nightly produces. `lastSequence` + an `after` jump reads the tail instead.
  const filler = Array.from({ length: 10_500 }, (_, i) => ({ type: 'tool.completed', payload: { i } }));
  const mercury = mercuryWith({
    runs: [{ id: 'run_long', createdAt: atInNight('2026-09-26'), workspacePath: '/ws/long' }],
    events: {
      run_long: [
        ...filler,
        { type: 'skill.completed', payload: { skill: 'issue-fix-loop', version: '1.2.0' } },
        { type: 'run.unpushed_commits', payload: { branch: 'fix/long', commits: ['deadbeef'] } },
        { type: 'run.completed', payload: {} },
      ],
    },
  });
  const runs = await scanNightRuns(mercury, '2026-09-26');
  assert.deepEqual(runs[0]!.unpushed, { branch: 'fix/long', commits: ['deadbeef'] });
  assert.deepEqual(runs[0]!.skills, [{ skill: 'issue-fix-loop', version: '1.2.0' }]);
});

test('#1024 review r2: another repository\'s Run is not published in this digest', async () => {
  const mercury = mercuryWith({
    runs: [
      { id: 'run_here', createdAt: atInNight('2026-09-26'), workspacePath: '/ws/here', repository: { url: 'https://github.com/aywengo/mercury.git' } },
      { id: 'run_elsewhere', createdAt: atInNight('2026-09-26'), workspacePath: '/ws/elsewhere', repository: { url: 'https://github.com/aywengo/other.git' } },
      { id: 'run_unknown', createdAt: atInNight('2026-09-26'), workspacePath: '/ws/unknown' },
    ],
    events: {
      run_here: [{ type: 'run.unpushed_commits', payload: { branch: 'fix/a', commits: ['aaa'] } }],
      run_elsewhere: [{ type: 'run.unpushed_commits', payload: { branch: 'fix/b', commits: ['bbb'] } }],
      run_unknown: [{ type: 'run.unpushed_commits', payload: { branch: 'fix/c', commits: ['ccc'] } }],
    },
  });
  const runs = await scanNightRuns(mercury, '2026-09-26', { repo: 'aywengo/mercury' });
  // The other repository is dropped; an UNKNOWN identity is kept (hiding it would silently empty
  // the section on a host whose Runs carry no url).
  assert.deepEqual(runs.map((r) => r.runId), ['run_here', 'run_unknown']);
});

test('runMatchesRepo: only an identifiable URL can exclude a Run', () => {
  assert.equal(runMatchesRepo({ url: 'https://github.com/aywengo/mercury.git' }, 'aywengo/mercury'), true);
  assert.equal(runMatchesRepo({ url: 'https://github.com/aywengo/mercury' }, 'aywengo/mercury'), true);
  assert.equal(runMatchesRepo({ url: 'git@github.com:aywengo/mercury.git' }, 'aywengo/mercury'), true);
  assert.equal(runMatchesRepo({ url: 'https://github.com/aywengo/mercury.git' }, 'aywengo/other'), false);
  // A local checkout directory name does NOT establish repository identity: it can be renamed
  // (`/srv/checkouts/mercury-main` for `aywengo/mercury`). Such a Run is kept, never hidden.
  assert.equal(runMatchesRepo({ localPath: '/tmp/fixtures/mercury' }, 'aywengo/mercury'), true);
  assert.equal(runMatchesRepo({ localPath: '/srv/checkouts/mercury-main' }, 'aywengo/mercury'), true);
  assert.equal(runMatchesRepo({ localPath: '/tmp/fixtures/elsewhere' }, 'aywengo/mercury'), true);
  assert.equal(runMatchesRepo({}, 'aywengo/mercury'), true);
  assert.equal(runMatchesRepo(null, 'aywengo/mercury'), true);
  assert.equal(runMatchesRepo({ url: 'not a url' }, 'aywengo/mercury'), true);
  // A URL WINS over a localPath: an identifiable mismatch still excludes.
  assert.equal(runMatchesRepo({ url: 'https://github.com/aywengo/other.git', localPath: '/srv/mercury' }, 'aywengo/mercury'), false);
});

test('#1024 review r2: a renamed local checkout keeps both signals (a path is not an identity)', async () => {
  const mercury = mercuryWith({
    runs: [
      // The digest's repository, checked out under a directory that is not named `mercury`.
      { id: 'run_renamed', createdAt: atInNight('2026-09-26'), workspacePath: '/ws/renamed', repository: { localPath: '/srv/checkouts/mercury-main' } },
      { id: 'run_other', createdAt: atInNight('2026-09-26'), workspacePath: '/ws/other', repository: { url: 'https://github.com/aywengo/other.git' } },
    ],
    events: {
      run_renamed: [
        { type: 'skill.completed', payload: { skill: 'issue-fix-loop', version: '1.4.0' } },
        { type: 'run.unpushed_commits', payload: { branch: 'fix/x', commits: ['abc'] } },
      ],
      run_other: [{ type: 'run.unpushed_commits', payload: { branch: 'fix/y', commits: ['def'] } }],
    },
  });
  const runs = await scanNightRuns(mercury, '2026-09-26', { repo: 'aywengo/mercury' });
  assert.deepEqual(runs.map((r) => r.runId), ['run_renamed'], 'the identifiable mismatch is dropped, the renamed checkout kept');
  assert.deepEqual(runs[0]!.unpushed, { branch: 'fix/x', commits: ['abc'] });
  assert.deepEqual(runs[0]!.skills, [{ skill: 'issue-fix-loop', version: '1.4.0' }]);
});

test('#1024 review r2: the scan budget is enforced per Run and per request, not only per page', async () => {
  // Four Runs on ONE page, each event request slow enough to blow the budget: the scan must stop and
  // return what it has, because the digest Run has its own 15-minute limit and must still file.
  // Every request must also carry a timeout capped at what is left of the budget -- a fixed 30 s
  // per-request timeout cannot honour a 60 s scan budget.
  const timeouts: (number | undefined)[] = [];
  const slow: NonNullable<ReportIo['mercury']> = {
    async get(path, opts) {
      timeouts.push(opts?.timeoutMs);
      if (path.startsWith('/api/runs?')) {
        return {
          body: { runs: ['a', 'b', 'c', 'd'].map((id) => ({ id: `run_${id}`, createdAt: atInNight('2026-09-26') })) },
          status: 200,
        };
      }
      await new Promise((r) => setTimeout(r, 200)); // every event request costs 200 ms
      return { body: { events: [], lastSequence: 0 }, status: 200 };
    },
  };
  const started = Date.now();
  const runs = await scanNightRuns(slow, '2026-09-26', { budgetMs: 50 });
  const elapsed = Date.now() - started;
  assert.ok(runs.length < 4, `the budget stopped the scan early (got ${runs.length} of 4)`);
  assert.ok(runs.length >= 1, 'and it still returned the Runs it managed to read');
  assert.ok(elapsed < 2_000, `the scan did not walk every Run (${elapsed} ms)`);
  assert.ok(timeouts.every((t) => typeof t === 'number' && t > 0 && t <= 30_000),
    `every request carries a bounded timeout: ${JSON.stringify(timeouts)}`);
});

test('#1024 review r2: the version line is rendered on a CURRENT night too, not only when stale', async () => {
  const bodies: string[] = [];
  const io: ReportIo = {
    async get(path) {
      if (path.startsWith('/search/issues?')) return { body: { items: [] }, status: 200 };
      if (path.includes('/issues/comments?since=')) return { body: [], status: 200 };
      if (path.includes('/contents/')) {
        return { body: { encoding: 'base64', content: Buffer.from('---\nversion: 1.4.0\n---\n').toString('base64') }, status: 200 };
      }
      return { body: [], status: 200 };
    },
    async post(_path, body) { bodies.push((body as { body: string }).body); return { body: { number: 906 }, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
    mercury: mercuryWith({
      runs: [{ id: 'run_cur', createdAt: atInNight('2026-09-26') }],
      events: { run_cur: [{ type: 'skill.completed', payload: { skill: 'issue-fix-loop', version: '1.4.0' } }] },
      hostVersion: '0.2.2',
    }),
  };
  await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  const first = bodies[0]!.split('\n')[2]!;
  assert.ok(first.includes('host Mercury 0.2.2'), 'the host version is stated on a current night');
  assert.ok(first.includes('1.4.0'), 'and the procedure version the night loaded');
  assert.ok(!first.includes('Stale'), 'without a false staleness warning');
});

test('#1042: FAILED runs of the night are listed with their reason, not hidden behind _none_', async () => {
  // A model outage fails Runs before they open a PR, comment, or release a claim, so every other
  // section of the digest says _none_ and the night looks quiet. This section names them.
  const io: ReportIo = {
    mercury: {
      async get(path) {
        if (path.startsWith('/api/runs?status=FAILED')) {
          return {
            body: {
              runs: [
                { id: 'run_a', task: 'nightly-next 2026-09-26: take the top rung', status: 'FAILED', createdAt: '2026-09-26T00:10:00', error: '507 Cannot load GLM: projected memory 637GB would exceed the ceiling\nsecond line' },
                { id: 'run_prev', task: 'nightly-next 2026-09-25: take the top rung', status: 'FAILED', createdAt: '2026-09-25T00:10:00', error: 'yesterday' },
                { id: 'run_noerror', task: 'nightly-e2e 2026-09-26', status: 'FAILED', createdAt: '2026-09-26T00:05:00', error: null },
              ],
            },
            status: 200,
          };
        }
        return { body: [], status: 200 };
      },
    },
    async get() { return { body: [], status: 200 }; },
    async post() { return { body: { number: 900 }, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  const failed = await collectFailedRuns(io.mercury!, '2026-09-26');
  assert.deepEqual(failed.map((r) => r.runId), ['run_a', 'run_noerror'], 'only this night\'s failures');
  assert.match(failed[0]!.error ?? '', /^507 Cannot load GLM/, 'the reason is the first line only');
  assert.doesNotMatch(failed[0]!.error ?? '', /second line/);
  assert.equal(failed[1]!.error, undefined, 'a run with no error still appears, without a dash');

  const { io: ghIo, calls } = ioWith({});
  const out = await runReport({ ...ghIo, mercury: io.mercury }, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(out.runsFailed.length, 2);
  const created = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'))!;
  const body = String((created.body as { body: string }).body);
  assert.match(body, /## Runs that failed/);
  assert.match(body, /run_a/);
  assert.match(body, /507 Cannot load GLM/);
  assert.doesNotMatch(body, /run_prev/, 'another night\'s failure is not this night\'s');
});

test('#1042: a failed runs listing degrades to an empty section, like the stopped-runs scan', async () => {
  let calls = 0;
  const io: ReportIo = {
    mercury: {
      async get(path) {
        if (path.startsWith('/api/runs?')) { calls += 1; throw new Error('ECONNREFUSED'); }
        return { body: [], status: 200 };
      },
    },
    async get() { return { body: [], status: 200 }; },
    async post() { return { body: {}, status: 201 }; },
    async patch() { return { body: {}, status: 200 }; },
  };
  assert.deepEqual(await collectFailedRuns(io.mercury!, '2026-09-26'), []);
  assert.equal(calls, 1, 'one attempt, no crash');
});

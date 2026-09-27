// The morning digest (N1-4, #741): assemble the night's data, file one nightly:report issue,
// close yesterday's. All I/O injected — no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runReport, collectBlocked, collectRunsStopped, collectFlakes, blockingQuestion, defaultNight, type ReportIo } from '../.agents/skills/nightly/report.ts';
import { localDateString } from '../.agents/skills/nightly/e2e.ts';
import { tempDir } from './helpers.ts';

const REPO = 'aywengo/mercury';
const ENV = { GH_TOKEN: 'test-token' };

interface Recorded { method: string; path: string; body?: unknown }

function ioWith(opts: {
  searchItems?: Record<string, unknown[]>;
  issues?: { number: number; title: string; labels?: { name: string }[]; pull_request?: unknown }[];
  comments?: Record<number, { body: string }[]>;
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
      'is:issue commented': [{ number: 702, title: 'older issue', html_url: 'u3' }],
    },
    issues: [
      { number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] },
      { number: 501, title: 'blocked thing', labels: [{ name: 'nightly:blocked' }] },
    ],
    comments: { 501: [{ body: '**Blocking question:** Which preset wins?' }] },
  });
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
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

test('searches cover the LOCAL night as a UTC instant window (not the UTC day)', async () => {
  const { io, calls } = ioWith({});
  await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: true });
  const searches = calls.filter((c) => c.method === 'GET' && c.path.startsWith('/search/issues?')).map((c) => decodeURIComponent(c.path));
  assert.equal(searches.length, 3);
  // Expected endpoints derived the same way the implementation derives them: local midnight of
  // the night and of the next day, as ISO instants with a +00:00 offset. The window must be an
  // instant range (a UTC-day qualifier would miss the hours between local and UTC midnight).
  const toIso = (day: string): string => new Date(`${day}T00:00:00`).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  // The upper bound is one second BEFORE the next local midnight (inclusive ranges): the
  // boundary instant itself belongs to tomorrow's window only.
  const win = `${toIso('2026-09-26')}..${new Date(new Date('2026-09-27T00:00:00').getTime() - 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00')}`;
  for (const q of searches) {
    assert.ok(q.includes(`created:${win}`) || q.includes(`commented:${win}`), `local-window: ${q}`);
    assert.ok(!q.includes('created:2026-09-26&'), `no UTC-day qualifier: ${q}`);
    assert.ok(!q.includes('commented:2026-09-26&'), `no UTC-day qualifier: ${q}`);
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
      { id: 'run_a', task: 'nightly-next', status: 'TIMED_OUT', constraints: { notAfter: '2026-09-25T23:59:59.000Z' } },
      { id: 'run_b', task: 'nightly-e2e', status: 'TIMED_OUT', constraints: { notAfter: '2026-09-26T04:00:00.000Z' } },
      { id: 'run_c', task: 'nightly-next', status: 'TIMED_OUT', constraints: { notAfter: '2026-09-26T04:00:00.000Z' } },
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
      { id: 'run_p', task: 'nightly-e2e', status: 'TIMED_OUT', constraints: { notAfter: '2026-09-26T04:00:00.000Z' } },
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
          return { body: { runs: [{ id: 'run_d', task: 'x', status: 'TIMED_OUT', constraints: { notAfter: '2026-09-26T04:00:00.000Z' } }] }, status: 200 };
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
          return { body: { runs: [{ id: 'run_long', task: 'nightly-next', status: 'TIMED_OUT', constraints: { notAfter: '2026-09-26T04:00:00.000Z' } }] }, status: 200 };
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
    /no issue number/,
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
  // The scan is the bounded TAIL: page 1, then the last LAST_PAGES(3) pages [5,6,7] - never a
  // full oldest-first walk of the thread.
  assert.deepEqual(requested, [1, 5, 6, 7], 'page 1 then the bounded tail before the last page');
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

test('a concurrent same-night duplicate is reconciled: the smaller number survives', async () => {
  // Two invocations created 902 (ours) and 701 (theirs). The listing after create shows both.
  const { io: base } = ioWith({
    issues: [{ number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] }],
  });
  let createCount = 0;
  const io: ReportIo = {
    async get(path) {
      if (path.includes('labels=nightly%3Areport')) {
        // Second listing (post-create reconciliation) reveals the concurrent duplicate 701.
        if (createCount > 0) {
          return { body: [
            { number: 902, title: 'nightly report — 2026-09-26' },
            { number: 701, title: 'nightly report — 2026-09-26' },
            { number: 500, title: 'nightly report — 2026-09-25' },
          ], status: 200 };
        }
        return base.get(path);
      }
      return base.get(path);
    },
    async post() { createCount += 1; return { body: { number: 902 }, status: 201 }; },
    async patch(path) { return { body: {}, status: 200 }; },
  };
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(out.issue, 701, 'the smaller same-night number is the survivor');
  assert.equal(out.closedPrevious, 500);
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

test('a backfill never closes a NEWER report: only the immediately previous night closes', async () => {
  const { io } = ioWith({
    issues: [
      { number: 600, title: 'nightly report — 2026-09-26', labels: [{ name: 'nightly:report' }] }, // NEWER than the backfill night
      { number: 500, title: 'nightly report — 2026-09-20', labels: [{ name: 'nightly:report' }] }, // not the previous night either
    ],
  });
  const closedPaths: string[] = [];
  const backfill: ReportIo = {
    ...io,
    async post() { return { body: { number: 903 }, status: 201 }; },
    async patch(path) { closedPaths.push(path); return { body: {}, status: 200 }; },
  };
  await runReport(backfill, ENV, { repo: REPO, night: '2026-09-25', dryRun: false });
  assert.deepEqual(closedPaths, [], 'no newer or unrelated-night report is closed by a backfill');
});

test('a 2xx Mercury events response with an unparsable payload skips the run, not the digest', async () => {
  const io: ReportIo = {
    mercury: {
      async get(path) {
        if (path.startsWith('/api/runs?')) {
          return { body: { runs: [{ id: 'run_bad', task: 'x', status: 'TIMED_OUT', constraints: { notAfter: '2026-09-26T04:00:00.000Z' } }] }, status: 200 };
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

test('a LOSING invocation closes nothing (only the smallest number survives the cleanup)', async () => {
  // Our invocation created 902; the reconciliation listing shows 701 (smaller) and ours.
  const { io: base } = ioWith({
    issues: [{ number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] }],
  });
  let createCount = 0;
  const patched: number[] = [];
  const io: ReportIo = {
    async get(path) {
      if (path.includes('labels=nightly%3Areport')) {
        if (createCount > 0) {
          return { body: [
            { number: 902, title: 'nightly report — 2026-09-26' },
            { number: 701, title: 'nightly report — 2026-09-26' },
          ], status: 200 };
        }
        return base.get(path);
      }
      return base.get(path);
    },
    async post() { createCount += 1; return { body: { number: 902 }, status: 201 }; },
    async patch(path) { patched.push(Number(/issues\/(\d+)$/.exec(path)![1])); return { body: {}, status: 200 }; },
  };
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(out.issue, 701, 'the loser reports the survivor');
  assert.deepEqual(patched, [500], 'the loser closes ONLY the previous night - never its own issue or the survivor');
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

test('a CLOSED reuse candidate never wins the reconciliation; the open duplicate survives', async () => {
  const { io: base } = ioWith({
    issues: [{ number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] }],
  });
  const patched: number[] = [];
  let openGets = 0;
  const io: ReportIo = {
    async get(path) {
      if (path.includes('state=all')) {
        return { body: [{ number: 690, title: 'nightly report — 2026-09-26', state: 'closed' }], status: 200 };
      }
      if (path.includes('state=open') && !path.includes('nightly%3Ablocked')) {
        openGets += 1;
        if (openGets >= 2) {
          // Reconciliation listing: an OPEN same-night duplicate exists next to the closed reuse.
          return { body: [{ number: 701, title: 'nightly report — 2026-09-26' }], status: 200 };
        }
        return base.get(path);
      }
      return base.get(path);
    },
    async post() { throw new Error('no create expected: the closed same-night digest is reused'); },
    async patch(path) { patched.push(Number(/issues\/(\d+)$/.exec(path)![1])); return { body: {}, status: 200 }; },
  };
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(out.issue, 701, 'the OPEN duplicate is the survivor, not the closed reuse candidate');
  assert.deepEqual(patched, [500], 'only yesterday is closed here: the closed candidate stays closed and the open winner heals the rest');
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

test('a fresh issue closed before the reconciliation listing can neither win nor be closed', async () => {
  // Our POST returned 701 (fresh = open at create time), but the operator closes it before the
  // reconciliation listing runs; the listing then shows only open duplicate 702.
  const { io: base } = ioWith({
    issues: [{ number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] }],
  });
  const patched: number[] = [];
  let openGets = 0;
  const io: ReportIo = {
    async get(path) {
      if (path.includes('state=all')) return { body: [], status: 200 };
      if (path.includes('state=open') && !path.includes('nightly%3Ablocked')) {
        openGets += 1;
        if (openGets >= 2) return { body: [{ number: 702, title: 'nightly report — 2026-09-26' }], status: 200 };
        return base.get(path);
      }
      return base.get(path);
    },
    async post() { return { body: { number: 701 }, status: 201 }; },
    async patch(path) { patched.push(Number(/issues\/(\d+)$/.exec(path)![1])); return { body: {}, status: 200 }; },
  };
  const out = await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(out.issue, 702, 'the confirmed-open duplicate is the survivor');
  assert.deepEqual(patched, [500], 'the stale-closed 701 is never PATCHed and never wins Math.min');
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

test('the survivor is revalidated before and during duplicate cleanup', async () => {
  // Winner invocation: our create returned 700 (smallest); open duplicates 701 and 702.
  // Survivor GET #1 says open -> close 702 first (descending does not matter; we keep the
  // listed order but assert the abort). Survivor GET #2 says closed -> the loop must STOP:
  // 701 stays open (healed tomorrow) and the night keeps its open survivor semantics.
  const { io: base } = ioWith({
    issues: [{ number: 500, title: 'nightly report — 2026-09-25', labels: [{ name: 'nightly:report' }] }],
  });
  const patched: number[] = [];
  let survivorChecks = 0;
  const io: ReportIo = {
    async get(path) {
      if (/\/issues\/700$/.test(path)) {
        survivorChecks += 1;
        // Check #1 (before cleanup): open. Check #2 (between closes): CLOSED - abort.
        return { body: { state: survivorChecks >= 2 ? 'closed' : 'open' }, status: 200 };
      }
      if (path.includes('state=all')) return { body: [], status: 200 };
      if (path.includes('state=open') && !path.includes('nightly%3Ablocked')) {
        // closeables listing: prevNight only.
        return base.get(path);
      }
      return base.get(path);
    },
    async post() { return { body: { number: 700 }, status: 201 }; },
    async patch(path) { patched.push(Number(/issues\/(\d+)$/.exec(path)![1])); return { body: {}, status: 200 }; },
  };
  // Feed the reconciliation listing via a dedicated override layer.
  let reconAsked = false;
  const io2: ReportIo = {
    ...io,
    async get(path) {
      if (path.includes('state=open') && !path.includes('nightly%3Ablocked') && reconAsked) {
        return { body: [{ number: 700, title: 'nightly report — 2026-09-26' }, { number: 701, title: 'nightly report — 2026-09-26' }, { number: 702, title: 'nightly report — 2026-09-26' }], status: 200 };
      }
      if (path.includes('state=open') && !path.includes('nightly%3Ablocked')) {
        reconAsked = true;
        // First open GET is the closeables scan: prevNight fixture.
        return base.get(path);
      }
      return io.get(path);
    },
  };
  const out = await runReport(io2, ENV, { repo: REPO, night: '2026-09-26', dryRun: false });
  assert.equal(out.issue, 700);
  assert.ok(survivorChecks >= 2, 'the survivor was revalidated');
  // The second revalidation (before 701's PATCH) observed the survivor CLOSED: the cleanup
  // aborts with NO duplicate closed. 701/702 stay open and are healed by tomorrow's prevNight
  // close - the night never loses its digest to a stale winner.
  assert.deepEqual(patched, [500], 'only yesterday is closed; the cleanup aborted before closing any duplicate');
});

test('repo validation refuses a non owner/name value', async () => {
  const { io } = ioWith({});
  await assert.rejects(() => runReport(io, ENV, { repo: 'no-slash', night: '2026-09-26', dryRun: true }), /owner\/name/);
});

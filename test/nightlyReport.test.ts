// The morning digest (N1-4, #741): assemble the night's data, file one nightly:report issue,
// close yesterday's. All I/O injected — no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { runReport, collectBlocked, collectRunsStopped, collectFlakes, type ReportIo } from '../.agents/skills/nightly/report.ts';

const REPO = 'aywengo/mercury';
const ENV = { GH_TOKEN: 'test-token' };

interface Recorded { method: string; path: string; body?: unknown }

function ioWith(opts: {
  searchItems?: Record<string, unknown[]>;
  issues?: { number: number; title: string; labels?: { name: string }[] }[];
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
            ? [{ type: 'run.timed_out', data: { reason: 'not-after' } }]
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
      { number: 500, title: 'yesterday\'s report', labels: [{ name: 'nightly:report' }] },
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
  assert.match(body, /\[a PR\]\(u1\)/);
  assert.match(body, /## Blocked .nightly:blocked, waiting on a human./);
  assert.match(body, /Which preset wins\?/);
  assert.match(body, /## Runs stopped by notAfter/);
  assert.match(body, /## Flakes/);
  const closed = calls.filter((c) => c.method === 'PATCH');
  assert.equal(closed.length, 1);
  assert.match(closed[0]!.path, /issues\/500$/);
  assert.deepEqual((created.body as { labels: string[] }).labels, ['nightly:report']);
});

test('searches are bounded to the night window [night, night+1) (backfills stay on-date)', async () => {
  const { io, calls } = ioWith({});
  await runReport(io, ENV, { repo: REPO, night: '2026-09-26', dryRun: true });
  const searches = calls.filter((c) => c.method === 'GET' && c.path.startsWith('/search/issues?')).map((c) => decodeURIComponent(c.path));
  assert.equal(searches.length, 3);
  for (const q of searches) {
    assert.ok(q.includes('created:2026-09-26..2026-09-27') || q.includes('commented:2026-09-26..2026-09-27'), `bounded: ${q}`);
    assert.ok(!q.includes('created:>='), `no open-ended lower bound: ${q}`);
    assert.ok(!q.includes('commented:>='), `no open-ended lower bound: ${q}`);
  }
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

test('a run.timed_out event past the first events page is still found (nextCursor walk)', async () => {
  const calls: string[] = [];
  const eventsPages: Record<string, { body: unknown; status: number }> = {
    '/api/runs/run_long/events': { body: { events: Array.from({ length: 1000 }, () => ({ type: 'log', data: {} })), nextCursor: 1000, hasMore: true }, status: 200 },
    '/api/runs/run_long/events?after=1000': { body: { events: [{ type: 'run.timed_out', data: { reason: 'not-after' } }], nextCursor: 1005, hasMore: false }, status: 200 },
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
        if (/[?&]page=1(?=&|$)/.test(path)) return { body: page1, status: 200 };
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
});

test('the digest is created BEFORE yesterday\'s close (a create failure never leaves zero reports)', async () => {
  const order: string[] = [];
  const { io: base } = ioWith({
    issues: [{ number: 500, title: 'yesterday', labels: [{ name: 'nightly:report' }] }],
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
  const dir = join('/tmp', `mercury-report-test-${process.pid}-${Date.now()}`);
  try {
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
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
});

test('a 2xx create without a parseable number fails hard BEFORE closing yesterday\'s report', async () => {
  const order: string[] = [];
  const { io: base } = ioWith({
    issues: [{ number: 500, title: 'yesterday', labels: [{ name: 'nightly:report' }] }],
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
  const dir = join('/tmp', `mercury-report-test2-${process.pid}-${Date.now()}`);
  try {
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
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
});

test('repo validation refuses a non owner/name value', async () => {
  const { io } = ioWith({});
  await assert.rejects(() => runReport(io, ENV, { repo: 'no-slash', night: '2026-09-26', dryRun: true }), /owner\/name/);
});

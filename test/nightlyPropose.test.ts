// The rung-4 guarded propose exit (#881): a stable source key, a dedupe search that blocks
// creation, and a fail-closed search. All I/O injected - no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { proposeIssue, sourceMarker, findExistingProposal, type NextIo } from '../.agents/skills/nightly/next.ts';

const REPO = 'aywengo/mercury';
const KEY = 'docs/crew/roadmap.md#8-phase-4';
const TITLE = 'Crew Phase 4: per-run MCP foundation (bindings, policy registries, run-scoped redaction, temp-config lifecycle)';

interface ListItem { user?: unknown; labels?: unknown[]; created_at?: string; number: number; title?: string; body?: string; state?: string; pull_request?: unknown }
function issueShaped(over: { number: number; title?: string; body?: string; state?: string }): ListItem {
  return { user: { login: 'mercury-nightly' }, labels: [], created_at: '2026-10-01T00:00:00Z', ...over };
}

/** An io whose dedupe search serves `pages` of results, per query, with a `rel="next"` link while
 * more pages remain. `over` overrides the answer for a leg by index (0 = source, 1 = title). */
function listIo(pages: ListItem[][], over: Record<number, { status?: number; body?: unknown; link?: string | null }> = {}, created?: { status: number; body: unknown }) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const seen = new Map<string, number>();
  const io: NextIo = {
    async get(path) {
      calls.push({ method: 'GET', path });
      if (!path.startsWith('/search/issues?')) return { body: [], status: 200, link: null };
      const q = new URL(`https://api.github.com${path}`).searchParams.get('q') ?? '';
      const leg = q.includes('in:title') ? 1 : 0;
      const page = (seen.get(q) ?? 0);
      seen.set(q, page + 1);
      const o = over[leg];
      if (o && page === 0) return { body: o.body ?? null, status: o.status ?? 200, link: o.link ?? null };
      const link = page < pages.length - 1
        ? `<https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page + 2}>; rel="next"`
        : null;
      return { body: { total_count: 1, incomplete_results: false, items: pages[page] ?? [] }, status: 200, link };
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      return created ?? { body: { number: 501 }, status: 201 };
    },
    async postLabel() { return true; },
    async deleteLabel() { return true; },
  };
  return { io, calls };
}

async function bodyFile(body = 'Draft argument for the proposal.'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nightly-propose-'));
  const p = join(dir, 'body.md');
  await writeFile(p, body);
  return p;
}

test('acceptance 1: an OPEN issue carrying source key K blocks creation; exit is clean and names it', async () => {
  const existing = issueShaped({ number: 875, title: 'something else', body: `intro\n\n${sourceMarker(KEY)}\n`, state: 'open' });
  const { io, calls } = listIo([[existing]]);
  const bf = await bodyFile();
  const out = await proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf });
  assert.equal(out.created, false);
  assert.equal(out.existing?.issue, 875);
  assert.equal(out.existing?.by, 'source');
  assert.equal(out.existing?.state, 'open');
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path.endsWith('/issues')), 'no issue was created');
});

test('acceptance 2: a CLOSED source-key match also blocks (a declined proposal is not re-filed nightly)', async () => {
  const existing = issueShaped({ number: 875, title: 'x', body: sourceMarker(KEY), state: 'closed' });
  const { io, calls } = listIo([[existing]]);
  const bf = await bodyFile();
  const out = await proposeIssue(io, process.env, { repo: REPO, source: KEY, title: 'different title', bodyFile: bf });
  assert.equal(out.created, false);
  assert.equal(out.existing?.issue, 875);
  assert.equal(out.existing?.state, 'closed');
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path.endsWith('/issues')));
});

test('acceptance 3: an exact-title match without a source key (a pre-fix draft) also blocks, open and closed', async () => {
  for (const state of ['open', 'closed']) {
    const existing = issueShaped({ number: 867, title: `  ${TITLE}  `, body: 'free-shape draft, no marker', state });
    const { io, calls } = listIo([[existing]]);
    const bf = await bodyFile();
    const out = await proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf });
    assert.equal(out.created, false, `${state} title match blocks`);
    assert.equal(out.existing?.issue, 867);
    assert.equal(out.existing?.by, 'title');
    assert.ok(!calls.some((c) => c.method === 'POST' && c.path.endsWith('/issues')));
  }
});

test('acceptance 4: a capped search fails closed - it throws and files nothing', async () => {
  // 10 pages, and the 10th still carries a next link: the walk cannot prove absence.
  // 11 pages exist; the walk is capped at 10, so the 10th response still carries a next link.
  const pages = Array.from({ length: 11 }, (_, i) => [issueShaped({ number: 100 + i, title: `unrelated ${i}`, body: 'no marker' })]);
  const { io, calls } = listIo(pages);
  const bf = await bodyFile();
  await assert.rejects(
    () => proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf }),
    /cap/,
  );
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path.endsWith('/issues')), 'fail closed: nothing filed');
});

test('acceptance 4b: a failed list page fails closed and files nothing', async () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const io: NextIo = {
    async get() { return { body: { message: 'boom' }, status: 500, link: null }; },
    async post(path, body) { calls.push({ method: 'POST', path, body }); return { body: { number: 1 }, status: 201 }; },
    async postLabel() { return true; },
    async deleteLabel() { return true; },
  };
  const bf = await bodyFile();
  await assert.rejects(() => proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf }), /dedupe search failed/);
  assert.equal(calls.length, 0);
});

test('acceptance 4c: a 200 page whose body cannot be decoded fails closed and files nothing', async () => {
  // `shared.ts` answers a 200 it cannot decode with `body: null`. The scan used `?? []`, so an
  // unreadable page looked like an empty one: no match, walk over, and the duplicate gets filed.
  // The status is 200 and the Link header is absent, so nothing else in the walk can notice.
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const io: NextIo = {
    async get() { return { body: null, status: 200, link: null }; },
    async post(path, body) { calls.push({ method: 'POST', path, body }); return { body: { number: 1 }, status: 201 }; },
    async postLabel() { return true; },
    async deleteLabel() { return true; },
  };
  const bf = await bodyFile();
  await assert.rejects(
    () => proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf }),
    /without an items list/,
  );
  assert.equal(calls.length, 0, 'fail closed: nothing filed');
});

test('acceptance 4d: a 200 page carrying a JSON object body fails closed too', async () => {
  // The other shape of the same fallback: an error payload served with a 200. `?? []` handed it to
  // `for...of` and surfaced as a TypeError, which is not the same as refusing to file.
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const io: NextIo = {
    async get() { return { body: { message: 'API rate limit exceeded' }, status: 200, link: null }; },
    async post(path, body) { calls.push({ method: 'POST', path, body }); return { body: { number: 1 }, status: 201 }; },
    async postLabel() { return true; },
    async deleteLabel() { return true; },
  };
  const bf = await bodyFile();
  await assert.rejects(
    () => proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf }),
    /without an items list/,
  );
  assert.equal(calls.length, 0, 'fail closed: nothing filed');
});

test('the happy path: no match -> the issue is created with nightly:proposed and the marker in the body', async () => {
  const { io, calls } = listIo([[issueShaped({ number: 1, title: 'unrelated', body: 'no marker', state: 'open' })]]);
  const bf = await bodyFile('Argument text.');
  const out = await proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf });
  assert.equal(out.created, true);
  assert.equal(out.issue, 501);
  const create = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'));
  assert.ok(create, 'exactly one creation');
  const body = (create!.body as { body: string }).body;
  assert.ok(body.startsWith('Argument text.'), 'the drafted prose is kept');
  assert.ok(body.includes(`## Source\n\n${sourceMarker(KEY)}`), 'the source marker is appended in the required form');
  assert.deepEqual((create!.body as { labels: string[] }).labels, ['nightly:proposed']);
});

test('dedupe walks pagination: a match on a later page is still found', async () => {
  const pages = [
    [issueShaped({ number: 2, title: 'a', body: 'x' })],
    [issueShaped({ number: 3, title: 'b', body: sourceMarker(KEY) })],
  ];
  const { io } = listIo(pages);
  const bf = await bodyFile();
  const out = await proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf });
  assert.equal(out.existing?.issue, 3);
});

test('the search asks for issues only, so a pull request quoting the marker cannot block', async () => {
  // The list endpoint returned pull requests and the walk skipped them client-side. Search can
  // exclude them at the query, which is what keeps a PR that quotes a marker from blocking rung 4.
  const { io, calls } = listIo([[]]);
  const bf = await bodyFile();
  await proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf });
  const queries = calls.filter((c) => c.method === 'GET').map((c) => new URL(`https://api.github.com${c.path}`).searchParams.get('q') ?? '');
  assert.equal(queries.length, 2, 'one query per leg');
  for (const q of queries) assert.match(q, /(^| )is:issue( |$)/, `every leg is issue-only: ${q}`);
});

test('input validation: bad source key, empty body file, empty title all refuse', async () => {
  const { io } = listIo([[]]);
  const bf = await bodyFile();
  await assert.rejects(() => proposeIssue(io, process.env, { repo: REPO, source: 'no-anchor', title: TITLE, bodyFile: bf }), /heading anchor/);
  await assert.rejects(() => proposeIssue(io, process.env, { repo: REPO, source: 'a b#c', title: TITLE, bodyFile: bf }), /single token/);
  await assert.rejects(() => proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: join(bf, 'missing.md') }));
  const empty = await bodyFile('   \n');
  await assert.rejects(() => proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: empty }), /empty/);
  await assert.rejects(() => proposeIssue(io, process.env, { repo: REPO, source: KEY, title: '   ', bodyFile: bf }), /non-empty --title/);
  await assert.rejects(() => proposeIssue(io, process.env, { repo: 'bad-repo', source: KEY, title: TITLE, bodyFile: bf }));
});

test('a body that already carries the marker is not double-marked; findExistingProposal is exported for the report', async () => {
  const bf = await bodyFile(`Draft.\n\n## Source\n\n${sourceMarker(KEY)}\n`);
  const { io, calls } = listIo([[]]);
  await proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf });
  const create = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'))!;
  assert.equal((create.body as { body: string }).body.split(sourceMarker(KEY)).length - 1, 1);
  const none = await findExistingProposal(io, { repo: REPO, source: KEY, title: TITLE });
  assert.equal(none, null);
});

test('#1018: a match is found with ONE query, however large the repository has grown', async () => {
  // The regression: the old dedupe walked /issues in pages of 100 and refused past 10 pages, so at
  // ~1017 issues+pull requests it could no longer prove absence and rung 4 filed nothing at all.
  // The search answers the same question with a bound repository growth cannot reach, so a match
  // costs one request -- not eleven.
  const existing = issueShaped({ number: 1100, title: 'filed long after the old window', body: `x\n\n${sourceMarker(KEY)}\n`, state: 'closed' });
  const { io, calls } = listIo([[existing]]);
  const bf = await bodyFile();
  const out = await proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf });
  assert.equal(out.created, false);
  assert.equal(out.existing?.issue, 1100);
  assert.equal(out.existing?.by, 'source');
  assert.equal(calls.filter((c) => c.method === 'GET').length, 1, 'the source leg answered on its first page');
});

test('#1018: an incomplete search answer fails closed - a partial miss proves nothing', async () => {
  // `incomplete_results: true` is GitHub saying it timed out and the list is partial. Filing on it
  // would recreate exactly the duplicate #881 exists to prevent.
  const { io, calls } = listIo([[issueShaped({ number: 1, title: 'x', body: 'no marker' })]], { 0: { body: { total_count: 0, incomplete_results: true, items: [] } } });
  const bf = await bodyFile();
  await assert.rejects(
    () => proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf }),
    /incomplete/,
  );
  assert.ok(!calls.some((c) => c.method === 'POST'), 'fail closed: nothing filed');
});

test('#1018: a search whose items cannot be read fails closed too', async () => {
  const { io, calls } = listIo([[]], { 0: { body: { message: 'API rate limit exceeded' } } });
  const bf = await bodyFile();
  await assert.rejects(
    () => proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf }),
    /without an items list/,
  );
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

test('#1053: the title leg queries TERMS, so punctuation cannot make an existing title unfindable', async () => {
  // Measured on #954: `in:title "<exact title>"` returned total_count 0, because GitHub search is
  // token-based and the title carries §, — and :. The old phrase query read as "not filed yet" and
  // rung 4 would have filed a duplicate. The query is now the title's terms, ANDed.
  const punctuated = 'Credential profiles: the three §15 open questions are live — decide the default (docs/credential-profiles-design.md §15)';
  const existing = issueShaped({ number: 954, title: punctuated, body: 'no marker here', state: 'open' });
  const { io, calls } = listIo([[existing]]);
  const bf = await bodyFile();
  const out = await proposeIssue(io, process.env, { repo: REPO, source: KEY, title: punctuated, bodyFile: bf });
  assert.equal(out.created, false, 'an exact title must block, punctuation or not');
  assert.equal(out.existing?.issue, 954);
  assert.equal(out.existing?.by, 'title');
  const q = calls.filter((c) => c.method === 'GET').map((c) => new URL(`https://api.github.com${c.path}`).searchParams.get('q') ?? '');
  const titleQ = q.find((x) => x.includes('in:title')) ?? '';
  assert.doesNotMatch(titleQ, /"/, `the title leg must not quote the phrase: ${titleQ}`);
  assert.match(titleQ, /in:title credential profiles the three 15 open questions/, 'alphanumeric terms, lowercased');
});

test('#1053: the source leg queries the KEY, not the marker, and still compares the marker exactly', async () => {
  // `"<!-- nightly-source:k -->"` is a phrase GitHub cannot match: the angle brackets and colons are
  // stripped, and the remaining terms do not have to be adjacent to the real marker.
  const { io, calls } = listIo([[issueShaped({ number: 7, title: 'x', body: 'no marker' })]]);
  const bf = await bodyFile();
  const out = await proposeIssue(io, process.env, { repo: REPO, source: KEY, title: TITLE, bodyFile: bf });
  assert.equal(out.created, true, 'a search hit whose body lacks the marker must not block');
  const q = calls.filter((c) => c.method === 'GET').map((c) => new URL(`https://api.github.com${c.path}`).searchParams.get('q') ?? '');
  assert.ok(q.some((x) => x.includes(`"${KEY}"`)), `the source leg must query the key: ${q.join(' | ')}`);
  assert.ok(!q.some((x) => x.includes('nightly-source')), 'the marker phrase must not be sent to search');
});

test('#1053: titleTerms stays inside the 256-character query budget', async () => {
  const { titleTerms } = await import('../.agents/skills/nightly/next.ts');
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  assert.ok(titleTerms(long).length <= 200);
  assert.ok(`repo:aywengo/mercury is:issue in:title ${titleTerms(long)}`.length <= 256);
  assert.equal(titleTerms('  Crew Phase 4: per-run MCP  '), 'crew phase 4 per run mcp');
});

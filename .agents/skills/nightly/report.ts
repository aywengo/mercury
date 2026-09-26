/**
 * `nightly/report.ts` — the morning digest (N1-4, #741).
 *
 * One GitHub issue per night, labeled `nightly:report`, closed by the next night's report:
 *
 *   - PRs opened tonight and issues filed tonight (GitHub search, repo-scoped, bounded).
 *   - Issues commented on tonight (search `commented:>=NIGHT`, bounded).
 *   - Blocked items: open issues labeled `nightly:blocked` with their latest blocking question.
 *   - Runs stopped by `notAfter` (the §4.3 window end) — optional section, only when
 *     `MERCURY_REPORT_API_URL` + `MERCURY_REPORT_TOKEN` are set; the Mercury runs API is read
 *     for TIMED_OUT runs and their `run.timed_out` reason event.
 *   - Flakes: the nightly-e2e flake clock (same state file) — recent fingerprint nights.
 *
 * Output: exactly one JSON line
 * `{ night, issue, closedPrevious, prs, issuesFiled, issuesCommented, blocked, runsStopped, flakes }`.
 * No dependencies; all I/O injectable. Everything is read-only except the digest issue itself.
 */

import { basename } from 'node:path';
import { loadFlakeState } from './e2e.ts';

const L_REPORT = 'nightly:report';
const L_BLOCKED = 'nightly:blocked';
const L_IN_PROGRESS = 'nightly:in-progress';
const SEARCH_PER_PAGE = 100;
const SEARCH_CAP = 10; // pages of 100 = 1000 hits, bounded

export interface ReportIo {
  get(path: string): Promise<{ body: unknown; status: number; link?: string | null }>;
  post(path: string, body: unknown): Promise<{ body: unknown; status: number }>;
  /** PATCH (issue close) — separate so tests can record it distinctly. */
  patch(path: string, body: unknown): Promise<{ body: unknown; status: number }>;
  /** Mercury runs API (optional source). */
  mercury?: {
    get(path: string): Promise<{ body: unknown; status: number }>;
  };
}

export interface ReportData {
  prs: { number?: number; title: string; url?: string }[];
  issuesFiled: { number?: number; title: string; url?: string; author?: string }[];
  issuesCommented: { number?: number; title: string; url?: string }[];
  blocked: { number?: number; title: string; question?: string }[];
  runsStopped: { runId?: string; task?: string; status?: string }[];
  flakes: { fingerprint: string; test: string; nights: string[] }[];
}

export interface ReportResult extends ReportData {
  night: string;
  issue?: number;
  closedPrevious?: number;
}

function assertRepo(repo: string): void {
  // Mirrors select.ts's validation exactly (same authority, same env).
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`repo must be exactly owner/name (e.g. aywengo/mercury); got '${repo}'`);
  }
}

async function search(io: ReportIo, repo: string, query: string): Promise<{ number?: number; title: string; url?: string; author?: string }[]> {
  const out: { number?: number; title: string; url?: string; author?: string }[] = [];
  for (let page = 1; page <= SEARCH_CAP; page++) {
    const path = `/search/issues?q=${encodeURIComponent(`repo:${repo} ${query}`)}&per_page=${SEARCH_PER_PAGE}&page=${page}`;
    const res = await io.get(path);
    if (res.status < 200 || res.status >= 300) throw new Error(`GET ${path} -> ${res.status}`);
    const items = ((res.body as { items?: { number?: number; title?: string; html_url?: string; user?: { login?: string } }[] }).items ?? []);
    for (const it of items) {
      out.push({ number: it.number, title: it.title ?? '', url: it.html_url, ...(it.user?.login ? { author: it.user.login } : {}) });
    }
    if (items.length < SEARCH_PER_PAGE) break;
  }
  return out;
}

/** Open issues labeled nightly:blocked, each with the latest comment as the question. */
export async function collectBlocked(io: ReportIo, repo: string): Promise<{ number?: number; title: string; question?: string }[]> {
  const out: { number?: number; title: string; question?: string }[] = [];
  for (let page = 1; page <= SEARCH_CAP; page++) {
    const path = `/repos/${repo}/issues?labels=${encodeURIComponent(L_BLOCKED)}&state=open&per_page=100&page=${page}`;
    const res = await io.get(path);
    if (res.status < 200 || res.status >= 300) throw new Error(`GET ${path} -> ${res.status}`);
    const issues = (res.body as { number?: number; title?: string }[] | null) ?? [];
    for (const issue of issues) {
      if (issue.number === undefined) continue;
      let question: string | undefined;
      const cRes = await io.get(`/repos/${repo}/issues/${issue.number}/comments?per_page=100`);
      if (cRes.status >= 200 && cRes.status < 300) {
        const comments = (cRes.body as { body?: string }[] | null) ?? [];
        const last = comments[comments.length - 1];
        if (last?.body) question = last.body.split('\n').find((l) => l.startsWith('**Blocking question:**'))?.replace(/^\*\*Blocking question:\*\*\s*/, '') ?? last.body.slice(0, 200);
      }
      out.push({ number: issue.number, title: issue.title ?? '', question });
    }
    if (issues.length < 100) break;
  }
  return out;
}

/** TIMED_OUT runs whose run.timed_out reason event says 'not-after' (the §4.3 window end). */
export async function collectRunsStopped(mercury: NonNullable<ReportIo['mercury']>): Promise<{ runId?: string; task?: string; status?: string }[]> {
  const out: { runId?: string; task?: string; status?: string }[] = [];
  const res = await mercury.get('/api/runs?status=TIMED_OUT&limit=200');
  if (res.status < 200 || res.status >= 300) throw new Error(`Mercury GET /api/runs -> ${res.status}`);
  const runs = (res.body as { runs?: { id?: string; task?: string; status?: string }[] }).runs ?? [];
  for (const run of runs) {
    if (!run.id) continue;
    const evRes = await mercury.get(`/api/runs/${run.id}/events`);
    if (evRes.status < 200 || evRes.status >= 300) continue; // unreadable events: skip, do not fail the digest
    const events = (evRes.body as { events?: { type?: string; data?: { reason?: string } }[] }).events ?? [];
    const timedOut = events.some((e) => e.type === 'run.timed_out' && e.data?.reason === 'not-after');
    if (timedOut) out.push({ runId: run.id, task: run.task, status: run.status });
  }
  return out;
}

/** Flake-clock entries, most recent night first. */
export function collectFlakes(env: NodeJS.ProcessEnv, night: string): { fingerprint: string; test: string; nights: string[] }[] {
  const state = loadFlakeState(env);
  return Object.entries(state)
    .map(([fingerprint, entry]) => ({ fingerprint, test: entry.test, nights: entry.nights }))
    .filter((f) => f.nights.some((n) => n <= night)) // anything recorded so far
    .sort((a, b) => (b.nights[b.nights.length - 1] ?? '').localeCompare(a.nights[a.nights.length - 1] ?? ''));
}

function digestBody(night: string, data: ReportData, note?: string): string {
  const lines: string[] = [`# nightly report — ${night}`, ''];
  if (note) lines.push(`_${note}_`, '');
  const list = (items: { title: string; url?: string; number?: number }[], empty: string): string =>
    items.length === 0 ? empty : items.map((it) => `- ${it.url ? `[${it.title ?? it.number}](${it.url})` : (it.title ?? it.number)}`).join('\n');
  lines.push('## PRs opened', list(data.prs, '_none_'), '');
  lines.push('## Issues filed', list(data.issuesFiled, '_none_'), '');
  lines.push('## Issues commented', list(data.issuesCommented, '_none_'), '');
  lines.push('## Blocked (nightly:blocked, waiting on a human)',
    data.blocked.length === 0 ? '_none_' : data.blocked.map((b) => `- #${b.number} ${b.title}${b.question ? ` — question: ${b.question}` : ''}`).join('\n'), '');
  lines.push('## Runs stopped by notAfter (the 06:00 window end)',
    data.runsStopped.length === 0 ? '_none_' : data.runsStopped.map((r) => `- \`${r.runId}\` — ${(r.task ?? '').slice(0, 120)}`).join('\n'), '');
  lines.push('## Flakes (nightly-e2e clock)',
    data.flakes.length === 0 ? '_none_' : data.flakes.map((f) => `- \`${f.fingerprint}\` ${f.test} — nights: ${f.nights.join(', ')}`).join('\n'), '');
  lines.push('---', '_Closed by tomorrow night\'s report._');
  return lines.join('\n');
}

/** Assemble the digest (all reads), file the issue, close yesterday's. */
export async function runReport(
  io: ReportIo,
  env: NodeJS.ProcessEnv,
  opts: { repo: string; night: string; dryRun: boolean },
): Promise<ReportResult> {
  assertRepo(opts.repo);
  const prs = await search(io, opts.repo, 'is:pr created:>=' + opts.night);
  const issuesFiled = await search(io, opts.repo, 'is:issue created:>=' + opts.night);
  const issuesCommented = await search(io, opts.repo, 'is:issue commented:>=' + opts.night);
  const blocked = await collectBlocked(io, opts.repo);
  const runsStopped = io.mercury ? await collectRunsStopped(io.mercury) : [];
  const flakes = collectFlakes(env, opts.night);
  const data: ReportData = { prs, issuesFiled, issuesCommented, blocked, runsStopped, flakes };

  if (opts.dryRun) {
    return { night: opts.night, ...data };
  }

  // Close the PREVIOUS open nightly:report issue (there should be exactly one; close all found).
  let closedPrevious: number | undefined;
  for (let page = 1; page <= SEARCH_CAP; page++) {
    const path = `/repos/${opts.repo}/issues?labels=${encodeURIComponent(L_REPORT)}&state=open&per_page=100&page=${page}`;
    const res = await io.get(path);
    if (res.status < 200 || res.status >= 300) throw new Error(`GET ${path} -> ${res.status}`);
    const prev = (res.body as { number?: number }[] | null) ?? [];
    for (const issue of prev) {
      if (issue.number === undefined) continue;
      await io.patch(`/repos/${opts.repo}/issues/${issue.number}`, { state: 'closed' });
      closedPrevious = closedPrevious ?? issue.number;
    }
    if (prev.length < 100) break;
  }

  const body = digestBody(opts.night, data);
  const created = await io.post(`/repos/${opts.repo}/issues`, {
    title: `nightly report — ${opts.night}`,
    body,
    labels: [L_REPORT],
  });
  if (created.status < 200 || created.status >= 300) {
    throw new Error(`digest issue create failed: POST /repos/${opts.repo}/issues -> ${created.status}`);
  }
  const issue = (created.body as { number?: number }).number;
  return { night: opts.night, ...(issue !== undefined ? { issue } : {}), ...(closedPrevious !== undefined ? { closedPrevious } : {}), ...data };
}

// ---- CLI ----

function ghToken(env: NodeJS.ProcessEnv): string {
  const tok = env.GH_TOKEN || env.GITHUB_TOKEN || '';
  if (!tok) throw new Error('GH_TOKEN (or GITHUB_TOKEN) is required: the report files and closes issues');
  return tok;
}

const FETCH_TIMEOUT_MS = 30_000;

async function ghGet(path: string, token: string): Promise<{ body: unknown; status: number; link?: string | null }> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { body: await res.json().catch(() => null), status: res.status, link: res.headers.get('link') };
}

async function ghPost(path: string, body: unknown, token: string): Promise<{ body: unknown; status: number }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { body: await res.json().catch(() => null), status: res.status };
}

async function ghPatch(path: string, body: unknown, token: string): Promise<{ body: unknown; status: number }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { body: await res.json().catch(() => null), status: res.status };
}

function mercuryFromEnv(env: NodeJS.ProcessEnv): ReportIo['mercury'] | undefined {
  const url = env.MERCURY_REPORT_API_URL;
  const token = env.MERCURY_REPORT_TOKEN;
  if (!url || !token) return undefined; // the section is omitted, not faked
  return {
    get: async (path) => {
      const res = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return { body: await res.json().catch(() => null), status: res.status };
    },
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const repo = flag('--repo') ?? process.env.REPO ?? '';
  const night = flag('--night') ?? new Date().toISOString().slice(0, 10);
  const dryRun = args.includes('--dry-run');
  runReport(
    {
      get: async (path) => await ghGet(path, ghToken(process.env)),
      post: async (path, body) => await ghPost(path, body, ghToken(process.env)),
      patch: async (path, body) => await ghPatch(path, body, ghToken(process.env)),
      mercury: mercuryFromEnv(process.env),
    },
    process.env,
    { repo, night, dryRun },
  )
    .then((out) => { process.stdout.write(JSON.stringify(out) + '\n'); })
    .catch((e: unknown) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    });
}

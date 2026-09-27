/**
 * `nightly/report.ts` — the morning digest (N1-4, #741).
 *
 * One GitHub issue per night, labeled `nightly:report`, closed by the next night's report:
 *
 *   - PRs opened tonight and issues filed tonight (GitHub search, repo-scoped, bounded).
 *   - Issues commented on tonight (candidates from the supported `updated:<range>` search,
 *     filtered by per-issue comment timestamps - GitHub search has no `commented:<range>`).
 *   - Blocked items: open issues labeled `nightly:blocked` with their latest blocking question.
 *   - Runs stopped by `notAfter` (the §4.3 window end 06:00 local) — optional section, only when
 *     `MERCURY_REPORT_API_URL` + `MERCURY_REPORT_TOKEN` are set; the Mercury runs API is read
 *     for TIMED_OUT runs and their `run.timed_out` reason event.
 *   - Flakes: the nightly-e2e flake clock (same state file) — recent fingerprint nights.
 *
 * Output: exactly one JSON line
 * `{ night, issue, closedPrevious, prs, issuesFiled, issuesCommented, blocked, runsStopped, flakes }`.
 * No dependencies; all I/O injectable. Writes: the digest issue itself and the close of
 * every OPEN digest titled `nightly report — D` with D strictly BEFORE the report night - one
 * rule that self-heals failed closes on any later night and can never erase a newer report.
 * Same-night duplicates from a racing retry heal the next night (their day turns older).
 * Single-writer scheduling (one report fire per night) is Mercury's job, enforced by the bot
 * config's singleFlight, not here.
 */

import { basename } from 'node:path';
import { loadFlakeState } from './e2e.ts';
import { assertRepo, localDateString, nextDay, prevDay, ghGet, ghPost, ghPatch, ghToken, FETCH_TIMEOUT_MS } from './shared.ts';

const L_REPORT = 'nightly:report';
const L_BLOCKED = 'nightly:blocked';
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

/** A real YYYY-MM-DD: format check AND calendar round-trip (2026-02-30 normalizes to March 2,
 * which would title one night while searching another). */
function assertNight(night: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(night)) {
    throw new Error(`night must be YYYY-MM-DD; got '${night}'`);
  }
  const roundTrip = `${new Date(`${night}T12:00:00Z`).getUTCFullYear()}-${String(new Date(`${night}T12:00:00Z`).getUTCMonth() + 1).padStart(2, '0')}-${String(new Date(`${night}T12:00:00Z`).getUTCDate()).padStart(2, '0')}`;
  if (roundTrip !== night) {
    throw new Error(`night is not a real calendar date: '${night}'`);
  }
}

async function search(io: ReportIo, repo: string, query: string): Promise<{ number?: number; title: string; url?: string; author?: string }[]> {
  const out: { number?: number; title: string; url?: string; author?: string }[] = [];
  for (let page = 1; page <= SEARCH_CAP; page++) {
    const path = `/search/issues?q=${encodeURIComponent(`repo:${repo} ${query}`)}&per_page=${SEARCH_PER_PAGE}&page=${page}`;
    const res = await io.get(path);
    if (res.status < 200 || res.status >= 300) throw new Error(`GET ${path} -> ${res.status}`);
    // A 2xx with an unexpected payload (parse failure -> null, rate-limit JSON, ...) must fail
    // with a targeted error, not a TypeError deep in the loop.
    const body = res.body as { items?: { number?: number; title?: string; html_url?: string; user?: { login?: string } }[] } | null;
    if (body === null || typeof body !== 'object' || !Array.isArray(body.items)) {
      throw new Error(`GET ${path} -> 2xx with an unexpected body (expected {items: [...]})`);
    }
    const items = body.items;
    for (const it of items) {
      out.push({ number: it.number, title: it.title ?? '', url: it.html_url, ...(it.user?.login ? { author: it.user.login } : {}) });
    }
    if (items.length < SEARCH_PER_PAGE) break;
  }
  return out;
}

/** Open issues labeled nightly:blocked, each with its blocking question: the issue BODY marker
 * first (nightly-filed issues carry it from the blocked exit, #770 - zero extra requests), then
 * the most recent **Blocking question:** comment marker, then the last comment. */
export async function collectBlocked(io: ReportIo, repo: string): Promise<{ number?: number; title: string; question?: string }[]> {
  const out: { number?: number; title: string; question?: string }[] = [];
  for (let page = 1; page <= SEARCH_CAP; page++) {
    const path = `/repos/${repo}/issues?labels=${encodeURIComponent(L_BLOCKED)}&state=open&per_page=100&page=${page}`;
    const res = await io.get(path);
    if (res.status < 200 || res.status >= 300) throw new Error(`GET ${path} -> ${res.status}`);
    // A 2xx with an unparsable payload (parse failure -> null) must not silently read as ZERO
    // blocked issues; that would hide real blockers from the digest. Targeted error instead.
    const issues = res.body as { number?: number; title?: string; body?: string; pull_request?: unknown }[] | null;
    if (!Array.isArray(issues)) {
      throw new Error(`GET ${path} -> 2xx with an unexpected body (expected an issue array)`);
    }
    for (const issue of issues) {
      if (issue.pull_request !== undefined) continue; // the issues listing includes PRs
      if (issue.number === undefined) continue;
      // The body marker is free (the listing already returned the body): try it BEFORE any
      // comment request. Unreadable/absent body falls through to the comment scan.
      const fromBody = typeof issue.body === 'string' ? questionFromBody(issue.body) : undefined;
      const question = fromBody ?? await blockingQuestion(io, repo, issue.number);
      out.push({ number: issue.number, title: issue.title ?? '', ...(question !== undefined ? { question } : {}) });
    }
    if (issues.length < 100) break;
  }
  return out;
}

/** The trailing invisible marker the nightly blocked exit appends to nightly-filed issue bodies:
 * `<!-- nightly:blocking-question\n<reason>\n-->` (#770). Returns the reason verbatim (single
 * line - the blocked exit trims the reason), or undefined when the body carries no marker. */
export function questionFromBody(body: string): string | undefined {
  const m = /<!-- nightly:blocking-question\n([\s\S]*?)-->\s*$/.exec(body);
  if (!m) return undefined;
  const reason = m[1]!.trim();
  return reason === '' ? undefined : reason;
}

/** The blocking question for an issue from its COMMENTS: walk the comment pages (bounded) and
 * take the LAST `**Blocking question:**` marker - the most recent blocked exit. If no marker
 * exists (a hand-labeled blocked issue), fall back to the last comment body, truncated.
 * Only reached when the issue BODY carried no nightly marker (collectBlocked checks that first,
 * #770). Exported for tests. */
export async function blockingQuestion(io: ReportIo, repo: string, issue: number): Promise<string | undefined> {
  // The blocking question is written by OUR nightly-next skill, so page 1 plus the Link-header
  // LAST page is enough - no multi-page walk. (Longer term the question moves to the issue
  // body; see the follow-up issue.)
  let question: string | undefined;
  let lastComment: string | undefined; // body of the newest comment seen so far (fallback)
  const res1 = await io.get(`/repos/${repo}/issues/${issue}/comments?per_page=100&page=1`);
  if (res1.status < 200 || res1.status >= 300) return undefined; // unreadable comments: leave the question unset
  const scanPage = (res: { body: unknown; status: number }): void => {
    if (res.status < 200 || res.status >= 300) return; // unreadable page: scan what we have
    // Same shape validation as every other list response: a 2xx non-array (proxy error page,
    // JSON object) makes the question unreadable, it must not crash the digest.
    const comments = Array.isArray(res.body)
      ? (res.body as { body: string }[]).filter((c): c is { body: string } =>
          c !== null && typeof c === 'object' && typeof (c as { body?: unknown }).body === 'string')
      : [];
    for (const c of comments) {
      if (!c.body) continue;
      const marker = c.body.split('\n').find((l) => l.startsWith('**Blocking question:**'));
      if (marker) question = marker.replace(/^\*\*Blocking question:\*\*\s*/, '');
    }
    if (comments.length > 0 && question === undefined) {
      lastComment = comments[comments.length - 1]?.body;
    }
  };
  scanPage(res1);
  const lastRel = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(res1.link ?? '');
  const parsed = lastRel ? Number(lastRel[1]) : 1;
  const lastPage = Number.isInteger(parsed) && parsed >= 2 ? parsed : 0;
  if (lastPage >= 2) {
    const res = await io.get(`/repos/${repo}/issues/${issue}/comments?per_page=100&page=${lastPage}`);
    scanPage(res);
  }
  if (question === undefined && lastComment !== undefined) question = lastComment.slice(0, 200);
  return question;
}


/** Issues from `candidates` that received a comment DURING the night window [startMs, endMs]:
 * reads each candidate's comments (page 1, newest-first is not guaranteed - scan the page),
 * bounded per issue. An unreadable comment page skips that candidate (best-effort, same policy
 * as the other reads). GitHub search cannot filter by commented:<range> (unsupported), so the
 * updated:<range> candidate set is filtered here.
 */
export async function collectIssuesCommented(
  io: ReportIo,
  repo: string,
  candidates: { number?: number; title: string; url?: string }[],
  startMs: number,
  endMs: number,
): Promise<{ number?: number; title: string; url?: string }[]> {
  // ONE repo-level listing replaces per-candidate comment fetches:
  // GET /repos/{o}/{r}/issues/comments?since=<startIso> returns every comment on every issue
  // created at/after the window start. Filter to the window end here, collect the distinct
  // issue numbers, and intersect with the `updated:<range>` search candidates (which carry
  // title/url). Bounded at 10 pages of 100 = 1000 comments per night.
  const commentedNumbers = new Set<number>();
  let path: string | undefined = `/repos/${repo}/issues/comments?since=${encodeURIComponent(new Date(startMs).toISOString())}&per_page=100`;
  for (let page = 0; page < 10 && path; page++) {
    let res;
    try {
      res = await io.get(path);
    } catch {
      break; // transport error: keep what was scanned, do not fail the digest
    }
    if (res.status < 200 || res.status >= 300) break; // unreadable: section degrades, same policy as the other reads
    const comments = Array.isArray(res.body)
      ? (res.body as { body?: unknown; created_at?: unknown; issue_url?: unknown }[]).filter(
          (c): c is { created_at: string; issue_url: string } =>
            c !== null && typeof c === 'object' && typeof c.created_at === 'string' && typeof c.issue_url === 'string')
      : [];
    for (const c of comments) {
      const ts = Date.parse(c.created_at);
      if (Number.isNaN(ts) || ts < startMs || ts > endMs) continue;
      const m = /\/issues\/(\d+)$/.exec(c.issue_url);
      if (m) commentedNumbers.add(Number(m[1]));
    }
    if (comments.length < 100) break; // short page = last page
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.link ?? '');
    path = next ? next[1].replace('https://api.github.com', '') : undefined;
  }
  return candidates.filter((c) => c.number !== undefined && commentedNumbers.has(c.number));
}


/** TIMED_OUT runs stopped by the §4.3 window end DURING the report night: cursor-paginated
 * (bounded), each candidate filtered by its constraints.notAfter falling on the report night's
 * local date before the events fetch (a backfill must not show other nights' stops). */
export async function collectRunsStopped(mercury: NonNullable<ReportIo['mercury']>, night: string): Promise<{ runId?: string; task?: string; status?: string }[]> {
  const out: { runId?: string; task?: string; status?: string }[] = [];
  let path: string | undefined = '/api/runs?status=TIMED_OUT&limit=100';
  for (let page = 0; page < 10 && path; page++) {
    let res: Awaited<ReturnType<typeof mercury.get>>;
    try {
      res = await mercury.get(path);
    } catch {
      // Transport errors (fetch timeout/connection reset) are the same best-effort case as a
      // failing status: end the scan and return what was collected so far.
      return out;
    }
    if (res.status < 200 || res.status >= 300) {
      // The Mercury section is optional/best-effort: a failing runs listing ends the scan and
      // returns what was collected so far (an empty list on a first-page failure) instead of
      // failing the whole digest - same policy as unreadable per-run events.
      return out;
    }
    const body = res.body as { runs?: { id?: string; task?: string; status?: string; constraints?: { notAfter?: string } }[]; nextCursor?: string } | null;
    if (body === null || typeof body !== 'object' || !Array.isArray(body.runs)) {
      // A 2xx with an unparsable payload (proxy error page, invalid JSON -> null) is an
      // unreadable listing: degrade to the partial result, do not fail the digest.
      return out;
    }
    const runs = body.runs;
    for (const run of runs) {
      if (!run.id) continue;
      // notAfter must land on the report night. Cheap pre-filter before the per-run events
      // fetch; the comparison itself is local-date based (see below).
      const notAfter = run.constraints?.notAfter;
      // Compare the notAfter instant's LOCAL calendar date to the night (the night is a local
      // date; slicing the ISO string would compare the UTC date and drop runs whose 06:00 local
      // deadline lands on the next/previous UTC day). Unparsable instants are skipped.
      if (!notAfter) continue;
      const notAfterDate = new Date(notAfter);
      if (Number.isNaN(notAfterDate.getTime()) || localDateString(notAfterDate) !== night) continue;
      // The events endpoint caps a page at 1000: scan forward via nextCursor (bounded) so the
      // terminal run.timed_out event is observed even on long runs.
      let evPath: string | undefined = `/api/runs/${run.id}/events`;
      let timedOut = false;
      let evPages = 0;
      while (evPath && evPages < 10 && !timedOut) {
        let evRes: Awaited<ReturnType<typeof mercury.get>>;
        try {
          evRes = await mercury.get(evPath);
        } catch {
          break; // transport error on this run's events: skip the run, do not fail the digest
        }
        if (evRes.status < 200 || evRes.status >= 300) break; // unreadable events: skip, do not fail the digest
        // The API returns MercuryEvent objects: the reason lives in `payload` (the worker
        // appends run.timed_out with payload { runId, reason }).
        const evBody = evRes.body as { events?: { type?: string; payload?: { reason?: string } }[]; nextCursor?: number; hasMore?: boolean } | null;
        if (evBody === null || typeof evBody !== 'object' || !Array.isArray(evBody.events)) {
          break; // unparsable events page: skip this run, do not fail the digest
        }
        const events = evBody.events;
        timedOut = events.some((e) => e.type === 'run.timed_out' && e.payload?.reason === 'not-after');
        evPages += 1;
        evPath = evBody.hasMore && evBody.nextCursor !== undefined && events.length > 0
          ? `/api/runs/${run.id}/events?after=${evBody.nextCursor}`
          : undefined;
      }
      if (timedOut) out.push({ runId: run.id, task: run.task, status: run.status });
    }
    path = body.nextCursor ? `/api/runs?status=TIMED_OUT&limit=100&cursor=${encodeURIComponent(body.nextCursor)}` : undefined;
  }
  return out;
}

/** The most recent night in a (possibly unsorted, e.g. after a backfill) night list. */
function newestNight(nights: string[]): string {
  return nights.reduce((acc, n) => (n > acc ? n : acc), nights[0] ?? '');
}

/** Flake-clock entries as of `night`: only nights <= the report night (a backfill run with an
 * older --night must not display future dates), most recent last-night first. */
export function collectFlakes(env: NodeJS.ProcessEnv, night: string): { fingerprint: string; test: string; nights: string[] }[] {
  const state = loadFlakeState(env);
  return Object.entries(state)
    .map(([fingerprint, entry]) => ({ fingerprint, test: entry.test, nights: entry.nights.filter((n) => n <= night) }))
    .filter((f) => f.nights.length > 0)
    // recordFlakeNight APPENDS, so a backfill can leave nights unsorted: the sort key must be
    // the MAX of the filtered nights, not the last stored element.
    .sort((a, b) => newestNight(b.nights).localeCompare(newestNight(a.nights)));
}

/** Escape Markdown-significant characters in user-controlled text (titles, questions) so a
 * crafted title cannot inject links/images into the digest. */
function escMd(text: string): string {
  return text.replace(/([\\`*_\[\]()<>#!])/g, '\\$1');
}

/** Caller-controlled text inside a Markdown inline-code span: code spans cannot be escaped with
 * backslashes, so strip the delimiter characters and flatten newlines instead of escaping. */
function codeSpan(text: string, max = 120): string {
  return `\`${text.replace(/[`\r\n]+/g, ' ').slice(0, max)}\``;
}

function digestBody(night: string, data: ReportData, note?: string): string {
  // GitHub rejects issue bodies over 65,536 characters: the POST would fail AFTER all reads
  // and the night would end with no digest at all. Render under a shared budget and note how
  // many items were omitted.
  const BUDGET = 60_000;
  const lines: string[] = [`# nightly report — ${night}`, ''];
  if (note) lines.push(`_${note}_`, '');
  let size = lines.join('\n').length;
  const fits = (s: string): boolean => {
    // +1 accounts for the joining newline between pushed entries.
    const cost = s.length + 1;
    if (size + cost > BUDGET) return false;
    size += cost;
    return true;
  };
  const list = (items: { title: string; url?: string; number?: number }[], empty: string): string => {
    if (items.length === 0) return empty;
    const out: string[] = [];
    let omitted = 0;
    for (const it of items) {
      // Titles are user-controlled: escape Markdown so `](...)` etc. cannot alter the rendered
      // digest or spoof a link target.
      const text = escMd(it.title || (it.number !== undefined ? `#${it.number}` : 'untitled'));
      const line = `- ${it.url ? `[${text}](<${it.url}>)` : text}`;
      if (!fits(line)) { omitted += 1; continue; }
      out.push(line);
    }
    if (omitted > 0) out.push(`_… ${omitted} more item${omitted === 1 ? '' : 's'} omitted (issue-body budget)_`);
    return out.join('\n');
  };
  // Each section RESERVES its heading first (charging it to the budget), then renders its
  // body line-by-line through the same charge. An overflowing body is truncated with the
  // omitted marker - it never silently discards already-rendered data, and a section that
  // starts always keeps at least its heading and its empty-state/omitted marker.
  const section = (heading: string, render: () => string): void => {
    if (!fits(heading)) return;
    lines.push(heading);
    lines.push(render(), '');
  };
  // The hand-mapped sections go through the SAME budget: one line at a time, over-budget
  // lines dropped with the same omitted marker, so no section can silently blow the limit.
  const bounded = (items: string[], empty: string): string => {
    if (items.length === 0) return empty;
    const out: string[] = [];
    let omitted = 0;
    for (const line of items) {
      if (!fits(line)) { omitted += 1; continue; }
      out.push(line);
    }
    if (omitted > 0) out.push(`_… ${omitted} more item${omitted === 1 ? '' : 's'} omitted (issue-body budget)_`);
    return out.join('\n');
  };
  section('## PRs opened', () => list(data.prs, '_none_'));
  section('## Issues filed', () => list(data.issuesFiled, '_none_'));
  section('## Issues commented', () => list(data.issuesCommented, '_none_'));
  section('## Blocked (nightly:blocked, waiting on a human)', () =>
    bounded(data.blocked.map((b) => `- #${b.number} ${escMd(b.title)}${b.question ? ` — question: ${escMd(b.question)}` : ''}`), '_none_'));
  section('## Runs stopped by notAfter (the 06:00 window end)', () =>
    bounded(data.runsStopped.map((r) => `- ${codeSpan(r.runId ?? '')} — ${codeSpan(r.task ?? '')}`), '_none_'));
  section('## Flakes (nightly-e2e clock)', () =>
    bounded(data.flakes.map((f) => {
      // State-derived text: flatten newlines BEFORE other rendering so a tampered entry or a
      // newline-bearing test name cannot inject headings/lists into the public digest. Night
      // entries must look like YYYY-MM-DD; malformed ones are dropped from the line.
      const nights = f.nights.filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).map((n) => codeSpan(n, 10));
      const test = escMd(f.test.replace(/[\r\n]+/g, ' '));
      return `- ${codeSpan(f.fingerprint, 16)} ${test} — nights: ${nights.join(', ')}`;
    }), '_none_'));
  lines.push('---', "_Closed by tomorrow night's report._");
  return lines.join('\n');
}

/** The §4.3 night window end, wall clock on the night's LOCAL date. The night is
 * [00:00, 06:00) local (dispatcher-bot-design §5 / nightly-self-development §4.3): the
 * work window the bot config enforces with `notAfterAt: "06:00"`. The report fired at
 * 06:05 covers exactly that window, so tonight's ladder activity is digested this
 * morning — not ~24 h later mixed with daytime — and runs stopped AT 06:00 are
 * observable, which a 05:40 fire could never see. */
export const NIGHT_END = '06:00';

/** The night window [00:00 local, 06:00 local) of `night` as a half-open instant range.
 * Exported for tests (the DST-switch dates must round-trip through the host zone). */
export function nightWindow(night: string): { startMs: number; endMs: number; startIso: string; endIso: string } {
  // LOCAL parsing (no Z): `new Date('YYYY-MM-DDT00:00:00')` is local per ES spec.
  const startMs = new Date(`${night}T00:00:00`).getTime();
  const [hh, mm] = NIGHT_END.split(':').map(Number) as [number, number];
  const endMs = new Date(`${night}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    throw new Error(`night window for ${night} is not a valid increasing local range`);
  }
  // GitHub search ranges are INCLUSIVE on both ends; one second below the end keeps the
  // boundary instant (06:00:00) out of this night (it belongs to no nightly activity window).
  const endIso = new Date(endMs - 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const startIso = new Date(startMs).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  return { startMs, endMs, startIso, endIso };
}

/** The night the report covers when --night is absent: the §4.3 window that just ENDED -
 * today's local date when the fire is at/after 06:00 local (the bot config fires the report
 * at 06:05), yesterday's date in the small hours before midnight-carryover edge handling.
 * A fire before 06:00 local still belongs to YESTERDAY's window (it is pre-deadline activity
 * the 06:05 report will cover), so the boundary is the window end, not local midnight. */
export function defaultNight(now: Date = new Date()): string {
  const [hh, mm] = NIGHT_END.split(':').map(Number) as [number, number];
  const cutoff = new Date(now);
  cutoff.setHours(hh, mm, 0, 0);
  // Before 06:00 local the current window has not ended yet: the report covers the COMPLETED
  // prior window (yesterday's date). At/after 06:00 local it covers the window that just
  // ended: today's date.
  return now.getTime() >= cutoff.getTime() ? localDateString(now) : prevDay(localDateString(now));
}

/** Assemble the digest (all reads), file the issue, close yesterday's. */
export async function runReport(
  io: ReportIo,
  env: NodeJS.ProcessEnv,
  opts: { repo: string; night: string; dryRun: boolean },
): Promise<ReportResult> {
  assertRepo(opts.repo);
  assertNight(opts.night);
  // The §4.3 night window as a UTC instant range [00:00 local, 06:00 local): GitHub search
  // date qualifiers need explicit instants - a plain `created:NIGHT` matches one UTC DAY, but
  // the nightly window is local - in Poznań (UTC+2) that misses everything between local
  // midnight and 02:00 (verified live: the local window finds PRs the UTC-day search does
  // not). `night` is parsed as LOCAL time (no Z suffix) and converted to ISO with a +00:00
  // offset, the format GitHub's search accepts. Ranges are INCLUSIVE on both ends, so the
  // upper bound is one SECOND before 06:00 local: the boundary instant itself belongs to no
  // nightly activity, and no item is counted twice.
  const win = nightWindow(opts.night);
  const startIso = win.startIso;
  const endIso = win.endIso;
  const prs = await search(io, opts.repo, `is:pr created:${startIso}..${endIso}`);
  const issuesFiled = await search(io, opts.repo, `is:issue created:${startIso}..${endIso}`);
  // GitHub's issue search does NOT support a commented:<range> qualifier (verified live: the
  // range form matches nothing while comments:>0 matches over a hundred). Candidates come from
  // the supported updated:<range> search; collectIssuesCommented then reads each candidate's
  // comments and keeps only issues with a comment authored DURING the night (bounded).
  const updatedCandidates = await search(io, opts.repo, `is:issue updated:${startIso}..${endIso}`);
  const issuesCommented = await collectIssuesCommented(io, opts.repo, updatedCandidates,
    win.startMs, win.endMs - 1000);
  const blocked = await collectBlocked(io, opts.repo);
  const runsStopped = io.mercury ? await collectRunsStopped(io.mercury, opts.night) : [];
  const flakes = collectFlakes(env, opts.night);
  const data: ReportData = { prs, issuesFiled, issuesCommented, blocked, runsStopped, flakes };

  if (opts.dryRun) {
    return { night: opts.night, ...data };
  }

  // The digest title carries its night: creation is IDEMPOTENT (a retry after a timeout or a
  // failed close reuses the same-night issue instead of filing a duplicate), and the close loop
  // NEVER touches a same-night issue (a concurrent invocation's digest is not ours to close).
  const title = `nightly report — ${opts.night}`;

  let issue: number | undefined;
  // Idempotency first: look for an existing same-night digest in ANY state (an operator or an
  // interrupted cleanup can close it before a retry; the retry must reuse, not duplicate).
  for (let page = 1; page <= SEARCH_CAP && issue === undefined; page++) {
    const path = `/repos/${opts.repo}/issues?labels=${encodeURIComponent(L_REPORT)}&state=all&per_page=100&page=${page}`;
    const res = await io.get(path);
    if (res.status < 200 || res.status >= 300) throw new Error(`GET ${path} -> ${res.status}`);
    const all = res.body as { number?: number; title?: string; pull_request?: unknown; state?: string }[] | null;
    if (!Array.isArray(all)) throw new Error(`GET ${path} -> 2xx with an unexpected body (expected an issue array)`);
    for (const cand of all) {
      if (cand.number === undefined || cand.pull_request !== undefined) continue;
      if (cand.title === title) {
        issue = cand.number;
        break;
      }
    }
    if ((all ?? []).length < 100) break;
  }

  // Close set: ONE rule - every OPEN digest titled exactly `nightly report — D` with D < night.
  // Strictly older than the digest this run creates/reuses, so a newer report is never erased,
  // and a FAILED close self-heals on any later night (the same rule re-runs over all older
  // nights - no special retry pass). Same-night duplicates from a racing retry (D == night) are
  // NOT closed here; they heal tomorrow when their day is older than that night. Single-writer
  // scheduling (one report fire per night) is enforced by Mercury's bot config, not here.
  const closeables: { number: number }[] = [];
  for (let page = 1; page <= SEARCH_CAP; page++) {
    const path = `/repos/${opts.repo}/issues?labels=${encodeURIComponent(L_REPORT)}&state=open&per_page=100&page=${page}`;
    const res = await io.get(path);
    if (res.status < 200 || res.status >= 300) throw new Error(`GET ${path} -> ${res.status}`);
    // GET /issues returns PRs as well: entries carrying a pull_request property are never
    // digest candidates. A 2xx with an unparsable payload (parse failure -> null) must not read
    // as ZERO open reports - that would create a duplicate and skip the close pass.
    const prev = res.body as { number?: number; title?: string; pull_request?: unknown }[] | null;
    if (!Array.isArray(prev)) throw new Error(`GET ${path} -> 2xx with an unexpected body (expected an issue array)`);
    for (const old of prev) {
      if (old.number === undefined || old.pull_request !== undefined) continue;
      const m = /^nightly report — (\d{4}-\d{2}-\d{2})$/.exec(old.title ?? '');
      if (m && m[1] < opts.night) closeables.push({ number: old.number });
    }
    if (prev.length < 100) break;
  }

  // Create the digest FIRST, then close the older ones: a create failure must never leave the
  // repo with NO open report. Worst case of a close failure is two open reports until tonight's
  // next run closes them - strictly better than a missing digest.
  if (issue === undefined) {
    const body = digestBody(opts.night, data);
    const created = await io.post(`/repos/${opts.repo}/issues`, {
      title,
      body,
      labels: [L_REPORT],
    });
    if (created.status < 200 || created.status >= 300) {
      throw new Error(`digest issue create failed: POST /repos/${opts.repo}/issues -> ${created.status}`);
    }
    const parsed = (created.body as { number?: unknown } | null)?.number;
    // Only a positive integer is an identifiable digest: null/0/string/negative all mean we
    // cannot know which issue to report. Fail hard instead of closing; the retry re-runs the night.
    if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`digest issue create returned no usable issue number (POST status ${created.status}, got ${JSON.stringify(parsed) ?? 'null'}); older reports stay open`);
    }
    issue = parsed;
  }

  let closedPrevious: number | undefined;
  for (const old of closeables) {
    if (old.number === issue) continue;
    const closed = await io.patch(`/repos/${opts.repo}/issues/${old.number}`, { state: 'closed' });
    // Record the close only when it SUCCEEDED: the CLI's ghPatch returns non-2xx without
    // throwing, and the JSON must not claim a close that did not happen. The digest is already
    // filed, so a failed close is reported, not fatal - tonight's run closes it.
    if (closed.status >= 200 && closed.status < 300) closedPrevious = closedPrevious ?? old.number;
  }
  return { night: opts.night, ...(issue !== undefined ? { issue } : {}), ...(closedPrevious !== undefined ? { closedPrevious } : {}), ...data };
}

// ---- CLI ----

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
  // A flag present WITHOUT its value (end of argv, or followed by another flag) must be an
  // error, not a silent default: `report.ts --night` would otherwise fall back to the prior
  // night and file/close a report for a different target than the operator asked for.
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${name} requires a value (got ${value === undefined ? 'nothing' : 'another flag'})`);
    }
    return value;
  };
  const repo = flag('--repo') ?? process.env.REPO ?? '';
  // Local calendar date, not UTC: the night label is the local date of the window the fire
  // covers (same rule as e2e.ts). The DEFAULT (lazy, only when --night is absent): the §4.3
  // window that just ENDED - today's date when the fire is at/after 06:00 local (the bot
  // config fires the report at 06:05), yesterday's date before that. Reporting the finished
  // window means every deadline stop it lists has already happened.
  const night = flag('--night') ?? defaultNight();
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

/**
 * `nightly/report.ts` — the morning digest (N1-4, #741).
 *
 * One GitHub issue per night, labeled `nightly:report`, closed by the next night's report:
 *
 *   - PRs opened tonight and issues filed tonight (GitHub search, repo-scoped, bounded).
 *   - Issues commented on tonight (search `commented:<night-local-start>..<night-local-end>`).
 *   - Blocked items: open issues labeled `nightly:blocked` with their latest blocking question.
 *   - Runs stopped by `notAfter` (the §4.3 window end) — optional section, only when
 *     `MERCURY_REPORT_API_URL` + `MERCURY_REPORT_TOKEN` are set; the Mercury runs API is read
 *     for TIMED_OUT runs and their `run.timed_out` reason event.
 *   - Flakes: the nightly-e2e flake clock (same state file) — recent fingerprint nights.
 *
 * Output: exactly one JSON line
 * `{ night, issue, closedPrevious, prs, issuesFiled, issuesCommented, blocked, runsStopped, flakes }`.
 * No dependencies; all I/O injectable. Writes: the digest issue itself, the close of the
 * previous open report, and the closure of same-night duplicates created by a racing retry
 * (the smallest OPEN issue number survives; a closed reuse candidate never wins).
 */

import { basename } from 'node:path';
import { loadFlakeState, localDateString } from './e2e.ts';

const L_REPORT = 'nightly:report';
const L_BLOCKED = 'nightly:blocked';
const SEARCH_PER_PAGE = 100;
const SEARCH_CAP = 10; // pages of 100 = 1000 hits, bounded
const LAST_PAGES = 3; // comment pages scanned, counting back from the Link-header last page

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

function assertRepo(repo: string): void {
  // Same regex and message as e2e.ts (#739): segments must START alphanumeric, so '..' can
  // never reach a URL segment. (next.ts/select.ts still carry the older loose form.)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)) {
    throw new Error(`repo must be exactly owner/name (e.g. aywengo/mercury); got '${repo}'`);
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

/** Open issues labeled nightly:blocked, each with the most recent **Blocking question:** marker
 * as the question (falling back to the last comment only when no marker exists). */
export async function collectBlocked(io: ReportIo, repo: string): Promise<{ number?: number; title: string; question?: string }[]> {
  const out: { number?: number; title: string; question?: string }[] = [];
  for (let page = 1; page <= SEARCH_CAP; page++) {
    const path = `/repos/${repo}/issues?labels=${encodeURIComponent(L_BLOCKED)}&state=open&per_page=100&page=${page}`;
    const res = await io.get(path);
    if (res.status < 200 || res.status >= 300) throw new Error(`GET ${path} -> ${res.status}`);
    // A 2xx with an unparsable payload (parse failure -> null) must not silently read as ZERO
    // blocked issues; that would hide real blockers from the digest. Targeted error instead.
    const issues = res.body as { number?: number; title?: string; pull_request?: unknown }[] | null;
    if (!Array.isArray(issues)) {
      throw new Error(`GET ${path} -> 2xx with an unexpected body (expected an issue array)`);
    }
    for (const issue of issues) {
      if (issue.pull_request !== undefined) continue; // the issues listing includes PRs
      if (issue.number === undefined) continue;
      out.push({ number: issue.number, title: issue.title ?? '', question: await blockingQuestion(io, repo, issue.number) });
    }
    if (issues.length < 100) break;
  }
  return out;
}

/** The blocking question for an issue: walk the comment pages (bounded) and take the LAST
 * `**Blocking question:**` marker - the most recent blocked exit. If no marker exists (a
 * hand-labeled blocked issue), fall back to the last comment body, truncated. Exported for
 * tests. */
export async function blockingQuestion(io: ReportIo, repo: string, issue: number): Promise<string | undefined> {
  let question: string | undefined;
  let lastComment: string | undefined; // body of the newest comment seen so far (fallback)
  // Comments are returned OLDEST first and the interesting marker is near the END. Discover the
  // last page from the Link header (res.link) and scan at most LAST_PAGES back from it, so a
  // >1000-comment thread still finds the newest marker within a bounded number of requests.
  // Without a Link header (<= 1 page) only page 1 exists.
  const res1 = await io.get(`/repos/${repo}/issues/${issue}/comments?per_page=100&page=1`);
  if (res1.status < 200 || res1.status >= 300) return undefined; // unreadable comments: leave the question unset
  const lastRel = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(res1.link ?? '');
  // No artificial cap: the scan itself is bounded to LAST_PAGES requests counting back from the
  // parsed last page, so even a 10k+ comment thread costs a fixed number of requests and still
  // reaches the real tail. Only an invalid number falls back to page 1.
  const parsed = lastRel ? Number(lastRel[1]) : 1;
  const lastPage = Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
  // Page 1 is ALREADY fetched: scan it for markers even when the tail scan starts later. An
  // old marker on page 1 is only ever a fallback candidate (a newer marker on a later page
  // overwrites it), and it is strictly better than missing a marker entirely.
  {
    const page1Comments = (res1.body as { body?: string }[] | null) ?? [];
    for (const c of page1Comments) {
      if (!c.body) continue;
      const marker = c.body.split('\n').find((l) => l.startsWith('**Blocking question:**'));
      if (marker) question = marker.replace(/^\*\*Blocking question:\*\*\s*/, '');
    }
    if (page1Comments.length > 0 && question === undefined) {
      lastComment = page1Comments[page1Comments.length - 1]?.body;
    }
  }
  const startPage = Math.max(2, lastPage - (LAST_PAGES - 1));
  for (let page = startPage; page <= lastPage; page++) {
    const res = await io.get(`/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`);
    if (res.status < 200 || res.status >= 300) break; // unreadable page: scan what we have
    const comments = (res.body as { body?: string }[] | null) ?? [];
    for (const c of comments) {
      if (!c.body) continue;
      const marker = c.body.split('\n').find((l) => l.startsWith('**Blocking question:**'));
      if (marker) question = marker.replace(/^\*\*Blocking question:\*\*\s*/, '');
    }
    // The newest comment of the scanned window is the fallback source. A FULL page (100) can be
    // the LAST page (the follow-up would be empty), so remember it on every non-empty page.
    if (comments.length > 0 && question === undefined) {
      lastComment = comments[comments.length - 1]?.body;
    }
  }
  if (question === undefined && lastComment !== undefined) question = lastComment.slice(0, 200);
  return question;
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
  const lines: string[] = [`# nightly report — ${night}`, ''];
  if (note) lines.push(`_${note}_`, '');
  const list = (items: { title: string; url?: string; number?: number }[], empty: string): string =>
    items.length === 0 ? empty : items.map((it) => {
      // Titles are user-controlled: escape Markdown so `](...)` etc. cannot alter the rendered
      // digest or spoof a link target.
      const text = escMd(it.title || (it.number !== undefined ? `#${it.number}` : 'untitled'));
      return `- ${it.url ? `[${text}](<${it.url}>)` : text}`;
    }).join('\n');
  lines.push('## PRs opened', list(data.prs, '_none_'), '');
  lines.push('## Issues filed', list(data.issuesFiled, '_none_'), '');
  lines.push('## Issues commented', list(data.issuesCommented, '_none_'), '');
  lines.push('## Blocked (nightly:blocked, waiting on a human)',
    data.blocked.length === 0 ? '_none_' : data.blocked.map((b) => `- #${b.number} ${escMd(b.title)}${b.question ? ` — question: ${escMd(b.question)}` : ''}`).join('\n'), '');
  lines.push('## Runs stopped by notAfter (the 06:00 window end)',
    data.runsStopped.length === 0 ? '_none_' : data.runsStopped.map((r) => `- ${codeSpan(r.runId ?? '')} — ${codeSpan(r.task ?? '')}`).join('\n'), '');
  lines.push('## Flakes (nightly-e2e clock)',
    data.flakes.length === 0 ? '_none_' : data.flakes.map((f) => `- ${codeSpan(f.fingerprint, 16)} ${escMd(f.test)} — nights: ${f.nights.join(', ')}`).join('\n'), '');
  lines.push('---', '_Closed by tomorrow night\'s report._');
  return lines.join('\n');
}

/** The day AFTER the report night, computed in UTC on the date string itself (calendar
 * arithmetic on the LABEL, not on the current time). */
function nextDay(night: string): string {
  const d = new Date(`${night}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The day BEFORE the report night (the only report this run is allowed to close). */
function prevDay(night: string): string {
  const d = new Date(`${night}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Assemble the digest (all reads), file the issue, close yesterday's. */
export async function runReport(
  io: ReportIo,
  env: NodeJS.ProcessEnv,
  opts: { repo: string; night: string; dryRun: boolean },
): Promise<ReportResult> {
  assertRepo(opts.repo);
  assertNight(opts.night);
  // The LOCAL night as a UTC instant range [00:00 local, 00:00 local next day): GitHub search
  // date qualifiers match one UTC DAY, but the nightly window is local - in Poznań (UTC+2) a
  // plain `created:NIGHT` misses everything between local midnight and 02:00 (verified live:
  // the local window finds PRs the UTC-day search does not). `night` is parsed as LOCAL time
  // (no Z suffix) and converted to ISO with a +00:00 offset, the format GitHub's search
  // accepts. GitHub ranges are INCLUSIVE on both ends, so the upper bound is one SECOND before
  // the next local midnight: [00:00, 24:00) - the boundary instant itself belongs to tomorrow's
  // window only, and no item is counted twice.
  const startIso = new Date(`${opts.night}T00:00:00`).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const endNight = nextDay(opts.night);
  const endIso = new Date(new Date(`${endNight}T00:00:00`).getTime() - 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const prs = await search(io, opts.repo, `is:pr created:${startIso}..${endIso}`);
  const issuesFiled = await search(io, opts.repo, `is:issue created:${startIso}..${endIso}`);
  const issuesCommented = await search(io, opts.repo, `is:issue commented:${startIso}..${endIso}`);
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
  // True when `issue` was REUSED and is open (a fresh create is open too). A closed reuse
  // candidate must never win the reconciliation below.
  let reusedOpen = false;
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
        reusedOpen = cand.state !== 'closed';
        break;
      }
    }
    if ((all ?? []).length < 100) break;
  }

  // Find OPEN reports for the close set: ONLY the immediately previous night's report. A
  // backfill (--night <today-1> while today's digest is open) or a clock-skewed run must never
  // erase a NEWER digest.
  const prevNight = prevDay(opts.night);
  const closeables: { number: number; title?: string }[] = [];
  for (let page = 1; page <= SEARCH_CAP; page++) {
    const path = `/repos/${opts.repo}/issues?labels=${encodeURIComponent(L_REPORT)}&state=open&per_page=100&page=${page}`;
    const res = await io.get(path);
    if (res.status < 200 || res.status >= 300) throw new Error(`GET ${path} -> ${res.status}`);
    // GET /issues returns PRs as well: entries carrying a pull_request property are never
    // digest candidates (a PR with this label/title is not a report). A 2xx with an unparsable
    // payload (parse failure -> null) must not read as ZERO open reports - that would create a
    // duplicate and skip yesterday's close.
    const prev = res.body as { number?: number; title?: string; pull_request?: unknown }[] | null;
    if (!Array.isArray(prev)) throw new Error(`GET ${path} -> 2xx with an unexpected body (expected an issue array)`);
    for (const old of prev) {
      if (old.number === undefined || old.pull_request !== undefined) continue;
      if (old.title === `nightly report — ${prevNight}`) closeables.push({ number: old.number, title: old.title });
    }
    if (prev.length < 100) break;
  }

  // Create the digest FIRST, then close yesterday's: a create failure must never leave the repo
  // with NO open report. Worst case of a close failure is two open reports until tonight's next
  // run closes them - strictly better than a missing digest.
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
    issue = (created.body as { number?: number } | null)?.number;
    reusedOpen = true; // a fresh create is open
    if (issue === undefined) {
      // A 2xx create whose body we could not parse: closing yesterday's now could leave ZERO open
      // reports (the new one is unidentifiable). Fail hard instead; the retry re-runs the night.
      throw new Error(`digest issue create returned no issue number (POST status ${created.status}); yesterday's report stays open`);
    }
  }

  // Post-create reconciliation for the create/create race: two invocations can both observe no
  // same-night report before either POST completes. Re-list the open reports and close every
  // same-night duplicate except the SMALLEST OPEN issue number - the rule is deterministic, so
  // both invocations converge on the same survivor no matter the order. (This run's JSON may report
  // an issue that a concurrent reconciliation then closes; the next night's report closes any
  // residue as an older night.)
  // The reconciliation set is built ONLY from the CURRENT open listing. The earlier all-states
  // hit (or this run's fresh POST) can go stale in the window before this listing - an operator
  // may close our issue in between - and a stale-open number winning Math.min would close the
  // actually-open duplicates and leave the night with no open digest. The listing is the same
  // source of truth the close PATCHes act on.
  const sameNight: number[] = [];
  let oursOpen = false;
  for (let page = 1; page <= SEARCH_CAP; page++) {
    const path = `/repos/${opts.repo}/issues?labels=${encodeURIComponent(L_REPORT)}&state=open&per_page=100&page=${page}`;
    const res = await io.get(path);
    if (res.status < 200 || res.status >= 300) break; // unreadable: the next night's close loop heals
    const prev = res.body as { number?: number; title?: string; pull_request?: unknown }[] | null;
    if (!Array.isArray(prev)) break; // unreadable: the next night's close loop heals
    for (const dup of prev) {
      if (dup.number === undefined || dup.pull_request !== undefined) continue;
      if (dup.title !== title) continue;
      if (dup.number === issue) oursOpen = true;
      if (!sameNight.includes(dup.number)) sameNight.push(dup.number);
    }
    if (prev.length < 100) break;
  }
  // The winner of the reconciliation is the SMALLEST number confirmed open NOW, and ONLY the
  // winner's invocation closes the others. A losing invocation closes NOTHING: two independent
  // closers could otherwise each kill the other's survivor and leave the night with no open
  // digest. The loser just reports the survivor; its own issue is closed by the winner (or by
  // tomorrow's prevNight close if the winner died first). An issue closed before the listing
  // (operator closure) is not in the set at all, so it can neither win nor be re-closed; an
  // unreadable listing leaves the set empty and closes nothing (healed by tomorrow's
  // prevNight close).
  if (sameNight.length > 0) {
    const survivor = Math.min(...sameNight);
    if (oursOpen && survivor === issue) {
      for (const n of sameNight) {
        if (n === survivor) continue;
        await io.patch(`/repos/${opts.repo}/issues/${n}`, { state: 'closed' });
      }
    } else if (survivor !== issue) {
      issue = survivor;
    }
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

function ghToken(env: NodeJS.ProcessEnv): string {
  const tok = env.GH_TOKEN || env.GITHUB_TOKEN || '';
  if (!tok) throw new Error('GH_TOKEN (or GITHUB_TOKEN) is required - even for --dry-run, which still runs the searches');
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
  // Local calendar date, not UTC: a nightly scheduled in local tz that fires at 00:05 belongs
  // to that local day even when UTC has rolled over (same rule as e2e.ts). The default is
  // computed lazily, only when --night is absent.
  const night = flag('--night') ?? localDateString();
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

/**
 * `nightly/next.ts` — the nightly-next driver (N1-3, #740).
 *
 * Deterministic selection + exit-path discipline; the issue-fix-loop itself is agent procedure
 * (SKILL.md commands it on the claimed issue). The ladder (§4.2) is `select.ts`'s:
 *
 *   - rung 1: trusted `origin:e2e` / `nightly:ready` issues (priority, then age)
 *   - rung 2: trusted `enhancement` issues — authored by @aywengo or labeled enhancement by
 *     @aywengo (timeline actor) — priority, then age (#800)
 *   - rung 3: new @aywengo issues, not yet labeled (age)
 *   - rung 4: docs → proposals — DRAFT ONLY (§6): the agent drafts `nightly:proposed` issues and
 *     never implements.
 *
 * The chosen issue is claimed `nightly:in-progress` by the selector before this skill reports it
 * (except in `--dry-run`, which selects and reports but writes nothing).
 * **Never asks** (§4.4): a nightly Run must end without NEEDS_INPUT — when in doubt, `blocked`
 * labels the issue, posts the question as an issue comment, and the Run finishes.
 *
 * Exit paths (every one removes `nightly:in-progress`):
 *   - `finish --issue N`   — the fix-loop completed (PR open/merged or nothing to do).
 *   - `blocked --issue N --reason "…"` — adds `nightly:blocked`, posts the question, removes the
 *     claim.
 * A Run stopped by its deadline is the REPORT's reset case (§4.3): the claim stays, with a
 * comment, and the next night's report lists it.
 *
 * Subcommands:
 *   node next.ts run    [--repo owner/name] [--dry-run]
 *   node next.ts finish --repo owner/name --issue N
 *   node next.ts blocked --repo owner/name --issue N --reason "…"
 *
 * Output: exactly one JSON line. No dependencies; all I/O injectable.
 */

import { basename, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { runSelectorWith } from './select.ts';
import { assertRepo, ghToken, ghGet, ghPost, ghPatch, FETCH_TIMEOUT_MS } from './shared.ts';

const L_IN_PROGRESS = 'nightly:in-progress';
const L_BLOCKED = 'nightly:blocked';
/** The nightly machine identity (docs/operations.md): only issues it FILED get the body
 * question marker on a blocked exit (#770) - user-authored bodies are never edited. */
const NIGHTLY_AUTHOR = 'mercury-nightly';
// Mirrors select.ts's validation EXACTLY: the selector is the authority and both read the same
// env; two different regexes would silently disagree on valid repos (e.g. 'octo-org/.github').
// REPO_RE/assertRepo come from shared.ts (#769): the STRICT form, one regex everywhere
// (the loose mirror of select.ts accepted dot-leading segments; report.ts/e2e.ts already refused them).

export interface GhLabel { name?: string | null }

/** The injected I/O surface: generic read/comment calls (`get`, `post`) plus label-specific
 * writes - `postLabel` returns true when a label was NEWLY added (2xx) and false when it was
 * already present (422); `deleteLabel` returns true on 2xx and false when the label was absent. */
export interface NextIo {
  /** `link` is the raw Link header (or null): the selector's bounded pagination parses rel="next"
   * from it. An implementation that drops it silently caps selection at the first page. */
  get(path: string): Promise<{ body: unknown; status: number; link?: string | null }>;
  post(path: string, body: unknown): Promise<{ body: unknown; status: number }>;
  /** Label add: true = newly added (2xx); false = already present (422 already-exists). */
  postLabel(path: string, body: unknown): Promise<boolean>;
  /** Label removal (DELETE /labels/<name>): true on 2xx. */
  deleteLabel(path: string): Promise<boolean>;
  /** Issue body update (PATCH /issues/<n>). Optional: only the blocked exit uses it, and only
   * for issues the nightly identity filed (#770). */
  patch?(path: string, body: unknown): Promise<{ body: unknown; status: number }>;
  /** Generic JSON POST returning the response body (the selector's GraphQL review-thread query).
   *  Optional; absent makes resume candidates fail closed (no resume, still reserved). */
  postJson?(path: string, body: unknown): Promise<{ body: unknown; status: number }>;
}

export interface NextSelection {
  rung: number | 'none';
  issue?: number;
  reason: string;
  /** What the AGENT (the Run) does next, per SKILL.md: run the issue-fix-loop on the claimed
   * issue, draft `nightly:proposed` issues from the docs (§6), or do nothing. */
  action: 'fix-loop' | 'draft-proposals' | 'no-op';
}

/** Every entry point interpolates repo into API paths: one strict owner/name check. */
/** Run the ladder (with claim) and report what the agent should do. */
export async function runNext(io: NextIo, env: NodeJS.ProcessEnv, opts: { repo: string; dryRun: boolean }): Promise<NextSelection> {
  assertRepo(opts.repo);
  const selection = await runSelectorWith(
    {
      // Fail loud on non-2xx reads: the selector assumes its transport throws (its own ghGet
      // does), and a silent error body would surface as a confusing parse failure instead.
      // `link` (the raw Link header) rides along for bounded pagination.
      get: async (path) => {
        const res = await io.get(path);
        if (res.status < 200 || res.status >= 300) throw new Error(`GET ${path} -> ${res.status}`);
        return res;
      },
      // The selector's io.post is label-add semantics (boolean); comments use io.post's generic form.
      post: (path, body) => io.postLabel(path, body),
      // The stale-claim reset (#800) deletes labels: forward the same DELETE transport the
      // finish/blocked exits use, or a pre-midnight claim would throw instead of reset.
      del: (path) => io.deleteLabel(path),
      // The resume rung's pending-findings check (#819) queries GraphQL review threads; absent
      // transport = the selector fails its resume candidates closed (still reserves their
      // issues from new work).
      postJson: io.postJson
        ? async (path, body) => await io.postJson!(path, body)
        : undefined,
    },
    { ...env, REPO: opts.repo },
    opts.dryRun,
  );
  if (selection.rung === 0 || selection.rung === 1 || selection.rung === 2 || selection.rung === 3) {
    // Rung 0 (resume, #819) is fix-loop step 5: address the pending Copilot findings on the
    // PR the earlier night opened, one batched push, then the relay fetches the fresh review.
    return { ...selection, action: 'fix-loop' };
  }
  if (selection.rung === 4) {
    return { ...selection, action: 'draft-proposals' };
  }
  return { rung: 'none', reason: selection.reason, action: 'no-op' };
}

/** The success exit path: the fix-loop finished (PR open/merged, or nothing actionable). */
export async function finishIssue(io: NextIo, opts: { repo: string; issue: number }): Promise<{ removed: boolean }> {
  assertRepo(opts.repo);
  const removed = await io.deleteLabel(`/repos/${opts.repo}/issues/${opts.issue}/labels/${encodeURIComponent(L_IN_PROGRESS)}`);
  return { removed };
}

/** The never-asks exit path: hand the question to a human via GitHub, remove the claim, finish. */
export async function blockIssue(io: NextIo, opts: { repo: string; issue: number; reason: string }): Promise<{ removed: boolean; newlyLabeled: boolean; commented: boolean }> {
  assertRepo(opts.repo);
  const reason = opts.reason.trim();
  if (reason === '') throw new Error('a blocked exit needs a non-empty --reason (the question a human must answer)');
  // Label FIRST so a crash between the two writes still shows the blocked state; the comment is
  // the second write. The comment MUST land before the claim is released - otherwise the issue is
  // unlabeled AND questionless (a silent stall). A failed comment fails hard; a rerun retries the
  // same writes (the label add is idempotent: already-present → false).
  // `newlyLabeled` = the label add was NEW (false on an idempotent retry where the label was
  // already present); the post-state is always "labeled" when this function returns.
  const newlyLabeled = await io.postLabel(`/repos/${opts.repo}/issues/${opts.issue}/labels`, { labels: [L_BLOCKED] });
  const res = await io.post(`/repos/${opts.repo}/issues/${opts.issue}/comments`, {
    body: `The nightly stopped on this issue instead of asking (nightly Runs never ask, §4.4).\n\n**Blocking question:** ${reason}\n\nThe issue is labeled \`${L_BLOCKED}\` for a human to answer or relabel; the \`${L_IN_PROGRESS}\` claim is being released right after this comment.`,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`blocked exit failed: the question comment was not accepted (POST returned ${res.status}); the claim stays so the next night retries`);
  }
  const commented = true;
  // The comment is the source of truth for the question. When the nightly identity FILED the
  // issue (its own defect report, author `mercury-nightly`), the question ALSO goes into the
  // issue body as a trailing invisible HTML-comment marker (#770): the morning report then reads
  // the question from the issue LISTING it already fetches - one object, zero comment requests -
  // while user-authored issues keep their body untouched (the nightly must not edit content it
  // does not own). Best-effort: a failed body patch degrades to the comment path, never fails
  // the blocked exit. A prior marker (a second blocked exit) is REPLACED so the body always
  // carries the latest question.
  try {
    const issueRes = await io.get(`/repos/${opts.repo}/issues/${opts.issue}`);
    if (issueRes.status >= 200 && issueRes.status < 300 && io.patch) {
      const issueBody = issueRes.body as { user?: { login?: string }; body?: string } | null;
      if (issueBody?.user?.login === NIGHTLY_AUTHOR && typeof issueBody.body === 'string') {
        const stripped = issueBody.body.replace(/\n?<!-- nightly:blocking-question[\s\S]*?-->$/, '');
        const marker = `\n\n<!-- nightly:blocking-question\n${reason}\n-->`;
        await io.patch(`/repos/${opts.repo}/issues/${opts.issue}`, { body: stripped + marker });
      }
    }
  } catch {
    // Body marker is an optimization; the comment already carries the question.
  }
  const removed = await io.deleteLabel(`/repos/${opts.repo}/issues/${opts.issue}/labels/${encodeURIComponent(L_IN_PROGRESS)}`);
  return { removed, newlyLabeled, commented };
}

/** Idempotence helper for retries: a re-run of `blocked` on an already-blocked issue is a no-op
 * repeat of the same writes (label add returns already-present; the comment repeats). */
export async function blockedAlready(io: NextIo, opts: { repo: string; issue: number }): Promise<boolean> {
  assertRepo(opts.repo);
  const res = await io.get(`/repos/${opts.repo}/issues/${opts.issue}`);
  if (res.status < 200 || res.status >= 300) return false;
  const labels = ((res.body as { labels?: GhLabel[] }).labels ?? []).map((l) => l.name ?? '');
  return labels.includes(L_BLOCKED);
}

// ---- Rung 4: the guarded filing exit (#881) ----

/** The provenance a rung-4 draft carries (§6/#881): a visible `Source key: <key>` line (what
 * search indexes) and the hidden `<!-- nightly-source: <key> -->` marker (what `sourceKeyOf`
 * reads back). */
export function sourceMarker(source: string): string {
  return `Source key: ${source.trim()}\n<!-- nightly-source: ${source.trim()} -->`;
}

/** The key charset (#928 review): a key outside it can never be read back by `sourceKeyOf`,
 * so it can never dedupe — refuse it instead of filing a proposal that cannot be found. */
const SOURCE_KEY_RE = /^[A-Za-z0-9._/#-]+$/;

/** The stable source key extracted from an issue body, or null when the body has no marker. */
export function sourceKeyOf(body: string | null | undefined): string | null {
  const m = typeof body === 'string' ? body.match(/<!-- nightly-source: ([^\s>]+) -->/) : null;
  return m ? m[1] : null;
}

/** The per-page search bound (#881 acceptance 4): a response that claims more pages than this
 * fails closed - an unbounded backlog must never turn into "search found nothing, file away". */
export const PROPOSE_SEARCH_MAX_PAGES = 10;

/** Rung 4's only filing exit: dedupe by source key (open AND closed, all labels) plus an
 * exact-title match (a pre-marker draft such as #867 must still block re-proposal), then file.
 * Fail closed: a failed or over-cap search throws and NOTHING is created. */
export async function proposeIssue(io: NextIo, opts: { repo: string; source: string; title: string; body: string }): Promise<{ created: boolean; existing?: number; issue?: number; sameRun?: boolean }> {
  assertRepo(opts.repo);
  const source = opts.source.trim();
  if (source === '') throw new Error('propose needs a non-empty --source key (the docs path + heading anchor)');
  const title = opts.title.trim();
  if (title === '') throw new Error('propose needs a non-empty --title');
  if (!SOURCE_KEY_RE.test(source)) {
    throw new Error(`propose: --source must match ${SOURCE_KEY_RE.source} (a key outside it can never dedupe) - nothing was filed`);
  }
  const titleEq = (a: string): boolean => a.trim() === title;

  // Same-night window (#928 review): a proposal filed earlier in THIS Run may not be in the
  // search index yet. A persistent record of keys already filed closes that gap; the Copilot
  // review on #946 found the in-memory map useless across CLI processes, because each
  // documented `next.ts propose` invocation is a fresh Node process.
  if (opts.body.includes('nightly-source:')) {
    // A body that already carries a provenance marker would read back under the WRONG key and
    // create an undedupable duplicate (#928 review "should fix" 1). Refuse instead. Checked
    // before the record and the search: a double-marked body must never be filed under any path.
    throw new Error('propose: the draft body already carries a nightly-source marker - refusing to double-mark - nothing was filed');
  }
  const memo = readProposedRecord(opts.repo, source);
  if (memo !== null) {
    return { created: false, existing: memo, sameRun: true };
  }

  const found = await searchIssues(io, opts.repo, source, title, titleEq);
  if (found !== null) {
    // The search itself succeeded: a match (open or closed, any labels) blocks creation.
    return { created: false, existing: found };
  }

  const marker = sourceMarker(source);
  const fullBody = `${opts.body.replace(/\s+$/, '')}\n\n${marker}`;
  const res = await io.post(`/repos/${opts.repo}/issues`, { title, body: fullBody });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`propose failed: POST /issues returned ${res.status} - nothing was filed`);
  }
  const created = (res.body as { number?: number } | null)?.number;
  if (!Number.isInteger(created) || (created as number) <= 0) {
    throw new Error(`propose failed: the issue-create response carried no issue number - nothing was filed`);
  }
  // Label the draft AFTER the create so a crash between the two writes leaves a visible
  // (unlabeled) draft a human can relabel, never a claimed-looking nothing. The label add is
  // idempotent (already-present -> false), so a rerun of the exit is safe.
  const labeled = await io.postLabel(`/repos/${opts.repo}/issues/${created}/labels`, { labels: ['nightly:proposed'] });
  if (!labeled) {
    // Already labeled means a retry raced us; that is fine. A 422-validation failure would have
    // thrown inside postLabel, same as the claim path.
  }
  writeProposedRecord(opts.repo, source, created as number);
  return { created: true, issue: created };
}

/** The persistent record of proposals already filed (Copilot review on #946): a same-night
 * re-proposal may predate search indexing (#928 review), and each documented `next.ts
 * propose` invocation is a SEPARATE Node process, so the guard cannot be a process-local map.
 * The record lives at `.mercury/nightly-proposals.json` in the current working directory —
 * the Run workspace — written immediately after a successful create, read before any search.
 * A read or parse failure is a refusal (fail closed): the search alone cannot prove absence.
 * Absent file, absent key, or a non-positive number means "nothing recorded", which is a
 * genuine miss rather than an error. */
export const PROPOSED_RECORD_PATH = '.mercury/nightly-proposals.json';

function isNodeErrWithCode(e: unknown, code: string): boolean {
  return e !== null && typeof e === 'object' && 'code' in e && (e as { code?: unknown }).code === code;
}

function recordPath(): string {
  return PROPOSED_RECORD_OVERRIDE ?? PROPOSED_RECORD_PATH;
}

function recordKeyFor(repo: string, source: string): string {
  return `${repo}#${source}`;
}

function readProposedRecord(repo: string, source: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(recordPath(), 'utf8');
  } catch (e: unknown) {
    if (isNodeErrWithCode(e, 'ENOENT')) return null;
    throw new Error(`propose: cannot read ${recordPath()}: ${e instanceof Error ? e.message : String(e)} - filing is refused (fail closed)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    throw new Error(`propose: ${recordPath()} is not valid JSON: ${e instanceof Error ? e.message : String(e)} - filing is refused (fail closed)`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`propose: ${recordPath()} is not a JSON object - filing is refused (fail closed)`);
  }
  const v = (parsed as Record<string, unknown>)[recordKeyFor(repo, source)];
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

function writeProposedRecord(repo: string, source: string, issue: number): void {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = readFileSync(recordPath(), 'utf8');
    const p: unknown = JSON.parse(raw);
    if (p !== null && typeof p === 'object' && !Array.isArray(p)) parsed = p as Record<string, unknown>;
  } catch { /* absent or unreadable file: start a fresh object; the create already succeeded */ }
  parsed[recordKeyFor(repo, source)] = issue;
  mkdirSync(dirname(recordPath()), { recursive: true });
  writeFileSync(recordPath(), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

/** Test hook: point the persistent proposal record at a scratch file (tests run in the repo,
 * where the real path must never be written). Pass null to restore the real path. */
export let PROPOSED_RECORD_OVERRIDE: string | null = null;
export function setProposedRecordPath(path: string | null): void {
  PROPOSED_RECORD_OVERRIDE = path;
}

/** Dedupe search (#881, reworked per the #928 review): GitHub search scoped to issues, bounded
 * by WHAT can match, not by repo age.
 *
 * - Primary: `repo + is:issue + "Source key: <key>"` — the visible provenance line; search does
 *   not reliably index HTML comments.
 * - Title fallback: `repo + is:issue + in:title "<title>"` — exact-compared client-side; it
 *   covers pre-marker drafts such as #867.
 *
 * Every hit is CONFIRMED by re-reading the issue and running `sourceKeyOf` on its body (or the
 * exact title comparison), so search-index noise never blocks and a stale index never slips a
 * real duplicate past. Returns the first confirmed matching issue NUMBER, null when no hit
 * confirms, and throws on any failure (non-2xx, `incomplete_results: true`, over-cap) — fail
 * closed, nothing is filed (#881 acceptance 4). */
async function searchIssues(io: NextIo, repo: string, source: string, title: string, titleEq: (t: string) => boolean): Promise<number | null> {
  const queries = [
    `repo:${repo} is:issue "${sourceKeyLine(source)}"`,
    `repo:${repo} is:issue in:title "${titleQueryPhrase(title)}"`,
  ];
  const seen = new Set<number>();
  for (const q of queries) {
    for (let page = 1; page <= PROPOSE_SEARCH_MAX_PAGES; page++) {
      const res = await io.get(`/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`propose dedupe search failed: search page ${page} returned ${res.status} - filing is refused`);
      }
      const payload = (res.body ?? {}) as { items?: unknown; incomplete_results?: boolean; total_count?: number };
      if (payload.incomplete_results === true) {
        throw new Error('propose dedupe search reported incomplete_results - filing is refused (fail closed, #881 acceptance 4)');
      }
      const items = (Array.isArray(payload.items) ? payload.items : []) as { number?: number }[];
      for (const it of items) {
        if (!Number.isInteger(it.number)) continue;
        const n = it.number as number;
        if (seen.has(n)) continue;
        seen.add(n);
        // Confirm each hit by re-reading the body: search can lag or match loosely; the
        // exact sourceKeyOf/exact-title check keeps the block precise.
        const single = await io.get(`/repos/${repo}/issues/${n}`);
        if (single.status === 404) continue; // the hit vanished from the index; it cannot dedupe
        if (single.status < 200 || single.status >= 300) {
          throw new Error(`propose dedupe search failed: confirming issue ${n} returned ${single.status} - filing is refused`);
        }
        const body = (single.body as { body?: string | null; title?: string } | null);
        if (sourceKeyOf(body?.body) === source || titleEq(body?.title ?? '')) return n;
      }
      // A partial page means the result set is exhausted for this query.
      if (items.length < 100) break;
      if (page === PROPOSE_SEARCH_MAX_PAGES) {
        throw new Error(`propose dedupe search exceeded ${PROPOSE_SEARCH_MAX_PAGES} pages without exhausting the result set - filing is refused (fail closed, #881 acceptance 4)`);
      }
    }
  }
  return null;
}

/** The visible provenance line a filed draft carries (what GitHub search indexes). */
function sourceKeyLine(source: string): string {
  return `Source key: ${source}`;
}

/** The title-fallback query phrase: the exact proposed title, exact-compared client-side. */
function titleQueryPhrase(title: string): string {
  return title;
}

// ---- GitHub I/O (thin, bounded, same shape as select.ts/e2e.ts) ----

async function ghPostLabel(path: string, body: unknown, token: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // 2xx = the label was newly added. 422 means already-exists ONLY when the payload says so (the
  // concurrent-nightly case); any other 422 is a configuration error and throws (same policy as
  // select.ts) - silently returning false would let a blocked exit proceed without the label.
  if (res.status >= 200 && res.status < 300) return true;
  if (res.status === 422) {
    const payload = (await res.json().catch(() => null)) as { message?: string; errors?: { code?: string }[] } | null;
    const already = payload?.errors?.some((e) => e.code === 'already_exists') ||
      (payload?.message ?? '').toLowerCase().includes('already');
    if (already) return false;
    throw new Error(`POST ${path} -> 422 validation failed${payload?.message ? `: ${payload.message}` : ''}`);
  }
  throw new Error(`POST ${path} -> ${res.status}`);
}

async function ghDelete(path: string, token: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status >= 200 && res.status < 300) return true;
  if (res.status === 404) return false; // the label was not there: idempotent removal
  throw new Error(`DELETE ${path} -> ${res.status}`);
}

function realIo(env: NodeJS.ProcessEnv): NextIo {
  const token = ghToken(env);
  return {
    get: async (path) => await ghGet(path, token),
    post: async (path, body) => await ghPost(path, body, token),
    // The resume rung's pending-findings check queries GraphQL review threads; without this the
    // production entry point could never resume (postJson absent = resume fails closed).
    postJson: async (path, body) => await ghPost(path, body, token),
    postLabel: async (path, body) => await ghPostLabel(path, body, token),
    deleteLabel: async (path) => await ghDelete(path, token),
    patch: async (path, body) => await ghPatch(path, body, token),
  };
}

// ---- CLI ----

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const repo = flag('--repo') ?? process.env.REPO ?? '';
  const work = (async (): Promise<unknown> => {
    if (cmd === 'run') {
      return await runNext(realIo(process.env), process.env, { repo, dryRun: args.includes('--dry-run') });
    }
    if (cmd === 'finish') {
      const issue = Number(flag('--issue'));
      if (!repo || !Number.isInteger(issue) || issue <= 0) throw new Error('usage: next.ts finish --repo <owner/name> --issue <n>');
      return await finishIssue(realIo(process.env), { repo, issue });
    }
    if (cmd === 'blocked') {
      const issue = Number(flag('--issue'));
      const reason = flag('--reason') ?? '';
      if (!repo || !Number.isInteger(issue) || issue <= 0) throw new Error('usage: next.ts blocked --repo <owner/name> --issue <n> --reason "<question>"');
      return await blockIssue(realIo(process.env), { repo, issue, reason });
    }
    if (cmd === 'propose') {
      const source = flag('--source') ?? '';
      const title = flag('--title') ?? '';
      const bodyFile = flag('--body-file') ?? '';
      if (!repo || source === '' || title === '' || bodyFile === '') {
        throw new Error('usage: next.ts propose --repo <owner/name> --source <key> --title <t> --body-file <p>');
      }
      const body = readFileSync(bodyFile, 'utf8');
      return await proposeIssue(realIo(process.env), { repo, source, title, body });
    }
    throw new Error('usage: next.ts run|finish|blocked|propose --repo <owner/name> [--dry-run] [--issue <n>] [--source <key>] [--title <t>] [--body-file <p>] [--reason "..."]');
  })();
  work
    .then((out) => { process.stdout.write(JSON.stringify(out) + '\n'); })
    .catch((e: unknown) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    });
}

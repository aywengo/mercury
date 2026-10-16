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

import { basename } from 'node:path';
import { readFileSync } from 'node:fs';

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

/** The machine-readable provenance marker every rung-4 draft carries (§6/#881): `<!-- nightly-source: <key> -->`. */
export function sourceMarker(source: string): string {
  return `<!-- nightly-source: ${source.trim()} -->`;
}

/** The key charset (--source validation, review round on #928): a key outside this set cannot
 * round-trip through the marker regex, so it could never dedupe. Refuse it instead. */
const SOURCE_KEY_RE = /^[A-Za-z0-9._/#-]+$/;

/** The stable source key extracted from an issue body, or null when the body has no marker. */
export function sourceKeyOf(body: string | null | undefined): string | null {
  const m = typeof body === 'string' ? body.match(/<!-- nightly-source: ([^\s>]+) -->/) : null;
  return m ? m[1] : null;
}

/** The in-run memory of what THIS Run filed (review round on #928, search-index lag): GitHub's
 * search index may not have seen an issue filed moments ago, so the same-key second `propose`
 * call in one Run must never rely on the search alone. One module-level set per Run process. */
const filedThisRun = new Map<string, number>();

/** Test hook: clear the in-run filed memory (a fresh Run starts with an empty memory). */
export function resetProposeRunMemory(): void {
  filedThisRun.clear();
}

/** Rung 4's only filing exit: dedupe by source key via the search API (open AND closed; PRs
 * never count, review round on #928), with an exact-title fallback for pre-marker drafts such
 * as #867, then file. The key goes into a VISIBLE line as well as the HTML comment - search
 * indexing of comments is not something to rely on. Each search hit is confirmed by fetching
 * the issue and re-deriving the key, so the check stays exact. Fail closed: a failed search or
 * an `incomplete_results` response throws and NOTHING is created (#881 acceptance 4). */
export async function proposeIssue(io: NextIo, opts: { repo: string; source: string; title: string; body: string }): Promise<{ created: boolean; existing?: number; issue?: number }> {
  assertRepo(opts.repo);
  const source = opts.source.trim();
  if (source === '') throw new Error('propose needs a non-empty --source key (the docs path + heading anchor)');
  if (!SOURCE_KEY_RE.test(source)) {
    throw new Error(`propose --source key "${source}" contains characters outside [A-Za-z0-9._/#-] - such a key cannot be read back from the marker and is refused (review round on #928)`);
  }
  const title = opts.title.trim();
  if (title === '') throw new Error('propose needs a non-empty --title');
  if (typeof opts.body === 'string' && /nightly-source/.test(opts.body)) {
    // A draft that already carries a provenance marker would get a SECOND marker appended and
    // then read back under the FIRST key (#928 review, "should fix" 1) - the next run files a
    // duplicate. Refuse instead of guessing.
    throw new Error('propose body already carries a nightly-source marker - one draft carries exactly one provenance marker; refusing to append another');
  }
  if (filedThisRun.has(source)) {
    // Filed earlier THIS Run; the search index may lag, so the memory is authoritative here.
    return { created: false, existing: filedThisRun.get(source) };
  }

  const titleEq = (a: string): boolean => a.trim() === title;
  const found = await searchIssues(io, opts.repo, [
    { q: `"${source}"`, confirm: (_n, _title, body) => sourceKeyOf(body) === source },
    { q: `in:title "${title}"`, confirm: (n, t, b) => titleEq(t) },
  ]);
  if (found !== null) {
    return { created: false, existing: found };
  }

  const fullBody = `${opts.body.replace(/\s+$/, '')}\n\n## Source\n\nSource key: ${source}\n\n${sourceMarker(source)}`;
  const res = await io.post(`/repos/${opts.repo}/issues`, { title, body: fullBody });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`propose failed: POST /issues returned ${res.status} - nothing was filed`);
  }
  const created = (res.body as { number?: number } | null)?.number;
  if (!Number.isInteger(created) || (created as number) <= 0) {
    throw new Error(`propose failed: the issue-create response carried no issue number - nothing was filed`);
  }
  filedThisRun.set(source, created as number);
  // Label the draft AFTER the create so a crash between the two writes leaves a visible
  // (unlabeled) draft a human can relabel, never a claimed-looking nothing. The label add is
  // idempotent (already-present -> false), so a rerun of the exit is safe.
  const labeled = await io.postLabel(`/repos/${opts.repo}/issues/${created}/labels`, { labels: ['nightly:proposed'] });
  if (!labeled) {
    // Already labeled means a retry raced us; that is fine. A 422-validation failure would have
    // thrown inside postLabel, same as the claim path.
  }
  return { created: true, issue: created };
}

/** One search query leg: the raw query terms and the client-side confirmation applied to each
 * hit (fetch the issue, re-derive the key / compare the title exactly). */
interface SearchLeg {
  q: string;
  confirm: (n: number, title: string, body: string | null) => boolean;
}

/** Run the dedupe legs against GitHub's search API (`GET /search/issues`), oldest-independent:
 * PRs never appear (`is:issue`) and never consume a page cap, so the scan no longer dies as the
 * repo grows (#928 review blocker). Bounded at one page per leg (100 hits); a search that
 * reports `incomplete_results` fails closed - a partial index must never read as "no match". */
async function searchIssues(io: NextIo, repo: string, legs: SearchLeg[]): Promise<number | null> {
  for (const leg of legs) {
    const res = await io.get(`/search/issues?q=${encodeURIComponent(`repo:${repo} is:issue ${leg.q}`)}&per_page=100&sort=created&order=asc`);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`propose dedupe search failed: GET search/issues returned ${res.status} - filing is refused`);
    }
    const payload = (res.body ?? {}) as { incomplete_results?: boolean; items?: { number?: number }[] };
    if (payload.incomplete_results === true) {
      throw new Error(`propose dedupe search reported incomplete_results - a partial index must not read as "no match"; filing is refused (fail closed, #881 acceptance 4)`);
    }
    for (const hit of payload.items ?? []) {
      if (!Number.isInteger(hit.number)) continue;
      // Confirm each hit against the issue itself so the check stays exact even if the search
      // index lags or paraphrases (review round on #928, "primary" bullet).
      const single = await io.get(`/repos/${repo}/issues/${hit.number}`);
      if (single.status < 200 || single.status >= 300) {
        throw new Error(`propose dedupe search failed: confirming hit #${hit.number} returned ${single.status} - filing is refused`);
      }
      const full = (single.body ?? {}) as { title?: string; body?: string | null; pull_request?: unknown };
      if (full.pull_request !== undefined) continue; // search lagged a recent PR over the is:issue filter
      if (leg.confirm(hit.number as number, full.title ?? '', full.body ?? null)) return hit.number as number;
    }
  }
  return null;
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

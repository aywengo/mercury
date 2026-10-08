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

/**
 * The rung-4 (docs → proposals, #6) filing exit (#881): the ONLY way a nightly Run files a
 * `nightly:proposed` issue. Dedupe is mechanical, not recalled: before creating anything the
 * exit searches open AND closed issues for
 *
 *   1. the source marker `<!-- nightly-source: <key> -->` in the body (the `## Source` section
 *      that rung-4 drafts carry), and
 *   2. an exact-title match in any state (pre-marker drafts such as #867 still block).
 *
 * A match creates nothing: the exit returns `{ created: false, existing: N }` (or `checkRan:
 * false` when the search failed or was capped) and the caller decides - the report lists the
 * existing number under "already proposed". FAIL CLOSED: a failed or capped search never files
 * a duplicate, it reports that the dedupe check could not run.
 */
export const SOURCE_MARKER_RE = /<!--\s*nightly-source:\s*(\S[^\n]*?)\s*-->/;
export function sourceMarker(key: string): string {
  return `<!-- nightly-source: ${key} -->`;
}

/** Bounded dedupe search: at most SEARCH_CAP_PAGES pages of issues in ANY state. `null` means
 * the check could not run (non-2xx page, unparsable payload, or the cap was reached before the
 * list ended) - the caller must treat that as "cannot prove absence" and file nothing. */
const PROPOSE_SEARCH_CAP_PAGES = 10;
export async function findExistingProposal(
  io: NextIo,
  repo: string,
  opts: { source: string; title: string },
): Promise<{ number: number; matched: 'source' | 'title' }[] | null> {
  const key = opts.source.trim();
  if (!key) throw new Error('propose needs a non-empty --source key (the doc path + heading anchor)');
  const title = opts.title.trim();
  if (!title) throw new Error('propose needs a non-empty --title');
  const matches: { number: number; matched: 'source' | 'title' }[] = [];
  for (let page = 1; page <= PROPOSE_SEARCH_CAP_PAGES; page++) {
    const path = `/repos/${repo}/issues?state=all&per_page=100&page=${page}`;
    let res: Awaited<ReturnType<NextIo['get']>>;
    try {
      res = await io.get(path);
    } catch {
      return null; // transport failure: fail closed
    }
    if (res.status < 200 || res.status >= 300) return null;
    const all = res.body as { number?: number; title?: string; pull_request?: unknown; body?: string }[] | null;
    if (!Array.isArray(all)) return null; // unparsable payload is not zero issues
    for (const cand of all) {
      if (cand.number === undefined || cand.pull_request !== undefined) continue;
      const body = typeof cand.body === 'string' ? cand.body : '';
      const m = SOURCE_MARKER_RE.exec(body);
      if (m && m[1].trim() === key) {
        matches.push({ number: cand.number, matched: 'source' });
        continue;
      }
      if ((cand.title ?? '').trim() === title) matches.push({ number: cand.number, matched: 'title' });
    }
    if (all.length < 100) return matches; // list ended inside the cap: the check ran fully
  }
  return null; // the cap was reached: the search is incomplete, fail closed
}

/** File a rung-4 proposal with a mechanical dedupe check (#881). Returns `created: false` with
 * either the existing issue number(s) or `checkRan: false` when the dedupe search failed. */
export async function proposeIssue(
  io: NextIo,
  opts: { repo: string; source: string; title: string; body: string },
): Promise<{ created: boolean; number?: number; existing?: { number: number; matched: 'source' | 'title' }[]; checkRan: boolean }> {
  assertRepo(opts.repo);
  const title = opts.title.trim();
  if (!title) throw new Error('propose needs a non-empty --title');
  const body = opts.body.endsWith('\n') ? opts.body : `${opts.body}\n`;
  if (!SOURCE_MARKER_RE.test(body)) {
    throw new Error('the proposal body must carry the `## Source` section with a `<!-- nightly-source: <key> -->` marker (#881)');
  }
  const existing = await findExistingProposal(io, opts.repo, { source: opts.source, title });
  if (existing === null) return { created: false, checkRan: false };
  if (existing.length > 0) return { created: false, checkRan: true, existing };
  const res = await io.post(`/repos/${opts.repo}/issues`, { title, body, labels: ['nightly:proposed'] });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`propose failed: issue creation was not accepted (POST returned ${res.status})`);
  }
  const created = res.body as { number?: number } | null;
  return { created: true, number: created?.number, checkRan: true };
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
    if (cmd === 'propose') {
      const source = flag('--source') ?? '';
      const title = flag('--title') ?? '';
      const bodyFile = flag('--body-file') ?? '';
      if (!repo || !source || !title || !bodyFile) {
        throw new Error('usage: next.ts propose --repo <owner/name> --source <doc-path#anchor> --title "<title>" --body-file <file>');
      }
      const { readFileSync } = await import('node:fs');
      const body = readFileSync(bodyFile, 'utf8');
      return await proposeIssue(realIo(process.env), { repo, source, title, body });
    }
    if (cmd === 'blocked') {
      const issue = Number(flag('--issue'));
      const reason = flag('--reason') ?? '';
      if (!repo || !Number.isInteger(issue) || issue <= 0) throw new Error('usage: next.ts blocked --repo <owner/name> --issue <n> --reason "<question>"');
      return await blockIssue(realIo(process.env), { repo, issue, reason });
    }
    throw new Error('usage: next.ts run|finish|blocked|propose --repo <owner/name> [--dry-run] [--issue <n>] [--reason "..."] [--source <key>] [--title "<t>"] [--body-file <f>]');
  })();
  work
    .then((out) => { process.stdout.write(JSON.stringify(out) + '\n'); })
    .catch((e: unknown) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    });
}

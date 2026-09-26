/**
 * `nightly/next.ts` — the nightly-next driver (N1-3, #740).
 *
 * Deterministic selection + exit-path discipline; the issue-fix-loop itself is agent procedure
 * (SKILL.md commands it on the claimed issue). The ladder (§4.2) is `select.ts`'s:
 *
 *   - rung 1: trusted `origin:e2e` / `nightly:ready` issues (priority, then age)
 *   - rung 2: new @aywengo issues, not yet labeled (age)
 *   - rung 3: docs → proposals — DRAFT ONLY (§6): the agent drafts `nightly:proposed` issues and
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

const L_IN_PROGRESS = 'nightly:in-progress';
const L_BLOCKED = 'nightly:blocked';
// Mirrors select.ts's validation EXACTLY: the selector is the authority and both read the same
// env; two different regexes would silently disagree on valid repos (e.g. 'octo-org/.github').
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
function assertRepo(repo: string): void {
  if (!REPO_RE.test(repo)) {
    throw new Error(`repo must be exactly owner/name (e.g. aywengo/mercury); got '${repo}'`);
  }
}

/** Run the ladder (with claim) and report what the agent should do. */
export async function runNext(io: NextIo, env: NodeJS.ProcessEnv, opts: { repo: string; dryRun: boolean }): Promise<NextSelection> {
  assertRepo(opts.repo);
  const selection = await runSelectorWith(
    {
      // The selector's io.post is label-add semantics (boolean); comments use io.post's generic form.
      get: (path) => io.get(path),
      post: (path, body) => io.postLabel(path, body),
    },
    { ...env, REPO: opts.repo },
    opts.dryRun,
  );
  if (selection.rung === 1 || selection.rung === 2) {
    return { ...selection, action: 'fix-loop' };
  }
  if (selection.rung === 3) {
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
    body: `The nightly stopped on this issue instead of asking (nightly Runs never ask, §4.4).\n\n**Blocking question:** ${reason}\n\nClaim released; the issue is labeled \`${L_BLOCKED}\` for a human to answer or relabel.`,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`blocked exit failed: the question comment was not accepted (POST returned ${res.status}); the claim stays so the next night retries`);
  }
  const commented = true;
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

function ghToken(env: NodeJS.ProcessEnv): string {
  const tok = env.GH_TOKEN || env.GITHUB_TOKEN || '';
  if (!tok) throw new Error('GH_TOKEN (or GITHUB_TOKEN) is required: nightly-next reads and labels issues');
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

async function ghPostLabel(path: string, body: unknown, token: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // 2xx = the claim is ours; 422 already-exists = a concurrent nightly won.
  if (res.status >= 200 && res.status < 300) return true;
  if (res.status === 422) return false;
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
    postLabel: async (path, body) => await ghPostLabel(path, body, token),
    deleteLabel: async (path) => await ghDelete(path, token),
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
    throw new Error('usage: next.ts run|finish|blocked --repo <owner/name> [--dry-run] [--issue <n>] [--reason "..."]');
  })();
  work
    .then((out) => { process.stdout.write(JSON.stringify(out) + '\n'); })
    .catch((e: unknown) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    });
}

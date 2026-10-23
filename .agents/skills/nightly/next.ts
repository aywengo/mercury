/**
 * `nightly/next.ts` — the nightly-next driver (N1-3, #740).
 *
 * Deterministic selection + exit-path discipline; the issue-fix-loop itself is agent procedure
 * (SKILL.md commands it on the claimed issue). The ladder (§4.2) is `select.ts`'s:
 *
 *   - rung 1: trusted `origin:e2e` / `nightly:ready` issues (priority, then age)
 *   - rung 2: trusted `enhancement` issues — authored by @aywengo or labeled enhancement by
 *     @aywengo (timeline actor) AND `nightly:ready` by @aywengo — priority, then age
 *     (#800; the ready requirement is #1001 decision A)
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
 *   node next.ts run    [--repo owner/name] [--dry-run] [--skip-model-check]
 *                       [--task <bot task>] [--model <id>] [--bot <alias>] [--bot-config <path>]
 *                       [--base-url <url>] [--api-key <key>]
 *   node next.ts finish --repo owner/name --issue N
 *   node next.ts blocked --repo owner/name --issue N --reason "…"
 *   node next.ts propose --repo owner/name --source <key> --title "…" --body-file <path>  (#881)
 *
 * Output: exactly one JSON line. No dependencies; all I/O injectable.
 */

import { basename } from 'node:path';

import { checkModel, defaultApiKey, defaultEndpoint, resolveTaskModel, type ModelCheck } from './model.ts';
import { runSelectorWith, type E2eGateState } from './select.ts';
import { assertRepo, ghToken, ghGet, ghPost, ghPatch, recordRunClaim, recordRunTerminal, FETCH_TIMEOUT_MS } from './shared.ts';

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
  /** What the rung-1 e2e gate did (#1010): 'absent' means the host never supplied
   *  `MERCURY_API_URL`/`MERCURY_API_TOKEN`, so rung 1 started without tonight's e2e verdict. */
  e2eGate: E2eGateState;
}

/**
 * The preflight failed, so NOTHING was claimed. Carries the record so the CLI can print it and the
 * Run leaves a readable "model unavailable" line instead of an unexplained non-zero exit (#1040).
 */
export class ModelUnavailableError extends Error {
  readonly record: ModelCheck;
  constructor(record: ModelCheck) {
    super(`model ${record.status}: ${record.model} at ${record.endpoint}${record.reason ? ` — ${record.reason}` : ''}; nothing claimed`);
    this.name = 'ModelUnavailableError';
    this.record = record;
  }
}

export interface RunNextOptions {
  repo: string;
  dryRun: boolean;
  /** The model the Run will use. When set (directly, or through `task`), the endpoint is checked
   * BEFORE the ladder runs, because the ladder's last act is a CLAIM: a model that cannot answer
   * must not leave an issue `nightly:in-progress` for the rest of the night. */
  model?: string;
  /** A bot task whose pinned `template.model` is the model to check (`--task nightly-next`). */
  task?: string;
  /** Test seam for the preflight. */
  checkModel?: (model: string) => Promise<ModelCheck>;
  /** Endpoint/key overrides, forwarded to the preflight (`--base-url`, `--api-key`). */
  baseUrl?: string;
  apiKey?: string;
  /** Bot config overrides for the model pin (`--bot-config`, `--bot`). */
  botConfig?: string;
  bot?: string;
}

/**
 * Refuse to go on when the model endpoint cannot answer. Throws `ModelUnavailableError` (which
 * carries the record) on any non-ok result; does nothing when no model is named.
 *
 * Exported separately because the CLI must run it BEFORE it builds the GitHub transport: a dead
 * model server should be reported as such, not as "GH_TOKEN is missing" (#1040 review).
 */
export async function preflightModel(opts: {
  model?: string;
  task?: string;
  baseUrl?: string;
  apiKey?: string;
  botConfig?: string;
  bot?: string;
  checkModel?: (model: string) => Promise<ModelCheck>;
}): Promise<void> {
  const model = opts.model ?? (opts.task ? resolveTaskModel(opts.task, { configPath: opts.botConfig, bot: opts.bot }) : undefined);
  if (model === undefined) return;
  const run = opts.checkModel ??
    ((m: string) => checkModel({ model: m, baseUrl: opts.baseUrl ?? defaultEndpoint(), apiKey: opts.apiKey ?? defaultApiKey() }));
  const check = await run(model);
  if (check.status !== 'ok') throw new ModelUnavailableError(check);
}

/** Run the ladder (with claim) and report what the agent should do. */
export async function runNext(io: NextIo, env: NodeJS.ProcessEnv, opts: RunNextOptions): Promise<NextSelection> {
  assertRepo(opts.repo);
  await preflightModel(opts);
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
    // The Run ledger (#1024): record the claim so the morning report can name a Run that claimed
    // work and never called `finish`/`blocked`. Best-effort - a selection is not worth failing
    // over an unwritable state file - and skipped on --dry-run, which claims nothing.
    if (!opts.dryRun) {
      recordRunClaim(env, { runId: env.MERCURY_RUN_ID, issue: selection.issue, cwd: process.cwd(), repo: opts.repo });
    }
    // Rung 0 (resume, #819) is fix-loop step 5: address the pending Copilot findings on the
    // PR the earlier night opened, one batched push, then the relay fetches the fresh review.
    return { ...selection, action: 'fix-loop' };
  }
  if (selection.rung === 4) {
    return { ...selection, action: 'draft-proposals' };
  }
  return { rung: 'none', reason: selection.reason, action: 'no-op', e2eGate: selection.e2eGate };
}

/** The success exit path: the fix-loop finished (PR open/merged, or nothing actionable).
 *
 * `env` is REQUIRED and has no `process.env` default on purpose (#1024 review r1): with a default,
 * every caller that forgets it writes to the host's REAL Run ledger. Inside a nightly Run that
 * means `npm test` -- which calls these exits with a fake io -- stamped the Run's own claim
 * `finish`, so the morning report could never list the Run it exists to catch. */
export async function finishIssue(io: NextIo, opts: { repo: string; issue: number }, env: NodeJS.ProcessEnv): Promise<{ removed: boolean }> {
  assertRepo(opts.repo);
  const removed = await io.deleteLabel(`/repos/${opts.repo}/issues/${opts.issue}/labels/${encodeURIComponent(L_IN_PROGRESS)}`);
  // The Run ledger (#1024): this is the terminal call the morning report looks for. Recorded even
  // when the label was already gone - the exit path RAN, which is the fact the report reads.
  recordRunTerminal(env, env.MERCURY_RUN_ID, 'finish');
  return { removed };
}

/** The never-asks exit path: hand the question to a human via GitHub, remove the claim, finish. */
export async function blockIssue(io: NextIo, opts: { repo: string; issue: number; reason: string }, env: NodeJS.ProcessEnv): Promise<{ removed: boolean; newlyLabeled: boolean; commented: boolean }> {
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
  // The Run ledger (#1024): `blocked` IS a terminal call - the never-asks exit is a finished Run,
  // and the report must not list it beside Runs that simply stopped mid-sentence.
  recordRunTerminal(env, env.MERCURY_RUN_ID, 'blocked');
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

// ---- rung 4: the guarded propose exit (#881) ----

/** The required machine-readable provenance marker (#881). The `## Source` section a proposal
 * body carries is prose; THIS marker is the dedupe key: exact, greppable, and written by
 * `propose` itself so it cannot drift from the body. Key shape: doc path plus heading anchor,
 * e.g. `docs/crew/roadmap.md#8-phase-4`. */
export function sourceMarker(source: string): string {
  return `<!-- nightly-source:${source} -->`;
}

function validateSource(source: string): string {
  const key = source.trim();
  if (key === '' || /\s/.test(key)) {
    throw new Error('--source must be a single token: the doc path plus heading anchor (e.g. docs/crew/roadmap.md#8-phase-4)');
  }
  if (!key.includes('/') || !key.includes('#')) {
    throw new Error(`--source must be "<doc path>#<heading anchor>"; got '${key}'`);
  }
  if (key.length > 300) throw new Error('--source is unreasonably long (cap 300 chars)');
  return key;
}

/** A previous proposal that blocks creation: the source key OR the exact (trimmed) title.
 * An open AND a closed match both block - a declined proposal is not re-proposed nightly;
 * re-proposal needs a human to reopen it (#881 acceptance 2). */
export interface ExistingMatch { issue: number; state: string; by: 'source' | 'title' }

/** Search open AND closed issues for the source key or an exact title match. Bounded at 10
 * pages of `state=all` (newest first, so recently filed duplicates are always inside the
 * window). A failed page, an unreadable page or a pagination-cap hit THROWS (fail closed, #881
 * acceptance 4): the caller files nothing and the report says the dedupe check could not run.
 * Pull requests are skipped. */
/** GitHub's search API serves at most 1000 results (10 pages of 100) per query. Unlike a list
 * walk, that bound does not grow with the repository: `is:issue` keeps pull requests out, and the
 * query is the source marker or the exact title, so a full cap means the search itself is too
 * broad to answer "does this exist" -- which is a failed search, not a reason to file. */
export const MAX_SEARCH_PAGES = 10;


/** GitHub search caps a query at 256 characters, and a long title does not fit. Tokens are ANDed
 * (the default), so the first few distinctive words narrow the candidate set and the caller's exact
 * comparison decides. Alphanumeric runs only: `§15` becomes `15`, `<!--` disappears, and punctuation
 * cannot make the query unmatchable (#1053). */
export function titleTerms(title: string, budget = 200): string {
  const terms: string[] = [];
  for (const term of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (term === '') continue;
    if ([...terms, term].join(' ').length > budget) break;
    terms.push(term);
  }
  return terms.join(' ');
}

export async function findExistingProposal(io: NextIo, opts: { repo: string; source: string; title: string }): Promise<ExistingMatch | null> {
  const marker = sourceMarker(opts.source);
  const title = opts.title.trim();
  if (title === '') throw new Error('a proposal needs a non-empty --title');
  // Two legs, both over issues only (a pull request quoting the marker is not a proposal):
  //   * the source KEY, as a phrase;
  //   * the title's terms, ANDed.
  // Both are then compared EXACTLY client-side (marker substring, trimmed title equality).
  //
  // Neither query may be the marker or the whole title as a quoted phrase: GitHub search is
  // token-based, so `"<!-- nightly-source:k -->"` and a title containing `§`, `—` or `:` match
  // nothing at all -- measured on #954, whose exact title returned total_count 0 while the term
  // query below finds it (#1053). A phrase query that silently finds nothing is worse than no
  // search, because it reads as "not filed yet".
  //
  // The list endpoint was the first choice (#928) because a list walk has no index lag, but it
  // counts PAGES over every issue AND pull request in the repository: at ~1000 items the walk
  // could no longer prove absence and #881's fail-closed rule turned rung 4 into a permanent
  // no-op (#1018). Search answers the same question with a bound that repo growth cannot reach.
  const legs: { by: 'source' | 'title'; q: string }[] = [
    { by: 'source', q: `repo:${opts.repo} is:issue "${opts.source}"` },
    { by: 'title', q: `repo:${opts.repo} is:issue in:title ${titleTerms(title)}` },
  ];
  for (const leg of legs) {
    let path: string | null = `/search/issues?q=${encodeURIComponent(leg.q)}&per_page=100`;
    for (let page = 0; page < MAX_SEARCH_PAGES && path; page++) {
      const res = await io.get(path);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`dedupe search failed: GET ${path} -> ${res.status}; nothing is filed`);
      }
      // `shared.ts` returns `body: null` when a 200 response cannot be decoded. An unreadable
      // answer is a failed search like any other -- throw, so the caller files nothing.
      const payload = res.body as { items?: unknown; incomplete_results?: unknown } | null;
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
        throw new Error(`dedupe search failed: GET ${path} -> ${res.status} returned a body without an items list; the answer could not be read, so nothing is filed (fail closed, #881)`);
      }
      // `incomplete_results` means the search timed out and its answer is partial: a miss proves
      // nothing, so filing on it would be exactly the duplicate #881 exists to prevent.
      if (payload.incomplete_results === true) {
        throw new Error(`dedupe search was incomplete (incomplete_results: true) for ${leg.by}; the answer cannot prove absence, so nothing is filed (fail closed, #881)`);
      }
      const items = payload.items as { number: number; title?: string; body?: string | null; state?: string }[];
      for (const it of items) {
        if (leg.by === 'source' && typeof it.body === 'string' && it.body.includes(marker)) {
          return { issue: it.number, state: it.state ?? 'unknown', by: 'source' };
        }
        if (leg.by === 'title' && typeof it.title === 'string' && it.title.trim() === title) {
          return { issue: it.number, state: it.state ?? 'unknown', by: 'title' };
        }
      }
      const next = res.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
      path = next ? next.replace('https://api.github.com', '') : null;
      if (page === MAX_SEARCH_PAGES - 1 && path) {
        throw new Error(`dedupe search hit its ${MAX_SEARCH_PAGES}-page cap (1000 results) on the ${leg.by} leg; the remaining results were not checked, so nothing is filed (fail closed, #881, cap: MAX_SEARCH_PAGES in .agents/skills/nightly/next.ts)`);
      }
    }
  }
  return null;
}

/** The ONLY way rung 4 files a proposal (#881): dedupe first (open AND closed, by source key or
 * exact title), then create with `nightly:proposed`. A match creates nothing and reports the
 * existing issue; a failed search throws (nothing filed). The body comes from a file so the
 * drafted prose never rides the command line. `--dry-run` runs the dedupe search and reports
 * what WOULD happen without creating anything. */
export async function proposeIssue(io: NextIo, env: NodeJS.ProcessEnv, opts: { repo: string; source: string; title: string; bodyFile: string; dryRun?: boolean }): Promise<{ created: boolean; issue?: number; existing?: ExistingMatch }> {
  assertRepo(opts.repo);
  const source = validateSource(opts.source);
  const { readFile } = await import('node:fs/promises');
  const drafted = await readFile(opts.bodyFile, 'utf8');
  if (drafted.trim() === '') throw new Error('--body-file is empty; a proposal carries its argument');
  const marker = sourceMarker(source);
  const body = drafted.includes(marker) ? drafted : `${drafted.replace(/\s*$/, '')}\n\n## Source\n\n${marker}\n`;
  const existing = await findExistingProposal(io, { repo: opts.repo, source, title: opts.title });
  if (existing) return { created: false, existing };
  if (opts.dryRun) return { created: false };
  const res = await io.post(`/repos/${opts.repo}/issues`, { title: opts.title.trim(), body, labels: ['nightly:proposed'] });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`proposal creation failed: POST /issues -> ${res.status}`);
  }
  const num = (res.body as { number?: number })?.number;
  if (!Number.isInteger(num)) throw new Error(`proposal creation returned no issue number (POST -> ${res.status})`);
  return { created: true, issue: num as number };
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

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
  };
  const work = (async (): Promise<unknown> => {
    const repo = flag('--repo') ?? process.env.REPO ?? '';
    if (cmd === 'run') {
      const dryRun = args.includes('--dry-run');
      // The model preflight is ON by default: the whole point is that a crashed server must not
      // cost a claim, and a guard the caller has to remember to request protects nothing (#1040
      // review M1). `--dry-run` writes nothing, so it skips; `--skip-model-check` is the explicit
      // escape hatch (no bot config on this host, a deliberately offline probe).
      const skip = args.includes('--skip-model-check') || dryRun;
      // BEFORE realIo(): building the GitHub transport demands a token, and "GH_TOKEN is missing" is
      // the wrong report for a night whose model server is down.
      await preflightModel(skip ? {} : {
        model: flag('--model'),
        task: flag('--task') ?? 'nightly-next',
        baseUrl: flag('--base-url'),
        apiKey: flag('--api-key'),
        botConfig: flag('--bot-config'),
        bot: flag('--bot'),
      });
      return await runNext(realIo(process.env), process.env, { repo, dryRun });
    }
    if (cmd === 'finish') {
      const issue = Number(flag('--issue'));
      if (!repo || !Number.isInteger(issue) || issue <= 0) throw new Error('usage: next.ts finish --repo <owner/name> --issue <n>');
      return await finishIssue(realIo(process.env), { repo, issue }, process.env);
    }
    if (cmd === 'propose') {
      const source = flag('--source') ?? '';
      const title = flag('--title') ?? '';
      const bodyFile = flag('--body-file') ?? '';
      if (!repo || !source || !title || !bodyFile) {
        throw new Error('usage: next.ts propose --repo <owner/name> --source <doc#anchor> --title "<title>" --body-file <path>');
      }
      return await proposeIssue(realIo(process.env), process.env, { repo, source, title, bodyFile, dryRun: args.includes('--dry-run') });
    }
    if (cmd === 'blocked') {
      const issue = Number(flag('--issue'));
      const reason = flag('--reason') ?? '';
      if (!repo || !Number.isInteger(issue) || issue <= 0) throw new Error('usage: next.ts blocked --repo <owner/name> --issue <n> --reason "<question>"');
      return await blockIssue(realIo(process.env), { repo, issue, reason }, process.env);
    }
    throw new Error('usage: next.ts run|finish|blocked|propose --repo <owner/name> [--dry-run] [--issue <n>] [--reason "..."] [--source <doc#anchor>] [--title "..."] [--body-file <path>]');
  })();
  work
    .then((out) => {
      // The gate's STATE is printed next to its answer (#1010). The boolean alone cannot tell a
      // provisioned host from an unprovisioned one, so an absent gate was invisible in the Run's
      // events for as long as nobody compared the host's environment to the docs.
      const gate = (out as { e2eGate?: string }).e2eGate;
      if (gate === 'absent') {
        console.error('e2e gate: absent — MERCURY_API_URL/MERCURY_API_TOKEN are not in this Run\'s environment, so rung 1 is NOT gated on tonight\'s e2e verdict (docs/operations.md §"Running the nightly bot", #1010)');
      } else if (gate === 'half-configured' || gate === 'unevaluable') {
        console.error(`e2e gate: ${gate} — the gate is configured but could not be evaluated; rung 1 fails closed`);
      }
      process.stdout.write(JSON.stringify(out) + '\n');
    })
    .catch((e: unknown) => {
      // The preflight record goes to STDOUT as the one JSON line, so a failed night leaves a
      // machine-readable reason next to the human message (#1040).
      if (e instanceof ModelUnavailableError) process.stdout.write(JSON.stringify(e.record) + '\n');
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    });
}

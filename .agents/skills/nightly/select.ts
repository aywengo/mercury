/**
 * `nightly/select.ts` — the deterministic ladder selector (N1-1, #738).
 *
 * Docs/dispatcher-bot... no: docs/nightly-self-development.md §4.2 (the ladder) and §5 (the
 * trust rule). An agent reading issue text to decide what to work on is exactly the injection
 * surface the trust rule closes, so this skill decides from GitHub METADATA only:
 *
 *   - author login,
 *   - label names,
 *   - the actor of `nightly:ready` labeling events from the issue timeline.
 *
 * The ladder, in order, takes the first rung with eligible work:
 *
 *   1. Trusted bugs — `origin:e2e` issues and `nightly:ready` issues, by priority label
 *      (priority: high > medium > low, absent sorts last) then age (oldest first). Rung 1
 *      additionally waits until tonight's `nightly-e2e` Run is terminal (queried from the host
 *      API with the same token the Run was created with): no new autonomous work starts while
 *      the E2E verdict for tonight is still open.
 *   2. New @aywengo issues — authored by @aywengo, no labels at all, oldest first.
 *   3. Docs → proposals (§6) — reported as `rung: 3` with no issue: the nightly drafts the
 *      issue set itself; selection has nothing to claim.
 *
 * An issue is eligible only under §5's trust rule: authored by @aywengo, filed from E2E
 * (`origin:e2e`), or labeled `nightly:ready` by @aywengo — the actor comes from the timeline's
 * labeled events, never from issue text. `nightly:in-progress`, `nightly:blocked` and
 * `nightly:proposed` exclude an issue outright. The chosen issue is claimed by adding
 * `nightly:in-progress` BEFORE the decision is printed; if a re-read shows the label already
 * present (a concurrent or retried nightly got there first), the selector picks again.
 *
 * Output: exactly one JSON line `{ rung, issue?, reason }` or `{ rung: "none", reason }`.
 *
 * Usage: `node .agents/skills/nightly/select.ts --repo aywengo/mercury [--dry-run]`
 * Environment: GH_TOKEN (or GITHUB_TOKEN) for the GitHub API; MERCURY_API_URL + the bot's API
 * token for the nightly-e2e terminal check (rung 1 gate; when unset the gate is treated as
 * passed — the e2e Run may simply not exist on this host).
 *
 * No dependencies. Fetch only.
 */

import { basename } from 'node:path';

const TRUSTED_AUTHOR = 'aywengo';
const L_READY = 'nightly:ready';
const L_IN_PROGRESS = 'nightly:in-progress';
const L_BLOCKED = 'nightly:blocked';
const L_PROPOSED = 'nightly:proposed';
const L_E2E = 'origin:e2e';
const EXCLUDED = [L_IN_PROGRESS, L_BLOCKED, L_PROPOSED] as const;
const PRIORITY_ORDER = ['priority: high', 'priority: medium', 'priority: low'] as const;

export interface GhIssue {
  number: number;
  title: string;
  user?: { login?: string | null } | null;
  labels?: { name?: string | null }[] | null;
  created_at?: string | null;
  pull_request?: unknown | null;
}

export interface LabelEvent {
  event?: string | null;
  actor?: { login?: string | null } | null;
  label?: { name?: string | null } | null;
}

export interface Selection {
  rung: number | 'none';
  issue?: number;
  reason: string;
}

export function issueLabels(issue: GhIssue): string[] {
  return (issue.labels ?? []).map((l) => l.name ?? '').filter((n) => n !== '');
}

export function issueAuthor(issue: GhIssue): string {
  return issue.user?.login ?? '';
}

/** §5 trust: authored by @aywengo, filed from E2E, or nightly:ready by @aywengo (timeline actor). */
export function isTrusted(issue: GhIssue, readyByTrusted: boolean): boolean {
  if (issueAuthor(issue) === TRUSTED_AUTHOR) return true;
  const labels = issueLabels(issue);
  if (labels.includes(L_E2E)) return true;
  return readyByTrusted;
}

/**
 * Whether the CURRENT nightly:ready was applied by the trusted actor, from the issue's timeline:
 * walk labeled/unlabeled events for the ready label in order; the final state decides. An
 * @aywengo ready that was later unlabeled and re-applied by someone else is NOT trusted — the
 * approval an operator gave is the one on the label NOW, not one from history.
 */
export function readyActorsFor(issue: GhIssue, timeline: LabelEvent[]): string[] {
  let current: string | null = null; // actor of the latest 'labeled' while not unlabeled since
  for (const e of timeline) {
    if (e.label?.name !== L_READY) continue;
    if (e.event === 'labeled' && e.actor?.login) current = e.actor.login;
    if (e.event === 'unlabeled') current = null;
  }
  return current ? [current] : [];
}

export function isExcluded(issue: GhIssue): boolean {
  const labels = issueLabels(issue);
  return EXCLUDED.some((l) => labels.includes(l));
}

export function priorityRank(issue: GhIssue): number {
  const labels = issueLabels(issue);
  for (let i = 0; i < PRIORITY_ORDER.length; i++) {
    if (labels.includes(PRIORITY_ORDER[i]!)) return i;
  }
  return PRIORITY_ORDER.length; // no priority label sorts last
}

export function ageKey(issue: GhIssue): number {
  const t = Date.parse(issue.created_at ?? '');
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/** One candidate for the ladder, with its trust inputs already resolved. */
export interface Candidate {
  issue: GhIssue;
  readyByTrusted: boolean; // nightly:ready applied by @aywengo (timeline-verified)
}

/**
 * The pure ladder over pre-fetched data. `e2eRunTerminal` is the rung-1 gate: tonight's
 * nightly-e2e Run must be terminal before rung 1 offers work (a retried E2E still open means
 * the night's verdict is not in yet).
 */
export function selectLadder(
  candidates: Candidate[],
  opts: { e2eRunTerminal: boolean },
  /** Candidates seen before claims were dropped (a caller mutating the array passes this). */
  seenCount?: number,
): Selection {
  const eligible = candidates.filter((c) => !isExcluded(c.issue) && isTrusted(c.issue, c.readyByTrusted));

  // Rung 1: origin:e2e or trusted nightly:ready, priority then age.
  if (opts.e2eRunTerminal) {
    const rung1 = eligible
      .filter((c) => {
        const labels = issueLabels(c.issue);
        return labels.includes(L_E2E) || c.readyByTrusted;
      })
      .sort((a, b) => priorityRank(a.issue) - priorityRank(b.issue) || ageKey(a.issue) - ageKey(b.issue));
    if (rung1.length > 0) {
      const top = rung1[0]!;
      const labels = issueLabels(top.issue);
      return {
        rung: 1,
        issue: top.issue.number,
        reason: labels.includes(L_E2E)
          ? `origin:e2e issue #${top.issue.number} (trusted: filed from E2E), priority ${priorityRank(top.issue) < PRIORITY_ORDER.length ? PRIORITY_ORDER[priorityRank(top.issue)] : 'none'}, oldest-first`
          : `nightly:ready by @${TRUSTED_AUTHOR} on #${top.issue.number}, priority ${priorityRank(top.issue) < PRIORITY_ORDER.length ? PRIORITY_ORDER[priorityRank(top.issue)] : 'none'}, oldest-first`,
      };
    }
  }

  // Rung 2: new @aywengo issues — authored by @aywengo, not yet labeled, oldest first.
  const rung2 = eligible
    .filter((c) => issueAuthor(c.issue) === TRUSTED_AUTHOR && issueLabels(c.issue).length === 0)
    .sort((a, b) => ageKey(a.issue) - ageKey(b.issue));
  if (rung2.length > 0) {
    const top = rung2[0]!;
    return { rung: 2, issue: top.issue.number, reason: `new @${TRUSTED_AUTHOR} issue #${top.issue.number}, no labels yet, oldest-first` };
  }

  // Rung 3: docs → proposals (§6). The nightly drafts the issue set itself; nothing to claim.
  // 'none' is only for a repo with no open issues at all — including when every candidate was
  // already claimed by a concurrent nightly (the callers drop claimed candidates).
  if (candidates.length > 0 || (seenCount ?? 0) > 0) {
    return { rung: 3, reason: 'rungs 1 and 2 have no eligible work; the night drafts docs → proposals (§6)' };
  }
  return { rung: 'none', reason: 'no open issues at all' };
}

// ---- GitHub/host I/O (thin, fail-loud) ----

function ghToken(env: NodeJS.ProcessEnv): string {
  const tok = env.GH_TOKEN || env.GITHUB_TOKEN || '';
  if (!tok) throw new Error('GH_TOKEN (or GITHUB_TOKEN) is required: the selector reads GitHub metadata only');
  return tok;
}

async function ghGet(path: string, token: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

/** Returns true when the label was newly added (2xx); false when GitHub says it is already there (422). */
async function ghPost(path: string, body: unknown, token: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return true;
  if (res.status === 422) return false; // Validation Failed: the label is already present
  throw new Error(`POST ${path} -> ${res.status}`);
}

/** Tonight's nightly-e2e Run must be terminal before rung 1 offers work.
 * Unset env = no gate configured = passed. A CONFIGURED gate that cannot be evaluated
 * (unreachable host, bad token, non-2xx) fails CLOSED: rung 1 does not start on a guess. */
export async function e2eRunTerminal(env: NodeJS.ProcessEnv): Promise<boolean> {
  const url = env.MERCURY_API_URL;
  const token = env.MERCURY_API_TOKEN;
  if (!url || !token) return true; // no host configured: no gate exists
  try {
    // Walk the run list with the same paged discipline the bot scheduler uses: a long-lived
    // non-terminal nightly-e2e Run can age out of page one, and missing it would pass the gate
    // while tonight's verdict is still open. Bounded at 20 pages, fail closed at the cap.
    const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
    let cursor: string | null = null;
    let found = 0;
    let nonTerminal = 0;
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ limit: '100' });
      if (cursor) qs.set('cursor', cursor);
      const res = await fetch(`${url.replace(/\/$/, '')}/api/runs?${qs}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false; // configured but unevaluable: fail closed
      const body = (await res.json()) as { runs?: { task?: string; status?: string }[]; nextCursor?: string | null };
      for (const r of body.runs ?? []) {
        if ((r.task ?? '').includes('nightly-e2e')) {
          found++;
          if (!TERMINAL.includes(r.status ?? '')) nonTerminal++;
        }
      }
      const next = body.nextCursor ?? null;
      if (!next) break;
      cursor = next;
      if (page === 19 && found > 0 && nonTerminal === 0) {
        // Cap hit with only terminal e2e Runs seen so far: older pages could still hide one.
        return false; // fail closed
      }
    }
    if (found === 0) return true; // no e2e Run tonight: nothing to wait for
    return nonTerminal === 0;
  } catch {
    return false; // configured but unreachable: fail closed
  }
}

/** The full pipeline over an INJECTED fetch-like transport (tests pass recordings; main passes ghGet/ghPost).
 * io.post returns true when the claim label was newly added, false when it was already present. */
export async function runSelectorWith(
  io: { get: (path: string) => Promise<unknown>; post: (path: string, body: unknown) => Promise<boolean> },
  env: NodeJS.ProcessEnv,
  dryRun: boolean,
): Promise<Selection> {
  const repo = env.REPO ?? '';
  if (!repo.trim() || repo.includes('//')) {
    throw new Error('REPO is required as owner/name (e.g. aywengo/mercury); got an empty or malformed value');
  }
  const issues = (await io.get(`/repos/${repo}/issues?state=open&per_page=100`)) as GhIssue[];
  const real = issues.filter((i) => !i.pull_request);
  const candidates: Candidate[] = [];
  for (const issue of real) {
    let readyByTrusted = false;
    if (issueLabels(issue).includes(L_READY)) {
      const timeline = (await io.get(`/repos/${repo}/issues/${issue.number}/timeline?per_page=100`)) as LabelEvent[];
      readyByTrusted = readyActorsFor(issue, timeline).includes(TRUSTED_AUTHOR);
    }
    candidates.push({ issue, readyByTrusted });
  }
  const e2eTerminal = await e2eRunTerminal(env);
  const seen = candidates.length;
  let selection = selectLadder(candidates, { e2eRunTerminal: e2eTerminal }, seen);
  // Claim BEFORE returning: label nightly:in-progress, then re-read; if the label was already
  // there (a concurrent nightly won), pick again from the remaining candidates.
  while (typeof selection.issue === 'number' && !dryRun) {
    const added = await io.post(`/repos/${repo}/issues/${selection.issue}/labels`, { labels: [L_IN_PROGRESS] });
    if (added) {
      // The claim is ours (2xx): the contract is one claimed issue, returned.
      break;
    }
    // 422: the label was ALREADY there — a concurrent or retried nightly won the race. Drop the
    // candidate and pick again; if everything is taken, the ladder reports rung 3.
    candidates.splice(candidates.findIndex((c) => c.issue.number === selection.issue), 1);
    selection = selectLadder(candidates, { e2eRunTerminal: e2eTerminal }, seen);
  }
  return selection;
}

export async function runSelector(repo: string, env: NodeJS.ProcessEnv, dryRun: boolean): Promise<Selection> {
  const token = ghToken(env);
  return runSelectorWith(
    {
      get: (path) => ghGet(path, token),
      post: (path, body) => ghPost(path, body, token),
    },
    { ...env, REPO: repo },
    dryRun,
  );
}

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const args = process.argv.slice(2);
  const repo = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  if (!repo) {
    console.error('usage: select.ts --repo <owner/name> [--dry-run]');
    process.exit(1);
  }
  runSelector(repo, process.env, dryRun)
    .then((selection) => {
      process.stdout.write(JSON.stringify(selection) + '\n');
    })
    .catch((e: unknown) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    });
}

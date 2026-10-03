/**
 * `nightly/select.ts` — the deterministic ladder selector (N1-1, #738).
 *
 * Spec: docs/nightly-self-development.md §4.2 (the ladder) and §5 (the trust rule). An agent
 * reading issue text to decide what to work on is exactly the injection surface the trust rule
 * closes, so this skill decides from GitHub METADATA only:
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
 *   2. Trusted features — `enhancement` issues the trusted author filed, or whose CURRENT
 *      `enhancement` label carries @aywengo as its timeline actor, priority then age (#800).
 *   3. New @aywengo issues — authored by @aywengo, no labels at all, oldest first.
 *   4. Docs → proposals (§6) — reported as `rung: 4` with no issue: the nightly drafts the
 *      issue set itself; selection has nothing to claim.
 *
 * An issue is eligible only under §5's trust rule: authored by @aywengo, filed by the nightly
 * identity from E2E (`origin:e2e` — the AUTHOR must be the nightly identity AND the CURRENT label
 * must carry the nightly identity as its timeline actor, because a label alone is provenance
 * anyone with triage access can apply), labeled `nightly:ready` by @aywengo, or whose CURRENT
 * `enhancement` label carries @aywengo as its timeline actor (#800) — the actor comes from the
 * timeline's labeled events, never from issue text.
 * `nightly:in-progress`, `nightly:blocked` and `nightly:proposed` exclude an issue outright.
 * The chosen issue is claimed by adding `nightly:in-progress` BEFORE the decision is printed;
 * 422 already-exists on the claim means a concurrent or retried nightly got there first and the
 * selector picks again.
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
import { REPO_RE, ghToken, ghGet as ghGetRaw, ghPost as ghPostRaw, ghDelete as ghDeleteRaw, FETCH_TIMEOUT_MS } from './shared.ts';

const TRUSTED_AUTHOR = 'aywengo';
/** The hosted Copilot reviewer's exact login (aywengo/mercury reviews). Exact match everywhere:
 * a prefix check admits lookalike accounts as reviewer identity (#820 r5). */
const COPILOT_REVIEWER = 'copilot-pull-request-reviewer[bot]';
/**
 * The nightly GitHub identity (docs/operations.md, "The nightly host's GitHub identity"). The
 * trust root must NOT be configurable from a Run's environment: an env override would let the
 * process under test grant itself trust. Change it here, in code review, when the identity changes.
 */
const NIGHTLY_IDENTITY = 'mercury-nightly';
const L_READY = 'nightly:ready';
const L_IN_PROGRESS = 'nightly:in-progress';
const L_BLOCKED = 'nightly:blocked';
const L_PROPOSED = 'nightly:proposed';
const L_E2E = 'origin:e2e';
const L_ENH = 'enhancement';
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
  created_at?: string | null;
}

export interface Selection {
  rung: number | 'none';
  issue?: number;
  reason: string;
}

/**
 * One open nightly PR with pending review remarks (#819): the resume rung's input. GitHub
 * metadata only - number, head, branch, the last Copilot review's head and state - never PR
 * body or comment text (the selector decides from metadata; remarks are the Run's work).
 */
export interface ResumeCandidate {
  issue: number;
  prNumber: number;
  headSha: string;
  /** 'findings' = a Copilot review exists on this head and its verdict is not approval-class;
   *  the run resumes fix-loop step 5 on the issue. */
  state: 'findings';
  /** Older first: with two open PRs for one issue the OLDER one is continued (the acceptance
   *  rule) and the newer must be superseded or closed by the Run. */
  createdAt: string;
}

export function issueLabels(issue: GhIssue): string[] {
  return (issue.labels ?? []).map((l) => l.name ?? '').filter((n) => n !== '');
}

export function issueAuthor(issue: GhIssue): string {
  return issue.user?.login ?? '';
}

/** §5 trust: authored by @aywengo, filed by the nightly identity from E2E, nightly:ready by
 * @aywengo, or enhancement by @aywengo. The ready and enhancement clauses are author-INDEPENDENT
 * — a @aywengo label makes even a nightly-authored issue eligible. The E2E clause is held to the
 * same standard as ready: the issue must be AUTHORED by the nightly identity AND the CURRENT
 * origin:e2e label must carry the nightly identity as its timeline actor. A label alone is
 * provenance anyone with triage access can apply — the author is what makes it "filed by the bot
 * from E2E". */
export function isTrusted(issue: GhIssue, readyByTrusted: boolean, e2eByNightly: boolean, enhByTrusted = false): boolean {
  if (issueAuthor(issue) === TRUSTED_AUTHOR) return true;
  if (readyByTrusted) return true;
  if (enhByTrusted) return true;
  return issueAuthor(issue) === NIGHTLY_IDENTITY && issueLabels(issue).includes(L_E2E) && e2eByNightly;
}

/**
 * Whether the CURRENT nightly:ready was applied by the trusted actor, from the issue's timeline:
 * walk labeled/unlabeled events for the ready label in order; the final state decides. An
 * @aywengo ready that was later unlabeled and re-applied by someone else is NOT trusted — the
 * approval an operator gave is the one on the label NOW, not one from history.
 */
export function readyActorsFor(issue: GhIssue, timeline: LabelEvent[]): string[] {
  return labelActorsFor(timeline, L_READY);
}

/**
 * The CURRENT actor of `labelName`, from the issue's timeline: walk labeled/unlabeled events for
 * that label in order; the final state decides. A trusted actor's label that was later unlabeled
 * and re-applied by someone else is NOT the trusted actor's — the approval that counts is the one
 * on the label NOW, not one from history.
 */
export function labelActorsFor(timeline: LabelEvent[], labelName: string): string[] {
  // `current: string | null | MISSING` — MISSING means "a labeled event exists whose actor we
  // cannot see". That is not the same as "no current actor's predecessor": inheriting the PREVIOUS
  // actor across an actor-less re-label would attribute a label nobody can verify to a trusted
  // actor, so an actor-less final labeled event fails CLOSED (unknown, not trusted).
  const MISSING = Symbol('missing');
  let current: string | null | typeof MISSING = null;
  for (const e of timeline) {
    if (e.label?.name !== labelName) continue;
    if (e.event === 'labeled') current = e.actor?.login ?? MISSING;
    if (e.event === 'unlabeled') current = null;
  }
  return typeof current === 'string' ? [current] : [];
}

/**
 * When the CURRENT `labelName` was applied, from the issue's timeline: the same walk as
 * `labelActorsFor`, but returning the final labeled event's timestamp (null = not currently
 * labeled). This is how a stale `nightly:in-progress` claim is recognized: a claim whose label
 * event predates the current night was left by a deadline-stopped Run (§4.3), not by a
 * concurrent one.
 */
export function lastLabeledAt(timeline: LabelEvent[], labelName: string): string | null {
  let current: string | null = null;
  for (const e of timeline) {
    if (e.label?.name !== labelName) continue;
    if (e.event === 'labeled') current = e.created_at ?? null;
    if (e.event === 'unlabeled') current = null;
  }
  return current;
}

/** The start of the CURRENT night (local 00:00), the claim-freshness boundary: the nightly
 * window is [00:00, 06:00) local (§4.3), so a claim applied before today's local midnight
 * cannot belong to a Run that is alive right now. */
export function nightStartLocal(now: Date = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
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
  /** origin:e2e trusted through the nightly identity: true ONLY when the issue is authored by
   * the nightly identity AND the CURRENT origin:e2e label's timeline actor is that identity.
   * False when the label is absent, the author differs, the actor differs, or the timeline walk
   * was skipped or hit its cap (fail closed). */
  e2eByNightly: boolean;
  /** enhancement applied by @aywengo (timeline-verified): the CURRENT enhancement label's
   * timeline actor is the trusted author (#800). False when absent/actor differs/cap hit. */
  enhByTrusted: boolean;
}

/**
 * The pure ladder over pre-fetched data. `e2eRunTerminal` is the rung-1 gate: tonight's
 * nightly-e2e Run must be terminal before rung 1 offers work (a retried E2E still open means
 * the night's verdict is not in yet).
 */
export function selectLadder(
  candidates: Candidate[],
  opts: { e2eRunTerminal: boolean; resume?: ResumeCandidate[]; pendingReviewIssues?: Set<number> },
  /** Candidates seen before claims were dropped (a caller mutating the array passes this). */
  seenCount?: number,
): Selection {
  // Rung 0 (resume, #819): finish what an earlier night opened before starting anything new.
  // Metadata-only inputs: an open nightly PR whose branch maps to an open issue
  // (fix/issue-<N>-*) with Copilot findings on its current head. Review-REQUEST fetching is
  // the relay's job (a head without a review is skipped here - the relay will fetch one).
  // Resume does NOT wait for tonight's e2e verdict: addressing review remarks on an existing
  // PR is not new work racing the E2E window.
  const resume = opts.resume ?? [];
  if (resume.length > 0) {
    const byNumber = new Map(candidates.map((c) => [c.issue.number, c] as const));
    const byIssue = new Map<number, ResumeCandidate>();
    for (const r of resume) {
      // A candidate whose issue is excluded (nightly:blocked after hand-off, proposed) or
      // absent from the open list cannot be claimed (#820 r1, blocker 1): the resume rung
      // re-checks exclusion itself instead of trusting the caller's scan.
      const cand = byNumber.get(r.issue);
      if (cand === undefined || isExcluded(cand.issue)) continue;
      const top = byIssue.get(r.issue);
      if (top === undefined || r.createdAt < top.createdAt) byIssue.set(r.issue, r);
    }
    const ordered = [...byIssue.entries()].sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
    if (ordered.length > 0) {
      const [issue, r] = ordered[0]!;
      return {
        rung: 0,
        issue,
        reason: `resume: PR #${r.prNumber} (branch fix/issue-${issue}) has Copilot findings on its head to address (fix-loop step 5, at most 2 rounds); oldest-first${byIssue.size > 1 ? `; ${byIssue.size - 1} more PR(s) waiting` : ''}`,
      };
    }
  }
  // Issues with an open nightly PR awaiting review or merge are out of NEW work (rungs 1-3):
  // claiming them again is exactly the duplicate-PR failure #819 exists to stop. Rung 0 does
  // not consult this set (it uses the resume list, which already passed its own checks).
  const pendingReviewIssues = opts.pendingReviewIssues ?? new Set<number>();
  const eligible = candidates.filter((c) => !isExcluded(c.issue)
    && !pendingReviewIssues.has(c.issue.number)
    && isTrusted(c.issue, c.readyByTrusted, c.e2eByNightly, c.enhByTrusted));

  // Rung 1: origin:e2e or trusted nightly:ready, priority then age.
  if (opts.e2eRunTerminal) {
    const rung1 = eligible
      .filter((c) => {
        const labels = issueLabels(c.issue);
        return (labels.includes(L_E2E) && c.e2eByNightly) || c.readyByTrusted;
      })
      .sort((a, b) => priorityRank(a.issue) - priorityRank(b.issue) || ageKey(a.issue) - ageKey(b.issue));
    if (rung1.length > 0) {
      const top = rung1[0]!;
      const labels = issueLabels(top.issue);
      return {
        rung: 1,
        issue: top.issue.number,
        reason: labels.includes(L_E2E) && top.e2eByNightly
          ? `origin:e2e issue #${top.issue.number} (trusted: filed by @${NIGHTLY_IDENTITY} from E2E), priority ${priorityRank(top.issue) < PRIORITY_ORDER.length ? PRIORITY_ORDER[priorityRank(top.issue)] : 'none'}, oldest-first`
          : `nightly:ready by @${TRUSTED_AUTHOR} on #${top.issue.number}, priority ${priorityRank(top.issue) < PRIORITY_ORDER.length ? PRIORITY_ORDER[priorityRank(top.issue)] : 'none'}, oldest-first`,
      };
    }
  }

  // Rung 2: trusted feature requests (#800) — `enhancement` issues authored by @aywengo, or
  // whose CURRENT enhancement label was applied by @aywengo (timeline-verified), priority then
  // age. An operator-filed feature request is autonomous work the same way a filed bug is: the
  // author's authorship is the trust root, and the review gate (never merge without review)
  // still applies to whatever the night builds.
  const rung2 = eligible
    .filter((c) => {
      const labels = issueLabels(c.issue);
      return (issueAuthor(c.issue) === TRUSTED_AUTHOR && labels.includes(L_ENH)) || c.enhByTrusted;
    })
    .sort((a, b) => priorityRank(a.issue) - priorityRank(b.issue) || ageKey(a.issue) - ageKey(b.issue));
  if (rung2.length > 0) {
    const top = rung2[0]!;
    const reason = top.enhByTrusted
      ? `enhancement issue #${top.issue.number} (trusted: labeled enhancement by @${TRUSTED_AUTHOR}), priority ${priorityRank(top.issue) < PRIORITY_ORDER.length ? PRIORITY_ORDER[priorityRank(top.issue)] : 'none'}, oldest-first`
      : `enhancement issue #${top.issue.number} (trusted: filed by @${TRUSTED_AUTHOR}), priority ${priorityRank(top.issue) < PRIORITY_ORDER.length ? PRIORITY_ORDER[priorityRank(top.issue)] : 'none'}, oldest-first`;
    return { rung: 2, issue: top.issue.number, reason };
  }

  // Rung 3: new @aywengo issues — authored by @aywengo, not yet labeled, oldest first.
  const rung3 = eligible
    .filter((c) => issueAuthor(c.issue) === TRUSTED_AUTHOR && issueLabels(c.issue).length === 0)
    .sort((a, b) => ageKey(a.issue) - ageKey(b.issue));
  if (rung3.length > 0) {
    const top = rung3[0]!;
    return { rung: 3, issue: top.issue.number, reason: `new @${TRUSTED_AUTHOR} issue #${top.issue.number}, no labels yet, oldest-first` };
  }

  // Rung 4: docs → proposals (§6). The nightly drafts the issue set itself; nothing to claim.
// Rung 4 covers every "issues existed but rungs 1-3 have nothing eligible" case — including a
// caller that dropped claimed candidates. 'none' means the repo had ZERO open issues.
  if (candidates.length > 0 || (seenCount ?? 0) > 0) {
    return { rung: 4, reason: 'rungs 1 to 3 have no eligible work; the nightly drafts docs → proposals (§6)' };
  }
  return { rung: 'none', reason: 'no open issues at all' };
}

// ---- GitHub/host I/O (thin, fail-loud) ----

/** The selector's fail-loud read policy on the shared raw GET (#769): any non-2xx throws. */
async function ghGet(path: string, token: string): Promise<{ body: unknown; link?: string | null }> {
  const res = await ghGetRaw(path, token);
  if (res.status < 200 || res.status >= 300) throw new Error(`GET ${path} -> ${res.status}`);
  return { body: res.body, link: res.link };
}

/** Returns true when the label was newly added (2xx); false ONLY for GitHub's
 * already-exists validation failure (the racer case). Any other 422 is a real configuration
 * error and throws instead of silently skipping work. */
/** The label-add POST (already-exists -> false) on the shared raw POST (#769). The 422 payload
 * arrives parsed in `body` (shared ghFetch consumed it). */
async function ghPost(path: string, body: unknown, token: string): Promise<boolean> {
  const res = await ghPostRaw(path, body, token);
  if (res.status >= 200 && res.status < 300) return true;
  if (res.status === 422) {
    const payload = res.body as { message?: string; errors?: { code?: string }[] } | null;
    const already = payload?.errors?.some((e) => e.code === 'already_exists') ||
      (payload?.message ?? '').toLowerCase().includes('already');
    if (already) return false;
    throw new Error(`POST ${path} -> 422 validation failed${payload?.message ? `: ${payload.message}` : ''}`);
  }
  throw new Error(`POST ${path} -> ${res.status}`);
}

/** Tonight's nightly-e2e Run must be terminal before rung 1 offers work.
 * Unset env = no gate configured = passed. A PARTIALLY configured gate (exactly one of
 * URL/token) fails closed — a half-set gate is a misconfiguration, not an absence. A fully
 * configured gate that cannot be evaluated (unreachable host, bad token, non-2xx) also fails
 * CLOSED: rung 1 does not start on a guess. */
export async function e2eRunTerminal(env: NodeJS.ProcessEnv): Promise<boolean> {
  const url = env.MERCURY_API_URL;
  const token = env.MERCURY_API_TOKEN;
  if (!url && !token) return true; // no gate configured at all
  if (!url || !token) return false; // half-configured: fail closed
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
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
      if (page === 19) {
        // Cap hit with MORE pages beyond: tonight's e2e Run could be on any of them.
        return false; // fail closed
      }
    }
    if (found === 0) return true; // reached the list end: no e2e Run tonight, nothing to wait for
    return nonTerminal === 0;
  } catch {
    return false; // configured but unreachable: fail closed
  }
}

/** The full pipeline over an INJECTED fetch-like transport (tests pass recordings; main passes ghGet/ghPost).
 * io.post returns true when the claim label was newly added, false when it was already present.
 * io.del returns true on 2xx and false when the label was absent (the stale-claim reset). */
export async function runSelectorWith(
  io: {
    get: (path: string) => Promise<unknown>;
    post: (path: string, body: unknown) => Promise<boolean>;
    del?: (path: string) => Promise<boolean>;
    /** Generic JSON POST returning the response body (GraphQL for review-thread state).
     *  Optional: ABSENT means the pending-findings check cannot run, so resume candidates
     *  fail closed (no resume) while their issues stay reserved from new work. */
    postJson?: (path: string, body: unknown) => Promise<{ body: unknown; status: number }>;
  },
  env: NodeJS.ProcessEnv,
  dryRun: boolean,
): Promise<Selection> {
  const repo = env.REPO ?? '';
  // REPO is interpolated into API paths for reads AND label writes: validate it with the shared
  // strict assertRepo (#769) so no path or query injection is possible and every nightly script
  // agrees on what a valid repo is (segments must START alphanumeric - '..' can never slip in).
  if (!REPO_RE.test(repo)) {
    throw new Error(`REPO must be exactly owner/name (e.g. aywengo/mercury); got '${repo}'`);
  }
  // The open-issue list is walked with Link-header pagination (bounded at 10 pages = 1000
  // issues): an eligible candidate past page one must not be invisible to a deterministic selector.
  const issues: GhIssue[] = [];
  let listPath: string | null = `/repos/${repo}/issues?state=open&per_page=100`;
  let listCapped = false;
  for (let page = 0; page < 10 && listPath; page++) {
    const { body, link } = (await io.get(listPath)) as { body: GhIssue[]; link?: string | null };
    issues.push(...body);
    const next = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    listPath = next ? next.replace('https://api.github.com', '') : null;
    if (page === 9 && listPath) listCapped = true;
  }
  const real = issues.filter((i) => !i.pull_request);
  const candidates: Candidate[] = [];
  for (const issue of real) {
    // The timeline is a security input for BOTH actor-checked trust clauses (nightly:ready by
    // @aywengo; origin:e2e by the nightly identity): walk it (bounded) when it can change the
    // verdict. The e2e clause can only pass for nightly-authored issues, so other authors skip
    // the walk (the timeline is the most expensive read per issue); a missed later
    // labeled/unlabeled event would misreport the CURRENT actor. A hit cap fails closed
    // (treated as not trusted).
    const labels = issueLabels(issue);
    const needTimeline = labels.includes(L_READY)
      || labels.includes(L_ENH)
      || labels.includes(L_IN_PROGRESS)
      || (labels.includes(L_E2E) && issueAuthor(issue) === NIGHTLY_IDENTITY);
    let readyByTrusted = false;
    let e2eByNightly = false;
    let enhByTrusted = false;
    let staleClaim = false;
    if (needTimeline) {
      const timeline: LabelEvent[] = [];
      let tlPath: string | null = `/repos/${repo}/issues/${issue.number}/timeline?per_page=100`;
      let capped = false;
      for (let page = 0; page < 10 && tlPath; page++) {
        const { body, link } = (await io.get(tlPath)) as { body: LabelEvent[]; link?: string | null };
        timeline.push(...body);
        const next = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
        tlPath = next ? next.replace('https://api.github.com', '') : null;
        if (page === 9 && tlPath) capped = true;
      }
      if (!capped) {
        readyByTrusted = labelActorsFor(timeline, L_READY).includes(TRUSTED_AUTHOR);
        // Author check INSIDE the assignment, so e2eByNightly stays false for a foreign-author
        // issue even when its timeline was walked for the ready clause (a ready-labeled issue
        // authored by someone else must never report the e2e reason text).
        e2eByNightly = issueAuthor(issue) === NIGHTLY_IDENTITY
          && labels.includes(L_E2E)
          && labelActorsFor(timeline, L_E2E).includes(NIGHTLY_IDENTITY);
        enhByTrusted = labelActorsFor(timeline, L_ENH).includes(TRUSTED_AUTHOR);
        // §4.3 stale-claim reset: an in-progress claim applied BEFORE the current night belongs
        // to a deadline-stopped Run ("nightly-report lists it, and the next night resets it").
        // Such a claim must not exclude the issue forever. A claim from TONIGHT still excludes:
        // that is a live concurrent/retried Run. In a dry run the stale label is only reported
        // around, never written.
        const claimedAt = lastLabeledAt(timeline, L_IN_PROGRESS);
        if (labels.includes(L_IN_PROGRESS) && claimedAt !== null) {
          const t0 = Date.parse(claimedAt);
          if (Number.isFinite(t0) && t0 < nightStartLocal()) {
            staleClaim = true;
            if (!dryRun) {
              if (!io.del) throw new Error('stale claim reset needs io.del; the injected transport lacks it');
              try {
                const removed = await io.del(`/repos/${repo}/issues/${issue.number}/labels/${encodeURIComponent(L_IN_PROGRESS)}`);
                if (!removed) {
                  // Absent label: the claim was released between the list walk and now; fine.
                  staleClaim = true;
                }
              } catch (e) {
                // Fail closed for THIS issue only: keep it excluded, keep selecting the rest.
                console.error(`stale-claim reset failed for #${issue.number}: ${String(e instanceof Error ? e.message : e)}`);
                staleClaim = false;
              }
            }
          }
        }
      }
    }
    // A reset stale claim no longer excludes the issue: drop the label from the candidate's view.
    const effectiveLabels = staleClaim ? labels.filter((l) => l !== L_IN_PROGRESS) : labels;
    const effectiveIssue = staleClaim ? { ...issue, labels: effectiveLabels.map((name) => ({ name })) } : issue;
    candidates.push({ issue: effectiveIssue, readyByTrusted, e2eByNightly, enhByTrusted });
  }
  const e2eTerminal = await e2eRunTerminal(env);
  // Resume candidates (#819): open PRs authored by the nightly identity whose branch names an
  // open issue (fix/issue-<N>-*). Metadata only: head sha, branch, created_at, the LAST
  // Copilot review's (head, state) on the PR, and the COUNT of Copilot review comments bound
  // to the current head - inline comments are what the hosted reviewer posts when it has
  // findings; an approval-recommended review has none (verified on #805/#816/#812). PR bodies,
  // review bodies and comment text are never read (the selector decides from metadata).
  // Bounded: up to 10 pages of open PRs; up to 5 pages of reviews per PR. A hit pagination cap
  // fails the resume scan for this run (logged, no resume) instead of scanning partially -
  // a partially-scanned list would hide exactly the stale PR the rung exists to resume (#820 r1).
  const resume: ResumeCandidate[] = [];
  /** Issues with an open nightly PR awaiting review or merge: excluded from rungs 1-3 so the
   *  night cannot start duplicate work on them (#820 r1, blocker 2). */
  const pendingReviewIssues = new Set<number>();
  {
    let prPath: string | null = `/repos/${repo}/pulls?state=open&per_page=30`;
    let prPages = 0;
    let prScanComplete = false;
    const nightlyPrs: { number: number; head?: { sha?: string | null; ref?: string | null } | null; user?: { login?: string | null } | null; created_at?: string | null }[] = [];
    try {
      while (prPath && prPages < 10) {
        const { body, link } = (await io.get(prPath)) as { body: typeof nightlyPrs; link?: string | null };
        for (const pr of body ?? []) {
          if (pr.user?.login === NIGHTLY_IDENTITY) nightlyPrs.push(pr);
        }
        prPages++;
        const next = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1]?.replace('https://api.github.com', '') ?? null;
        // Stay on this resource: a next-link for a different list (a hostile or confused
        // transport) must not redirect the walk into re-reading another endpoint.
        prPath = next !== null && next.startsWith('/repos/') && next.includes('/pulls?') ? next : null;
      }
      prScanComplete = !prPath;
    } catch (e) {
      console.error(`resume scan: PR list failed: ${String(e instanceof Error ? e.message : e)}`);
    }
    if (!prScanComplete) {
      // A failed or capped scan means the nightly-PR state is UNKNOWN, not absent: treating it
      // as absent would let the night double-claim an issue that already has a PR (#820 r2,
      // blocker 1). Abort selection: nothing is claimed tonight; the next Run retries.
      return { rung: 'none', reason: 'selection aborted: the open-nightly-PR scan is incomplete (pagination cap or transport failure); claiming new work now could duplicate an existing PR' };
    }
    {
      const openIssues = new Map(candidates.map((c) => [c.issue.number, c]));
      // Pass 1 - choose the OLDEST open nightly PR per mapped issue BEFORE any review state is
      // read (#820 r3, blocker 3): otherwise an older PR awaiting a fresh review loses its turn
      // to a newer duplicate that happens to carry findings, and the duplicate gets continued.
      const chosen = new Map<number, { number: number; head: { sha?: string | null; ref?: string | null } | null; created_at?: string | null; supersededBy: number[] }>();
      for (const pr of nightlyPrs) {
        const branch = pr.head?.ref ?? '';
        const m = branch.match(/^fix\/(issue)-(\d+)-/);
        if (!m) continue;
        const issue = Number(m[2]);
        const issueCandidate = openIssues.get(issue);
        if (!issueCandidate) continue;
        const cur = chosen.get(issue);
        if (cur === undefined) {
          chosen.set(issue, { number: pr.number, head: pr.head ?? null, created_at: pr.created_at ?? '', supersededBy: [] });
          continue;
        }
        const isNewer = (pr.created_at ?? '') > (cur.created_at ?? '')
          || ((pr.created_at ?? '') === (cur.created_at ?? '') && pr.number > cur.number);
        if (isNewer) {
          cur.supersededBy.push(pr.number);
        } else {
          cur.supersededBy.push(cur.number);
          chosen.set(issue, { number: pr.number, head: pr.head ?? null, created_at: pr.created_at ?? '', supersededBy: cur.supersededBy });
        }
      }
      // Every chosen PR reserves its issue from rungs 1-3 - before any review read (#820 r2):
      // unreviewed, approval-class-awaiting-merge and unreadable-review PRs all keep their
      // issue out of new work, and the reservation is recomputed from the still-open PR each
      // night, so it survives `finish` releasing the claim.
      for (const issue of chosen.keys()) pendingReviewIssues.add(issue);
      // Pass 2 - review state of the CHOSEN PR only.
      for (const [issue, pr] of chosen) {
        const issueCandidate = openIssues.get(issue)!;
        const headSha = pr.head?.sha ?? '';
        if (!headSha) continue;
        // Last Copilot review on this PR.
        let lastCopilot: { commit_id?: string | null; state?: string | null } | null = null;
        let unresolvedOnPr = 0;
        let rvPath: string | null = `/repos/${repo}/pulls/${pr.number}/reviews?per_page=50`;
        let rvPages = 0;
        let rvScanComplete = false;
        try {
          while (rvPath && rvPages < 5) {
            const { body, link } = (await io.get(rvPath)) as { body: { user?: { login?: string | null }; commit_id?: string | null; state?: string | null }[]; link?: string | null };
            for (const rv of body ?? []) {
              // Exact login: a lookalike account (copilot-pull-request-reviewer-x) must neither
              // replace the last review nor fake a verdict (#820 r5).
              if (rv.user?.login !== COPILOT_REVIEWER) continue;
              lastCopilot = rv; // pages are oldest-first; keep the last seen
            }
            rvPages++;
            const rvNext = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1]?.replace('https://api.github.com', '') ?? null;
            rvPath = rvNext !== null && rvNext.includes(`/pulls/${pr.number}/reviews?`) ? rvNext : null;
          }
          rvScanComplete = !rvPath;
          // Pending findings: UNRESOLVED, NOT-OUTDATED review threads whose first comment is
          // the Copilot reviewer's AND was authored against the CURRENT head (#820 r3,
          // blocker 4): a clean current-head review must not inherit an older review's stale
          // threads, an unrelated reviewer's thread must not count, and a thread from a
          // previous review round (older commit) belongs to the resolved history.
          if (io.postJson) {
            const gql = {
              query: `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){totalCount,pageInfo{hasNextPage},nodes{isResolved,isOutdated,comments(first:1){nodes{author{login},originalCommit{oid}}}}}}}}`,
              variables: { owner: repo.split('/')[0] ?? '', name: repo.split('/')[1] ?? '', number: pr.number },
            };
            const res = await io.postJson('/graphql', gql);
            if (res.status !== 200) {
              console.error(`resume scan: PR #${pr.number} reviewThreads query -> ${res.status}`);
              rvScanComplete = false;
            } else {
              const threads = (res.body as { data?: { repository?: { pullRequest?: { reviewThreads?: { totalCount?: number; pageInfo?: { hasNextPage?: boolean }; nodes?: { isResolved?: boolean; isOutdated?: boolean; comments?: { nodes?: { author?: { login?: string | null } | null; originalCommit?: { oid?: string | null } | null }[] } | null }[] } } } } }).data?.repository?.pullRequest?.reviewThreads;
              if (!threads || threads.pageInfo?.hasNextPage) {
                rvScanComplete = false; // capped query fails closed
              } else {
                unresolvedOnPr = (threads.nodes ?? []).filter((t) =>
                  t.isResolved === false
                  && t.isOutdated === false
                  && t.comments?.nodes?.[0]?.author?.login === COPILOT_REVIEWER
                  && t.comments?.nodes?.[0]?.originalCommit?.oid === headSha
                ).length;
              }
            }
          } else {
            console.error('resume scan: io.postJson missing; cannot verify pending findings');
            rvScanComplete = false;
          }
        } catch (e) {
          console.error(`resume scan: PR #${pr.number} threads failed: ${String(e instanceof Error ? e.message : e)}`);
          rvScanComplete = false;
        }
        if (!rvScanComplete) continue; // fail closed for THIS PR: no resume, but the issue stays reserved
        const hasHeadReview = lastCopilot !== null && lastCopilot.commit_id === headSha;
        if (!hasHeadReview || lastCopilot === null) continue; // relay fetches the review first
        if (lastCopilot.state === 'APPROVED') continue; // awaiting merge; not resume work
        if (unresolvedOnPr === 0) continue; // approval-class or fully addressed: awaits merge
        // Excluded issues (nightly:blocked after hand-off, proposed) never resume (#820 r1,
        // blocker 1): the review cannot re-open work a human must answer.
        if (isExcluded(issueCandidate.issue)) continue;
        resume.push({ issue, prNumber: pr.number, headSha, state: 'findings', createdAt: pr.created_at ?? '' });
        if (pr.supersededBy.length > 0) {
          console.error(`resume scan: PR #${pr.number} continues for issue #${issue}; newer duplicate(s) superseded: ${pr.supersededBy.map((n) => '#' + n).join(', ')}`);
        }
      }
    }
  }
  // A capped list walk means open items exist beyond page 10 (they may all be PRs or PR-like):
  // the ladder must report rung 3 rather than a false 'none'.
  const seen = candidates.length + (listCapped ? 1 : 0);
  let selection = selectLadder(candidates, { e2eRunTerminal: e2eTerminal, resume, pendingReviewIssues }, seen);
  // Claim BEFORE returning: label nightly:in-progress, then VERIFY ownership through the same
  // primitive the trust rule uses - the label timeline's CURRENT actor (round-3 review on #801).
  // GitHub's add-labels endpoint is IDEMPOTENT (a duplicate POST returns 200 with the label
  // list, verified 2026-09-30 on this repo), so the assumed 422 already-exists never fires and
  // a competitor's claim would look like ours. After the POST, the final labeled event for
  // nightly:in-progress must carry OUR identity as actor: our own POST makes us the last
  // writer, so a foreign final actor means someone claimed between our read and write - drop
  // the candidate and re-select. Residual window: a claim that lands between our DELETE (stale
  // reset) and POST, or a manual claimant who never verifies - labels alone cannot exclude
  // those; singleFlight and the morning report are the mitigation (documented, not defended).
  /** Issues whose claim failed verification: excluded from EVERY later retry (rung 0 and
   *  rungs 1-3) so two broken claims cannot ping-pong forever (#820 r1, blocker 4). */
  const failedIssues = new Set<number>();
  while (typeof selection.issue === 'number' && !dryRun) {
    const claimPath = `/repos/${repo}/issues/${selection.issue}/labels`;
    await io.post(claimPath, { labels: [L_IN_PROGRESS] });
    // Ownership check: walk the timeline (bounded, fail closed at the cap or on an actor-less
    // final event - the same discipline as the trust walk).
    const timeline: LabelEvent[] = [];
    let tlPath: string | null = `/repos/${repo}/issues/${selection.issue}/timeline?per_page=100`;
    let capped = false;
    for (let page = 0; page < 10 && tlPath; page++) {
      const { body, link } = (await io.get(tlPath)) as { body: LabelEvent[]; link?: string | null };
      timeline.push(...body);
      const next = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
      tlPath = next ? next.replace('https://api.github.com', '') : null;
      if (page === 9 && tlPath) capped = true;
    }
    const actors = capped ? [] : labelActorsFor(timeline, L_IN_PROGRESS);
    if (!capped && actors.length === 1 && actors[0] === NIGHTLY_IDENTITY) {
      // The claim is ours: the contract is one claimed issue, returned.
      break;
    }
    // A capped walk, a hidden actor, or a foreign current claim: not verifiably ours - record
    // the failure and pick again with BOTH work pools filtered, so failed claims can never be
    // re-selected (two mutually-rejecting claims would otherwise ping-pong). If everything is
    // taken, the ladder reports rung 4.
    const failed = selection.issue;
    failedIssues.add(failed);
    const ci = candidates.findIndex((c) => c.issue.number === failed);
    if (ci !== -1) candidates.splice(ci, 1);
    selection = selectLadder(candidates, {
      e2eRunTerminal: e2eTerminal,
      resume: resume.filter((r) => !failedIssues.has(r.issue)),
      pendingReviewIssues: new Set([...pendingReviewIssues].filter((n) => !failedIssues.has(n))),
    }, seen);
  }
  return selection;
}

export async function runSelector(repo: string, env: NodeJS.ProcessEnv, dryRun: boolean): Promise<Selection> {
  const token = ghToken(env);
  return runSelectorWith(
    {
      get: async (path) => await ghGet(path, token),
      post: (path, body) => ghPost(path, body, token),
      postJson: async (path, body) => await ghPostRaw(path, body, token),
      del: async (path) => {
        const res = await ghDeleteRaw(path, token);
        if (res.status >= 200 && res.status < 300) return true;
        if (res.status === 404) return false; // label already absent
        throw new Error(`DELETE ${path} -> ${res.status}`);
      },
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

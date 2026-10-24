// Shared plumbing for the nightly skill scripts (#769): repo validation, date-window helpers,
// the GitHub fetch primitives, and the nightly-next Run ledger (#1024). One copy exists so the
// regex-drift review finding on #768 (select.ts/next.ts loose form vs e2e.ts/report.ts strict form)
// cannot recur. The scripts run standalone via `node .agents/skills/nightly/<x>.ts`, so these stay
// dependency-free (node stdlib + fetch) and each script imports only what it uses.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

/** Repo validation: segments must START alphanumeric, so '..' can never reach a URL segment.
 * This is the STRICT form introduced in #739/#741 review; select.ts/next.ts previously carried a
 * looser form that accepted dot-leading segments (e.g. '..') - one regex, everywhere, now. */
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Throws unless `repo` is exactly owner/name with alphanumeric-leading segments. */
export function assertRepo(repo: string): void {
  if (!REPO_RE.test(repo)) {
    throw new Error(`repo must be exactly owner/name (e.g. aywengo/mercury); got '${repo}'`);
  }
}

/** The local (host-zone) calendar date of `d` as YYYY-MM-DD. The nightly windows are LOCAL. */
export function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Calendar arithmetic on a YYYY-MM-DD LABEL (never on the current time): the day after. */
export function nextDay(night: string): string {
  const d = new Date(`${night}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Calendar arithmetic on a YYYY-MM-DD LABEL (never on the current time): the day before. */
export function prevDay(night: string): string {
  const d = new Date(`${night}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Every gh call is bounded: a hung fetch is indistinguishable from a slow one. */
export const FETCH_TIMEOUT_MS = 30_000;

/** The marker the selector puts on the comment it posts when it releases a dead Run's
 * `nightly:in-progress` claim (#1001). The morning report reads it back from the repo-level
 * comment listing, so a release is visible without a per-issue timeline walk. Lives here, not
 * in select.ts, so report.ts can import it without depending on the selector. */
export const CLAIM_RELEASED_MARKER = '<!-- nightly:claim-released -->';

// ---- the nightly-next Run ledger (issue #1024) ----

/**
 * `next.ts` records two moments per nightly Run: the CLAIM it took (`run`) and its TERMINAL CALL
 * (`finish` or `blocked`). The morning report reads the ledger back and lists every Run that
 * claimed work and never called either exit -- the shape that made run_84a35e1f57ae4df4 look
 * finished while its commits sat in a worktree (issue #1023/#1024).
 *
 * The ledger is a state file, not GitHub data: the signal is "did this process call the exit
 * path", which leaves no other trace. Same state home as the flake clock, one file.
 */
export interface RunLedgerEntry {
  /** Mercury Run id (`MERCURY_RUN_ID`). Absent entries are never written: without an id there is
   *  nothing for the report to name. */
  runId: string;
  /** The claimed issue. A rung-4 Run (proposals only) claims nothing and has no terminal call to
   *  make, so it is not an entry at all. */
  issue?: number;
  /** Where the Run worked (`process.cwd()` when `next.ts` ran) - the recovery path. */
  cwd?: string;
  /** The repository the claim was made in (`owner/name`). The digest is per-repo, so an entry
   *  without this would let one repository's digest list another repository's un-finished Run. */
  repo?: string;
  /** ISO instant of the claim. */
  claimedAt: string;
  terminal?: 'finish' | 'blocked';
  terminalAt?: string;
}

/** `${XDG_STATE_HOME:-~/.local/state}/mercury/nightly/run-ledger.json`, 0600. */
export function runLedgerPath(env: NodeJS.ProcessEnv): string {
  if (env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== '') {
    return `${env.XDG_STATE_HOME}/mercury/nightly/run-ledger.json`;
  }
  const home = env.HOME && env.HOME.trim() !== '' ? env.HOME : homedir();
  if (!home || home.trim() === '' || home === '/') {
    throw new Error('cannot locate a state directory: set XDG_STATE_HOME (or HOME) - the Run ledger needs a writable home');
  }
  return `${home}/.local/state/mercury/nightly/run-ledger.json`;
}

/** How many entries the ledger keeps. Two hundred nights is far past the report horizon; the cap
 *  exists so a machine that runs nightly for years does not grow an unbounded file. */
export const RUN_LEDGER_CAP = 200;

/** Shape-validated read. A corrupt or absent file is an EMPTY ledger, never a crash: the report
 *  and the exit paths must both survive a half-written state file. */
export function loadRunLedger(env: NodeJS.ProcessEnv): RunLedgerEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(runLedgerPath(env), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: RunLedgerEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.runId !== 'string' || e.runId === '') continue;
    if (typeof e.claimedAt !== 'string') continue;
    const entry: RunLedgerEntry = { runId: e.runId, claimedAt: e.claimedAt };
    if (typeof e.issue === 'number' && Number.isInteger(e.issue) && e.issue > 0) entry.issue = e.issue;
    if (typeof e.cwd === 'string' && e.cwd !== '') entry.cwd = e.cwd;
    if (typeof e.repo === 'string' && e.repo !== '') entry.repo = e.repo;
    if (e.terminal === 'finish' || e.terminal === 'blocked') entry.terminal = e.terminal;
    if (typeof e.terminalAt === 'string') entry.terminalAt = e.terminalAt;
    out.push(entry);
  }
  return out;
}

function saveRunLedger(env: NodeJS.ProcessEnv, entries: RunLedgerEntry[]): void {
  const p = runLedgerPath(env);
  mkdirSync(dirname(p), { recursive: true });
  // Write-then-rename, not a direct write: the realistic torn write is the one this feature is
  // about -- the Run killed at its notAfter deadline WHILE `next.ts` writes. A truncated file
  // reads as an empty ledger, which would silently empty the "never called finish/blocked" section
  // for the very night it matters.
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries.slice(-RUN_LEDGER_CAP), null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

/** Record a claim. Returns false when there is no Run id to record (a manual invocation), and
 *  never throws: the exit path and the selection both matter more than the ledger. */
export function recordRunClaim(env: NodeJS.ProcessEnv, entry: { runId?: string; issue?: number; cwd?: string; repo?: string; at?: Date }): boolean {
  const runId = entry.runId;
  if (!runId) return false;
  try {
    const entries = loadRunLedger(env).filter((e) => e.runId !== runId);
    entries.push({
      runId,
      ...(entry.issue !== undefined ? { issue: entry.issue } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      ...(entry.repo ? { repo: entry.repo } : {}),
      claimedAt: (entry.at ?? new Date()).toISOString(),
    });
    saveRunLedger(env, entries);
    return true;
  } catch {
    return false;
  }
}

/** Record the terminal call for a Run. Idempotent (a retried `finish` rewrites the same entry) and
 *  never throws. Returns false when the Run has no claim to close or there is no Run id. */
export function recordRunTerminal(env: NodeJS.ProcessEnv, runId: string | undefined, terminal: 'finish' | 'blocked', at: Date = new Date()): boolean {
  if (!runId) return false;
  try {
    const entries = loadRunLedger(env);
    const entry = entries.find((e) => e.runId === runId);
    if (!entry) return false; // rung 4 / manual: nothing was claimed, nothing to close
    entry.terminal = terminal;
    entry.terminalAt = at.toISOString();
    saveRunLedger(env, entries);
    return true;
  } catch {
    return false;
  }
}

export function ghToken(env: NodeJS.ProcessEnv): string {
  const tok = env.GH_TOKEN || env.GITHUB_TOKEN || '';
  if (!tok) throw new Error('GH_TOKEN (or GITHUB_TOKEN) is required - even for --dry-run, which still runs the searches');
  return tok;
}

const GH_HEADERS = {
  authorization: '',
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
} as const;

async function ghFetch(method: string, path: string, token: string, body?: unknown): Promise<{ body: unknown; status: number; link?: string | null }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { ...GH_HEADERS, authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // Every HTTP response is returned, 5xx included - CALLERS own the non-2xx policy (the selector
  // throws, the report degrades sections). Callers needing Link-based pagination read `link`.
  return { body: await res.json().catch(() => null), status: res.status, link: res.headers.get('link') };
}

export function ghGet(path: string, token: string): Promise<{ body: unknown; status: number; link?: string | null }> {
  return ghFetch('GET', path, token);
}

export function ghPost(path: string, body: unknown, token: string): Promise<{ body: unknown; status: number }> {
  return ghFetch('POST', path, token, body);
}

export function ghPatch(path: string, body: unknown, token: string): Promise<{ body: unknown; status: number }> {
  return ghFetch('PATCH', path, token, body);
}

export function ghDelete(path: string, token: string): Promise<{ body: unknown; status: number; link?: string | null }> {
  return ghFetch('DELETE', path, token);
}

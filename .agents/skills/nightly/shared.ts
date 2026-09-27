// Shared plumbing for the nightly skill scripts (#769): repo validation, date-window helpers,
// and the GitHub fetch primitives. One copy exists so the regex-drift review finding on #768
// (select.ts/next.ts loose form vs e2e.ts/report.ts strict form) cannot recur. The scripts run
// standalone via `node .agents/skills/nightly/<x>.ts`, so these stay dependency-free (node stdlib
// + fetch) and each script imports only what it uses.

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

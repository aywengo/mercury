/**
 * `nightly/e2e.ts` — the nightly E2E skill (N1-2, #739).
 *
 * Runs the E2E suite once, reruns each failure once to separate flakes from defects, and turns
 * real failures into GitHub issues (docs/nightly-self-development.md §7, docs/nightly-issues.md
 * §N1-2):
 *
 *   - A REAL failure (still failing on rerun) is fingerprinted: sha-256 over the test name and
 *     the NORMALIZED error line — volatile ids, absolute paths, durations and byte counts are
 *     stripped, so the same defect on a different machine hashes the same.
 *   - Open issues are searched for the fingerprint's hidden marker
 *     `<!-- nightly-e2e-fp:<hash> -->`. A match gets a comment (one data point per night, never a
 *     duplicate issue); no match files a NEW issue labeled `origin:e2e` with the marker in the
 *     body.
 *   - A failure that PASSES on rerun is a flake: listed in the report, never filed — until the
 *     SAME fingerprint has flaked on three nights (state file, one JSON object per fingerprint),
 *     when it is filed as a flake defect with the three nights cited.
 *
 * Output: exactly one JSON line
 * `{ pass, fail, real: [...], flakes: [...] }` — see E2eReport.
 *
 * Usage: `node .agents/skills/nightly/e2e.ts --repo aywengo/mercury [--dry-run] [--state <path>]`
 * Environment: GH_TOKEN (or GITHUB_TOKEN), demanded only when GitHub is actually touched — a green
 * suite (no failures) and --dry-run (local observation) need no credentials. The suite runs via
 * `npm run test:e2e` from the repository root (needs Docker).
 *
 * No dependencies. Fetch only. Everything testable is a pure function or runs over injected I/O.
 */

import { basename } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** A flake is filed as a defect only after the same fingerprint flaked on 3 distinct nights. */
export const FLAKE_FILE_NIGHTS = 3;
const FETCH_TIMEOUT_MS = 30_000;

export interface SuiteFailure {
  /** The failing test's full name from the spec reporter. */
  test: string;
  /** First line of the error output, e.g. `AssertionError [ERR_ASSERTION]: numbers diverge`. */
  error: string;
  /** The test file the failure was reported at, when the output names one. */
  file?: string;
}

export interface RealOutcome {
  test: string;
  error: string;
  fingerprint: string;
  issue?: number;
  action: 'filed' | 'commented' | 'dry-run';
}

export interface FlakeOutcome {
  test: string;
  error: string;
  fingerprint: string;
  nights: number;
  /** Set when this night's flake was the third and the defect got filed. */
  issue?: number;
}

export interface E2eReport {
  pass: number;
  fail: number;
  real: RealOutcome[];
  flakes: FlakeOutcome[];
}

// ---- fingerprinting ----

/**
 * Normalize one error line so the same defect hashes the same across machines, temp dirs and
 * Run ids: absolute paths become their basename, temp-dir and workspace paths collapse, hex ids
 * and run ids drop, durations and numbers drop, whitespace squeezes. The stable remainder is
 * what identifies the DEFECT, not the incident.
 */
export function normalizeErrorLine(line: string): string {
  return line
    .replace(/\brun_[0-9a-f]{8,}\b/g, 'run_<id>')
    .replace(/\bnote_[0-9a-f]{8,}\b/g, 'note_<id>')
    .replace(/\bevt_[0-9a-f]{8,}\b/g, 'evt_<id>')
    .replace(/\b[0-9a-f]{16,}\b/g, '<hex>')
    .replace(/(?:[A-Za-z]:)?(?:\\|\/)private(?:\\|\/)tmp(?:\\|\/)[^\s:'"]+/g, 'tmp/<dir>')
    .replace(/(?:[A-Za-z]:)?(?:\\|\/)tmp(?:\\|\/)[^\s:'"]+/g, 'tmp/<dir>')
    .replace(/(?:[A-Za-z]:)?(?:\\|\/)(?:[A-Za-z0-9_.-]+[\/])+[A-Za-z0-9_.-]+\.(?:ts|js|mjs|cjs)/g, (m) => basename(m))
    .replace(/:\d+(?::\d+)?/g, '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|min|h)\b/g, '<dur>')
    .replace(/\b\d+(?:,\d{3})*\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The fingerprint: sha-256 over test name + normalized error, first 16 hex chars. */
export async function fingerprintOf(test: string, error: string): Promise<string> {
  const data = new TextEncoder().encode(`${test}\n${normalizeErrorLine(error)}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The hidden marker an issue carries in its body; searches match on it, not on prose. */
export const fpMarker = (fp: string): string => `<!-- nightly-e2e-fp:${fp} -->`;

// ---- parsing the spec reporter ----

/**
 * Extract failing tests from the default (spec) reporter output. The detail block after
 * `✖ failing tests:` prints, per failure, a `test at <file>:<line>:<col>` line followed by the
 * ✖ line with the test's name, then the error. Names are unique per suite run; the first ✖
 * occurrence in the detail block wins for name->file attribution.
 */
export function parseFailures(output: string): SuiteFailure[] {
  const lines = output.split('\n');
  const detailStart = lines.findIndex((l) => l.includes('failing tests:'));
  const detail = detailStart >= 0 ? lines.slice(detailStart) : lines;
  const failures: SuiteFailure[] = [];
  let pendingFile: string | undefined;
  for (const l of detail) {
    const at = /^\s*test at (.*?):\d+(?::\d+)?\s*$/.exec(l);
    if (at?.[1]) {
      pendingFile = at[1];
      continue;
    }
    const fail = /^✖\s+(.+?)\s+\(\d+(?:\.\d+)?m?s\)\s*$/.exec(l);
    if (fail?.[1]) {
      const name = fail[1].trim();
      if (!failures.some((f) => f.test === name)) {
        failures.push({ test: name, error: '', ...(pendingFile ? { file: pendingFile } : {}) });
      }
      pendingFile = undefined;
    }
  }
  for (const f of failures) {
    const idx = detail.findIndex((l) => l.startsWith(`✖ ${f.test} (`) || l.startsWith(`✖ ${f.test} `));
    for (let i = idx + 1; i < detail.length && i < idx + 12; i++) {
      const l = detail[i]!;
      const s = l.trim();
      if (s === '' || s.startsWith('test at') || s.startsWith('✖')) continue;
      f.error = s;
      break;
    }
  }
  return failures;
}

/** Parse `ℹ pass N` / `ℹ fail N` counts from the summary. Absent counts stay 0. */
export function parseCounts(output: string): { pass: number; fail: number } {
  const pass = /ℹ\s+pass\s+(\d+)/.exec(output);
  const fail = /ℹ\s+fail\s+(\d+)/.exec(output);
  return { pass: pass ? Number(pass[1]) : 0, fail: fail ? Number(fail[1]) : 0 };
}

// ---- flake state ----

export interface FlakeState { [fingerprint: string]: { test: string; error: string; nights: string[] } }

/** The flake memory: `${XDG_STATE_HOME:-~/.local/state}/mercury/nightly/e2e-flakes.json`, 0600. */
export function statePath(env: NodeJS.ProcessEnv): string {
  if (env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== '') {
    return `${env.XDG_STATE_HOME}/mercury/nightly/e2e-flakes.json`;
  }
  const home = env.HOME && env.HOME.trim() !== '' ? env.HOME : homedir();
  if (!home || home.trim() === '' || home === '/') {
    throw new Error('cannot locate a state directory: set XDG_STATE_HOME (or HOME) — the flake clock needs a writable home');
  }
  return `${home}/.local/state/mercury/nightly/e2e-flakes.json`;
}

export function loadFlakeState(env: NodeJS.ProcessEnv): FlakeState {
  const p = statePath(env);
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as FlakeState;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {}; // a corrupt state file resets the flake clocks rather than crashing the night
  }
}

export function saveFlakeState(env: NodeJS.ProcessEnv, state: FlakeState): void {
  const p = statePath(env);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(p, 0o600);
}

/** Record one flake night; returns how many DISTINCT nights the fingerprint has now flaked. */
export function recordFlakeNight(state: FlakeState, fp: string, test: string, error: string, night: string): number {
  const entry = state[fp] ?? { test, error, nights: [] };
  if (!entry.nights.includes(night)) entry.nights.push(night);
  entry.test = test;
  entry.error = error;
  state[fp] = entry;
  return entry.nights.length;
}

// ---- GitHub I/O (thin, bounded, fail-closed on transport) ----

function ghToken(env: NodeJS.ProcessEnv): string {
  const tok = env.GH_TOKEN || env.GITHUB_TOKEN || '';
  if (!tok) throw new Error('GH_TOKEN (or GITHUB_TOKEN) is required: the skill files and comments on issues');
  return tok;
}

async function ghGet(path: string, token: string): Promise<{ body: unknown; status: number }> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok && res.status >= 500) throw new Error(`GET ${path} -> ${res.status}`);
  return { body: await res.json().catch(() => null), status: res.status };
}

async function ghPost(path: string, body: unknown, token: string): Promise<{ body: unknown; status: number }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok && res.status >= 500) throw new Error(`POST ${path} -> ${res.status}`);
  return { body: await res.json().catch(() => null), status: res.status };
}

/** The injected I/O surface: the suite runner and the GitHub calls. Tests pass fakes. */
export interface E2eIo {
  /** Run the suite (or a rerun of one file). Returns the COMBINED output and exit code. */
  run(argv: string[], opts: { timeoutMs: number }): Promise<{ code: number; output: string }>;
  get(path: string): Promise<{ body: unknown; status: number }>;
  post(path: string, body: unknown): Promise<{ body: unknown; status: number }>;
}

// ---- the pipeline ----

/**
 * The nightly E2E pass. `firstRun`/`rerun` come from io.run; `night` is the local date (YYYY-MM-DD)
 * the report cites. Dry-run never writes to GitHub (state still advances: the flake clock is
 * local, and a night whose observations are not recorded was not observed).
 */
export async function runE2eSkill(
  io: E2eIo,
  env: NodeJS.ProcessEnv,
  opts: { repo: string; dryRun: boolean; night: string; suiteTimeoutMs?: number; cwd?: string },
): Promise<E2eReport> {
  if (!REPO_RE.test(opts.repo)) {
    throw new Error(`repo must be exactly owner/name (e.g. aywengo/mercury); got '${opts.repo}'`);
  }
  const timeoutMs = opts.suiteTimeoutMs ?? 20 * 60_000; // the prepr gate's e2e deadline
  const first = await io.run(['npm', 'run', 'test:e2e'], { timeoutMs });
  const counts = parseCounts(first.output);
  const report: E2eReport = { ...counts, real: [], flakes: [] };
  if (first.code === 0) return report;

  const failures = parseFailures(first.output);
  // The token is required only when GitHub is actually read/written; a fully dry or green night
  // with no failures must not demand credentials.
  let cachedToken: string | null = null;
  const token = (): string => {
    if (cachedToken === null) cachedToken = ghToken(env);
    return cachedToken;
  };
  const state = loadFlakeState(env);
  let stateDirty = false;

  for (const failure of failures) {
    // Rerun ONCE. A named file reruns just that file (the suite is minutes long; the rerun's job
    // is only to separate flake from defect); without a file the whole suite reruns.
    const rerunArgv = failure.file
      ? ['node', '--test', failure.file]
      : ['npm', 'run', 'test:e2e'];
    const rerun = await io.run(rerunArgv, { timeoutMs });
    const fp = await fingerprintOf(failure.test, failure.error);
    if (rerun.code === 0) {
      // Flake. Record the night; file only when the same fingerprint flaked on FLAKE_FILE_NIGHTS nights.
      const nights = recordFlakeNight(state, fp, failure.test, failure.error, opts.night);
      stateDirty = true;
      // Exactly ONCE: nights counts DISTINCT nights, so === hits only on the threshold night.
      // >= would re-file the same flaky-test issue on nights 4, 5, ... (no filed-marker state).
      if (nights === FLAKE_FILE_NIGHTS && !opts.dryRun) {
        const nightsList = state[fp]!.nights.join(', ');
        const body = [
          `Flake filed by the nightly E2E skill (N1-2): the fingerprint below flaked on ${nights} distinct nights (${nightsList}).`,
          '',
          `**Test:** \`${failure.test}\``,
          '',
          '**Error (normalized on filing):**',
          '```',
          normalizeErrorLine(failure.error),
          '```',
          '',
          fpMarker(fp),
          '',
          'Filed per docs/nightly-issues.md §N1-2: the same fingerprint flaked on three nights, so it is a defect worth a dedicated fix, not a report line.',
        ].join('\n');
        const res = await io.post(`/repos/${opts.repo}/issues`, { title: `Flaky test: ${failure.test}`, body, labels: ['origin:e2e'] });
        if (res.status >= 200 && res.status < 300) {
          const issue = (res.body as { number?: number })?.number;
          report.flakes.push({ test: failure.test, error: failure.error, fingerprint: fp, nights, ...(issue ? { issue } : {}) });
        } else {
          report.flakes.push({ test: failure.test, error: failure.error, fingerprint: fp, nights });
        }
      } else {
        report.flakes.push({ test: failure.test, error: failure.error, fingerprint: fp, nights });
      }
      continue;
    }
    // Real failure: comment on the open issue carrying the marker, or file a new one.
    // Dry-run is local observation: it never reads GitHub, so it needs no credentials.
    if (opts.dryRun) {
      report.real.push({ test: failure.test, error: failure.error, fingerprint: fp, action: 'dry-run' });
      continue;
    }
    const marker = fpMarker(fp);
    let existing: number | null;
    try {
      existing = await findIssueByMarker(io, opts.repo, marker, token());
    } catch (e: unknown) {
      // The search failed (rate limit, permissions, unexpected response): "no match" is NOT
      // established, so filing could duplicate. Record the observation and skip this night.
      report.real.push({ test: failure.test, error: failure.error, fingerprint: fp, action: 'dry-run' });
      continue;
    }
    if (existing) {
      const comment = [
        `Reproduced on the night of ${opts.night}. The failure fingerprint matches this issue.`,
        '',
        '**Error (normalized):**',
        '```',
        normalizeErrorLine(failure.error),
        '```',
        '',
        marker,
      ].join('\n');
      const res = await io.post(`/repos/${opts.repo}/issues/${existing}/comments`, { body: comment });
      if (res.status >= 200 && res.status < 300) {
        report.real.push({ test: failure.test, error: failure.error, fingerprint: fp, issue: existing, action: 'commented' });
      } else {
        // The comment failed (rate limit, permissions): still record the observation honestly.
        report.real.push({ test: failure.test, error: failure.error, fingerprint: fp, issue: existing, action: 'dry-run' });
      }
      continue;
    }
    const body = [
      `Filed by the nightly E2E skill (N1-2) on ${opts.night}: the suite failed and the failure reproduced on an immediate single rerun of the same file.`,
      '',
      `**Test:** \`${failure.test}\``,
      '',
      '**Error (normalized on filing):**',
      '```',
      normalizeErrorLine(failure.error),
      '```',
      '',
      `The fingerprint below identifies this defect. Later nights COMMENT on this issue instead of filing duplicates; the marker is a hidden HTML comment, matched by exact string.`,
      '',
      marker,
    ].join('\n');
    const res = await io.post(`/repos/${opts.repo}/issues`, { title: `E2E failure: ${failure.test}`, body, labels: ['origin:e2e'] });
    if (res.status >= 200 && res.status < 300) {
      const issue = (res.body as { number?: number })?.number;
      report.real.push({ test: failure.test, error: failure.error, fingerprint: fp, ...(issue ? { issue } : {}), action: 'filed' });
    } else {
      report.real.push({ test: failure.test, error: failure.error, fingerprint: fp, action: 'dry-run' });
    }
  }
  if (stateDirty) saveFlakeState(env, state);
  return report;
}

/** Find the OPEN issue whose body carries the exact fingerprint marker. Walks ?page=N (the io
 * contract hides headers, and GitHub's REST pagination accepts an explicit page parameter),
 * bounded at 10 pages = the newest 1000 open issues. */
export async function findIssueByMarker(io: E2eIo, repo: string, marker: string, token: string): Promise<number | null> {
  for (let page = 1; page <= 10; page++) {
    const res = await io.get(`/repos/${repo}/issues?state=open&per_page=100&page=${page}`);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`issue search failed: GET /repos/${repo}/issues page ${page} returned ${res.status}`);
    }
    const issues = (res.body as { number?: number; body?: string | null; pull_request?: unknown }[] | null) ?? [];
    for (const issue of issues) {
      if (issue.pull_request) continue;
      if ((issue.body ?? '').includes(marker)) return issue.number ?? null;
    }
    if (issues.length < 100) break; // last page
  }
  return null;
}

// ---- main ----

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const args = process.argv.slice(2);
  const repo = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  const stateArg = args.includes('--state') ? args[args.indexOf('--state') + 1] : undefined;
  if (!repo) {
    console.error('usage: e2e.ts --repo <owner/name> [--dry-run] [--state <path>]');
    process.exit(1);
  }
  const env = { ...process.env, ...(stateArg ? { XDG_STATE_HOME: stateArg } : {}) };
  const { spawn } = await import('node:child_process');
  const cwd = process.cwd();
  const run = (argv: string[], o: { timeoutMs: number }): Promise<{ code: number; output: string }> =>
    new Promise((resolve) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => { output += d; });
      child.stderr.on('data', (d: string) => { output += d; });
      const killer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs);
      child.on('exit', (code) => { clearTimeout(killer); resolve({ code: code ?? 1, output }); });
      child.on('error', () => { clearTimeout(killer); resolve({ code: 1, output }); });
    });
  // Lazy: the token is demanded only when a GitHub call is actually made — a green suite or
  // --dry-run needs no credentials.
  let cachedToken: string | null = null;
  const token = (): string => {
    if (cachedToken === null) cachedToken = ghToken(env);
    return cachedToken;
  };
  runE2eSkill(
    {
      run,
      get: async (path) => await ghGet(path, token()),
      post: async (path, body) => await ghPost(path, body, token()),
    },
    env,
    { repo, dryRun, night: new Date().toISOString().slice(0, 10) },
  )
    .then((report) => { process.stdout.write(JSON.stringify(report) + '\n'); })
    .catch((e: unknown) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    });
}

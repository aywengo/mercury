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
 * Usage: `node .agents/skills/nightly/e2e.ts --repo aywengo/mercury [--dry-run] [--state <state-home-dir>]`
 * Environment: GH_TOKEN (or GITHUB_TOKEN), demanded only when GitHub is actually touched — a green
 * suite (no failures) and --dry-run (local observation) need no credentials. The suite runs via
 * `npm run test:e2e` from the repository root (needs Docker). `--state` overrides XDG_STATE_HOME
 * (the STATE-HOME directory; the flake state lands at <state-home>/mercury/nightly/e2e-flakes.json).
 *
 * No dependencies. Fetch only. Everything testable is a pure function or runs over injected I/O.
 */

import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { REPO_RE, localDateString, ghToken, ghGet, ghPost, FETCH_TIMEOUT_MS } from './shared.ts';
// The SAME redaction Mercury applies to event content (#806): one implementation, no drift.
import { createRedactor } from '../../../src/domain/redact.ts';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// REPO_RE comes from shared.ts (#769): one strict regex everywhere.
/** A flake is filed as a defect only after the same fingerprint flaked on 3 distinct nights. */
export const FLAKE_FILE_NIGHTS = 3;


// The LOCAL date helper lives in shared.ts (#769); re-exported so report.ts and the tests keep
// one import path.
export { localDateString } from './shared.ts';

export interface SuiteFailure {
  /** The failing test's full name from the spec reporter. */
  test: string;
  /** The SPECIFIC error line, e.g. `AssertionError [ERR_ASSERTION]: numbers diverge`. Empty when
   * the block held only Node's generic wrapper lines (nothing fingerprintable). */
  error: string;
  /** The test file the failure was reported at, when the output names one. */
  file?: string;
  /** The failure's raw detail block (lines after the ✖ header to the next `test at`/`✖` line),
   * for the bounded redacted attachment on filed issues and comments (#806). */
  raw?: string[];
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
    .replace(/(?:[A-Za-z]:)?(?:\\|\/)(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:ts|js|mjs|cjs)/g, (m) => basename(m.replace(/\\/g, '/')))
    .replace(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:ts|js|mjs|cjs)/g, (m) => basename(m.replace(/\\/g, '/')))
    .replace(/:\d+(?::\d+)?/g, '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|min|h)\b/g, '<dur>')
    .replace(/\b\d+(?:,\d{3})*\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The fingerprint: sha-256 over test name + normalized error, first 16 hex chars. */
export async function fingerprintOf(test: string, error: string): Promise<string> {
  return createHash('sha256').update(`${test}\n${normalizeErrorLine(error)}`).digest('hex').slice(0, 16);
}

/** The hidden marker an issue carries in its body; searches match on it, not on prose. */
export const fpMarker = (fp: string): string => `<!-- nightly-e2e-fp:${fp} -->`;

// ---- parsing the spec reporter ----

/**
 * Node's generic wrapper error lines (#806): they say a test or file failed, never WHY. When a
 * whole file fails, the spec reporter prints one of these FIRST and the specific cause (the load
 * error, the first failing subtest's assertion) after it. Choosing one of these as the error
 * makes the fingerprint file name + "test failed", which merges distinct defects in one file.
 */
const GENERIC_WRAPPER_LINES: readonly RegExp[] = [
  /^'?test failed'?$/,
  /^\d+ subtests? failed$/,
  /^test did not finish before its parent and was cancelled$/,
  /^Promise resolution is still pending but the event loop has already resolved$/,
];

/** An `Error`-family message line: `Error: boom`, `Error [ERR_X]: msg`, `AssertionError [...]`. */
const ERROR_NAME_RE = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*Error(?:\s*\[[A-Z0-9_]+\])?:\s*(.*)$/;

/** A `code: 'ERR_…'` line from the failure object dump. */
const ERR_CODE_LINE_RE = /^code:\s*['"]ERR_[A-Z0-9_]+['"],?$/;

/** True when the line is one of the generic wrappers, unwrapping an `Error […]:` prefix and
 * quotes so `Error [ERR_TEST_FAILURE]: 'test failed'` still counts as generic. */
function isGenericWrapperLine(s: string): boolean {
  const body = (ERROR_NAME_RE.exec(s)?.[1] ?? s).trim().replace(/^['"]|['"]$/g, '').trim();
  return GENERIC_WRAPPER_LINES.some((re) => re.test(body));
}

/**
 * Choose the failure's error line from its detail block (#806): the first specific line,
 * preferring, in order, an Error/AssertionError message line, a `code: 'ERR_…'` line, then the
 * first line that is not a stack frame. Generic wrapper lines, reporter summary lines (`ℹ`),
 * `test at`/`✖` headers and blank lines never win — a block holding only them yields '' (the
 * caller treats that like the no-error case: no fingerprint, no filing).
 */
function chooseErrorLine(block: string[]): string {
  const structural = (s: string): boolean =>
    s === '' ||
    s.startsWith('test at') ||
    s.startsWith('✖') ||
    s.startsWith('ℹ') ||
    /^⎯+$/.test(s) ||
    /^at\b/.test(s) || // stack frames (`at Test...`, `at async ...`)
    isGenericWrapperLine(s);
  for (const raw of block) {
    const s = raw.trim();
    if (!structural(s) && ERROR_NAME_RE.test(s)) return s;
  }
  for (const raw of block) {
    const s = raw.trim();
    if (!structural(s) && ERR_CODE_LINE_RE.test(s)) return s;
  }
  for (const raw of block) {
    const s = raw.trim();
    if (!structural(s)) return s;
  }
  return '';
}

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
    // Greedy capture + suffix strip: a non-greedy (.*?) would stop at the drive colon of
    // C:\repo\system.test.ts:42:1 and capture just 'C'.
    const at = /^\s*test at (.+):\d+(?::\d+)?\s*$/.exec(l);
    if (at?.[1]) {
      // Greedy capture keeps Windows drive colons; any trailing :line:col groups were matched by
      // the suffix regex, but a single-suffix line can leave :N inside the capture - strip it.
      pendingFile = at[1].replace(/:\d+$/, '');
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
    // Duration form first; the no-duration form must be an EXACT line match - a prefix match
    // would bind 'alpha' to the block of 'alpha works' when one name prefixes another.
    const idx = detail.findIndex((l) => l.startsWith(`✖ ${f.test} (`) || l.trim() === `✖ ${f.test}`);
    if (idx === -1) continue; // no detail block line for this name: leave the error empty
    // The failure's detail block runs to the next `test at` or `✖` line (#806): not a fixed
    // 12-line window, which could stop short of the specific cause after a generic wrapper.
    const block: string[] = [];
    for (let i = idx + 1; i < detail.length; i++) {
      const l = detail[i]!;
      const s = l.trim();
      if (s.startsWith('test at') || s.startsWith('✖')) break;
      block.push(l);
    }
    while (block.length > 0 && (block[block.length - 1]!.trim() === '' || block[block.length - 1]!.trim().startsWith('ℹ'))) block.pop();
    f.raw = block;
    f.error = chooseErrorLine(block);
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
    const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    // Shape-validate every entry: a valid-JSON-but-wrong shape (an array, a stray string, an
    // entry without a nights array) would otherwise corrupt later saves or crash the night.
    const out: FlakeState = {};
    for (const [fp, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (entry === null || typeof entry !== 'object') continue;
      const e = entry as { test?: unknown; error?: unknown; nights?: unknown };
      if (typeof e.test !== 'string' || typeof e.error !== 'string' || !Array.isArray(e.nights)) continue;
      if (!e.nights.every((n) => typeof n === 'string')) continue;
      out[fp] = { test: e.test, error: e.error, nights: [...e.nights] };
    }
    return out;
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

/** The injected I/O surface: the suite runner and the GitHub calls. Tests pass fakes. */
export interface E2eIo {
  /** Run the suite (or a rerun of one file). Returns the COMBINED output and exit code. */
  run(argv: string[], opts: { timeoutMs: number }): Promise<{ code: number; output: string }>;
  get(path: string): Promise<{ body: unknown; status: number }>;
  post(path: string, body: unknown): Promise<{ body: unknown; status: number }>;
}

// ---- the bounded raw-block attachment (#806) ----

/** Bounds for the raw detail block attached to filed issues and comments. */
export const RAW_BLOCK_MAX_LINES = 60;
export const RAW_BLOCK_MAX_BYTES = 6 * 1024;

/**
 * The failure's raw detail block as a collapsed `<details>` section: redacted with the same
 * redactor Mercury applies to event content, then bounded (first 60 lines, max 6 kB). Empty when
 * the failure has no block. The fingerprint is computed from the normalized error line only, so
 * this section never changes how failures match existing issues.
 */
export function rawDetailsSection(failure: Pick<SuiteFailure, 'raw'>): string {
  if (!failure.raw || failure.raw.length === 0) return '';
  let text = createRedactor().redact(failure.raw.join('\n'));
  let lines = text.split('\n').slice(0, RAW_BLOCK_MAX_LINES);
  while (lines.length > 0 && Buffer.byteLength(lines.join('\n'), 'utf8') > RAW_BLOCK_MAX_BYTES) lines = lines.slice(0, -1);
  text = lines.join('\n');
  return [
    '<details>',
    '<summary>Raw failure output (redacted, bounded)</summary>',
    '',
    '```',
    text,
    '```',
    '</details>',
  ].join('\n');
}

/**
 * Join issue-body parts, inserting the bounded raw-block section just before the fingerprint
 * marker when the failure carries a detail block (#806). Empty-string parts are markdown blank
 * lines and are preserved, never filtered.
 */
function joinWithRawBlock(parts: string[], marker: string, failure: SuiteFailure): string {
  const raw = rawDetailsSection(failure);
  if (!raw) return parts.join('\n');
  const at = parts.indexOf(marker);
  const out = parts.slice();
  out.splice(at === -1 ? out.length : at, 0, raw, '');
  return out.join('\n');
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
  opts: { repo: string; dryRun: boolean; night: string; suiteTimeoutMs?: number },
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
  if (failures.length === 0) {
    // The suite failed but the reporter output yielded no parseable failures (format drift,
    // harness crash). Never file blind: one honest observation, no GitHub actions.
    report.real.push({ test: '<unparseable suite failure>', error: normalizeErrorLine(first.output.split('\n').find((l) => l.trim() !== '') ?? ''), fingerprint: '', action: 'dry-run' });
    return report;
  }
  const state = loadFlakeState(env);
  let stateDirty = false;

  // Credentials are demanded lazily at the FIRST actual GitHub touch (a green suite returned
  // earlier; dry-run and unparseable paths continue without any): the gated io below enforces
  // that for the real transport AND for injected io.
  let tokenChecked = false;
  const gatedIo: E2eIo = {
    run: io.run,
    async get(path) {
      if (!tokenChecked) { ghToken(env); tokenChecked = true; }
      return io.get(path);
    },
    async post(path, body) {
      if (!tokenChecked) { ghToken(env); tokenChecked = true; }
      return io.post(path, body);
    },
  };

  for (const failure of failures) {
    // Rerun ONCE. A named file reruns just that file (the suite is minutes long; the rerun's job
    // is only to separate flake from defect); without a file the whole suite reruns.
    const rerunArgv = failure.file
      ? ['node', '--test', failure.file]
      : ['npm', 'run', 'test:e2e'];
    const rerun = await io.run(rerunArgv, { timeoutMs });
    if (rerun.code !== 0) {
      // The rerun is the confirmation run: when it names the same test with a different primary
      // error line, THAT is the reproducible signature — fingerprint and file from the rerun.
      const rerunFailures = parseFailures(rerun.output);
      const same = rerunFailures.find((f) => f.test === failure.test);
      if (same && same.error) {
        failure.error = same.error;
        if (same.raw && same.raw.length > 0) failure.raw = same.raw; // attach the reproducible run's block
      }
    }
    if (!failure.error) {
      // No SPECIFIC error line could be extracted from either run (an empty block, or only
      // Node's generic wrapper lines like 'test failed'): the fingerprint would collapse to the
      // test name alone — or to the wrapper — and merge distinct defects. Observe honestly and
      // skip filing; the first raw line (when any) is the reason the report can show.
      const reason = (failure.raw ?? []).map((l) => l.trim()).find((s) => s !== '' && !/^at\b/.test(s)) ?? '';
      report.real.push({ test: failure.test, error: reason, fingerprint: '', action: 'dry-run' });
      continue;
    }
    const fp = await fingerprintOf(failure.test, failure.error);
    if (rerun.code === 0) {
      // Flake. Record the night; file only when the same fingerprint flaked on FLAKE_FILE_NIGHTS nights.
      const nights = recordFlakeNight(state, fp, failure.test, failure.error, opts.night);
      stateDirty = true;
      // Exactly ONCE: nights counts DISTINCT nights, so === hits only on the threshold night.
      // >= would re-file the same flaky-test issue on nights 4, 5, ... (no filed-marker state).
      if (nights === FLAKE_FILE_NIGHTS && !opts.dryRun) {
        const nightsList = state[fp]!.nights.join(', ');
        const body = joinWithRawBlock([
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
        ], fpMarker(fp), failure);
        const res = await gatedIo.post(`/repos/${opts.repo}/issues`, { title: `Flaky test: ${failure.test}`, body, labels: ['origin:e2e'] });
        if (res.status >= 200 && res.status < 300) {
          const issue = (res.body as { number?: number })?.number;
          report.flakes.push({ test: failure.test, error: failure.error, fingerprint: fp, nights, ...(issue ? { issue } : {}) });
        } else {
          // The create failed (rate limit, permissions): roll THIS night back off the clock so
          // the counter returns to FLAKE_FILE_NIGHTS - 1 and the NEXT night retries the filing.
          // Without the rollback the burned threshold night would make the flake unfillable.
          const entry = state[fp]!;
          const k = entry.nights.lastIndexOf(opts.night);
          if (k !== -1) entry.nights.splice(k, 1);
          report.flakes.push({ test: failure.test, error: failure.error, fingerprint: fp, nights: entry.nights.length });
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
      existing = await findIssueByMarker(gatedIo, opts.repo, marker);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('GH_TOKEN')) throw e; // missing credentials is not a "failed search"

      // The search failed (rate limit, permissions, unexpected response): "no match" is NOT
      // established, so filing could duplicate. Record the observation and skip this night.
      report.real.push({ test: failure.test, error: failure.error, fingerprint: fp, action: 'dry-run' });
      continue;
    }
    if (existing) {
      const comment = joinWithRawBlock([
        `Reproduced on the night of ${opts.night}. The failure fingerprint matches this issue.`,
        '',
        '**Error (normalized):**',
        '```',
        normalizeErrorLine(failure.error),
        '```',
        '',
        marker,
      ], marker, failure);
      const res = await gatedIo.post(`/repos/${opts.repo}/issues/${existing}/comments`, { body: comment });
      if (res.status >= 200 && res.status < 300) {
        report.real.push({ test: failure.test, error: failure.error, fingerprint: fp, issue: existing, action: 'commented' });
      } else {
        // The comment failed (rate limit, permissions): still record the observation honestly.
        report.real.push({ test: failure.test, error: failure.error, fingerprint: fp, issue: existing, action: 'dry-run' });
      }
      continue;
    }
    const body = joinWithRawBlock([
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
    ], marker, failure);
    const res = await gatedIo.post(`/repos/${opts.repo}/issues`, { title: `E2E failure: ${failure.test}`, body, labels: ['origin:e2e'] });
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
export async function findIssueByMarker(io: E2eIo, repo: string, marker: string): Promise<number | null> {
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

/**
 * Install the suite's dependencies when the workspace has no node_modules.
 *
 * A fresh Run workspace is a clean git worktree with nothing installed: the workspace
 * manager creates the tree and installs no dependencies. Left unchecked, `npm run
 * test:e2e` fails to load (ERR_MODULE_NOT_FOUND) before any test runs, and the spec
 * reporter reports the file as a failing "test" — which this skill would file as a
 * defect for a suite that is actually healthy. The guard turns that environment problem
 * into a clear, honest error instead of a spurious issue.
 *
 * Throws when the install fails, so the caller can stop without proceeding to a suite
 * that could not load.
 */
export async function ensureDependencies(
  run: E2eIo['run'],
  cwd: string,
): Promise<void> {
  if (existsSync(join(cwd, 'node_modules'))) return;
  const dep = await run(['npm', 'ci'], { timeoutMs: 300_000 });
  if (dep.code !== 0) {
    throw new Error('the E2E suite cannot run: `npm ci` failed\n' + dep.output.slice(-1000));
  }
}

// ---- main ----

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const args = process.argv.slice(2);
  const repo = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  const stateArg = args.includes('--state') ? args[args.indexOf('--state') + 1] : undefined;
  if (!repo) {
    console.error('usage: e2e.ts --repo <owner/name> [--dry-run] [--state <state-home-dir>]');
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
      // 'close', not 'exit': exit can fire before stdout/stderr are fully drained, truncating the
      // output the parser and fingerprints depend on.
      child.on('close', (code) => { clearTimeout(killer); resolve({ code: code ?? 1, output }); });
      child.on('error', () => { clearTimeout(killer); resolve({ code: 1, output }); });
    });
  // A fresh Run workspace has no node_modules (the workspace manager installs nothing).
  // Without the suite's dependencies the suite would fail to load (ERR_MODULE_NOT_FOUND)
  // and this skill would file a spurious issue for healthy tests. Install them, or stop
  // with an honest error rather than proceeding to a suite that could not load.
  try {
    await ensureDependencies(run, cwd);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
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
    // Local date, not UTC: a 00:05 local fire must count as THIS local night (UTC can already
    // be the next day).
    { repo, dryRun, night: localDateString() },
  )
    .then((report) => { process.stdout.write(JSON.stringify(report) + '\n'); })
    .catch((e: unknown) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    });
}

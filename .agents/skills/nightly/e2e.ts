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
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRedactor } from '../../../src/domain/redact.ts';
import { forwardedCredentialValues } from '../../../src/sandbox/sandboxManager.ts';

// REPO_RE comes from shared.ts (#769): one strict regex everywhere.
/** A flake is filed as a defect only after the same fingerprint flaked on 3 distinct nights. */
export const FLAKE_FILE_NIGHTS = 3;


// The LOCAL date helper lives in shared.ts (#769); re-exported so report.ts and the tests keep
// one import path.
export { localDateString } from './shared.ts';

export interface SuiteFailure {
  /** The failing test's full name from the spec reporter. */
  test: string;
  /** First SPECIFIC line of the error output, e.g. `AssertionError [ERR_ASSERTION]: numbers diverge`. */
  error: string;
  /** The test file the failure was reported at, when the output names one. */
  file?: string;
  /**
   * The failure's raw detail block (bounded, un-normalized), kept so filed issues can carry the
   * diagnostic that generic wrapper lines would have hidden (#806). Empty for a failure with no
   * detail block lines.
   */
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

// Two redaction layers, matching the CLI's event redactor (src/cli.ts): the operator's declared
// MERCURY_SECRETS plus the exact values of forwarded provider credentials. The e2e skill posts
// failure output to GitHub - a credential that reaches an agent can reach the issue body unless
// redaction tracks forwarding (#817 review: the shape-only redactor let a literal secret through).
let rawRedactorInstance: ReturnType<typeof createRedactor> | null = null;

/**
 * The redactor, built on FIRST USE rather than at module load: the skill reads MERCURY_SECRETS
 * and forwarded credential values from its own process env, and tests (which set env per-case)
 * must see the current values, not whatever the import-time environment had. Layers match the
 * CLI's event redactor: operator-declared MERCURY_SECRETS + exact forwarded credential values
 * (#817 review: shape-only redaction let a declared literal secret through).
 */
function rawRedactor(): ReturnType<typeof createRedactor> {
  if (rawRedactorInstance === null) {
    rawRedactorInstance = createRedactor([
      ...(process.env.MERCURY_SECRETS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      // The configured sandbox allowlist, with the CLI's config semantics (src/config.ts):
      // MERCURY_SANDBOX_ENV unset -> null (the built-in model-provider allowlist); set -> the
      // operator's exact list (possibly empty = forward nothing but PATH). A custom forwarded
      // variable like MY_PROVIDER_KEY must be redacted by VALUE even when its name matches no
      // token shape (#811 r2).
      ...forwardedCredentialValues(
        process.env,
        process.env.MERCURY_SANDBOX_ENV === undefined
          ? null
          : process.env.MERCURY_SANDBOX_ENV.split(',').map((v) => v.trim()).filter(Boolean),
      ),
    ]);
  }
  return rawRedactorInstance;
}

/** Test hook: drop the memoized redactor so a later call re-reads the environment. */
export function resetRawRedactorForTests(): void {
  rawRedactorInstance = null;
}

/**
 * The failure's RAW detail block, redacted with the same secret shapes Mercury applies to event
 * content, as a collapsed <details> section for an issue body or comment (#806). The section is
 * omitted when there is no block. The marker/normalized error stay OUTSIDE this — they are
 * machine-matched and hashed, never human-read raw.
 */
export function rawDetailsSection(failure: { raw?: string[] }): string[] {
  const raw = failure.raw ?? [];
  if (raw.length === 0) return [];
  // Redact the JOINED block, not each split line: a credential value can span a line boundary
  // (a trailing newline inside a quoted env value), and the exact-value pattern registered from
  // the forwarded credential then matches only across the original text (#811 r3, high).
  const redactedText = rawRedactor().redact(raw.join('\n'));
  const redacted = redactedText.split('\n');
  const fence = codeFence(redacted);
  return ['', '<details>', '<summary>Raw failure block (redacted)</summary>', '', fence, ...redacted, fence, '', '</details>', ''];
}

/**
 * A fenced-code fence LONGER than the longest backtick run in the content: a fixed ``` fence
 * closes early when a failure prints Markdown (an assertion diff with a ``` block), which breaks
 * the collapsed <details> section and swallows the issue text after it (#811/#817 review). Four
 * backticks is the common case (content containing ```); grow to fit so the fence can never
 * appear in the content.
 */
export function codeFence(contentLines: string[]): string {
  let longest = 0;
  for (const line of contentLines) {
    for (const run of line.match(/`+/g) ?? []) {
      if (run.length > longest) longest = run.length;
    }
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The normalized error line, redacted with the same secret shapes as the raw block: the error
 *  can carry credential shapes too (a URL with an embedded token, for example), and it posts
 *  OUTSIDE the collapsed section (#817 review). */
export function redactedErrorLine(failure: { error: string }): string {
  // Redact FIRST, then normalize: normalizeErrorLine rewrites numbers/paths/hex (`<n>`), which
  // can mutate a registered exact-value secret before the redactor's literal pattern could match
  // it — `custom-secret-806` became `custom-secret-<n>` and posted publicly (#811 r7, high).
  // Normalizing the ALREADY-redacted text is safe: '[REDACTED]' contains no digits/paths to rewrite.
  return normalizeErrorLine(rawRedactor().redact(failure.error));
}

// ---- parsing the spec reporter ----

/**
 * Error lines that identify the INCIDENT, not the DEFECT: node's spec reporter synthesizes them
 * when a whole test file fails (child exited nonzero without a reportable error — the stack went
 * to stderr) or when a parent test is cancelled with pending subtests. A failure whose FIRST
 * detail line is one of these has its real cause further down the block (#806). Note
 * 'test timed out after …ms' is NOT generic: a timeout often IS the reproducible signature.
 */
const GENERIC_ERROR_RE =
  /^'?test failed'?$|^'?\d+ subtests? failed'?$|^'?test did not finish before its parent and was cancelled'?$|^'?Promise resolution is still pending but the event loop has already resolved'?$/;

/** A stack frame line ("    at TestContext.<anonymous> (file:///…)"), not a message. */
const STACK_FRAME_RE = /^\s*at\s|^\s+at\s/;

const RAW_BLOCK_MAX_LINES = 60;
const RAW_BLOCK_MAX_BYTES = 6 * 1024;

/**
 * The bounded RAW detail block of one failure: everything after its ✖ line up to the next
 * `test at` or `✖` line (the block the issue body will carry verbatim, redacted). Bounded at
 * RAW_BLOCK_MAX_LINES lines and RAW_BLOCK_MAX_BYTES bytes; a `…` line marks truncation.
 */
export function rawBlockOf(detail: string[], idx: number): string[] {
  const raw: string[] = [];
  let bytes = 0;
  for (let i = idx + 1; i < detail.length; i++) {
    const l = detail[i]!;
    const s = l.trim();
    if (s.startsWith('test at') || s.startsWith('✖')) break;
    // Count real UTF-8 bytes (the promise in the doc comment): a astral-heavy line (emoji) is
    // 2 UTF-16 units per glyph but 3-4 bytes each (#811 r3).
    const lineBytes = Buffer.byteLength(l, 'utf8');
    if (raw.length >= RAW_BLOCK_MAX_LINES || bytes + lineBytes + 1 > RAW_BLOCK_MAX_BYTES) {
      raw.push('…');
      break;
    }
    raw.push(l.replace(/\s+$/, ''));
    bytes += lineBytes + 1;
  }
  while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') raw.pop();
  return raw;
}

/**
 * Pick the SPECIFIC error line for one failure and attach the raw block. Preference order
 * within the block: an Error/AssertionError message line, a `code: 'ERR_…'` line, then the
 * first line that is neither generic nor a stack frame. Only-generic blocks leave the error
 * empty — the caller's existing no-error path (no fingerprint, no filing) takes over.
 *
 * The block usually carries a specific line even for a file-level failure: `e2e.ts`'s runner
 * captures stderr into the same `output`, so the load error that PRECEDED the report sits inside
 * this failure's detail block. When it does not (a genuine wrapper-only block), `stderr` — the
 * output before the `✖ failing tests:` detail block — is searched as a fallback before giving up.
 */
function extractError(detail: string[], idx: number, f: SuiteFailure, stderr: string, stderrIsReal = false): void {
  // Pick the cause from the COMPLETE detail block, not from the bounded attachment copy: a
  // wrapper followed by 60 diagnostic lines puts the real Error beyond RAW_BLOCK_MAX_LINES, and
  // picking from the bounded copy would fingerprint the first diagnostic line instead (#811 r3).
  // The attached f.raw stays bounded independently.
  const blockEnd = detail.findIndex((l, i) => i > idx && (/^\s*test at /.test(l.trim()) || l.trim().startsWith('✖')));
  const fullBlock = (blockEnd === -1 ? detail.slice(idx + 1) : detail.slice(idx + 1, blockEnd)).filter((l) => l.trim() !== '…');
  f.raw = rawBlockOf(detail, idx);
  const picked = pickSpecificLine(fullBlock.map((l) => l.trim()));
  if (picked !== null) {
    f.error = picked;
    return;
  }
  // Wrapper-only block: the cause lives on stderr, before the detail block (the runner combines
  // stdout+stderr, so a load error that aborted the file appears there). The combined prefix can
  // also hold ORDINARY stdout with Error-looking lines ('Error: recovered probe' printed by a
  // passing probe), so a bare Error-shaped line is NOT enough: restrict the fallback to
  // CRASH/LOAD-shaped causes — a module-not-found Error or an ERR_ code — which are exactly the
  // aborts that leave a wrapper-only block (#811 r3). Anything else stays empty: no cause, no
  // filing.
  const stderrLines = stderr.split('\n').map((l) => l.trim());
  // REAL child stderr (captured separately by the runner) carries no stdout noise: any
  // Error/AssertionError/SyntaxError line here is a genuine crash cause of a wrapper-only block
  // (#811 r6). The DERIVED combined prefix can hold ordinary stdout Error-looking lines
  // ('Error: recovered probe' from a passing probe), so it keeps the narrow crash/load-only
  // guard from r3/r4: module-not-found Errors and ERR_-coded Errors only.
  const realErrRe = /^(?:[A-Za-z]*Error|AssertionError|SyntaxError)\b|^Error \[ERR_[A-Z_]+\]:/;
  const derivedErrRe =
    /^Error: (Cannot find module|Module not found)\b|^Error \[ERR_[A-Z_]+\]:/;
  const errLine = stderrLines.find((s) => (stderrIsReal ? realErrRe : derivedErrRe).test(s));
  if (errLine) {
    f.error = errLine;
    return;
  }
  const codeMatch = /code:\s*['"](ERR_[A-Z_]+)['"]/.exec(stderr);
  if (codeMatch?.[1]) {
    f.error = `code: '${codeMatch[1]}'`;
    return;
  }
  f.error = '';
}

/** The first specific message line of a trimmed block: Error-shaped, else ERR_ code, else the
 * first non-generic non-stack-frame line. Null when the block is only generic/empty lines. */
function pickSpecificLine(trimmed: string[]): string | null {
  let codeLine: string | undefined;
  let fallback: string | undefined;
  for (const s of trimmed) {
    if (s === '') continue;
    if (GENERIC_ERROR_RE.test(s)) continue;
    if (STACK_FRAME_RE.test(s)) continue;
    const code = /^code:\s*['"](ERR_[A-Z_]+)['"],?$/.exec(s);
    if (code?.[1]) {
      if (!codeLine) codeLine = `code: '${code[1]}'`;
      continue;
    }
    if (/^(?:[A-Za-z]*Error|AssertionError)\b/.test(s)) return s;
    if (!fallback) fallback = s;
  }
  return codeLine ?? fallback ?? null;
}

/**
 * Extract failing tests from the default (spec) reporter output. The detail block after
 * `✖ failing tests:` prints, per failure, a `test at <file>:<line>:<col>` line followed by the
 * ✖ line with the test's name, then the error. Names are unique per suite run; the first ✖
 * occurrence in the detail block wins for name->file attribution.
 *
 * When a whole test FILE fails, the reporter prints only a generic cause line first —
 * `'test failed'`, `N subtest(s) failed`, `test did not finish before its parent and was
 * cancelled` — while the specific reason (load error, assertion, stack) follows. #806: those
 * wrappers are skipped, so the fingerprint binds to the SPECIFIC cause (a file with two
 * different defects fingerprints differently) and the raw block is kept for the issue body.
 */
export function parseFailures(output: string, realStderr?: string): SuiteFailure[] {
  const lines = output.split('\n');
  const detailStart = lines.findIndex((l) => l.includes('failing tests:'));
  const detail = detailStart >= 0 ? lines.slice(detailStart) : lines;
  // The fallback's cause pool. When the runner reports the child's stderr SEPARATELY, use it —
  // the combined prefix can hold ordinary stdout lines that are not crash causes (#811 r3/r5).
  // Otherwise derive a prefix from the combined output (fixtures and older callers).
  const stderrBeforeDetail =
    realStderr !== undefined
      ? realStderr
      : detailStart > 0
        ? lines.slice(0, detailStart).join('\n')
        : '';
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
    extractError(detail, idx, f, stderrBeforeDetail, realStderr !== undefined);
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
  /** Run the suite (or a rerun of one file). Returns the COMBINED output and exit code.
   *  `stderr` (the child's stderr alone) is optional: fixtures may omit it, and then the
   *  fallback derives a prefix from the combined output. */
  run(argv: string[], opts: { timeoutMs: number }): Promise<{ code: number; output: string; stderr?: string }>;
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

  const failures = parseFailures(first.output, first.stderr);
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
      const rerunFailures = parseFailures(rerun.output, rerun.stderr);
      const same = rerunFailures.find((f) => f.test === failure.test);
      if (same && same.error) {
        failure.error = same.error;
        if (same.raw?.length) failure.raw = same.raw;
      }
    }
    if (!failure.error) {
      // No error line could be extracted from either run: the fingerprint would collapse to the
      // test name alone and could merge distinct defects. Observe honestly; skip filing.
      report.real.push({ test: failure.test, error: '', fingerprint: '', action: 'dry-run' });
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
        const fenceErr = codeFence([normalizeErrorLine(failure.error)]);
        const body = [
          `Flake filed by the nightly E2E skill (N1-2): the fingerprint below flaked on ${nights} distinct nights (${nightsList}).`,
          '',
          `**Test:** \`${failure.test}\``,
          '',
          '**Error (normalized on filing):**',
          fenceErr,
          redactedErrorLine(failure),
          fenceErr,
          ...rawDetailsSection(failure),
          fpMarker(fp),
          '',
          'Filed per docs/nightly-issues.md §N1-2: the same fingerprint flaked on three nights, so it is a defect worth a dedicated fix, not a report line.',
        ].join('\n');
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
      const fenceErr = codeFence([normalizeErrorLine(failure.error)]);
      const comment = [
        `Reproduced on the night of ${opts.night}. The failure fingerprint matches this issue.`,
        '',
        '**Error (normalized):**',
        fenceErr,
        redactedErrorLine(failure),
        fenceErr,
        ...rawDetailsSection(failure),
        marker,
      ].join('\n');
      const res = await gatedIo.post(`/repos/${opts.repo}/issues/${existing}/comments`, { body: comment });
      if (res.status >= 200 && res.status < 300) {
        report.real.push({ test: failure.test, error: failure.error, fingerprint: fp, issue: existing, action: 'commented' });
      } else {
        // The comment failed (rate limit, permissions): still record the observation honestly.
        report.real.push({ test: failure.test, error: failure.error, fingerprint: fp, issue: existing, action: 'dry-run' });
      }
      continue;
    }
    const fenceErr = codeFence([normalizeErrorLine(failure.error)]);
    const body = [
      `Filed by the nightly E2E skill (N1-2) on ${opts.night}: the suite failed and the failure reproduced on an immediate single rerun of the same file.`,
      '',
      `**Test:** \`${failure.test}\``,
      '',
      '**Error (normalized on filing):**',
      fenceErr,
      redactedErrorLine(failure),
      fenceErr,
      ...rawDetailsSection(failure),
      `The fingerprint below identifies this defect. Later nights COMMENT on this issue instead of filing duplicates; the marker is a hidden HTML comment, matched by exact string.`,
      '',
      marker,
    ].join('\n');
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
  const run = (argv: string[], o: { timeoutMs: number }): Promise<{ code: number; output: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => { output += d; });
      child.stderr.on('data', (d: string) => { output += d; stderr += d; });
      const killer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs);
      // 'close', not 'exit': exit can fire before stdout/stderr are fully drained, truncating the
      // output the parser and fingerprints depend on.
      child.on('close', (code) => { clearTimeout(killer); resolve({ code: code ?? 1, output, stderr }); });
      child.on('error', () => { clearTimeout(killer); resolve({ code: 1, output, stderr }); });
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

// The host copilot-relay (deploy/nightly/copilot-relay.sh): the nightly identity cannot obtain a
// Copilot review, so an operator-owned LaunchAgent re-requests one on every open nightly PR whose
// head has none. These tests drive the real script with a fake `gh` -- no network, no GitHub.
//
// The regression this file exists for is not a wrong request; it is a SILENT relay. The first
// version logged only when it acted, so when launchd stopped spawning it the log simply stopped,
// and five nightly PRs sat unreviewed for one to three days before anyone noticed. Every run now
// writes a heartbeat, and these tests pin that: a run that does nothing still says so.
//
// The other failure mode is the opposite: a relay that acts on information it does not have. A
// truncated listing hides PRs, and an unreadable review list reads as "no review on this head", so
// the relay would re-request a review that already exists every pass and report "0 failed". Both
// directions are pinned below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, '..', 'deploy', 'nightly', 'copilot-relay.sh');
const PLIST = join(import.meta.dirname, '..', 'deploy', 'nightly', 'com.mercury.copilot-relay.plist.template');
const REPO = 'aywengo/mercury';

// Emulates `gh api`, including `--paginate`: a second page is emitted only when the caller asked
// for pagination, so a caller that reads one page sees one page -- exactly as GitHub behaves.
const FAKE_GH = `#!/bin/bash
set -u
paginate=0
for a in "$@"; do [ "$a" = "--paginate" ] && paginate=1; done
case "$*" in
  "api user --jq .login")
    [ -n "\${FAKE_USER:-}" ] || exit 1
    echo "$FAKE_USER"; exit 0 ;;
  *"/pulls?state=open"*)
    printf '%s\\n' "\${FAKE_PRS:-}"
    [ "$paginate" = 1 ] && printf '%s\\n' "\${FAKE_PRS_PAGE2:-}"
    exit 0 ;;
  *"/reviews"*)
    n=$(printf '%s' "$*" | sed -n 's|.*/pulls/\\([0-9]*\\)/reviews.*|\\1|p')
    [ -n "\${FAKE_REVIEWS_FAIL:-}" ] && exit 1
    grep "^$n " "\${FAKE_REVIEWED}" 2>/dev/null | awk '{print $2}'
    [ "$paginate" = 1 ] && printf '%s\\n' "\${FAKE_REVIEWS_PAGE2:-}"
    exit 0 ;;
  *"requested_reviewers"*)
    n=$(printf '%s' "$*" | sed -n 's|.*/pulls/\\([0-9]*\\)/requested_reviewers.*|\\1|p')
    printf '%s\\n' "$n" >> "\${FAKE_POSTED}"
    printf '%s\\n' "\${FAKE_POST_STATUS:-HTTP/2.0 201 Created}"
    exit 0 ;;
esac
exit 0
`;

interface Fixture {
  stateDir: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

/** A throwaway state dir, a fake `gh`, and the env the script reads. */
async function fixture(opts: {
  user?: string | null;
  prs?: string;
  prsPage2?: string;
  reviewed?: string;
  reviewsPage2?: string;
  reviewsFail?: boolean;
  postStatus?: string;
}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-relay-'));
  const stateDir = join(dir, 'state');
  await mkdir(stateDir, { recursive: true });
  const gh = join(dir, 'gh');
  await writeFile(gh, FAKE_GH);
  await chmod(gh, 0o755);
  const reviewedFile = join(dir, 'reviewed');
  await writeFile(reviewedFile, opts.reviewed ?? '');
  const postedFile = join(dir, 'posted');
  await writeFile(postedFile, '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_RELAY_STATE_DIR: stateDir,
    MERCURY_RELAY_GH: gh,
    MERCURY_RELAY_REPO: REPO,
    FAKE_REVIEWED: reviewedFile,
    FAKE_POSTED: postedFile,
    FAKE_PRS: opts.prs ?? '',
    FAKE_PRS_PAGE2: opts.prsPage2 ?? '',
    FAKE_REVIEWS_PAGE2: opts.reviewsPage2 ?? '',
    FAKE_POST_STATUS: opts.postStatus ?? 'HTTP/2.0 201 Created',
  };
  if (opts.reviewsFail) env.FAKE_REVIEWS_FAIL = '1';
  if (opts.user !== null) env.FAKE_USER = opts.user ?? 'aywengo';
  return { stateDir, log: join(stateDir, 'copilot-relay.log'), env };
}

async function runRelay(env: NodeJS.ProcessEnv, args: string[] = []): Promise<{ code: number; log: string }> {
  let code = 0;
  try {
    await run('/bin/bash', [SCRIPT, ...args], { env, timeout: 60_000 });
  } catch (err) {
    code = (err as { code?: number }).code ?? 1;
  }
  return { code, log: await readLog(env) };
}

async function readLog(env: NodeJS.ProcessEnv): Promise<string> {
  const logPath = join(String(env.MERCURY_RELAY_STATE_DIR), 'copilot-relay.log');
  return existsSync(logPath) ? await readFile(logPath, 'utf8') : '';
}

async function postedTo(env: NodeJS.ProcessEnv): Promise<string[]> {
  const raw = await readFile(String(env.FAKE_POSTED), 'utf8');
  return raw.split('\n').filter(Boolean);
}

/** Run `--watch` for `ms`, then SIGTERM it. Returns the log it left behind. */
async function runWatch(env: NodeJS.ProcessEnv, ms: number): Promise<string> {
  const child = spawn('/bin/bash', [SCRIPT, '--watch'], { env });
  await new Promise((r) => setTimeout(r, ms));
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  return readLog(env);
}

test('a PR whose head has no Copilot review is re-requested, and the run still writes a heartbeat', async () => {
  const f = await fixture({
    prs: '982 aaaa\n981 bbbb',
    reviewed: '981 bbbb\n', // 982 has no review on head; 981 is current
  });
  const { code, log } = await runRelay(f.env);
  assert.equal(code, 0);
  assert.match(log, /PR #982 head aaaa last-reviewed\s+-> re-requested \(HTTP\/2\.0 201 Created\)/);
  assert.doesNotMatch(log, /PR #981/, 'a PR already reviewed on its head is left alone');
  assert.match(
    log,
    /run: 2 open PR\(s\) by mercury-nightly, 1 re-requested, 1 already reviewed on head, 0 failed/,
  );
  assert.deepEqual(await postedTo(f.env), ['982'], 'exactly the stale PR was re-requested');
});

test('a run with nothing to do still writes its heartbeat - silence must mean dead', async () => {
  const f = await fixture({ prs: '982 aaaa', reviewed: '982 aaaa\n' });
  const { code, log } = await runRelay(f.env);
  assert.equal(code, 0);
  assert.match(log, /run: 1 open PR\(s\) by mercury-nightly, 0 re-requested, 1 already reviewed on head, 0 failed/);
});

test('no open nightly PRs is a heartbeat, not silence', async () => {
  const f = await fixture({ prs: '' });
  const { code, log } = await runRelay(f.env);
  assert.equal(code, 0);
  assert.match(log, /run: 0 open PR\(s\) by mercury-nightly, 0 re-requested, 0 already reviewed on head, 0 failed/);
});

test('a nightly PR on a later page is still scanned', async () => {
  // The listing is filtered by author, so a fixed first page of open PRs can be filled with
  // non-nightly work. Without --paginate the relay reports success while never looking at PRs it
  // never fetched, which is the outage again with a green heartbeat on top.
  const f = await fixture({ prs: '', prsPage2: '982 aaaa' });
  const { code, log } = await runRelay(f.env);
  assert.equal(code, 0);
  assert.match(log, /run: 1 open PR\(s\) by mercury-nightly, 1 re-requested, 0 already reviewed on head, 0 failed/);
  assert.deepEqual(await postedTo(f.env), ['982']);
});

test('a Copilot review on a later page counts as reviewed', async () => {
  // Reviews are oldest-first, so a current-head review past the first page would otherwise be
  // re-requested on every single pass.
  const f = await fixture({ prs: '982 aaaa', reviewsPage2: 'aaaa' });
  const { code, log } = await runRelay(f.env);
  assert.equal(code, 0);
  assert.match(log, /run: 1 open PR\(s\) by mercury-nightly, 0 re-requested, 1 already reviewed on head, 0 failed/);
  assert.deepEqual(await postedTo(f.env), [], 'a reviewed head must not be re-requested');
});

test('a failed review lookup is skipped, not read as "this head needs a review"', async () => {
  // An unreadable review list is not evidence. Reading it as one re-requests a review that already
  // exists, every pass, and the successful POST hides the broken lookup behind "0 failed".
  const f = await fixture({ prs: '982 aaaa', reviewsFail: true });
  const { code, log } = await runRelay(f.env);
  assert.equal(code, 1, 'a lookup we could not perform must not exit 0');
  assert.match(log, /ERROR: review lookup for PR #982 failed/);
  assert.deepEqual(await postedTo(f.env), [], 'nothing is requested when the relay cannot tell');
  assert.match(log, /0 re-requested, 0 already reviewed on head, 1 failed/);
});

test('a non-operator gh identity refuses and says why, without requesting anything', async () => {
  // The whole point of the relay is that the nightly token cannot request a Copilot review. If it
  // ever ran under that token it would look identical to a working relay while doing nothing.
  const f = await fixture({ user: 'mercury-nightly', prs: '982 aaaa' });
  const { code, log } = await runRelay(f.env);
  assert.equal(code, 1);
  assert.match(log, /ERROR: gh identity is mercury-nightly, expected aywengo - refusing/);
  assert.doesNotMatch(log, /re-requested/);
});

test('an unauthenticated gh is an error, not a quiet no-op', async () => {
  const f = await fixture({ user: null, prs: '982 aaaa' });
  const { code, log } = await runRelay(f.env);
  assert.equal(code, 1);
  assert.match(log, /ERROR: .* not authenticated/);
});

test('a request that does not come back 2xx is logged as a failure and fails the run', async () => {
  const f = await fixture({ prs: '982 aaaa', postStatus: 'HTTP/2.0 422 Unprocessable Entity' });
  const { code, log } = await runRelay(f.env);
  assert.equal(code, 1, 'a failed request must not exit 0 - that is the silent failure again');
  assert.match(log, /ERROR: PR #982 head aaaa request failed \(HTTP\/2\.0 422 Unprocessable Entity\)/);
  assert.match(log, /0 re-requested, 0 already reviewed on head, 1 failed/);
});

test('--watch takes repeated passes, so launchd only has to spawn it once', async () => {
  // The relay is a KeepAlive daemon precisely because launchd's scheduled spawns are unreliable on
  // the nightly host (`gui` domain in "on-demand-only mode": StartInterval and RunAtLoad do not
  // fire). If the loop ever stopped after one pass, the outage would come straight back.
  const f = await fixture({ prs: '982 aaaa', reviewed: '982 aaaa\n' });
  f.env.MERCURY_RELAY_INTERVAL = '1';
  const log = await runWatch(f.env, 3000);
  assert.match(log, /watch: starting, one pass every 1s \(pid \d+\)/);
  const passes = log.split('\n').filter((l) => l.includes('run: 1 open PR(s)'));
  assert.ok(passes.length >= 2, `expected at least two passes, saw ${passes.length}:\n${log}`);
});

test('an unknown argument is refused, not ignored', async () => {
  // A typo in the plist's ProgramArguments must not silently become "run the default".
  const f = await fixture({ prs: '' });
  const { code, log } = await runRelay(f.env, ['--watc']);
  assert.equal(code, 2);
  assert.match(log, /ERROR: unknown argument '--watc'/);
});

test('the LaunchAgent template is valid XML, so the deployed plist parses anywhere', async () => {
  // XML forbids the double-hyphen sequence inside a comment. `plutil` is lenient about it, but
  // `xmllint` rejects the artifact and Python's `plistlib` raises, so the deployed file would only
  // load on Apple's parser. Checked structurally rather than with a parser: the repo has no XML
  // dependency and CI is not guaranteed to have one.
  const tpl = await readFile(PLIST, 'utf8');
  let rest = tpl;
  let comments = 0;
  for (;;) {
    const open = rest.indexOf('<!--');
    if (open === -1) break;
    const close = rest.indexOf('-->', open + 4);
    assert.notEqual(close, -1, 'unterminated XML comment');
    const body = rest.slice(open + 4, close);
    assert.ok(
      !body.includes('--'),
      `XML forbids '--' inside a comment (line ${tpl.slice(0, open).split('\n').length}):\n${body.slice(0, 200)}`,
    );
    comments += 1;
    rest = rest.slice(close + 3);
  }
  assert.ok(comments > 0, 'the header is the documentation; it should still be there');
  assert.match(tpl, /<string>--watch<\/string>/, 'the watch flag belongs in ProgramArguments, where -- is legal');
});

// The release workflow's tag validation, executed rather than pattern-matched.
//
// Issue #252 added a manifest comparison to the `cli` branch, which was the only one accepting a tag
// unchecked. That branch has since been removed entirely: a cli tag published a GitHub Release and no
// artifact, so the whole pattern was dropped rather than kept and guarded. What remains here is the
// proof that host and fleet still compare tags to their manifests, and that cli is refused outright.
//
// A test that asserts the workflow text "contains a version check" would pass on a check that never
// fires, and would fail on a harmless reformat. So this extracts the real shell step from the YAML and
// RUNS it against fake tags, with `gh` and `npm` stubbed on PATH. Every assertion below is about an exit
// code and a message the script actually produced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { tempDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };

/** A JWT-shaped string with the given claims, so the step's claim printer has something to decode. */
function fakeJwt(claims: Record<string, string>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

/**
 * Pull the `run: |` body out of the release workflow.
 *
 * The repo deliberately has no YAML dependency (client/test/coupling.test.ts pins the dependency set),
 * so this is indentation-based rather than a parsed document. It fails loudly if the step it is looking
 * for is not found, because a silently-empty script would make every scenario below "pass".
 */
function extractReleaseScript(): string {
  const lines = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes('run: |'));
  assert.ok(start >= 0, 'no `run: |` step found in release.yml; the extractor is stale');
  const keyIndent = lines[start].search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') { body.push(''); continue; }
    const indent = line.search(/\S/);
    if (indent <= keyIndent) break;
    body.push(line);
  }
  const script = body.map((l) => (l.trim() === '' ? '' : l.slice(keyIndent + 2))).join('\n');
  assert.ok(script.includes('refusing tag'),
    'the extracted step is not the tag-validation step; the extractor found the wrong `run:` block');
  assert.ok(script.includes('gh release create'),
    'the extracted step does not create the release; it is incomplete');
  return script;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  npmrc: string;
  notesOut: string;
}

/** Run the workflow step for one tag, in a throwaway tree with stubbed `gh` and `npm`. */
function runTag(
  tag: string,
  opts: { notes?: string[]; pkgVersion?: string; npmToken?: string; oidc?: boolean; npmrc?: string;
    directPublish?: string; npmHasStage?: boolean; npmFails?: boolean; event?: string; omitDryRunVar?: boolean;
    pkgHttp?: string;
    npmSubmitErr?: string; exchange?: string; exchangeExit?: number;
    exchange2?: string; exchange2Exit?: number; control?: string; controlExit?: number;
    control2?: string; control2Exit?: number } = {},
): Run {
  // tempDir() registers the path with the file-level teardown in helpers.ts, which also runs when a
  // test file aborts partway -- something a per-test finally block cannot guarantee.
  const tmp = tempDir('release-step-');
  try {
    writeFileSync(join(tmp, 'package.json'),
      JSON.stringify({ name: '@aywengo/mercury', version: opts.pkgVersion ?? pkg.version }));
    writeFileSync(join(tmp, 'fleet-package-dir-marker'), '');
    mkdirSync(join(tmp, 'fleet'), { recursive: true });
    writeFileSync(join(tmp, 'fleet', 'package.json'),
      JSON.stringify({ name: '@aywengo/mercury-fleet', version: opts.pkgVersion ?? pkg.version }));
    // The fleet branch copies LICENSE into fleet/ before publishing. Without it the fleet PUBLISH path
    // could not be exercised at all -- the only pre-existing fleet test asserted a version mismatch,
    // which exits before the cp, so the gap stayed invisible.
    writeFileSync(join(tmp, 'LICENSE'), 'MIT\n');
    for (const note of opts.notes ?? []) {
      mkdirSync(join(tmp, 'docs', 'releases', note.split('/')[0]), { recursive: true });
      writeFileSync(join(tmp, 'docs', 'releases', note), `# ${note}\n\nbody long enough to not be a stub.\n`);
    }

    // The step builds the Homebrew bundle with the real repo script. In this throwaway tree there is
    // no dist/ and no dependency tree, so the real script would correctly refuse and every test here
    // would fail for a reason unrelated to what it is checking. Substitute one that reports a bundle
    // the way the real script does; the bundle's own behaviour is covered by test/bundle.test.ts.
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    writeFileSync(join(tmp, 'scripts', 'build-bundle.mjs'),
      'console.log(JSON.stringify({ tarball: process.argv[process.argv.indexOf("--out") + 1] '
      + '+ "/mercury-fake-bundle.tar.gz", version: "0.0.0", sha256: "f".repeat(64) }));\n');

    // Same reasoning as the bundle stub above: the real generator would run against this throwaway
    // tree. It is exercised for real by test/formula.test.ts.
    writeFileSync(join(tmp, 'scripts', 'update-formula.mjs'),
      'console.log(JSON.stringify({ formula: "Formula/mercury-ai.rb", version: "0.0.0", '
      + 'sha256: "f".repeat(64), rubySyntax: "skipped (no ruby)" }));\n');

    // Stub the only two external commands the step uses, and record what it asked for.
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    for (const cmd of ['gh', 'npm']) {
      const stub = join(bin, cmd);
      // The step probes `npm stage --help` to decide between staging and direct publishing. Logging
      // that probe would put a bogus "npm stage" line in the call log and confuse every ordering
      // assertion below, and STUB_NPM_STAGE_RC lets a test simulate an npm too old to stage.
      const body = cmd === 'npm'
        ? '#!/bin/sh\ncase "$*" in\n  "stage --help") exit "${STUB_NPM_STAGE_RC:-0}" ;;\nesac\n'
          + 'echo "npm $*" >> "' + tmp + '/calls.log"\n'
          // Scoped to the submission: --provenance appears only on the publish/stage call. Failing
          // on every npm call instead also killed `npm ci`, which made three tests fail for a reason
          // that had nothing to do with what they were checking.
          + 'case "$*" in\n  *--provenance*) if [ -n "${STUB_NPM_SUBMIT_ERR:-}" ]; then printf "%s\\n" "${STUB_NPM_SUBMIT_ERR}" >&2; fi; exit "${STUB_NPM_SUBMIT_RC:-0}" ;;\nesac\nexit 0\n'
        : `#!/bin/sh\necho "${cmd} $*" >> "${tmp}/calls.log"\nexit 0\n`;
      writeFileSync(stub, body);
      chmodSync(stub, 0o755);
    }
    // The formula step drives git directly, and the step runs in a throwaway directory that is not a
    // repository, so the real git would fail for reasons unrelated to what these tests check. The
    // `diff --cached --quiet` case exits 1 on purpose: that is git's "there ARE staged changes"
    // answer, which is the branch that commits and pushes. Without it the stub would always report a
    // clean tree and the push path would never be exercised.
    // Stub curl. Without it the OIDC branch reached the real GitHub token endpoint and, once the
    // rehearsal began probing npm's token exchange, the real registry: a test suite whose result
    // depends on two third-party services is neither hermetic nor debuggable, and a registry that
    // rate-limits would turn a green suite red for no reason in the diff.
    //
    // It answers the two URLs the step knows. The id-token endpoint returns the JWT in STUB_JWT so
    // a test controls the claims; the exchange endpoint replays STUB_EXCHANGE with STUB_EXCHANGE_EXIT
    // so a test controls whether npm trusts the workflow.
    const curlStub = join(bin, 'curl');
    writeFileSync(curlStub,
      '#!/bin/sh\n'
      + 'url=""\n'
      + 'for a in "$@"; do case "$a" in http*) url="$a" ;; "%{http_code}") wfmt=1 ;; esac; done\n'
      + 'case "$url" in\n'
      + '  *idToken*) printf \'%s\' "{\\"value\\":\\"${STUB_JWT}\\"}" ;;\n'
      + '  *oidc/token/exchange*)\n'
      + '    n=0; [ -f "' + tmp + '/exchange.count" ] && n=$(cat "' + tmp + '/exchange.count");\n'
      + '    n=$((n+1)); printf "%s" "$n" > "' + tmp + '/exchange.count";\n'
      // Two dimensions decide which canned answer to replay. The package is visible in the URL, so
      // the control package is separated that way. The audience is not in the URL at all, so the
      // call number carries it: the step probes two audiences and, for each, ours then the control,
      // so calls 1-2 are the first audience and 3-4 the second.
      + '    case "$url" in *left-pad*) which=CONTROL ;; *) which=OURS ;; esac\n'
      + '    if [ "$n" -le 2 ]; then a=1; else a=2; fi\n'
      + '    if [ "$which" = OURS ]; then\n'
      + '      if [ "$a" = 1 ]; then body="${STUB_EXCHANGE_OURS1-$STUB_EXCHANGE}"; code="${STUB_EXCHANGE_OURS1_EXIT-$STUB_EXCHANGE_EXIT}";\n'
      + '      else body="${STUB_EXCHANGE_OURS2-$STUB_EXCHANGE}"; code="${STUB_EXCHANGE_OURS2_EXIT-$STUB_EXCHANGE_EXIT}"; fi\n'
      + '    else\n'
      + '      if [ "$a" = 1 ]; then body="${STUB_EXCHANGE_CONTROL1-${STUB_EXCHANGE_CONTROL-$STUB_EXCHANGE}}"; code="${STUB_EXCHANGE_CONTROL1_EXIT-${STUB_EXCHANGE_CONTROL_EXIT-$STUB_EXCHANGE_EXIT}}";\n'
      + '      else body="${STUB_EXCHANGE_CONTROL2-${STUB_EXCHANGE_CONTROL-$STUB_EXCHANGE}}"; code="${STUB_EXCHANGE_CONTROL2_EXIT-${STUB_EXCHANGE_CONTROL_EXIT-$STUB_EXCHANGE_EXIT}}"; fi\n'
      + '    fi\n'
      + '    printf "%s" "$body"; exit "$code" ;;\n'
      // Package metadata is public, and the failure classifier now reads it to tell a rejected
      // publisher apart from a package that has never existed. STUB_PKG_HTTP is that answer.
      + '  *) if [ -n "${wfmt:-}" ]; then printf "%s" "${STUB_PKG_HTTP:-200}"; exit 0; fi; exit 22 ;;\n'
      + 'esac\nexit 0\n');
    chmodSync(curlStub, 0o755);

    const gitStub = join(bin, 'git');
    writeFileSync(gitStub,
      '#!/bin/sh\necho "git $*" >> "' + tmp + '/calls.log"\n'
      + 'case "$1 $2" in "diff --cached") exit 1 ;; esac\nexit 0\n');
    chmodSync(gitStub, 0o755);

    // actions/setup-node writes this PROJECT .npmrc because registry-url is set. OIDC mode has to drop
    // the empty token line from it, so the tests must be able to present the file the runner presents.
    if (opts.npmrc !== undefined) {
      writeFileSync(join(tmp, '.npmrc'), opts.npmrc);
    }

    const script = join(tmp, 'step.sh');
    writeFileSync(script, extractReleaseScript());
    const r = spawnSync('/bin/bash', [script], {
      cwd: tmp,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REF: `refs/tags/${tag}`,
        GITHUB_REF_NAME: tag,
        // Set explicitly rather than inherited. The step now refuses when the publish credential is
        // absent, so inheriting process.env would make every test below depend on whether the
        // developer's shell happens to export NODE_AUTH_TOKEN -- locally-green, CI-red, or the reverse.
        // The default is a non-empty placeholder: present-but-fake, which is all the guard checks.
        NODE_AUTH_TOKEN: opts.npmToken ?? 'npm-token-placeholder',
        // Set explicitly for the same reason as NODE_AUTH_TOKEN: the step falls back to OIDC trusted
        // publishing when no token is present, and that fallback is keyed on exactly these two runner
        // variables. Inheriting them would make the result depend on whether the tests happen to run
        // inside GitHub Actions -- locally-green, CI-red, or the reverse.
        ACTIONS_ID_TOKEN_REQUEST_URL: opts.oidc ? 'https://token.actions.githubusercontent.com/idToken' : undefined,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: opts.oidc ? 'oidc-request-token' : undefined,
        // The curl stub replays these. Default exchange body is empty, which the step treats as
        // "not JSON, therefore no evidence" -- so existing OIDC tests stay on the branch they were
        // written for instead of every one of them suddenly asserting about trust.
        STUB_JWT: fakeJwt({ repository_owner: 'aywengo', repository: 'aywengo/mercury',
          job_workflow_ref: 'aywengo/mercury/.github/workflows/release.yml@refs/heads/main',
          aud: 'npm:registry.npmjs.org', ref: 'refs/heads/main', ref_type: 'branch',
          event_name: 'workflow_dispatch', workflow: 'Release' }),
        STUB_EXCHANGE: opts.exchange ?? '',
        STUB_EXCHANGE_EXIT: String(opts.exchangeExit ?? 0),
        STUB_PKG_HTTP: opts.pkgHttp ?? '200',
        STUB_EXCHANGE_OURS1: opts.exchange ?? '',
        STUB_EXCHANGE_OURS1_EXIT: String(opts.exchangeExit ?? 0),
        STUB_EXCHANGE_OURS2: opts.exchange2 ?? opts.exchange ?? '',
        STUB_EXCHANGE_OURS2_EXIT: String(opts.exchange2Exit ?? opts.exchangeExit ?? 0),
        STUB_EXCHANGE_CONTROL: opts.control ?? opts.exchange ?? '',
        STUB_EXCHANGE_CONTROL_EXIT: String(opts.controlExit ?? opts.exchangeExit ?? 0),
        STUB_EXCHANGE_CONTROL2: opts.control2 ?? opts.control ?? opts.exchange ?? '',
        STUB_EXCHANGE_CONTROL2_EXIT: String(opts.control2Exit ?? opts.controlExit ?? opts.exchangeExit ?? 0),
        // Explicit for the same reason as the two above: the submission verb now depends on this
        // variable, so inheriting it would let a stray shell variable flip the mode under test.
        NPM_DIRECT_PUBLISH: opts.directPublish ?? '',
        // 1 makes `npm stage --help` fail, i.e. an npm older than 11.15 with no staging support.
        STUB_NPM_STAGE_RC: opts.npmHasStage === false ? '1' : '0',
        // Makes the submission itself fail while leaving the `stage --help` capability probe alone,
        // so a test can model "npm is unreachable" without modelling "npm is too old".
        STUB_NPM_SUBMIT_RC: opts.npmFails ? '1' : '0',
        // The registry's actual words on the failing submit. The step classifies the failure from the
        // captured log, so a test has to be able to present the message the registry really sends.
        STUB_NPM_SUBMIT_ERR: opts.npmSubmitErr ?? '',
        // The step writes the bundle under $RUNNER_TEMP. With `set -u` an unset value aborts the
        // step, so it is provided here exactly as the runner would provide it.
        RUNNER_TEMP: tmp,
        // Always present on a real runner; the formula push builds its remote from it. With `set -u`
        // an unset value aborts the step, so the harness has to provide it the way the runner does.
        GITHUB_REPOSITORY: 'aywengo/mercury',
        // Explicit for the same reason as the three above. DRY_RUN selects the rehearsal path, and it
        // is derived from the event name on a real runner; inheriting either would let a stray shell
        // variable silently change which of the two paths a test is asserting about.
        GITHUB_EVENT_NAME: opts.event ?? 'push',
        // `undefined` is omitted from the child environment by spawnSync, which is how a test models
        // the variable being absent altogether rather than merely empty.
        DRY_RUN: opts.omitDryRunVar ? undefined
          : (opts.event ?? 'push') === 'workflow_dispatch' ? 'true' : 'false',
      },
    });
    const calls = existsSync(join(tmp, 'calls.log')) ? readFileSync(join(tmp, 'calls.log'), 'utf8') : '';
    // Read before the finally block deletes the tree: OIDC mode edits .npmrc in place, and the edit
    // is only observable here.
    const npmrc = existsSync(join(tmp, '.npmrc')) ? readFileSync(join(tmp, '.npmrc'), 'utf8') : '';
    // The step appends the pending-approval notice to the notes file it is about to upload, so the
    // notes are read back here rather than trusted from the command line.
    const notesOut = opts.notes?.length
      ? (existsSync(join(tmp, 'docs', 'releases', opts.notes[0]))
        ? readFileSync(join(tmp, 'docs', 'releases', opts.notes[0]), 'utf8') : '')
      : '';
    return { status: r.status, stdout: r.stdout + calls, stderr: r.stderr, npmrc, notesOut };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const V = pkg.version;

/**
 * The submission call, whichever verb the step chose. Dist-tag and ordering assertions are about the
 * submission, not about whether it was staged, so they match both: pinning them to one verb would make
 * a change of default look like a change of behaviour.
 */
const SUBMIT = 'npm (?:stage )?publish';

test('a cli tag is refused outright, even one matching package.json', () => {
  // The cli release stream was removed. A cli-vX.Y.Z tag created a GitHub Release and published no
  // artifact, because the CLI ships inside @aywengo/mercury and has no version of its own -- so the tag
  // announced a version nobody could install. Nothing was ever tagged (no tags, no releases, nothing on
  // npm at the time of removal), so dropping the pattern strands nothing.
  //
  // The version-matching tag is the case that matters: it is the one the old code ACCEPTED. Notes are
  // supplied so the refusal can only come from the tag pattern, not from a missing notes file.
  const r = runTag(`cli-v${V}`, { notes: [`cli/${V}.md`] });
  assert.equal(r.status, 1, `cli-v${V} should be refused now, got exit ${r.status}`);
  assert.match(r.stderr, /refusing tag cli-v/, `expected a tag-pattern refusal: ${r.stderr}`);
  assert.ok(!/gh release create/.test(r.stdout), 'a refused tag must not create a release');
  assert.ok(!new RegExp(SUBMIT).test(r.stdout), 'a refused tag must not submit anything');
});

test('the workflow tag filter no longer admits cli', () => {
  // The regex above is what rejects an already-triggered run, but the `on.push.tags` filter decides
  // whether the workflow runs at all. Both must drop cli, or a cli tag still starts a job that fails
  // instead of never starting. Asserted on the filter block, not the whole file, so a comment that
  // mentions cli cannot satisfy it.
  const lines = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === 'tags:');
  assert.ok(start >= 0, 'no `tags:` filter found in release.yml; the extractor is stale');
  const filter = lines.slice(start + 1).filter((l) => /^\s*-\s+'/.test(l));
  assert.ok(filter.length >= 2, `tag filter looks truncated: ${JSON.stringify(filter)}`);
  assert.ok(!filter.some((l) => l.includes('cli')),
    `the tag filter still admits a cli pattern: ${JSON.stringify(filter)}`);
  // Both directions: dropping cli must not have dropped a product that still releases.
  assert.ok(filter.some((l) => l.includes('host-v')), 'host tag pattern missing from the filter');
  assert.ok(filter.some((l) => l.includes('fleet-v')), 'fleet tag pattern missing from the filter');
});

test('host and fleet keep their existing manifest comparison', () => {
  // The cli fix must not be the only guarded path, and must not have disturbed the two that already
  // worked. Both are given their notes file so the failure can only come from the version comparison.
  const host = runTag('host-v9.9.9', { notes: ['host/9.9.9.md'] });
  assert.equal(host.status, 1, `host-v9.9.9 should still be refused, got exit ${host.status}`);
  assert.match(host.stderr, new RegExp(`package\\.json version ${V.replace(/\./g, '\\.')} != tag 9\\.9\\.9`),
    `refusal should name both versions: ${host.stderr}`);

  const fleet = runTag('fleet-v9.9.9', { notes: ['fleet/9.9.9.md'] });
  assert.equal(fleet.status, 1, `fleet-v9.9.9 should still be refused, got exit ${fleet.status}`);
  assert.match(fleet.stderr, new RegExp(`fleet/package\\.json version ${V.replace(/\./g, '\\.')} != tag 9\\.9\\.9`),
    `refusal should name both versions: ${fleet.stderr}`);
});

test('a matching host tag still publishes, so the guards did not over-tighten', () => {
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, `expected acceptance, got exit ${r.status}:\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(SUBMIT + ' --access public --provenance'), 'host must submit to npm');
});

test('an OIDC submit rejected with 404 names both candidate causes', () => {
  // The whole reason this exists. npm's OIDC failures are log.verbose only, so a rejected trusted
  // publisher arrives as a bare registry 404 -- byte-identical in the log to a package that does not
  // exist. Two different settings produce it, and picking between them by hand cost three releases.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, directPublish: 'true', npmToken: '',
    npmFails: true, npmSubmitErr: 'npm error code E404',
  });
  assert.equal(r.status, 1, 'a failed submit must still fail the job');
  const out = r.stdout + r.stderr;
  // Match the stable header, not one candidate cause: the wording under it is exactly the part that
  // has to change when the run stages instead of publishing.
  assert.match(out, /cause: the registry refused the OIDC credential/, 'must identify the auth failure');
  assert.match(out, /workflow filename release\.yml/, 'must name the three things the publisher matches');
  assert.match(out, /direct publishing is not enabled/, 'a direct-publish run must get that candidate');
});

test('an OIDC failure does not get the token explanation', () => {
  // The converse of the test below, and the one missing from the first version of this feature --
  // which is how an ungated branch survived review. npm's OIDC exchange can surface as ENEEDAUTH, and
  // without the gate the job then blames NPM_TOKEN on a run that has no token at all.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '',
    npmFails: true, npmSubmitErr: 'npm error code ENEEDAUTH',
  });
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /cause: the registry refused the OIDC credential/, 'OIDC auth errors get the OIDC explanation');
  assert.ok(!/NPM_TOKEN is set/.test(out), 'must not blame a secret this run does not have');
});

test('a token-mode failure does not get the OIDC explanation', () => {
  // The hint is only true of the OIDC path. Printing it under a token would send the operator to a
  // settings page that has nothing to do with the failure.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], npmFails: true, npmSubmitErr: 'npm error code E404' });
  assert.equal(r.status, 1);
  assert.ok(!/direct publishing is not enabled/.test(r.stdout + r.stderr),
    'the OIDC hint must not appear when a token was used');
});

test('a staging run is not told to unset NPM_DIRECT_PUBLISH', () => {
  // The hint used to assert, unconditionally, that this run chose direct publishing. When the
  // repository variable is unset the run stages, and the advice sends the operator to a variable that
  // is not in effect -- the same class of overstatement this repo keeps removing from its docs.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '',
    npmFails: true, npmSubmitErr: 'npm error code ENEEDAUTH',
  });
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /cause: the registry refused the OIDC credential/, 'still identifies the auth failure');
  assert.ok(!/this run asked for direct because NPM_DIRECT_PUBLISH is set/.test(out),
    `a staging run must not be told it published directly:\n${out}`);
  assert.match(out, /did not ask for direct publishing/, 'must say which mode it actually ran in');
});

test('an npm too old to stage is not told it chose direct publishing', () => {
  // `npm_verb` is `publish` in two different situations: the operator asked for it, and the runner's
  // npm predates staging. Gating the hint on the verb conflated them, so the fallback path got advice
  // about a variable that was never set. Gate on the variable.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', npmHasStage: false,
    npmFails: true, npmSubmitErr: 'npm error code ENEEDAUTH',
  });
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /cause: the registry refused the OIDC credential/, 'still identifies the auth failure');
  assert.ok(!/NPM_DIRECT_PUBLISH is set/.test(out),
    `the fallback path must not blame a variable that is unset:\n${out}`);
  assert.match(out, /did not ask for direct publishing/, 'must describe the mode it actually ran in');
});

test('an already-published version is reported as such, not as a credential problem', () => {
  // The failure a re-tagged release actually produces, and the one most likely to be misread as auth.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', npmFails: true,
    npmSubmitErr: 'npm error code EPUBLISHCONFLICT',
  });
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /already on the registry/, 'must name the real cause');
  assert.ok(!/direct publishing is not enabled/.test(out), 'must not blame the credential');
});

test('the OIDC diagnostic prints the claim npm actually matches', () => {
  // A trusted publisher is keyed on owner + repository + workflow filename. The filename is not in
  // `workflow` (that is the display name) -- it is in `job_workflow_ref`. A first version of this
  // diagnostic printed a hand-picked list of claims that omitted it, and from that omission the
  // conclusion was drawn that no claim carried the filename at all. A diagnostic that cannot see the
  // field it is meant to explain is worse than none, because it invites a confident wrong answer.
  const script = extractReleaseScript();
  // Scope to the key list itself. A first version matched `job_workflow_ref` anywhere in the step and
  // survived a mutation that removed it from the printed list, because the word also appears in the
  // comment above -- the guard passed on prose while the diagnostic had regressed.
  const keyList = script.match(/for \(const k of \[([\s\S]*?)\]\)/);
  assert.ok(keyList, 'could not find the OIDC claim key list; the probe shape changed');
  const keys = keyList[1].split(',').map((k) => k.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  for (const needed of ['job_workflow_ref', 'repository_owner', 'repository']) {
    assert.ok(keys.includes(needed),
      `the claims probe must print ${needed}; got ${JSON.stringify(keys)}`);
  }
});

test('a dispatch rehearsal submits nothing, releases nothing and pushes nothing', () => {
  // The rehearsal exists because this workflow failed three times and every diagnosis cost a real tag
  // push. That only pays off if a rehearsal provably cannot publish, so assert the absence of all
  // three external effects rather than the presence of a log line saying it was careful.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], event: 'workflow_dispatch' });
  assert.equal(r.status, 0, `expected a clean rehearsal, got exit ${r.status}:\n${r.stdout}\n${r.stderr}`);
  // The rehearsal must still do the real work, or it proves nothing about a real run.
  assert.match(r.stdout, /bundle sha256=/, 'a rehearsal that skips the bundle is not a rehearsal');
  assert.match(r.stdout, /npm publish --dry-run/, 'the rehearsal should pack what a real run would ship');
  // ... and must not touch anything outside the runner.
  assert.ok(!new RegExp(SUBMIT + ' --access public --provenance').test(r.stdout),
    `a dispatch must never submit to npm:\n${r.stdout}`);
  assert.ok(!/gh release create/.test(r.stdout), `a dispatch must never create a release:\n${r.stdout}`);
  assert.ok(!/git push/.test(r.stdout), `a dispatch must never push the formula:\n${r.stdout}`);
});

test('a tag push is still a real release, so the rehearsal gate did not swallow it', () => {
  // The mirror image of the test above. Without it, a DRY_RUN that was true for every event would
  // pass the rehearsal assertions while silently turning real releases into no-ops that still go
  // green -- the one failure mode worse than a failed publish.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, `expected acceptance, got exit ${r.status}:\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(SUBMIT + ' --access public --provenance'), 'a tag push must submit');
  assert.match(r.stdout, /gh release create/, 'a tag push must create the release');
  assert.match(r.stdout, /git push/, 'a tag push must push the formula');
  assert.ok(!/npm publish --dry-run/.test(r.stdout), 'a tag push must not be a rehearsal');
});

test('a matching host tag with DRY_RUN unset still publishes', () => {
  // `${DRY_RUN:-}` rather than `${DRY_RUN}`: the step runs under `set -u`, and the first CI run of
  // the rehearsal feature died with `DRY_RUN: unbound variable` in exactly this situation. The
  // default also matters in the safe direction -- unset means "publish", matching the behaviour
  // before the rehearsal existed, whereas defaulting to a rehearsal would turn a missing variable
  // into a green run that silently publishes nothing.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], omitDryRunVar: true });
  assert.equal(r.status, 0, `expected acceptance, got exit ${r.status}:\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(SUBMIT + ' --access public --provenance'), 'unset DRY_RUN must publish');
});

test('a host tag with no notes file is still refused', () => {
  // The notes check must stay live for the products that do release. It used to be asserted through a
  // cli tag; cli is now refused at the tag pattern, before the notes check is ever reached, so that
  // path would prove nothing. host is a product that actually publishes, so assert on it.
  const r = runTag(`host-v${V}`, { notes: [] });
  assert.equal(r.status, 1, `missing notes should refuse, got exit ${r.status}`);
  assert.match(r.stderr, /missing docs\/releases\/host\//);
  assert.ok(!/gh release create/.test(r.stdout), 'a tag with no notes must not create a release');
});

test('a prerelease host tag is accepted and published under dist-tag rc, not latest', () => {
  // The whole point of the RC work. npm applies `latest` to ANY version published without --tag
  // (`npm config get tag` prints "latest"), so publishing 0.1.0-rc1 the old way would have made
  // `npm install @aywengo/mercury` resolve to the release candidate for everyone. The stubbed npm on
  // PATH records the exact argv, so this asserts the flag the real publish would carry.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, `a prerelease tag matching package.json must be accepted: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(`gh release create host-v${V.replace(/\./g, '\\.')}`));
  assert.match(r.stdout, new RegExp(SUBMIT + ' [^\\n]*--tag rc\\b'),
    `prerelease must publish under dist-tag rc, got:\n${r.stdout}`);
  assert.ok(!/--tag latest/.test(r.stdout), 'a prerelease must NOT be published under latest');
});

test('a stable version still publishes under latest', () => {
  // Both directions: routing prereleases to rc must not have moved stable releases off latest.
  const r = runTag('host-v1.2.3', { notes: ['host/1.2.3.md'], pkgVersion: '1.2.3' });
  assert.equal(r.status, 0, `stable tag should be accepted: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(SUBMIT + ' [^\\n]*--tag latest\\b'),
    `stable must publish under latest, got:\n${r.stdout}`);
});

test('a prerelease fleet tag publishes fleet under rc too', () => {
  const r = runTag('fleet-v2.0.0-beta.3', { notes: ['fleet/2.0.0-beta.3.md'], pkgVersion: '2.0.0-beta.3' });
  assert.equal(r.status, 0, `fleet prerelease should be accepted: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(SUBMIT + ' [^\\n]*--tag beta\\b'),
    `fleet beta must publish under beta, got:\n${r.stdout}`);
});

test('a prerelease with no alphabetic identifier publishes under next, never latest', () => {
  // 1.0.0-1 has a numeric identifier, so stripping digits yields an empty string. Publishing that
  // would mean `npm publish --tag ""`. The workflow falls back to `next`; without the fallback the
  // empty tag would either error or, worse, be dropped and leave npm on its `latest` default.
  const r = runTag('host-v1.0.0-1', { notes: ['host/1.0.0-1.md'], pkgVersion: '1.0.0-1' });
  assert.equal(r.status, 0, `should be accepted: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(SUBMIT + ' [^\\n]*--tag next\\b'),
    `numeric-only prerelease must use next, got:\n${r.stdout}`);
  assert.ok(!/--tag latest/.test(r.stdout), 'a prerelease must never reach latest');
});

test('a prerelease tag that disagrees with package.json is still refused', () => {
  // The #252 invariant must survive prerelease support: loosening the tag pattern must not loosen the
  // manifest comparison, or 0.1.0-rc9 would publish against a package that says 0.1.0-rc1.
  const r = runTag('host-v0.9.9-rc1', { notes: ['host/0.9.9-rc1.md'] });
  assert.equal(r.status, 1, `mismatched prerelease should be refused, got exit ${r.status}`);
  assert.match(r.stderr, /package\.json version/);
  assert.ok(!/gh release create/.test(r.stdout), 'a refused tag must not create a release');
});

test('a malformed tag is refused before any product logic runs', () => {
  const r = runTag('v9.9.9', { notes: [] });
  assert.equal(r.status, 1, `bare v9.9.9 should be refused, got exit ${r.status}`);
  assert.match(r.stderr, /refusing tag v9\.9\.9/);
});

test('a missing NPM_TOKEN refuses the tag BEFORE the release is created (issue #264)', () => {
  // gh release create needs only contents:write, so it succeeds with no credential; the npm publish
  // afterwards then fails closed. The result was a public GitHub Release advertising a version that
  // was never published -- the same half-state that made the cli-* tag worth deleting.
  //
  // The assertion that matters is not the exit code, it is that `gh release create` never ran. A guard
  // placed after the release would also exit 1 and would leave the half-release behind, which is the
  // exact bug being prevented.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], npmToken: '' });
  assert.equal(r.status, 1, `missing credential should refuse, got exit ${r.status}`);
  assert.match(r.stderr, /no NPM_TOKEN and no OIDC id-token/,
    `expected a refusal naming both auth modes: ${r.stderr}`);
  assert.ok(!/gh release create/.test(r.stdout),
    'the release must NOT be created when the credential is missing -- that is the whole point');
  assert.ok(!new RegExp(SUBMIT).test(r.stdout), 'nothing should be submitted either');
});

test('a present credential still creates the release and publishes', () => {
  // Both directions: the guard must not refuse a correctly configured release.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, `valid credential should publish: ${r.stderr}`);
  assert.match(r.stdout, /gh release create/);
  assert.match(r.stdout, new RegExp(SUBMIT));
});

test('an npm failure still produces the release, the bundle and the formula', () => {
  // The coupling this removes was costing the whole Homebrew channel: the bundle and the formula
  // need nothing from npm, yet an abort at the npm call meant neither was ever built (issue #277).
  // The invariant is that the release body accurately describes what is installable -- not that a
  // release requires npm to have worked.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], npmFails: true });
  const calls = r.stdout.split('\n').filter((l) => /^(npm|gh|git) /.test(l));
  assert.match(r.stderr, /npm submission FAILED/, 'the failure must be reported');
  assert.ok(calls.some((l) => l.startsWith('gh release create')), `release must still be created: ${calls.join(' | ')}`);
  assert.ok(calls.some((l) => l.startsWith('gh release create') && l.includes('bundle')),
    'the Homebrew bundle must still be attached');
  assert.ok(calls.some((l) => l.startsWith('git push')), `the formula must still be pushed: ${calls.join(' | ')}`);
});

test('an npm failure is disclosed on the release body, not hidden', () => {
  // A body that stayed silent would advertise an `npm install` that does not resolve -- the same
  // overstatement class as the deleted cli-* tag.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], npmFails: true });
  assert.match(r.notesOut, /npm package not available for this release/, `body must disclose it:\n${r.notesOut}`);
  assert.match(r.notesOut, /brew install/, 'and point at the channel that does work');
});

test('an npm failure still fails the job, after everything installable exists', () => {
  // Red must survive the decoupling, or a missing npm package becomes invisible. What changed is
  // only WHEN it fails: after the release and formula, so red means "npm needs attention" rather
  // than "nobody can install Mercury".
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], npmFails: true });
  assert.equal(r.status, 1, 'the job must still go red when npm failed');
  assert.match(r.stderr, /Homebrew and the release asset are live/);
});

test('a successful submission does not claim the npm package is unavailable', () => {
  // Both directions, or the disclosure becomes a permanent warning label that nobody reads.
  const ok = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!/npm package not available/.test(ok.notesOut), `clean run must stay clean:\n${ok.notesOut}`);
  assert.match(ok.notesOut, /awaiting maintainer approval/, 'staged state is still disclosed');
});

test('the package is staged rather than published directly, by default', () => {
  // npm is removing direct publish from 2FA-bypassing tokens and recommends that CI configurations
  // stage; staging is also the only mode the surviving credential can actually reach, and without
  // it the job aborts before the Homebrew bundle and formula are ever built. `npm stage publish`
  // is `npm publish` with stage=true (npm/cli lib/commands/stage/publish.js), so the flags carry
  // over unchanged.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /npm submission mode: stage publish/, `expected staging by default: ${r.stdout}`);
  assert.match(r.stdout, /npm stage publish --access public --provenance/);
});

test('a staged release says the npm package is awaiting approval', () => {
  // The release notes are committed before the run and cannot know the submission was only staged.
  // Without this notice the page tells a user to `npm install` a version that does not resolve --
  // the same class of overstatement as the deleted cli-* tag, reached from the other direction.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.notesOut, /awaiting maintainer approval/, 'release notes must disclose the staged state');
  assert.match(r.notesOut, /already live/, 'and must say the Homebrew path is unaffected');
});

test('NPM_DIRECT_PUBLISH publishes straight to the registry and adds no approval notice', () => {
  // An OIDC configuration with direct publishing enabled does not want a human in the loop, and a
  // "pending approval" notice on a version that IS live would be its own falsehood.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], directPublish: 'true' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /npm submission mode: publish$/m, `expected direct mode: ${r.stdout}`);
  assert.ok(!/npm stage publish/.test(r.stdout), 'must not stage in direct mode');
  assert.ok(!/awaiting maintainer approval/.test(r.notesOut), `notes must stay clean:\n${r.notesOut}`);
});

test('an npm without staging support falls back to direct publishing', () => {
  // Staging needs npm >= 11.15, verified against the published tarballs (absent from 11.14.0,
  // present in 11.15.0). The runner's npm comes from the node version, so the step probes for it;
  // assuming it would break the release on any runner whose node ships an older npm.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], npmHasStage: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /npm submission mode: publish$/m, `expected the fallback: ${r.stdout}`);
  assert.match(r.stdout, /\bnpm publish --access public/);
  assert.ok(!/awaiting maintainer approval/.test(r.notesOut), 'a direct publish is not pending');
});

test('staging still happens before the release is created', () => {
  // The ordering property is about the submission whatever it is called. If staging moved after
  // `gh release create`, a staging failure would leave a public release with no package at all.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, r.stderr);
  const calls = r.stdout.split('\n').filter((l) => /^(npm|gh|git) /.test(l));
  const submit = calls.findIndex((l) => new RegExp('^' + SUBMIT + '\\b').test(l));
  const release = calls.findIndex((l) => l.startsWith('gh release create'));
  assert.ok(submit >= 0 && release >= 0, `expected both calls, got: ${calls.join(' | ')}`);
  assert.ok(submit < release, `staging must precede the release, got: ${calls.join(' | ')}`);
});

test('no credential at all still publishes when the runner offers an OIDC id-token', () => {
  // npm is removing direct publish from 2FA-bypassing granular tokens, so a long-lived NPM_TOKEN
  // is a deprecation waiting to happen rather than a requirement. The runner hands out an OIDC
  // id-token whenever the job has id-token:write, which this workflow already grants, so the
  // release must be able to proceed on that alone.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], npmToken: '', oidc: true });
  assert.equal(r.status, 0, `OIDC mode should publish, got exit ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /publish auth: OIDC/, 'expected the log to name the auth mode');
  assert.match(r.stdout, new RegExp(SUBMIT), 'expected an npm submission attempt');
  assert.match(r.stdout, /gh release create/, 'expected the release to be created');
});

test('OIDC mode publishes verbosely so npm states why a trusted-publishing config failed', () => {
  // npm/cli's lib/utils/oidc.js never throws. Every failure -- including "this package has no
  // trusted-publishing configuration" -- is log.verbose and returns undefined, after which npm
  // publishes with no credential and the registry answers an opaque E404. Two real releases here
  // were diagnosed by reading npm source for exactly that reason. Verbose logging puts the cause
  // in the run log instead of in the reader's head.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], npmToken: '', oidc: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(SUBMIT + '[^\\n]*--loglevel verbose'), `expected a verbose submission: ${r.stdout}`);
});

test('a token is preferred over OIDC and publishes at normal log level', () => {
  // With both available the step must not silently take the newer path: the token is the explicit
  // operator choice, and verbose npm output on every routine token publish buries the lines that
  // matter.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], npmToken: 'npm-placeholder-token', oidc: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /publish auth: NPM_TOKEN/, 'the token must win when both are present');
  assert.match(r.stdout, new RegExp(SUBMIT + '[^\\n]*--loglevel normal'));
});

test('OIDC mode removes the empty project-scope token that setup-node writes', () => {
  // registry-url makes setup-node emit `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into a
  // PROJECT .npmrc. With no secret that is an empty credential, and project scope outranks the
  // user-scope token npm's OIDC exchange installs, so leaving it would send an empty bearer token
  // instead of the exchanged one. The registry line must survive: it is what points npm at
  // registry.npmjs.org at all.
  const npmrc = '//registry.npmjs.org/:_authToken=\nregistry=https://registry.npmjs.org/\n';
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], npmToken: '', oidc: true, npmrc });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/_authToken/.test(r.npmrc), `empty token line should be gone, got:\n${r.npmrc}`);
  assert.match(r.npmrc, /registry=https:\/\/registry\.npmjs\.org\//, 'the registry line must survive');
});

test('OIDC mode keeps a populated .npmrc credential rather than clearing it', () => {
  // The empty-token cleanup exists because setup-node writes an EMPTY value when the secret is
  // absent. A POPULATED value came from somewhere deliberate, and wiping it would replace a
  // working credential with an anonymous request. This runs the OIDC branch specifically: in
  // token mode the filter never executes, so the token-mode test above cannot see a filter that
  // was broadened from "empty" to "any".
  const npmrc = '//registry.npmjs.org/:_authToken=deliberately-populated\nregistry=https://registry.npmjs.org/\n';
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], npmToken: '', oidc: true, npmrc });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.npmrc, /_authToken=deliberately-populated/, 'OIDC mode must not clear a populated credential');
});

test('a populated credential in .npmrc is never edited', () => {
  // The filter is scoped to an EMPTY token on purpose. Broadening it would turn a working token
  // publish into a 401 with nothing to explain it.
  const npmrc = '//registry.npmjs.org/:_authToken=abc123\nregistry=https://registry.npmjs.org/\n';
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`], npmToken: 'npm-placeholder-token', npmrc });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.npmrc, /_authToken=abc123/, 'a populated credential must not be touched');
});

test('dependencies are installed before anything compiles', () => {
  // setup-node does not install dependencies, and `npm publish` runs `prepare`, which runs tsc. With
  // no install step the publish dies with "tsc: not found" -- and did so after the release had
  // already been created. No tag had ever been pushed, so this path had never run.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, `release should succeed: ${r.stderr}`);
  const calls = r.stdout.split('\n').filter((l) => /^(npm|gh|node) /.test(l));
  const ci = calls.findIndex((l) => /^npm ci\b/.test(l));
  const publish = calls.findIndex((l) => new RegExp('^' + SUBMIT + '\\b').test(l));
  assert.ok(ci >= 0, `expected an "npm ci" call, got: ${calls.join(' | ')}`);
  assert.ok(publish >= 0, `expected an "npm publish" call, got: ${calls.join(' | ')}`);
  assert.ok(ci < publish, 'npm ci must run before npm publish, otherwise the build has no compiler');
});

test('the GitHub Release is created only after a successful publish', () => {
  // Ordering, not mere presence: `gh release create` needs only contents:write, so it succeeds even
  // when the publish afterwards fails. A release created first therefore advertises a version nobody
  // can install. #265 guarded the missing-credential case; this guards every other publish failure.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, `release should succeed: ${r.stderr}`);
  const calls = r.stdout.split('\n').filter((l) => /^(npm|gh) /.test(l));
  const publish = calls.findIndex((l) => new RegExp('^' + SUBMIT + '\\b').test(l));
  const created = calls.findIndex((l) => /^gh release create\b/.test(l));
  assert.ok(publish >= 0 && created >= 0, `expected both calls, got: ${calls.join(' | ')}`);
  assert.ok(publish < created,
    `the npm submission must precede gh release create, got order: ${calls.join(' | ')}`);
});

test('a host release attaches the Homebrew bundle', () => {
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, `release should succeed: ${r.stderr}`);
  const created = r.stdout.split('\n').find((l) => l.startsWith('gh release create'));
  assert.ok(created, 'no gh release create call');
  assert.match(created, /mercury-fake-bundle\.tar\.gz/,
    `the host release must attach the bundle so the formula has something to point at: ${created}`);
  assert.match(r.stdout, /bundle sha256=[0-9a-f]{64}/,
    'the host step must report the bundle sha256; that value is what the formula pins');
});

test('a fleet release attaches no bundle, because Fleet has no formula', () => {
  const r = runTag(`fleet-v${V}`, { notes: [`fleet/${V}.md`] });
  assert.equal(r.status, 0, `fleet release should succeed: ${r.stderr}`);
  const created = r.stdout.split('\n').find((l) => l.startsWith('gh release create'));
  assert.ok(created, 'no gh release create call');
  assert.ok(!/bundle/.test(created), `fleet release should carry no bundle: ${created}`);
  // The build itself runs under `node`, which is not stubbed, so it leaves no line in the call log.
  // What the step does emit is the bundle report, so that is the observable signal that the bundle
  // branch ran at all. Asserting on the script name instead was vacuous and survived a mutation that
  // made every fleet tag build a bundle it has no use for.
  assert.ok(!/bundle sha256=/.test(r.stdout),
    `a fleet tag must not build the Homebrew bundle; step output was: ${r.stdout}`);
});

test('the Homebrew formula is written only after the release exists', () => {
  // A formula committed before the release would 404 for anyone who ran `brew install` in the window
  // between the two, so ordering is the whole correctness property here.
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, `release should succeed: ${r.stderr}`);
  const calls = r.stdout.split('\n').filter((l) => /^(npm|gh|node|git) /.test(l));
  const created = calls.findIndex((l) => /^gh release create\b/.test(l));
  // `node` is not stubbed, so the generator itself leaves no line in the call log -- asserting on it
  // would be vacuous. Staging the formula is the observable proof that the step ran, and it is the
  // last thing before the push that would make the formula live.
  const formula = calls.findIndex((l) => /^git add Formula\/mercury-ai\.rb$/.test(l));
  assert.ok(created >= 0 && formula >= 0, `expected both calls, got: ${calls.join(' | ')}`);
  assert.ok(created < formula,
    `the formula must be written after the release that hosts its asset, got: ${calls.join(' | ')}`);
});

test('the formula update is pushed to main', () => {
  const r = runTag(`host-v${V}`, { notes: [`host/${V}.md`] });
  assert.equal(r.status, 0, `release should succeed: ${r.stderr}`);
  assert.match(r.stdout, /^git push .*HEAD:main$/m,
    `expected a push of HEAD:main so the tap picks up the new formula:\n${r.stdout}`);
});

test('a fleet tag never touches the formula', () => {
  const r = runTag(`fleet-v${V}`, { notes: [`fleet/${V}.md`] });
  assert.equal(r.status, 0, `fleet release should succeed: ${r.stderr}`);
  assert.ok(!/Formula\/mercury-ai\.rb/.test(r.stdout), `fleet must not write the host formula:\n${r.stdout}`);
  assert.ok(!/git push/.test(r.stdout), 'fleet must not push to main');
});

test('a rehearsal performs the token exchange npm would perform', () => {
  // The gap this closes: `npm publish --dry-run` never authenticates, so every rehearsal before this
  // proved the tarball and the claims and nothing about whether npm trusts the workflow. The one
  // open question about the release path lived in the exchange call.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', event: 'workflow_dispatch',
    exchange: JSON.stringify({ token: 'npm-'.padEnd(140, 'z') }),
  });
  assert.equal(r.status, 0, 'an accepted exchange must not fail the rehearsal');
  assert.match(r.stdout, /oidc exchange \[[^\]]+\] @aywengo%2Fmercury: ACCEPTED/, 'must report the exchange result');
  assert.match(r.stdout, /issued a 140-char/, 'must report that a credential came back');
});

test('the issued publish token is never printed', () => {
  // The exchange response IS a credential that can publish this package. Reporting that npm issued
  // one is the point; putting the value in a log anyone with read access to the run can open is not.
  const secret = 'npm-'.padEnd(140, 'z');
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', event: 'workflow_dispatch',
    exchange: JSON.stringify({ token: secret }),
  });
  assert.equal(r.status, 0);
  assert.ok(!(r.stdout + r.stderr).includes(secret), 'the token value must not reach the log');
});

test('a refused exchange fails the rehearsal and quotes npm', () => {
  // A structured refusal is direct evidence about the trust configuration, and a real release dies
  // on this same call. A rehearsal that printed it and went green would be worse than no rehearsal.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', event: 'workflow_dispatch',
    exchange: JSON.stringify({ message: 'this package has no trusted publishing configuration' }),
    control: JSON.stringify({ message: 'unrelated package answered differently' }),
  });
  assert.equal(r.status, 1, 'a refusal must fail the rehearsal');
  const out = r.stdout + r.stderr;
  assert.match(out, /oidc exchange \[[^\]]+\] @aywengo%2Fmercury: REFUSED/, 'must name the failure and which audience');
  assert.match(out, /no trusted publishing configuration/, 'must quote what npm actually said');
  // Not asserted: which setting to blame. With the control answering identically the step is
  // deliberately forbidden from naming one -- see the control tests below.
});

test('a non-JSON exchange answer is inconclusive, not a refusal', () => {
  // A proxy, a WAF or a rate limiter can all answer this call with HTML. That is not evidence about
  // npm's trust configuration, and failing here would train people to ignore a red rehearsal.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', event: 'workflow_dispatch',
    exchange: '<html>403 Forbidden</html>',
  });
  assert.equal(r.status, 0, 'an answer that is not from npm must not fail the release rehearsal');
  assert.match(r.stdout, /NO_ANSWER/, 'must say it learned nothing rather than guess');
});

test('a real release does not run the exchange probe', () => {
  // On a tag push npm performs the exchange itself as part of publishing. Doing it again would mint
  // a second credential for nothing, and a probe that runs on the path it claims to predict cannot
  // distinguish its own result from the real one.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', event: 'push',
    exchange: JSON.stringify({ token: 'x'.repeat(120) }),
  });
  assert.match(r.stdout, /oidc sub = /, 'sanity: the OIDC branch did run, so the probe was skipped on purpose');
  assert.equal(r.status, 0);
  assert.ok(!(r.stdout + r.stderr).includes('oidc exchange'),
    'the probe is a rehearsal-only diagnostic');
});

test('the probe covers both candidate audiences, not just the one npm uses', () => {
  // npm/cli builds the audience as `npm:${hostname}` and publishes with that token, so it must be
  // probed. But the first rehearsal refused on it alone, and a refusal on one audience is not
  // evidence that npm distrusts the workflow -- it may be evidence that the wrong audience was
  // asked. Probing both is what turns "npm said no" into something a reader can act on.
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(wf, /for aud in npm:registry\.npmjs\.org https:\/\/registry\.npmjs\.org/,
    'both candidate audiences must be probed');
  assert.match(wf, /&audience=\$\{aud\}/,
    'the token must be minted per audience rather than once with a fixed one');
});

test('one audience accepted and the other refused still passes the rehearsal', () => {
  // The case the first version of this probe could not express, and the reason it probes both
  // audiences. A provenance-style trusted publisher may accept the registry URL where npm's own
  // `npm:${hostname}` audience is refused -- or the reverse. Failing on the first refusal would
  // report "npm does not trust this workflow" on a configuration that works fine, and a rehearsal
  // that cries wolf is a rehearsal nobody reads.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', event: 'workflow_dispatch',
    exchange: JSON.stringify({ message: 'unauthorized' }),
    exchange2: JSON.stringify({ token: 'npm-'.padEnd(140, 'z') }),
  });
  assert.equal(r.status, 0, 'an accepted audience must outweigh a refused one');
  const out = r.stdout + r.stderr;
  assert.match(out, /npm:registry\.npmjs\.org\] @aywengo%2Fmercury: REFUSED/, 'must still report the refusal it saw');
  assert.match(out, /https:\/\/registry\.npmjs\.org\] @aywengo%2Fmercury: ACCEPTED/, 'and the acceptance it saw');
  assert.match(out, /npm trusts this workflow/, 'and the conclusion the operator acts on');
});

test('a refusal the control does not share fails the rehearsal', () => {
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', event: 'workflow_dispatch',
    exchange: JSON.stringify({ message: 'unauthorized' }),
    control: JSON.stringify({ message: 'a different answer entirely' }),
  });
  assert.equal(r.status, 1, 'a refusal the control does not share must fail the rehearsal');
  const out = r.stdout + r.stderr;
  assert.match(out, /The registry does distinguish/, 'must say the answers differ');
  assert.match(out, /bare\s+name/, 'and name the field most often entered wrong');
});

test('every curl in the release step is bounded', () => {
  // A hung request is indistinguishable from a slow one, and this step has four of them against two
  // third-party services. The workflow timeout is the only thing that would ever notice, which turns
  // a network stall into a ten-minute wait with no diagnosis. One line of the probe was already
  // bounded and the one that mints the id token was not -- exactly the shape a guard catches.
  const script = extractReleaseScript();
  const unbounded = script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\bcurl\b/.test(l) && !l.startsWith('#'))
    .filter((l) => !/--max-time/.test(l));
  assert.deepEqual(unbounded, [], 'every curl must carry --max-time');
});

test('an identical answer for an unrelated package is reported as distinguishing nothing', () => {
  // The control exists because "unauthorized" arrived with no detail at all, and the obvious reading
  // -- "our trusted publisher does not match" -- is only correct if the registry says something
  // DIFFERENT about a package that has no configuration. If it says the same thing to everyone, the
  // line is not evidence about our configuration and the log must not imply that it is.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', event: 'workflow_dispatch',
    exchange: JSON.stringify({ message: 'OIDC token exchange error - unauthorized' }),
  });
  // This is what the registry actually returns today, for our package and for `left-pad` alike. A
  // rehearsal that fails on it is red on every run, and a check that is always red is a check people
  // stop reading -- which costs exactly the run where it means something.
  assert.equal(r.status, 0, 'a refusal the control shares must not fail the rehearsal');
  const out = r.stdout + r.stderr;
  assert.match(out, /left-pad: REFUSED -- OIDC token exchange error - unauthorized/,
    'the control package must be probed and shown');
  assert.match(out, /says nothing about whether a real publish would/,
    'an identical answer must be labelled as no evidence');
  assert.match(out, /diagnostic, not a gate/, 'and must say so in the terms the operator acts on');
});

test('a different answer for the control package means the configuration is being evaluated', () => {
  // The other half of the control: if an unrelated package gets a different reply, the registry does
  // tell these cases apart, and our refusal therefore points at a real mismatch worth going to fix.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', event: 'workflow_dispatch',
    exchange: JSON.stringify({ message: 'OIDC token exchange error - unauthorized' }),
    control: JSON.stringify({ message: 'this package has no trusted publishing configuration' }),
  });
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /The registry does distinguish/, 'must conclude that the answers differ');
  assert.match(out, /bare\s+name/, 'must name the field most often entered wrong');
});

test('a differing pair on the second audience still gates, even if the first was noise', () => {
  // The bug both reviewers found in the version this replaces: the comparison used the first answer
  // seen for each package, so a non-JSON reply on the first audience locked the comparison against
  // nothing and a genuine difference on the second audience was never examined.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', event: 'workflow_dispatch',
    exchange: JSON.stringify({ message: 'refused for a real reason' }),
    exchange2: JSON.stringify({ message: 'refused for a real reason' }),
    control: '<html>rate limited</html>',
    control2: JSON.stringify({ message: 'a different answer' }),
  });
  assert.equal(r.status, 1, 'a comparable pair that differs must gate regardless of which audience produced it');
  assert.match(r.stdout + r.stderr, /The registry does distinguish/);
});

test('a non-JSON control is never compared against a real refusal', () => {
  // The converse: noise on the control side must not manufacture a difference and fail the release
  // rehearsal for something the registry never said.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', event: 'workflow_dispatch',
    exchange: JSON.stringify({ message: 'unauthorized' }),
    exchange2: JSON.stringify({ message: 'unauthorized' }),
    control: '<html>rate limited</html>',
    control2: '<html>rate limited</html>',
  });
  assert.equal(r.status, 0, 'no comparable pair means no evidence, and no evidence means no gate');
  assert.ok(!(r.stdout + r.stderr).includes('The registry does distinguish'),
    'must not claim a difference it never observed');
});

test('the release step contains no empty-string concatenation on an assignment', () => {
  // `distinguishes=0""` shipped, survived `bash -n`, and survived 58 tests, because bash reads it as
  // `distinguishes=0`. It was an editing accident, not a construct, and it sat on the line that
  // initialises the variable deciding whether a release rehearsal fails. Nothing catches that class
  // of typo, so this does: an assignment whose value is a number glued to an empty string is never
  // intentional here.
  const script = extractReleaseScript();
  const offenders = script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=(-?[0-9]+)+""/.test(l));
  assert.deepEqual(offenders, [], 'numeric assignments must not be glued to an empty string');
});

test('a submit failure for a package that has never existed is named as that', () => {
  // The workflow used to say a rejected publisher and a nonexistent package are indistinguishable in
  // npm's log. In the log, true; to the registry, false -- package metadata is public, and one
  // request turns a wrong diagnosis into the right one. Fleet is the live case:
  // @aywengo/mercury-fleet has never been published, so a fleet tag would otherwise be told to go
  // configure a Trusted Publisher on a package page that does not exist.
  const r = runTag(`fleet-v${V}`, {
    notes: [`fleet/${V}.md`], oidc: true, npmToken: '',
    npmFails: true, npmSubmitErr: 'npm error code E404', pkgHttp: '404',
  });
  assert.equal(r.status, 1, 'a failed submit still fails the job');
  const out = r.stdout + r.stderr;
  assert.match(out, /does not exist on the registry/, 'must name the actual cause');
  assert.ok(!/the registry refused the OIDC credential/.test(out),
    'must not blame the credential for a package that was never there');
  assert.ok(!/Trusted Publisher settings/.test(out),
    'must not send the operator to settings that cannot exist yet');
});

test('a refused publisher is still blamed on the credential when the package does exist', () => {
  // The converse, and the reason the new branch sits ahead of the OIDC one rather than replacing it:
  // with the package present, a 404 really is an auth-shaped answer.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, directPublish: 'true', npmToken: '',
    npmFails: true, npmSubmitErr: 'npm error code E404', pkgHttp: '200',
  });
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /the registry refused the OIDC credential/, 'must keep the credential diagnosis');
  assert.ok(!/does not exist on the registry/.test(out), 'and must not invent a missing package');
});

test('a failed fleet submit does not advertise Homebrew or a bundle that Fleet does not have', () => {
  // The disclosure block exists to stop the release body advertising an `npm install` that does not
  // resolve. It was doing the same thing one level up: telling Fleet readers to run `brew install`
  // (which installs a different product) and to download a bundle that is attached only to host
  // releases. Fleet attaches no asset and has no formula, so the honest sentence is that nothing is
  // installable -- which is also the only wording that makes #329 visible to whoever reads the release.
  const r = runTag(`fleet-v${V}`, {
    notes: [`fleet/${V}.md`], oidc: true, npmToken: '',
    npmFails: true, npmSubmitErr: 'npm error code E404', pkgHttp: '404',
  });
  assert.equal(r.status, 1);
  assert.ok(!/brew install/.test(r.notesOut), 'Fleet has no formula; naming one sends users to another product');
  assert.ok(!/download and unpack the bundle/.test(r.notesOut), 'Fleet attaches no asset');
  assert.match(r.notesOut, /Fleet ships only through npm/, 'must say what is actually true');
  assert.match(r.notesOut, /unavailable by every channel/, 'and say it plainly');
});

test('a failed host submit still names both host install paths', () => {
  // The converse, and the reason this is a branch rather than a deletion: for host the alternatives
  // are real, and omitting them would understate a release that genuinely is installable two ways.
  const r = runTag(`host-v${V}`, {
    notes: [`host/${V}.md`], oidc: true, npmToken: '', npmFails: true, npmSubmitErr: 'npm error code E401',
  });
  assert.equal(r.status, 1);
  assert.match(r.notesOut, /brew install aywengo\/mercury\/mercury-ai/, 'host really does have a formula');
  assert.match(r.notesOut, /download and unpack the bundle/, 'and really does attach the bundle');
});

test('a staged fleet release does not claim assets or a formula are live', () => {
  const r = runTag(`fleet-v${V}`, { notes: [`fleet/${V}.md`], oidc: true, npmToken: '' });
  assert.equal(r.status, 0);
  assert.ok(!/Homebrew formula are already live/.test(r.notesOut),
    'nothing else is attached to a Fleet release');
  assert.match(r.notesOut, /only way this version becomes installable/);
});

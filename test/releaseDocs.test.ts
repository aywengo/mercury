import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The release runbook is the file an operator reads at the moment of highest stakes, and it is the only
 * part of this release path with no automated check. That gap has a measured cost: three separate review
 * findings on the same file in one week were all the same mistake -- prose slightly wider or vaguer than
 * the code it describes. `fleet-*` where the regex requires `fleet-vX.Y.Z`; "publishes only to npm" where
 * the job does create a GitHub Release; an unbounded `curl` in a repository that has a written rule about
 * bounding commands.
 *
 * These tests pin that class of drift. They deliberately assert relationships (docs are no wider than the
 * workflow) rather than wording, so the runbook stays free to be rewritten.
 */

const ROOT = join(import.meta.dirname, '..');
/**
 * Does this text claim the Fleet PACKAGE is absent, as opposed to one VERSION of it?
 *
 * Anchoring on the package name was the first attempt and it missed `docs/README.md`, which says only
 * "the package does not exist on npm" without ever naming it. The signal that actually separates the
 * two claims is a version qualifier: "`0.1.0` is not on the registry" stays true after the bootstrap
 * publish, "the package is not on the registry" becomes false. So look for an absence phrase with no
 * SemVer in the run-up to it.
 */
function claimsPackageAbsent(text: string): boolean {
  const phrase = /\b(?:does not exist|doesn't exist|is still absent|is not on the npm registry|absent from the npm registry|returns? `?404`?)/gi;
  for (const m of text.matchAll(phrase)) {
    // Scope to the CLAUSE, not a fixed character window. A window picked up versions from adjacent
    // markdown links and headings, which suppressed real claims: "Fleet 0.1.0](...) -- the package
    // does not exist on npm" looked version-qualified because the link text two clauses away names a
    // version. The qualifier that matters is the subject of THIS clause.
    const start = Math.max(
      text.lastIndexOf('.', m.index!), text.lastIndexOf('\n', m.index!), text.lastIndexOf(';', m.index!),
      text.lastIndexOf(':', m.index!), text.lastIndexOf(',', m.index!),
      m.index! - 2 > 0 && text.slice(m.index! - 2, m.index!) === '--' ? m.index! - 2 : -1,
      text.lastIndexOf('>', m.index!), 0);
    const clause = text.slice(start, m.index!);
    const aboutPackage = /\bpackage\b|mercury-fleet/i.test(clause);
    const versionQualified = /\d+\.\d+\.\d+/.test(clause);
    if (aboutPackage && !versionQualified) return true;
  }
  return false;
}
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const WORKFLOW = '.github/workflows/release.yml';
const RUNBOOKS = ['docs/releasing.md', 'docs/distribution.md'];

/** Tag shapes the workflow actually accepts, read from the step rather than restated here. */
function acceptedTagRegex(): RegExp {
  const wf = read(WORKFLOW);
  const m = wf.match(/=~ \^(\(host\|fleet\)[^ ]*?) \]\]/);
  assert.ok(m, 'the tag regex must be findable in the release step; if it moved, update this test');
  return new RegExp('^' + m[1] + '$');
}

test('the runbooks never name a tag glob wider than the workflow accepts', () => {
  // `fleet-*` reads as though `fleet-next` is a Fleet release. It is not: the tag is refused as malformed
  // before any Fleet logic runs, so the wider glob sends an operator to the wrong branch of the workflow.
  const re = acceptedTagRegex();
  for (const doc of RUNBOOKS) {
    const text = read(doc);
    for (const glob of text.match(/\b(?:host|fleet)-\*[^\s`]*/g) ?? []) {
      const concrete = glob.replace(/\*+/g, '0.0.0');
      assert.ok(
        re.test(concrete),
        `${doc} advertises tag pattern "${glob}", which the workflow does not accept (${concrete})`,
      );
    }
  }
});

test('every curl in the runbooks is bounded', () => {
  // AGENTS.md: a hung command is indistinguishable from a slow one, and `timeout` does not exist on macOS.
  // The release workflow enforces this with a guard over its own steps; the runbook commands an operator
  // copy-pastes were unguarded, and one of them hung a reader on a network stall.
  for (const doc of RUNBOOKS) {
    const text = read(doc);
    const blocks = text.match(/```[a-z]*\n([\s\S]*?)```/g) ?? [];
    for (const block of blocks) {
      const joined = block.replace(/\\\n\s*/g, ' ');
      for (const line of joined.split('\n')) {
        if (/\bcurl\b/.test(line)) {
          // Any non-empty value bounds the request: `--max-time 30`, `--max-time=30` and
          // `--max-time "$CURL_TIMEOUT"` all do the job; requiring digits after whitespace would fail a
          // correctly bounded command, and a guard that fails on valid code gets switched off.
          assert.match(line, /--max-time(\s+\S+|=\S+)/, `${doc}: unbounded curl in a runbook block: ${line.trim()}`);
        }
      }
    }
  }
});

test('the runbooks do not give Fleet an artifact it does not have', () => {
  // Fleet attaches no bundle and has no formula. Naming one sends the reader to a different product,
  // which is the error the release body was rewritten to stop making.
  for (const doc of RUNBOOKS) {
    const text = read(doc);
    for (const line of text.split('\n')) {
      if (/[Ff]leet/.test(line) && /bundle\.tar\.gz|mercury-ai\.rb|brew install aywengo/.test(line)) {
        assert.fail(`${doc}: attributes a host-only artifact to Fleet: ${line.trim()}`);
      }
    }
  }
});

test('the runbook tag annotation matches the release title the workflow creates', () => {
  // The workflow titles releases "Mercury host v..." and "Mercury Fleet v..." -- host lowercase, Fleet
  // capitalised, because that is what shipped in rc1 and a release title is user-visible history. A
  // runbook snippet that interpolates the raw product name produces "Mercury fleet", which reads as a
  // different product. The runbook is copy-pasted at the moment of highest stakes, so it has to produce
  // the same string, and the check reads both sides rather than restating either.
  const wf = read(WORKFLOW);
  const titles = [...wf.matchAll(/title="Mercury (\S+) v\$\{version\}"/g)].map((m) => m[1]);
  assert.deepEqual(titles.sort(), ['Fleet', 'host'], 'the workflow titles both products; update this test if that changes');

  const runbook = read('docs/releasing.md');
  const block = (runbook.match(/```bash\n([\s\S]*?git push origin[\s\S]*?)```/) ?? [])[1];
  assert.ok(block, 'the tag snippet must be present in the runbook');
  for (const display of titles) {
    assert.ok(
      block.includes(display),
      `the tag snippet must produce the display name "${display}" that the workflow uses`,
    );
  }
  // Both forms interpolate the raw product name; only the braced one was caught before, so an
  // edit to `$product` would have regressed to "Mercury fleet" while still passing.
  assert.ok(!/-m "Mercury \$\{?product\b/.test(block),
    'and must not interpolate the raw product name, which lowercases Fleet');
});

test('the runbook does not claim a rehearsal predicts a tag publish', () => {
  // A rehearsal is a workflow_dispatch run, so DRY_RUN is true and the token it holds carries
  // `...:ref:refs/heads/<branch>`. A real release is a tag push and carries
  // `...:ref:refs/tags/<tag>`. The subjects differ by construction, so the exchange result cannot
  // transfer between them in either direction -- yet the runbook used to say `ACCEPTED` "means npm
  // trusts the workflow, and a real publish would authenticate". An operator who believed that would
  // tag a release on the strength of a token npm had only ever seen on a branch.
  const doc = read('docs/releasing.md');
  const wf = read(WORKFLOW);
  assert.match(doc, /refs\/heads\/<branch>/, 'the runbook must name the subject the rehearsal actually holds');
  assert.match(doc, /refs\/tags\/<tag>/, 'and the subject a real release holds');
  // The phrase "would authenticate" is fine under a negation -- the workflow says the exchange "says
  // nothing about whether a real publish would authenticate", which is the correct reading. What must not
  // come back is the positive claim, so that is what is pinned.
  for (const [name, text] of [['docs/releasing.md', doc], ['release.yml', wf]] as const) {
    // Judged by statement, not by line: the honest sentence in release.yml wraps, so the fragment
    // carrying "would authenticate" has no negation on it and reads as a claim.
    const claims = text
      .split('\n')
      .map((l) => l.replace(/^\s*(#|\/\/)?\s?/, '').trim())
      .join('\n')
      .split(/\n\s*\n|\.\n\s*\n/)
      .map((b) => b.replace(/\s+/g, ' ').trim())
      .filter((b) => /would authenticate/.test(b))
      .filter((b) => !/\b(nothing|not|never|no)\b/i.test(b));
    assert.deepEqual(claims, [], `${name} asserts a rehearsal authenticates a real publish`);
  }
});

test('the documented OIDC probe tag cannot trigger a real release', () => {
  // docs/releasing.md tells an operator to push a throwaway tag and dispatch the release workflow at it,
  // to get a tag-subject OIDC token without publishing. The tag name is the only thing standing between
  // that procedure and a real release: `on.push.tags` fires on `host-v*.*.*` and `fleet-v*.*.*`, and the
  // obvious-looking `host-v0.0.0-probe` MATCHES, because `*` swallows `-probe`. A runbook step that
  // silently publishes a version is worse than no runbook step, so the name is pinned here.
  const doc = read('docs/releasing.md');
  const wf = read(WORKFLOW);
  // Scope to the probe's own bash block and allow flags: an annotated `git tag -a NAME` or a second
  // `git tag` snippet elsewhere must not silently change which name this guard checks.
  // The capture group is the point. Without it `[1]` is undefined and `?? doc` silently restores the
  // unscoped behaviour this line exists to remove -- the guard would still pass, checking the wrong text.
  // Scoping to the dispatch command alone is not enough either: the rehearsal section has its own
  // `gh workflow run release.yml` block with no tag in it, and it comes first. The probe block is the one
  // that does both.
  // Capture everything up to the closing fence rather than excluding backticks. A shell block can
  // legitimately contain a backtick -- old-style command substitution such as `whoami`, or a markdown code
  // span inside a comment line -- and a backtick-free class would stop at the first one. That hands this
  // guard a truncated block, or the wrong block entirely: the count below would then see zero candidates
  // and fail, or two and fail, rather than silently checking something else.
  const blocks = [...doc.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].map((x) => x[1]);
  const probeBlocks = blocks.filter((b) => /git tag /.test(b) && /gh workflow run release\.yml/.test(b));
  assert.equal(probeBlocks.length, 1, `expected exactly one probe block, found ${probeBlocks.length}`);
  const m = probeBlocks[0].match(/git tag (?:-\S+\s+|"[^"]+"\s+)?([A-Za-z0-9][A-Za-z0-9._-]*)/);
  assert.ok(m, 'the runbook must show the probe tag name it means');
  const probe = m[1];

  // Quote style is formatting; the trigger is the pattern.
  const patterns = [...wf.matchAll(/^\s+- ['"]?((?:host|fleet)-v[^'"\s]*)['"]?$/gm)].map((x) => x[1]);
  assert.ok(patterns.length >= 2, 'could not read the release tag triggers from the workflow');
  // GitHub glob semantics for these patterns: `*` matches any run of characters except `/`.
  const toRe = (g: string) => new RegExp('^' + g.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
  const matched = patterns.filter((g) => toRe(g).test(probe));
  assert.deepEqual(matched, [], `probe tag ${probe} would trigger a real release via ${matched.join(', ')}`);

  // The procedure is only safe if the reader knows WHY the name is odd, so the constraint must be stated
  // next to it rather than living only in this test.
  for (const g of patterns) assert.ok(doc.includes(`\`${g}\``), `the runbook must name the trigger ${g} it is avoiding`);
});

test('the runbook states the measured exchange result and not the disproved cause', () => {
  // This guard was written to stop an inferred cause being presented as measured. The inference it
  // guarded (npm rejecting the immutable subject format) has since been DISPROVED: npm's own code path
  // returns HTTP 201 and logs "Successfully retrieved and set token". The runbook now has to carry the
  // measured result, keep the disproved claims out, and keep the reason the probe was wrong -- because
  // the same mistake is easy to repeat with another curl.
  const doc = read('docs/releasing.md');
  const flat = doc.replace(/\s+/g, ' ');

  // Not a bare /201/: the log block quotes the URL and status, so a looser assertion is satisfied even
  // when the sentence explaining what 201 means is deleted.
  assert.match(flat, /`201` plus "Successfully retrieved and set token"/,
    'must state in prose what the 201 means, not merely contain the digits');
  assert.match(flat, /Successfully retrieved and set token/, 'must record npm\'s own success message');
  assert.match(flat, /not\.a\.real\.jwt/, 'must keep the disproof of the curl probe visible');

  for (const claim of [
    /The cause is measured, not guessed/,
    /npm matches publishers against the\s+name-only shape/,
    /it cannot, and no npmjs\.com setting changes that/,
    /no per-package setting explains this/i,
    /the token is rejected on its face/i,
  ]) {
    // Case-insensitive: the disproved sentences were written as sentence starts, and a guard that only
    // matches them mid-sentence is a guard against the copy, not against the claim.
    assert.ok(!claim.test(flat), `the runbook repeats a disproved claim: ${claim}`);
  }
});

test('the runbook says a green run still needs npm approval', () => {
  // The job submits with `npm stage publish`, so a green run leaves the version un-installable until a
  // maintainer approves it. A runbook that ends at "the workflow publishes to npm" teaches an operator to
  // push a tag, see green, and announce a release nobody can install. Pin that the doc says otherwise.
  const doc = read('docs/releasing.md').replace(/\r\n/g, '\n');
  assert.match(doc, /npm stage approve/,
    'the runbook must give the approval command, not only the UI path');
  assert.match(doc, /green run does not mean|does not mean the version is installable/i,
    'the runbook must say a green run is not an installable release');
  // "publishes to npm" is the wording that hides the gap; the job submits, a human publishes.
  // The step wraps across lines, so take the whole numbered paragraph rather than the line that matched.
  // A blank line inside a Markdown list is often whitespace-only, so tolerate trailing spaces rather than
  // making this guard fail on formatting trivia.
  const paras = doc.split(/[ \t]*\n[ \t]*\n/);
  const step = paras.find(x => /creates the GitHub Release from/.test(x)) ?? '';
  assert.ok(step, 'the tag-push step must exist');
  assert.match(step, /submits the package to npm/,
    'the tag-push step must say the job submits rather than publishes');
});

test('the runbook does not let a rehearsal stand in for provenance signing', () => {
  // The rehearsal command carries --provenance, so a reader reasonably concludes it validates provenance.
  // It cannot: --dry-run returns before libpub, and generateProvenance lives inside it. Saying so is what
  // stops the next person reading a provenance failure as a credentials failure and going back to npmjs.com
  // settings that are already correct.
  const doc = read('docs/releasing.md').replace(/\r\n/g, '\n');
  const paras = doc.split(/[ \t]*\n[ \t]*\n/);
  const claim = paras.filter(x => /does not prove|nothing about provenance/i.test(x));
  assert.equal(claim.length, 1,
    'exactly one paragraph must scope what the rehearsal proves');
  assert.match(claim[0], /generateProvenance|provenance signing/i,
    'it must name the step a rehearsal never reaches');
  // Presence of the word "provenance" is not the property. The paragraph must actually negate coverage of
  // it, and must not simultaneously claim the rehearsal validates the whole path -- the earlier version of
  // this guard passed while the sentence said "a green rehearsal proves the whole release path", because it
  // only looked for keywords that were still sitting elsewhere in the paragraph.
  assert.match(claim[0], /never run|says nothing about|does not (?:prove|reach)/i,
    'the paragraph must negate provenance coverage, not merely mention it');
  assert.ok(!/rehearsal (?:proves|validates|confirms) the (?:whole|entire|full)/i.test(claim[0]),
    'the paragraph must not claim the rehearsal covers the whole release path');
  // The reason --provenance is present must be stated, or someone will "fix" the command by dropping it.
  assert.match(claim[0], /id-token|ACTIONS_ID_TOKEN_REQUEST/,
    'it must say what actually gates the exchange, not the flag');
});

test('the runbook gives the fleet bootstrap command and warns where to run it', () => {
  // No Fleet release exists yet, so the first release publish cannot use trusted publishing -- the
  // package page that configures it requires the package to exist first. The one command that can do it is
  // dangerous in a specific way: `npm publish` from the repository root publishes @aywengo/mercury, the host
  // package, not fleet. Naming the directory is therefore not formatting, it is the difference between
  // bootstrapping fleet and accidentally shipping a host version.
  const doc = read('docs/releasing.md').replace(/\r\n/g, '\n');
  const paras = doc.split(/[ \t]*\n[ \t]*\n/);
  const boot = paras.filter(x => /cd fleet/.test(x));
  assert.equal(boot.length, 1, 'exactly one paragraph must carry the fleet bootstrap');
  assert.match(boot[0], /npm publish --access public/, 'it must give the publish command');
  assert.match(boot[0], /cp \.\.\/LICENSE LICENSE/,
    'it must copy the LICENSE, since fleet/ declares MIT but ships no such file');
  assert.match(boot[0], /repo(?:sitory)? root.*@aywengo\/mercury|publishes @aywengo\/mercury/,
    'it must warn that the root publishes the host package instead');
  // The command used to be `npm publish --access public --tag rc` at whatever version fleet/package.json
  // held, which was 0.1.0. npm refuses to publish a version twice, so an operator who followed it
  // consumed the exact version the release was for: the fleet-v0.1.0 tag would then fail with "cannot
  // publish over it", leaving no way to ship 0.1.0 with provenance and no route but a version bump.
  // The workflow message was corrected in #442; the runbook carried the same instruction and a guard
  // pinned it, so the wrong command was the version under test. Pin the invariant, not the wording.
  assert.match(boot[0], /npm version --no-git-tag-version \d+\.\d+\.\d+[-+][0-9A-Za-z.-]+/,
    'the bootstrap must pin a PRERELEASE version, which cannot collide with a real release version');
  assert.ok(!/npm publish[^\n]*--tag\s+rc\b/.test(boot[0]),
    'the bootstrap must not publish under rc at the release version');
  // The WHY lives in the prose after the fence, and `paras` splits on blank lines, so it is not part of
  // boot[0]. Read the section that follows rather than loosening the paragraph split for every other
  // assertion in this test.
  const after = doc.slice(doc.indexOf(boot[0]), doc.indexOf(boot[0]) + 2600);
  assert.match(after, /refuses to publish|twice|consume/i,
    'it must explain WHY the bootstrap version is disposable');
  // The trusted publisher is what makes the tag path secretless, and the workflow submits with
  // `npm stage publish` whenever the runner has it. A publisher without that permission refuses the
  // real command, so a runbook that omits it produces a bootstrap that cannot be followed by a release.
  // Scope to the command itself. An earlier version matched `npm trust github ... --allow-stage-publish`
  // across the whole section, and passed on a doc whose command omitted the flag while the prose merely
  // mentioned it -- a mutation that deleted the flag went uncaught.
  const trustFence = (after.match(/```(?:bash|sh|shell)?\n[\s\S]*?npm trust github[\s\S]*?```/) ?? [''])[0];
  const trustCmd = trustFence;
  assert.ok(trustCmd, 'the runbook must give the npm trust github command');
  assert.match(trustCmd, /--allow-stage-publish/,
    'the trusted publisher must be allowed to stage-publish; the workflow uses `npm stage publish`');
  assert.match(trustCmd, /--file\s+release\.yml[\s\S]{0,80}--repo\s+aywengo\/mercury|--repo\s+aywengo\/mercury[\s\S]{0,80}--file\s+release\.yml/,
    'the trusted publisher must name the workflow and repository that will actually run');
  // The bump is not inert. `fleet/test/version.test.ts` asserts fleet/package.json equals
  // fleet/version.ts, so the suite is red for as long as it is present, and a checkout left holding it
  // -- which is exactly what happened during the real bootstrap -- invites committing a bootstrap
  // version into the release. The runbook created that state and never mentioned undoing it.
  assert.match(after, /git checkout -- fleet\/package\.json|git restore fleet\/package\.json/,
    'the runbook must say how to discard the disposable version bump');
  assert.match(after, /version\.test\.ts/,
    'it must name the test the bump breaks, so a red suite is not mistaken for a broken bootstrap');
});

test('the E2E docs do not claim the reaper test asserts disappearance', () => {
  // Both docs used to say `e2e/robustness.test.ts` SIGKILLs a probe and requires its container to
  // disappear. It does not, deliberately: Ryuk is shared across processes, so that timing is not
  // Mercury's to assert. A doc quoting a mutation result for a deleted assertion is worse than no doc --
  // it reads as proof of a guarantee nothing checks. Pin the docs against the test that exists.
  const design = read('docs/local-e2e-design.md').replace(/\r\n/g, '\n');
  const readme = read('e2e/README.md').replace(/\r\n/g, '\n');
  for (const [name, text] of [['design doc', design], ['README', readme]] as const) {
    const para = text.split(/[ \t]*\n[ \t]*\n/).filter(x => /robustness\.test\.ts/.test(x) && /Ryuk|reaper/i.test(x));
    assert.equal(para.length, 1, `${name}: exactly one paragraph must describe the reaper guarantee`);
    assert.ok(!/requir(?:es|ing) its container to disappear|requires the container to disappear/i.test(para[0]),
      `${name}: must not claim the test asserts disappearance`);
    assert.match(para[0], /session label|session label Ryuk reaps on/,
      `${name}: must state the property the test actually asserts`);
  }
  // The design note must say plainly that the timing is out of scope, or the next reader re-adds it.
  assert.match(design, /does not assert that the container disappears|does NOT assert how fast/i,
    'the design note must record what it deliberately does not assert');
});

test('the staged-approval step names the npm version that introduced `npm stage`', () => {
  // `npm stage` is not a plugin: older npm answers `Unknown command "stage"`. Measured by
  // inspecting published npm tarballs for docs/content/commands/npm-stage.md -- absent through
  // 11.14.1, present from 11.15.0. Without a stated floor, an operator on an older npm hits
  // the failure at the last step of a release, with a staged package already waiting.
  const text = read('docs/releasing.md');
  const at = text.indexOf('npm stage approve');
  assert.notEqual(at, -1, 'the runbook must give the staged-approval command');
  const near = text.slice(at, at + 700);
  // Tolerate the ways a minimum version is actually written. The point is the relationship
  // (a floor exists, and it is not below 11.15.0), not the phrasing -- pinning wording here
  // would fail harmless rewrites while still missing a genuinely stale floor.
  // A floor must be *claimed*: `>=`, a trailing `+`, or the words "or newer"/"or later".
  // With both the prefix and the suffix optional a bare `npm 11.15.0` matched, so the docs
  // could drop the minimum entirely and still pass. A bare `>` is an exclusive bound, not the
  // inclusive floor `npm stage` needs, so only `>=` counts.
  const m = near.match(/npm\s+v?\s*(>=)?\s*(\d+\.\d+\.\d+)\s*(\+|or\s+(?:newer|later))?/i);
  const floorClaimed = m !== null && (m[1] !== undefined || m[3] !== undefined);
  assert.ok(floorClaimed,
    `the staged-approval step must state a MINIMUM npm version, not merely mention one; got:\n${near}`);
  // Narrow explicitly rather than relying on assert.ok throwing above: the next lines index the
  // match, and a reader (or tsc) should not have to re-derive that floorClaimed implies m is set.
  if (m === null) assert.fail('unreachable: a floor claim requires a match');
  const floor = m[2] ?? '';
  assert.ok(floor, `the stated npm floor is not a version number: ${m[0]}`);
  const [maj, min] = floor.split('.').map(Number);
  assert.ok(maj > 11 || (maj === 11 && min >= 15),
    `stated npm floor ${floor} predates the release of \`npm stage\` (11.15.0)`);
  // The fallback must not depend on a recent npm, or the floor is a dead end.
  assert.ok(/npmjs\.com/.test(near), 'must offer a fallback that needs no particular npm version');
  // Regression guard for the matcher itself: a bare version is not a floor claim.
  const floorClaim = (s: string) => {
    const g = s.match(/npm\s+v?\s*(>=)?\s*(\d+\.\d+\.\d+)\s*(\+|or\s+(?:newer|later))?/i);
    return g !== null && Boolean(g[1] || g[3]);
  };
  const cases: Array<[string, boolean]> = [['npm 11.15.0 or newer', true], ['npm >=11.15.0', true],
    ['npm >= 11.15.0', true], ['npm v11.15.0 or later', true], ['npm v11.15.0+', true],
    ['npm 11.15.0+', true], ['npm 11.15.0', false], ['npm >11.15.0', false]];
  for (const [ph, want] of cases) {
    assert.equal(floorClaim(ph), want, `matcher must ${want ? 'accept' : 'reject'} \`${ph}\``);
  }
});

test('the docs do not still describe latest as a prerelease channel', () => {
  // Before 0.1.0 shipped, README explained that `latest` pointed at a prerelease and that both tags
  // resolved to the same version. That was true only while no stable release existed, and nothing
  // guarded it -- so it would have sat there contradicting `npm view` indefinitely. Pin the
  // relationship that must now hold, and forbid the specific stale assertions.
  const readme = read('README.md');
  for (const phrase of [
    /latest`? also points at the prerelease/i,
    /both tags resolve to the\s+same version/i,
    /Until the first stable release ships/i,
    /latest`? moves when the first stable release ships/i,
  ]) {
    assert.ok(!phrase.test(readme), `README still asserts a pre-stable state: ${phrase}`);
  }
  // Relationship, not wording: `latest` and "stable channel" must be said together, in any phrasing
  // or order. An exact-phrase pin here would fail a correct rewording -- the brittleness this file
  // exists to avoid.
  assert.match(readme, /`latest`[^.]{0,80}stable channel|stable channel[^.]{0,80}`latest`/i,
    'README must state that latest is the stable channel');

  // The 0.1.0 notes once claimed the source was identical to rc1 with nothing merged between them.
  // fb1317e (#285) disproves that; the claim survived a CHANGELOG fix and had to be caught here.
  const notes = read('docs/releases/host/0.1.0.md');
  assert.ok(!/identical to `0\.1\.0-rc1`; nothing was merged/i.test(notes),
    'the 0.1.0 notes must not claim equivalence with rc1 -- #285 landed between them');
  assert.match(notes, /#285/, 'the 0.1.0 notes must name the functional delta from rc1');
});

test('the distribution table describes channels, not pinned versions', () => {
  // The npm row once read "live; `0.1.0` on `latest`, `0.1.0-rc2` on `rc`". Correct the day it was
  // written, wrong the moment anything shipped -- exactly the rot this PR set out to stop. The row
  // must state the relationship and point at the registry for the current value.
  const row = read('docs/distribution.md').split('\n').find((l) => /^\| npm \|/.test(l));
  assert.ok(row, 'docs/distribution.md must keep its npm row');
  const cells = row.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
  const state = cells[cells.length - 1];
  assert.ok(!/\d+\.\d+\.\d+/.test(state),
    `the npm row must not pin versions, which rot on the next release: ${state}`);
  assert.match(state, /latest/, 'must name the stable channel');
  assert.match(state, /dist-tags|npm view/, 'must point at the registry for the current value');
});

test('docs never present the unpublished Fleet package as installable', () => {
  // No Fleet release version has ever been published, there is no fleet tag and no fleet GitHub
  // Release. The Fleet release notes nonetheless
  // told readers it was published to `rc` and gave a working install command. SECURITY.md listed it as
  // a supported product. Both are now corrections, and this guard keeps them corrections.
  const sec = read('SECURITY.md');
  const fleetRow = sec.split('\n').find((l) => /mercury-fleet/.test(l));
  assert.ok(fleetRow, 'SECURITY.md should keep its Fleet row');
  assert.match(fleetRow, /Not released/, `Fleet must not be listed as supported: ${fleetRow}`);

  // Every Fleet notes file, not just the one that was wrong. A new release note is exactly where a
  // premature install command would appear, and a guard pinned to one filename would not see it.
  const notesDir = join(ROOT, 'docs', 'releases', 'fleet');
  const notesFiles = readdirSync(notesDir).filter((f) => f.endsWith('.md')).sort();
  assert.ok(notesFiles.length > 0, 'no Fleet release notes found to check');
  for (const notesFile of notesFiles) {
    const notes = read(join('docs', 'releases', 'fleet', notesFile));
    // rc1 says it was never published; 0.1.0 says it is not published yet. Both are true and both
    // must stay, so the guard accepts either rather than pinning one file's phrasing.
    // "Up front" is the requirement, so the check is positional: the statement must appear before
    // the first section heading. Asserting only that the file contains the phrase is not enough --
    // 0.1.0.md discusses rc1 having "never published" further down, so a buried historical aside
    // would satisfy a whole-file match while the reader saw no warning at all.
    const preamble = notes.split(/^##\s/m)[0];
    assert.match(preamble, /never (?:been )?published|not (?:yet )?published|not published yet/i,
      `docs/releases/fleet/${notesFile} must state before its first heading that the release has not happened`);
    // Forbid it as an executable instruction, not as a quoted correction: the correction block has to
    // name the command it is retracting, and forbidding that would force history to be erased.
    // Any fence, tagged or not: an untyped ``` block is just as runnable, and so is any language tag
    // a future editor might reach for. Matching only bash|sh|shell would let the command back in.
    const fences = notes.match(/```[^\n]*\n[\s\S]*?```/g) ?? [];
    assert.ok(!fences.some((b) => /npm install[^\n]*mercury-fleet/.test(b)),
      `docs/releases/fleet/${notesFile} must not offer a runnable install for a package that does not exist`);
  }
});

test('the Fleet changelog does not offer an npm install for a package that is not published', () => {
  // fleet/CHANGELOG.md announced "First public Fleet release" with `npm install -g
  // @aywengo/mercury-fleet`. The package 404s, so the only working path is a source checkout.
  const log = read('fleet/CHANGELOG.md');
  const fences = log.match(/```[^\n]*\n[\s\S]*?```/g) ?? [];
  assert.ok(!fences.some((b) => /npm install[^\n]*mercury-fleet/.test(b)),
    'no runnable npm install for the unpublished Fleet package');
  assert.match(log, /never published|not on the npm registry/i,
    'the Fleet changelog must say the version was never published');
});

test('no Fleet doc claims a shipped capability is absent', () => {
  // Every one of these contradictions came from the same habit: a document written at Phase 0 that
  // nobody re-read after Phases 1-6 landed. `fleet/CHANGELOG.md` carried "Dispatch: Fleet cannot
  // start a Run" while `fleet/dispatch.ts` and its tests were in the tree, and `docs/fleet-design.md`
  // section 15 opened by stating there was "no Fleet server, no Fleet unit, no caller
  // authentication, and no redactor" while all four existed. Neither sentence was checked against
  // anything, so both stayed true-looking for months.
  //
  // The check is a relationship, not a wording pin: a capability that ships may not be described as
  // missing. Rewriting the prose freely stays possible; contradicting the tree does not.
  const shipped: Array<{ file: string; inAbsenceList: RegExp; deniedAs: string }> = [
    { file: 'fleet/dispatch.ts', inAbsenceList: /\bdispatch\b/i, deniedAs: 'dispatch' },
    { file: 'fleet/sweep.ts', inAbsenceList: /\b(?:sweep|reconcil\w*)\b/i, deniedAs: 'sweep' },
    { file: 'fleet/routing.ts', inAbsenceList: /\brouting\b/i, deniedAs: 'routing' },
    { file: 'fleet/interact.ts', inAbsenceList: /\binteraction\b/i, deniedAs: 'interact' },
    { file: 'fleet/metrics.ts', inAbsenceList: /\brollup\b/i, deniedAs: 'metrics' },
    { file: 'fleet/server.ts', inAbsenceList: /\b(?:fleet )?server\b/i, deniedAs: 'server' },
    { file: 'fleet/auth.ts', inAbsenceList: /caller authentication/i, deniedAs: 'authentication' },
    { file: 'fleet/redact.ts', inAbsenceList: /\bredactor\b/i, deniedAs: 'redactor' },
    // The unit is not a fleet/*.ts file, and it was one of the four things section 15 denied.
    { file: 'deploy/fleet.service', inAbsenceList: /\b(?:systemd )?unit\b/i, deniedAs: 'unit' },
  ];
  const missing = shipped.filter((s) => !existsSync(join(ROOT, s.file))).map((s) => s.file);
  assert.deepEqual(missing, [], 'every artifact listed here must be in the tree, or the guard proves nothing');

  // A section that enumerates what is missing, up to the next heading or end of file. The body must
  // be consumed with a negative lookahead on the *next heading*: an end-of-string alternative like
  // `\s*$` under the `m` flag matches the blank line right after the heading, which silently yields
  // an empty body and a guard that passes everything.
  const absenceBody = /^#{2,4}[^\n]*\bnot (?:in this release|included|shipped)\b[^\n]*\n((?:(?!^#{2,4}\s)[\s\S])*)/gim;

  for (const doc of ['fleet/CHANGELOG.md', 'docs/releases/fleet/0.1.0-rc1.md', 'docs/fleet-design.md']) {
    const text = read(doc);
    const blocks = [...text.matchAll(absenceBody)].map((m) => m[1]);
    if (doc === 'fleet/CHANGELOG.md') {
      // Prove the extractor works before trusting a pass over it.
      assert.ok(blocks.length > 0 && blocks.some((b) => b.trim().length > 0),
        'the absence-section extractor found nothing, so this guard would pass vacuously');
    }

    for (const { file, inAbsenceList, deniedAs } of shipped) {
      for (const block of blocks) {
        assert.ok(!inAbsenceList.test(block),
          `${doc}: ${file} ships, so it must not appear under a heading saying it does not`);
      }
      const denial = new RegExp(
        `there (?:is|are) no[^.]*\\b${deniedAs}\\b|\\b${deniedAs}\\b[^.]{0,40}does not exist yet`, 'i');
      assert.ok(!denial.test(text), `${doc}: denies "${deniedAs}" while ${file} is in the tree`);
    }
  }
});

/**
 * Does the documentation match what the registry actually serves?
 *
 * Every other guard in this file is textual, which has a specific blind spot: it cannot tell whether the
 * package exists. That blind spot is how the original false claim shipped -- `docs/releases/fleet/0.1.0.md`
 * told readers Fleet was published to `rc` and gave a working install command while the package returned
 * 404, and SECURITY.md listed it as a supported product. A textual guard was satisfied by the corrected
 * wording afterwards, and would have been equally satisfied by an early re-flip to "installable".
 *
 * So the decision is factored out as a pure function and tested against BOTH directions with synthetic
 * inputs. A guard whose only passing evidence is "no violations today" is unproven; these prove it fires.
 * The live registry read is kept in one test that skips when the network is unavailable, so CI never
 * depends on a third party it does not control.
 */
type FleetDocState = {
  /** Versions the registry serves, or null when the registry could not be reached. */
  registryVersions: string[] | null;
  /** The version fleet/package.json is releasing. */
  manifestVersion: string;
  /** Docs offer a runnable `npm install` of the Fleet package. */
  docsOfferInstall: boolean;
  /** SECURITY.md presents Fleet as a released, supported product. */
  securitySaysReleased: boolean;
  /** Docs state that the PACKAGE itself is absent from the registry. */
  docsClaimPackageAbsent: boolean;
};

function fleetDocDrift(s: FleetDocState): string[] {
  if (s.registryVersions === null) return [];
  const published = s.registryVersions.includes(s.manifestVersion);
  const problems: string[] = [];
  if (published && !s.docsOfferInstall) {
    problems.push(`the registry serves ${s.manifestVersion} but the docs still refuse to offer an install`);
  }
  if (!published && s.docsOfferInstall) {
    problems.push(`the docs offer an install but the registry has no ${s.manifestVersion} `
      + `(it serves ${s.registryVersions.join(', ') || 'nothing'})`);
  }
  if (s.securitySaysReleased !== published) {
    problems.push(`SECURITY.md says released=${s.securitySaysReleased} while the registry says ${published}`);
  }
  // A separate fact from whether a RELEASE version exists. The bootstrap publish created the package
  // page, so "the package does not exist on npm" became false while "0.1.0 is not published" stayed
  // true. Four documents asserted the first, and every guard in this file was satisfied by both,
  // because none of them distinguished the package from the version.
  if (s.registryVersions.length > 0 && s.docsClaimPackageAbsent) {
    problems.push(`the registry serves ${s.registryVersions.join(', ')} but the docs say the package `
      + 'itself does not exist');
  }
  return problems;
}

test('the registry comparison fires when docs claim an install that is not published', () => {
  // The #431 defect, expressed as data. Without this case the guard's only evidence is that it stayed
  // quiet, which is also what a guard that can never fire looks like.
  const problems = fleetDocDrift({
    registryVersions: ['0.0.1-bootstrap'], manifestVersion: '0.1.0',
    docsOfferInstall: true, securitySaysReleased: true, docsClaimPackageAbsent: false,
  });
  assert.equal(problems.length, 2, `expected both the install and SECURITY.md to be reported: ${problems}`);
  assert.match(problems.join('\n'), /offer an install but the registry has no 0\.1\.0/);
  assert.match(problems.join('\n'), /SECURITY\.md/);
});

test('the registry comparison fires when docs withhold an install that is published', () => {
  // The other direction: after the release lands, the same docs become a false understatement and stop
  // telling anyone the package is installable.
  const problems = fleetDocDrift({
    registryVersions: ['0.0.1-bootstrap', '0.1.0'], manifestVersion: '0.1.0',
    docsOfferInstall: false, securitySaysReleased: false, docsClaimPackageAbsent: false,
  });
  assert.equal(problems.length, 2, `expected both to be reported: ${problems}`);
  assert.match(problems.join('\n'), /still refuse to offer an install/);
});

test('an unreachable registry is not reported as drift', () => {
  // Absent evidence is not evidence of absence. Reporting drift here would make CI red whenever the
  // network is down, which is the fastest way to get a useful guard deleted.
  assert.deepEqual(fleetDocDrift({
    registryVersions: null, manifestVersion: '0.1.0', docsOfferInstall: false, securitySaysReleased: false,
    docsClaimPackageAbsent: true,
  }), []);
});

test('the Fleet docs match what the npm registry actually serves', async (t) => {
  const manifest = JSON.parse(read('fleet/package.json')) as { version: string };
  let registryVersions: string[] | null = null;
  try {
    const res = await fetch('https://registry.npmjs.org/@aywengo%2fmercury-fleet',
      { signal: AbortSignal.timeout(20_000) });
    // A 404 is a real answer, not a failure: the package genuinely does not exist yet.
    if (res.status === 404) registryVersions = [];
    else if (res.ok) {
      // Read the body exactly once. `fetch` bodies are single-use, and an assertion message that
      // interpolates `await res.text()` consumes it even when the assertion passes.
      const body = await res.text();
      registryVersions = Object.keys(JSON.parse(body).versions ?? {});
    } else {
      t.skip(`registry answered ${res.status}`);
      return;
    }
  } catch (e) {
    t.skip(`registry unreachable: ${(e as Error).name}`);
    return;
  }

  const notesDir = join(ROOT, 'docs', 'releases', 'fleet');
  const docsText = ['fleet/CHANGELOG.md', 'docs/README.md',
    ...readdirSync(notesDir).filter((f) => f.endsWith('.md'))
    .map((f) => join('docs/releases/fleet', f))].map((f) => read(f)).join('\n');
  // Only a command inside a fenced block counts as an offer: prose that merely names the package is not
  // something a reader runs, and the original defect was a runnable command.
  const fences = docsText.match(/```[^\n]*\n[\s\S]*?```/g) ?? [];
  const docsOfferInstall = fences.some((b) => /npm (?:install|i)\b[^\n]*mercury-fleet/.test(b));
  const secRow = read('SECURITY.md').split('\n').find((l) => /mercury-fleet/.test(l)) ?? '';
  assert.ok(secRow, 'SECURITY.md must keep its Fleet row');

  // "The package does not exist" and "this version is not published" are different claims, and the
  // bootstrap publish made the first false while the second stayed true. Detect the first by looking for
  // the package name near an absence claim with no version between them.
  const docsClaimPackageAbsent = claimsPackageAbsent(docsText);
  const state: FleetDocState = {
    registryVersions, manifestVersion: manifest.version, docsOfferInstall,
    securitySaysReleased: !/Not released/i.test(secRow), docsClaimPackageAbsent,
  };
  assert.deepEqual(fleetDocDrift(state), [],
    `docs and registry disagree (registry serves ${registryVersions.join(', ') || 'nothing'}, `
    + `docs offer install=${docsOfferInstall}):\n${read('docs/releases/fleet/0.1.0.md').slice(0, 200)}`);
});

test('the registry comparison fires when docs call an existing package absent', () => {
  // The bootstrap publish created the package page. Four documents kept saying the package "does not
  // exist on npm", which was then false, while "0.1.0 is not published" remained true. Every guard in
  // this file passed throughout, because none distinguished the package from the version.
  const problems = fleetDocDrift({
    registryVersions: ['0.0.1-bootstrap'], manifestVersion: '0.1.0',
    docsOfferInstall: false, securitySaysReleased: false, docsClaimPackageAbsent: true,
  });
  assert.equal(problems.length, 1, `expected exactly the package-absence claim: ${problems}`);
  assert.match(problems[0], /package itself does not exist/);
});

test('the docs do not call the Fleet package absent while the registry serves it', () => {
  // The textual half of the same invariant, so a regression is caught even where the live read skips.
  const docs = ['fleet/CHANGELOG.md', 'docs/README.md', 'docs/releases/fleet/0.1.0.md',
    'docs/releases/fleet/0.1.0-rc1.md'].map((f) => read(f)).join('\n');
  assert.ok(!claimsPackageAbsent(docs),
    'the package page exists; say which VERSION is unpublished instead of calling the package absent');
  // And the placeholder is a live trap: `latest` points at a non-release that prints `0.1.0`.
  assert.match(docs, /placeholder/, 'the docs must warn that latest points at a bootstrap placeholder');
});

test('the runbook does not claim a token publish preserves attestations', () => {
  // The runbook used to say, in bold: "The fallback is a short-lived token, and it does not cost you
  // provenance." It cited a real log line and a real Rekor entry, and was still wrong. Measured on the
  // registry, `@aywengo/mercury@0.1.0-rc1` -- the very run cited -- has NO attestations (404), while
  // `0.1.0-rc2` and `0.1.0`, both published through OIDC trusted publishing, each carry two including
  // `slsa.dev/provenance/v1`. npm wrote the statement to Rekor but never attached it to the version, so
  // `npm audit signatures` and the registry API see nothing. This is the most consequential doc error
  // in the release path, because it is the argument that talks an operator into silently downgrading a
  // release while believing they kept its security property.
  const doc = read('docs/releasing.md').replace(/\r\n/g, '\n');
  const paras = doc.split(/[ \t]*\n[ \t]*\n/);
  const claim = paras.filter((x) => /short-lived token/.test(x));
  assert.equal(claim.length, 1, 'exactly one paragraph must carry the token-fallback guidance');
  assert.match(claim[0], /DOES cost you provenance|does cost you provenance/i,
    'the guidance must state that the token fallback costs provenance');
  assert.ok(!/does not cost you provenance/i.test(claim[0]),
    'the disproven claim must not come back');
  // The correction is only useful if it names the measured evidence rather than just the conclusion.
  // Scoped to the fallback section. `Rekor` is discussed legitimately further down the file, so a
  // whole-document match was satisfied even with the explanation deleted here -- the same scope error
  // that bit the bootstrap guard.
  const section = doc.slice(doc.indexOf(claim[0]), doc.indexOf(claim[0]) + 3000);
  assert.match(section, /0\.1\.0-rc1[^|]*\|[^|]*`?NPM_TOKEN`?[^|]*\|[^|]*404/,
    'the table must show rc1 (token) as having no attestations');
  // The claim, not the keyword: the point is that the statement reached Rekor but npm never attached it
  // to the version. Asserting bare /Rekor/ was satisfied by the unrelated verification section further
  // down the same file, so deleting the explanation here went uncaught.
  assert.match(section, /Rekor[\s\S]{0,400}?(?:never|not)[\s\S]{0,80}?attach\w* it to the\s+published version/i,
    'it must say the statement reached Rekor but was never attached to the published version');
  assert.match(section, /npm audit signatures/, 'and name the tooling that therefore sees nothing');
});

test('the registry attestations still match what the runbook records', async (t) => {
  // The corrected passage is a set of claims about three immutable published versions. Pinning the
  // wording would let the claims rot silently; this checks them against npm and skips when the network
  // is unavailable, so CI never depends on a third party it does not control.
  const probe = async (ver: string): Promise<number> => {
    try {
      const res = await fetch(
        `https://registry.npmjs.org/-/npm/v1/attestations/@aywengo/mercury@${ver}`,
        { signal: AbortSignal.timeout(20_000) });
      return res.status;
    } catch (e) {
      return -1;
    }
  };
  // Only 200 and 404 are ANSWERS. A 503 from the registry -- which is what this probe returned on the
  // first CI run, on node 22 only, while node 24 got 200 for the same version minutes apart -- says
  // nothing about attestations. Treating a thrown fetch as "unreachable" while letting an error status
  // fall through to the assertion is the exact mistake #447 fixed in the release body: an unconfirmed
  // probe must never be reported as a confirmed absence.
  const ANSWERED = (s: number) => s === 200 || s === 404;
  const rc1 = await probe('0.1.0-rc1');
  if (!ANSWERED(rc1)) { t.skip(`registry gave ${rc1} for 0.1.0-rc1; not an answer`); return; }
  const stable = await probe('0.1.0');
  if (!ANSWERED(stable)) { t.skip(`registry gave ${stable} for 0.1.0; not an answer`); return; }
  assert.equal(rc1, 404,
    'the runbook records rc1 (token-published) as having no attestations; if that changed, correct the doc');
  assert.equal(stable, 200,
    'the runbook records 0.1.0 (OIDC-published) as carrying attestations; if that changed, correct the doc');
});

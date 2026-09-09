import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  // @aywengo/mercury-fleet does not exist yet, so its first publish cannot use trusted publishing -- the
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

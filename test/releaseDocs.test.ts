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
          assert.match(line, /--max-time\s+\d+/, `${doc}: unbounded curl in a runbook block: ${line.trim()}`);
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
  assert.ok(!/-m "Mercury \$\{product\}/.test(block),
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

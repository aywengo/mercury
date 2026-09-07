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

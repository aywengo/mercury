/**
 * Issue #596: `waitFor` used to fail with the four words "waitFor timed out", which made a timeout
 * unattributable.
 *
 * Two knowledge tests degrade under heavy concurrent load, and every occurrence looked identical: a 20 s
 * deadline missed somewhere in a Run. The wait that failed could have been workspace creation, the worker
 * claiming the Run, or the Run reaching its terminal status, and the message did not distinguish them. Since
 * the load needed to trigger it is beyond what the machine now reaches, the failures were unreproducible AND
 * undiagnosable -- the worst combination, and the reason this is worth a test of its own rather than a fix
 * to the tests that happened to time out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './helpers.ts';

test('a waitFor timeout names the condition it was waiting for', async () => {
  // `string`, not a literal: the predicate must be a comparison TypeScript cannot prove false, or
  // the file stops typechecking and CI blocks it even though the test itself passes.
  const run: { status: string } = { status: 'RUNNING' };
  await assert.rejects(() => waitFor(() => run.status === 'DONE', 30, 5), (err: unknown) => {
    const msg = (err as Error).message;
    assert.match(msg, /waitFor timed out/, 'still recognisable as a waitFor failure');
    assert.match(msg, /after \d+ms/, 'reports how long it actually waited');
    assert.match(msg, /limit 30ms/, 'reports the deadline that was passed, which varies per call site');
    // The predicate's SOURCE, which is what makes a timeout attributable to a call site. Asserting on the
    // source rather than on a label means the message cannot drift away from the code it describes.
    assert.match(msg, /waiting for: .*status === 'DONE'/,
      'names the condition -- without this the message is unattributable');
    return true;
  });
});

test('the named condition survives the whitespace a real predicate is written with', async () => {
  // The call sites that matter are multi-line arrow functions over Run state, e.g.
  //   waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 20_000)
  // Collapsing newlines keeps that on one line of output instead of scattering it across the log.
  // `string`, not a literal: the predicate must be a comparison TypeScript cannot prove false, or
  // the file stops typechecking and CI blocks it even though the test itself passes.
  const run: { status: string } = { status: 'RUNNING' };
  await assert.rejects(
    () => waitFor(() => run.status === 'COMPLETED', 30, 5),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.ok(!msg.includes('\n'), `the message must stay on one line: ${JSON.stringify(msg)}`);
      assert.match(msg, /status === 'COMPLETED'/, 'the predicate is readable, not just present');
      return true;
    },
  );
});

test('waitFor still returns as soon as the condition holds', async () => {
  // The diagnosis is only worth having if the happy path is untouched: a helper that starts swallowing
  // or delaying success would make every timing test lie in the same direction.
  let n = 0;
  const t0 = Date.now();
  await waitFor(() => ++n >= 3, 5_000, 5);
  assert.equal(n, 3, 'stops polling the moment the condition holds');
  assert.ok(Date.now() - t0 < 1_000, 'returns promptly rather than waiting out the deadline');
});

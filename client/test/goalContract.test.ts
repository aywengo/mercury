/**
 * The contract is the part that says what "met" meant, and until issue #497 nothing on the
 * read side could display it: the server stored it, the API returned it, and the client parser
 * dropped it on the floor.
 *
 * Section 4 argues a COMPLETED Run must not be read as "done". The thing that defines "done" is
 * the contract, so showing `unmet` while hiding the contract reproduces that failure one level
 * down -- which is what these tests prevent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunDetailResponse, ProtocolError } from '../api/protocol.ts';
import { renderRunDetail } from '../commands/show.ts';

const RUN = {
  id: 'run_1', ownerId: 'a', task: 'fix it', agent: 'fake', status: 'COMPLETED', attempt: 1,
  retryOf: null, error: null, errorKind: null, constraints: { maxDurationMs: 1, maxRetries: 0 },
  createdAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:01Z',
  completedAt: '2026-01-01T00:10:00Z', workspaceBranch: null, workspacePath: null,
  leaseOwner: null, leaseExpiresAt: null, cancellationRequestedAt: null,
  finalCommits: [], prUrl: null, repository: { url: 'https://example.invalid/r.git' },
};

const GOAL = {
  runId: 'run_1', status: 'unmet', objective: 'make the tests pass', updatedAt: '2026-01-01T00:10:00Z',
};

const detail = (extra: Record<string, unknown> = {}) => ({ run: RUN, skills: [], ...extra });
const render = (goal: unknown) => renderRunDetail(
  parseRunDetailResponse(detail(goal === undefined ? {} : { goal })),
  { json: false, noColor: true } as never,
  false,
);

test('the contract survives the parser instead of being dropped', () => {
  const contract = {
    outcome: 'all tests pass',
    verification: 'npm test exits 0',
    constraints: 'no new dependencies',
    boundaries: 'do not touch the schema',
    stopWhen: 'two consecutive failures',
  };
  const parsed = parseRunDetailResponse(detail({ goal: { ...GOAL, contract } }));
  assert.deepEqual(parsed.goal?.contract, contract);
});

test('a contract with no fields is absent, not an empty object', () => {
  // `{}` and "no contract" must not be two ways to say the same thing, or a consumer cannot
  // tell an operator who set nothing from one who set an empty something.
  for (const value of [undefined, null, {}, { outcome: '   ' }, { outcome: '' }]) {
    const parsed = parseRunDetailResponse(detail({ goal: { ...GOAL, contract: value } }));
    assert.ok(!('contract' in (parsed.goal ?? {})), `contract ${JSON.stringify(value)} should be absent`);
  }
});

test('a non-string contract field is rejected, not rendered as [object Object]', () => {
  // The success condition an operator is being judged against is not something to coerce.
  for (const bad of [{ outcome: 42 }, { verification: ['a'] }, { constraints: {} }, { stopWhen: true }]) {
    assert.throws(
      () => parseRunDetailResponse(detail({ goal: { ...GOAL, contract: bad } })),
      ProtocolError,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test('unknown contract fields are ignored, not rejected', () => {
  // The contract is free-form prose and a newer server may add a field this client predates.
  const parsed = parseRunDetailResponse(detail({ goal: { ...GOAL, contract: { outcome: 'x', futureField: 'y' } } }));
  assert.deepEqual(parsed.goal?.contract, { outcome: 'x' });
});

test('runs show renders the contract beside the objective it defines', () => {
  const out = render({
    ...GOAL,
    contract: { outcome: 'all tests pass', verification: 'npm test exits 0', stopWhen: 'two failures' },
  });
  for (const text of ['all tests pass', 'npm test exits 0', 'two failures']) {
    assert.ok(out.includes(text), `contract value "${text}" was not rendered`);
  }
  assert.ok(out.includes('must achieve') && out.includes('verified by') && out.includes('stop when'));
  // Objective must still be present: the contract supplements it, it does not replace it.
  assert.ok(out.includes('make the tests pass'));
});

test('runs show omits contract labels entirely when no contract was set', () => {
  const out = render(GOAL);
  for (const label of ['must achieve', 'verified by', 'out of scope', 'stop when']) {
    assert.ok(!out.includes(label), `${label} appeared with no contract`);
  }
  assert.ok(out.includes('make the tests pass'), 'the objective must still render');
});

test('contract text is treated as untrusted input', () => {
  // Free text from whoever created the Run, rendered into a terminal.
  const out = render({ ...GOAL, contract: { outcome: 'done\u001b[31mPWNED\u0007' } });
  assert.ok(!out.includes('\u001b'), 'escape sequence reached the terminal');
  assert.ok(!out.includes('\u0007'), 'bell character reached the terminal');
});

test('the contract never claims a verdict', () => {
  // Mercury records the contract and does not judge it (docs/goals.md 12). A tick or a
  // pass marker here would turn a recorded request into a fabricated result.
  const out = render({ ...GOAL, contract: { outcome: 'all tests pass', verification: 'npm test' } });
  for (const mark of ['PASS', 'pass:', '✓', '✔', 'FAIL']) {
    assert.ok(!out.includes(mark), `contract rendering claimed a verdict with ${mark}`);
  }
});

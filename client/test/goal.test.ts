// Phase 3 client surface: goal state parses across all three states and renders beside, never
// instead of, Run status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunDetailResponse, parseRunListResponse, ProtocolError } from '../api/protocol.ts';
import { renderRunDetail } from '../commands/show.ts';
import { renderRunList } from '../commands/list.ts';

const OFF = { json: false, noColor: true, cursor: undefined } as never;

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
  tokensUsed: 4200, tokenBudget: 5000, turnsUsed: 7, source: 'operator',
};

function detail(extra: Record<string, unknown> = {}) {
  return { run: RUN, skills: [], ...extra };
}

test('detail parses a goal when the server sends one', () => {
  const parsed = parseRunDetailResponse(detail({ goal: GOAL }));
  assert.equal(parsed.goal?.status, 'unmet');
  assert.equal(parsed.goal?.objective, 'make the tests pass');
  assert.equal(parsed.goal?.tokenBudget, 5000);
});

test('detail distinguishes "no goal" from "server predates goals"', () => {
  // The three states must survive parsing. Collapsing an absent key into null would make an old
  // server report that every Run was given no objective, which is a claim about data the client
  // has never been told.
  const answered = parseRunDetailResponse(detail({ goal: null }));
  const silent = parseRunDetailResponse(detail());
  assert.equal(answered.goal, null);
  assert.equal(silent.goal, undefined);
  assert.notEqual(answered.goal, silent.goal);
});

test('an unknown goal status is rejected rather than rendered', () => {
  // Same rule as event types: a status the client cannot name must not be drawn as if it were
  // one it can, because the operator would act on a label that means nothing.
  assert.throws(
    () => parseRunDetailResponse(detail({ goal: { ...GOAL, status: 'teleported' } })),
    (e: unknown) => e instanceof ProtocolError && /unknown goal status/.test(e.message),
  );
  assert.throws(
    () => parseRunListResponse({ runs: [RUN], nextCursor: null, goals: { run_1: 'teleported' } }),
    (e: unknown) => e instanceof ProtocolError && /unknown goal status/.test(e.message),
  );
});

test('runs show prints Run status AND goal status together', () => {
  // The headline pair the feature exists to expose: a COMPLETED run whose objective was not met.
  // If either word can be missing, the CLI has reproduced the original problem.
  const out = renderRunDetail(
    { run: RUN as never, skills: [], goal: GOAL as never },
    OFF, false,
  );
  assert.match(out, /^status\s+COMPLETED$/m, 'Run status missing');
  assert.match(out, /^goal\s+unmet$/m, 'goal status missing');
  assert.match(out, /objective\s+make the tests pass/);
  assert.match(out, /goal tokens\s+4200 \/ 5000/);
  // Both on their own lines, Run status first: one must not be substituted for the other.
  const statusAt = out.search(/^status\s+COMPLETED$/m);
  const goalAt = out.search(/^goal\s+unmet$/m);
  assert.ok(statusAt >= 0 && goalAt >= 0);
  assert.ok(statusAt < goalAt, 'goal status printed before run status');
});

test('runs show says "unknown" for a server that predates goals, never "none"', () => {
  const silent = renderRunDetail({ run: RUN as never, skills: [] }, OFF, false);
  const answered = renderRunDetail({ run: RUN as never, skills: [], goal: null }, OFF, false);
  assert.match(silent, /goal\s+unknown/, 'a silent server must not claim the Run had no goal');
  assert.match(answered, /goal\s+none$/m);
  assert.notEqual(silent, answered);
});

test('runs list shows a Goal column with all three states', () => {
  const withGoal = renderRunList(
    { runs: [RUN as never], nextCursor: null, goals: { run_1: 'unmet' } } as never, OFF, false,
  );
  assert.match(withGoal, /STATUS\s+GOAL\s+AGENT/);
  assert.match(withGoal, /COMPLETED\s+unmet/);

  const goalless = renderRunList({ runs: [RUN as never], nextCursor: null, goals: {} } as never, OFF, false);
  assert.match(goalless, /COMPLETED\s+-\s/, 'a run with no goal must show a dash, not a blank');

  const silent = renderRunList({ runs: [RUN as never], nextCursor: null } as never, OFF, false);
  assert.match(silent, /COMPLETED\s+\?/, 'a silent server must render unknown, not absence');
});

test('goal status never overwrites run status in list output', () => {
  // A regression that would be easy to introduce: writing the goal into the status column when
  // a goal exists. Assert the status column keeps the Run status even when the goal disagrees.
  const out = renderRunList(
    { runs: [RUN as never], nextCursor: null, goals: { run_1: 'unmet' } } as never, OFF, false,
  );
  assert.match(out, /COMPLETED/);
  assert.ok(!/^\s*unmet\s+COMPLETED/m.test(out), 'goal and run status swapped columns');
});

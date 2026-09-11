// Phase 4: gate specs are parsed strictly and rendered as a SPEC, never as an outcome.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunDetailResponse, ProtocolError } from '../api/protocol.ts';
import { renderRunDetail } from '../commands/show.ts';
import { goalGatesHtml } from '../../ui/app.js';

const OFF = { json: false, noColor: true, cursor: undefined } as never;

const RUN = {
  id: 'run_1', ownerId: 'a', task: 'fix it', agent: 'fake', status: 'COMPLETED', attempt: 1,
  retryOf: null, error: null, errorKind: null, constraints: { maxDurationMs: 1, maxRetries: 0 },
  createdAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:01Z',
  completedAt: '2026-01-01T00:10:00Z', workspaceBranch: null, workspacePath: null,
  leaseOwner: null, leaseExpiresAt: null, cancellationRequestedAt: null,
  finalCommits: [], prUrl: null, repository: { url: 'https://example.invalid/r.git' },
};

function goal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run_1', status: 'unmet', objective: 'make the tests pass',
    updatedAt: '2026-01-01T00:10:00Z', ...extra,
  };
}
function detail(extra: Record<string, unknown> = {}) {
  return { run: RUN, skills: [], ...extra } as never;
}

test('gate specs survive the protocol round trip', () => {
  const gates = [
    { command: 'npm test', timeoutMs: 60000, maxRetries: 2 },
    { command: 'npm run lint', timeoutMs: 1500, maxRetries: 0 },
  ];
  const parsed = parseRunDetailResponse(detail({ goal: goal({ gates }) }));
  assert.deepEqual(parsed.goal?.gates, gates);
});

test('a malformed gate is rejected rather than silently dropped', () => {
  // A gate list that quietly loses entries would understate what the harness was asked to
  // enforce, which is the opposite of what this surface is for.
  for (const bad of [
    goal({ gates: [{ command: 42, timeoutMs: 1, maxRetries: 0 }] }),
    goal({ gates: [{ command: 'x', timeoutMs: 'soon', maxRetries: 0 }] }),
    goal({ gates: [{ command: 'x', timeoutMs: 1 }] }),
    goal({ gates: 'npm test' }),
    goal({ gates: [null] }),
  ]) {
    assert.throws(
      () => parseRunDetailResponse(detail({ goal: bad })),
      ProtocolError,
      `accepted a malformed gate: ${JSON.stringify(bad.gates)}`,
    );
  }
});

test('a goal with no gates parses without inventing an empty list', () => {
  const parsed = parseRunDetailResponse(detail({ goal: goal() }));
  assert.equal(parsed.goal?.gates, undefined, 'an absent gate list became something it is not');
});

test('runs show renders each declared gate with its timeout and retries', () => {
  const out = renderRunDetail(detail({
    goal: goal({ gates: [
      { command: 'npm test', timeoutMs: 60000, maxRetries: 2 },
      { command: 'npm run lint', timeoutMs: 1500, maxRetries: 0 },
    ] }),
  }), OFF, false);
  assert.match(out, /npm test/);
  assert.match(out, /60s/);
  assert.match(out, /2 retries/);
  assert.match(out, /npm run lint/);
  assert.match(out, /1500ms/, 'a sub-second timeout must not render as 0s');
  assert.doesNotMatch(out, /1 retries/, 'retry counts must agree with their noun');
});

test('runs show renders no gate lines when there are none', () => {
  const out = renderRunDetail(detail({ goal: goal() }), OFF, false);
  assert.doesNotMatch(out, /gate 1/);
});

test('a hostile gate command cannot break out of the terminal line', () => {
  // The command is caller-supplied text that round-trips through the API. It is rendered on the
  // same line as dimmed metadata, so an unescaped control sequence could restyle the rest.
  const evil = `npm test\u001b[31m\u0007$(rm -rf /)`;
  const out = renderRunDetail(detail({
    goal: goal({ gates: [{ command: evil, timeoutMs: 1000, maxRetries: 0 }] }),
  }), OFF, false);
  assert.ok(!out.includes('\u001b'), `raw escape sequence reached the terminal: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('\u0007'), 'raw BEL reached the terminal');
});

test('goalGatesHtml escapes a hostile command', () => {
  const html = goalGatesHtml(goal({
    gates: [{ command: '</code><img src=x onerror=alert(1)>', timeoutMs: 1000, maxRetries: 0 }],
  }));
  // What matters is that no live tag or attribute survives. The payload's literal text is
  // expected to appear -- escaped -- since the point is to show the operator the command.
  assert.ok(!html.includes('<img'), `unescaped tag in markup: ${html}`);
  assert.ok(html.includes('&lt;img'), 'the payload should be present but escaped');
  assert.equal(html.match(/<code>/g)?.length, 1, 'exactly one code element should exist');
  assert.equal(html.match(/<\/code>/g)?.length, 1);
});

test('goalGatesHtml renders nothing when there is nothing to say', () => {
  // Three shapes, one answer: no goal, no gates, and a server that never had the field.
  assert.equal(goalGatesHtml(null), '');
  assert.equal(goalGatesHtml(undefined), '');
  assert.equal(goalGatesHtml(goal()), '');
  assert.equal(goalGatesHtml(goal({ gates: [] })), '');
});

test('gate markup claims no outcome', () => {
  // Mercury records the spec and never runs it (docs/goals.md 12). Markup that reads as a
  // verdict would put a judgement in Mercury's mouth that the design forbids it from making.
  const html = goalGatesHtml(goal({
    gates: [{ command: 'npm test', timeoutMs: 60000, maxRetries: 1 }],
  }));
  for (const claim of ['pass', 'fail', 'ok', 'green', 'red', 'success', '✔', '✗', '✓']) {
    assert.ok(!html.toLowerCase().includes(claim.toLowerCase()), `gate markup claims "${claim}": ${html}`);
  }
});

test('goalGatesHtml coerces wire numbers defensively', () => {
  // The parser guarantees numbers, but the function is exported and used from the dashboard on
  // data that reached innerHTML; a non-number must produce escaped text, not markup.
  const html = goalGatesHtml({ gates: [{ command: 'x', timeoutMs: { toString: () => '<b>1</b>' }, maxRetries: 0 }] } as never);
  assert.ok(!html.includes('<b>'), `object coerced into markup: ${html}`);
});

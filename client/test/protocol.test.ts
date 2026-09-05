import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAgentsResponse, parseCreateRunResponse, parseRunActionResponse, parseRetryRunResponse,
  parseRunListResponse, parseRunDetailResponse, parseEventPage, parseRun, parseEvent, parseOkResponse, ProtocolError,
} from '../api/protocol.ts';

// Fixtures for every endpoint the client consumes (docs/cli-tui-design.md §16 M0 acceptance).
//
// Shapes are transcribed from the real handlers in src/api/routes.ts, not from docs/api.md, because
// a fixture written from a doc reproduces the doc's errors. Two examples here are things only the
// handler makes obvious: GET /runs/:id returns bare ResolvedSkill objects (not the RunSkill wrapper
// the table name suggests), and run-list nextCursor is a string while event nextCursor is a number.

const RUN = {
  id: 'run-1', ownerId: 'alice', task: 'fix the flaky test',
  repository: { url: 'https://example/repo.git' },
  workspaceBranch: 'mercury/run-1', workspacePath: '/ws/run-1',
  agent: 'fake', status: 'FAILED', attempt: 1, retryOf: null,
  error: 'agent exited with code 1', errorKind: 'agent',
  constraints: { maxDurationMs: 600000, maxRetries: 2 },
  createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:01.000Z',
  completedAt: '2026-01-01T00:02:00.000Z', leaseOwner: null, leaseExpiresAt: null,
  cancellationRequestedAt: null, finalCommits: ['abc123'], prUrl: null,
};

const SKILL = {
  id: 'testing', version: '1.0.0', description: 'verify changes', capabilities: ['verify'],
  path: '/skills/testing', content: '# testing', files: {}, hash: 'sha256:abc',
};

const EVENT = {
  id: 'e1', runId: 'run-1', type: 'tool.started', sequence: 1,
  timestamp: '2026-01-01T00:00:02.000Z', payload: { tool: 'Bash' },
};

test('GET /api/agents', () => {
  assert.deepEqual(parseAgentsResponse({ agents: ['fake', 'prime'], defaultAgent: 'fake' }), {
    agents: ['fake', 'prime'], defaultAgent: 'fake',
  });
});

test('POST /api/runs -> 201 body', () => {
  assert.deepEqual(parseCreateRunResponse({ runId: 'run-1', status: 'QUEUED' }), {
    runId: 'run-1', status: 'QUEUED',
  });
});

test('GET /api/runs -> runs plus opaque string cursor', () => {
  const page = parseRunListResponse({ runs: [RUN], nextCursor: '2026-01-01T00:00:00.000Z|run-1' });
  assert.equal(page.runs.length, 1);
  // The cursor is passed back UNCHANGED. Asserting the exact string here documents that the client
  // must not parse it into parts.
  assert.equal(page.nextCursor, '2026-01-01T00:00:00.000Z|run-1');
});

test('GET /api/runs -> null cursor means the end of the list', () => {
  assert.equal(parseRunListResponse({ runs: [], nextCursor: null }).nextCursor, null);
});

test('GET /api/runs/:id -> run plus bare ResolvedSkill objects', () => {
  const detail = parseRunDetailResponse({ run: RUN, skills: [SKILL] });
  assert.equal(detail.run.id, 'run-1');
  assert.equal(detail.skills[0]!.id, 'testing');
});

test('GET /api/runs/:id/events -> page with numeric cursor', () => {
  const page = parseEventPage({ events: [EVENT], lastSequence: 5, nextCursor: 1, hasMore: true });
  assert.equal(page.nextCursor, 1);
  assert.equal(page.hasMore, true);
});

test('POST cancel -> runId and status', () => {
  assert.deepEqual(parseRunActionResponse({ runId: 'run-1', status: 'CANCELLED' }), {
    runId: 'run-1', status: 'CANCELLED',
  });
});

test('POST retry -> new runId, status and retryOf', () => {
  assert.deepEqual(parseRetryRunResponse({ runId: 'run-2', status: 'QUEUED', retryOf: 'run-1' }), {
    runId: 'run-2', status: 'QUEUED', retryOf: 'run-1',
  });
});

test('retryOf may be null but must be present', () => {
  assert.equal(parseRetryRunResponse({ runId: 'r', status: 'QUEUED', retryOf: null }).retryOf, null);
  // Absent is a protocol break: retryOf is the only evidence the command produced a NEW Run rather
  // than transitioning the old one, which the command contract forbids presenting.
  assert.throws(() => parseRetryRunResponse({ runId: 'r', status: 'QUEUED' }), ProtocolError);
});

test('an unknown Run status is a protocol break, not a tolerated unknown field', () => {
  // Tolerating it would force a guess: treat PAUSED as terminal and `runs watch` reports an outcome
  // that never happened; treat it as running and watch hangs forever on a finished Run.
  assert.throws(() => parseRun({ ...RUN, status: 'PAUSED' }), ProtocolError);
});

test('an unknown event TYPE is tolerated, an unknown status is not', () => {
  // The asymmetry is the point. A new event type only needs generic rendering, so an older client
  // must keep working when Mercury learns one. Failing here would break a complete Run over cosmetics.
  const ev = parseEvent({ ...EVENT, type: 'agent.thinking.v2' });
  assert.equal(ev.type, 'agent.thinking.v2');
});

test('unknown extra fields are preserved rather than dropped', () => {
  const run = parseRun({ ...RUN, futureField: { nested: true } });
  assert.deepEqual((run as unknown as Record<string, unknown>).futureField, { nested: true });
});

test('a missing event sequence is a hard failure and never defaults to zero', () => {
  // Defaulting to 0 would make every event look like a duplicate of the cursor and the observer
  // would silently drop the entire stream while exiting 0.
  const { sequence: _drop, ...withoutSeq } = EVENT;
  assert.throws(() => parseEvent(withoutSeq), /sequence/);
  assert.throws(() => parseEvent({ ...EVENT, sequence: '3' }), /sequence/);
  assert.throws(() => parseEvent({ ...EVENT, sequence: NaN }), /sequence/);
});

test('a missing event nextCursor is a hard failure', () => {
  // Paging from lastSequence instead is issue #54 exactly: on a capped page it skips every event the
  // cap left out, and the client would report a complete history while missing the tail.
  assert.throws(
    () => parseEventPage({ events: [EVENT], lastSequence: 5, hasMore: true }),
    /nextCursor/,
  );
});

test('a missing run-list cursor is a hard failure rather than a silent end of list', () => {
  // Reading an absent nextCursor as null would truncate the list while looking like a full result.
  assert.throws(() => parseRunListResponse({ runs: [RUN] }), /nextCursor/);
});

test('non-object responses are rejected rather than read as empty', () => {
  for (const bad of [null, undefined, 42, 'oops', []]) {
    assert.throws(() => parseRunListResponse(bad), ProtocolError);
  }
});

test('a non-array runs field is rejected', () => {
  assert.throws(() => parseRunListResponse({ runs: { '0': RUN }, nextCursor: null }), ProtocolError);
});

test('an ok acknowledgement must actually say ok', () => {
  assert.deepEqual(parseOkResponse({ ok: true }), { ok: true });
  // A 200 with an unexpected or error-shaped body must not be reported as accepted, or a failed
  // `runs input` tells the operator the Run was answered while it stays NEEDS_INPUT.
  assert.throws(() => parseOkResponse({}), ProtocolError);
  assert.throws(() => parseOkResponse({ ok: false }), ProtocolError);
  assert.throws(() => parseOkResponse({ error: 'boom' }), ProtocolError);
});

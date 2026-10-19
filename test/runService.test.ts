import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { NotFoundError } from '../src/domain/errors.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/db/database.ts';
import { makeEnv, tempDir, waitFor } from './helpers.ts';
import type { AgentAdapter, RunConstraints } from '../src/domain/types.ts';
import { hasStarted } from '../src/domain/types.ts';
import { createRedactor } from '../src/domain/redact.ts';
import { FakeAgentAdapter } from '../src/adapters/fakeAgentAdapter.ts';
import { validateModelShape } from '../src/runs/runService.ts';

test('omitting agent selects fake', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'smoke' });
    assert.equal(run.agent, 'fake');
  } finally {
    env.close();
  }
});

test('omitting agent uses defaultAgent override', () => {
  const env = makeEnv({
    workerEnabled: false,
    defaultAgent: 'primeagent',
    adapters: { primeagent: new FakeAgentAdapter({ script: [] }) },
  });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'smoke' });
    assert.equal(run.agent, 'primeagent');
  } finally {
    env.close();
  }
});

test('unknown defaultAgent fails at construction', () => {
  assert.throws(
    () => makeEnv({ workerEnabled: false, defaultAgent: 'nope' }),
    /MERCURY_DEFAULT_AGENT=nope is not a registered agent/,
  );
});

test('create run: QUEUED, stable id, events persisted', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Fix the failing integration tests',
      agent: 'fake',
    });
    assert.match(run.id, /^run_/);
    assert.equal(run.status, 'QUEUED');
    assert.equal(run.ownerId, 'alice');
    const events = env.events.list(run.id);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('run.created'));
    assert.ok(types.includes('run.queued'));
    assert.ok(types.includes('skill.selected'));
    // sequences are monotonic
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].sequence > events[i - 1].sequence);
    }
  } finally {
    env.close();
  }
});

test('idempotency key returns the same run', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const input = {
      ownerId: 'alice',
      task: 'Upgrade dependencies',
      agent: 'fake',
      idempotencyKey: 'key-123',
    };
    const r1 = env.runService.create(input);
    const r2 = env.runService.create(input);
    assert.equal(r1.id, r2.id);
  } finally {
    env.close();
  }
});

test('unknown agent rejected', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'nope' }),
      /Unknown agent/,
    );
  } finally {
    env.close();
  }
});


test('create run with repositories[] persists them and is backward compatible', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Cross-repo refactor',
      agent: 'fake',
      repository: { url: 'https://example.com/main.git' },
      repositories: [
        { url: 'https://example.com/lib-a.git' },
        { url: 'https://example.com/lib-b.git' },
      ],
    });
    assert.equal(run.repository.url, 'https://example.com/main.git');
    assert.equal(run.repositories?.length, 2);
    // Round-trip through the store.
    const loaded = env.runs.get(run.id)!;
    assert.equal(loaded.repositories?.length, 2);
    assert.equal(loaded.repositories?.[0].url, 'https://example.com/lib-a.git');
  } finally {
    env.close();
  }
});

test('create run with only repository (no repositories) still works', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'Single repo task',
      agent: 'fake',
      repository: { url: 'https://example.com/only.git' },
    });
    assert.equal(run.repositories, undefined);
    const loaded = env.runs.get(run.id)!;
    assert.equal(loaded.repositories, undefined);
  } finally {
    env.close();
  }
});

test('cancel queued run transitions to CANCELLED', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    const cancelled = env.runService.cancel(run.id, 'alice', false);
    assert.equal(cancelled.status, 'CANCELLED');
    const events = env.events.list(run.id).map((e) => e.type);
    assert.ok(events.includes('run.cancelled'));
  } finally {
    env.close();
  }
});

test('cancel requires ownership', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    // Asserted by error CLASS, not message text: the class is what the API maps to a status, and
    // a foreign run must be indistinguishable from a nonexistent one (404, never 403) so that
    // cancelling someone else's run does not confirm it exists.
    assert.throws(() => env.runService.cancel(run.id, 'bob', false), NotFoundError);
    assert.throws(() => env.runService.cancel('does-not-exist', 'alice', true), NotFoundError);
  } finally {
    env.close();
  }
});

test('retry creates a new run referencing the original', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    // force terminal via a valid path: STARTING -> FAILED
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'FAILED', { completedAt: new Date().toISOString() });
    const retried = env.runService.retry(run.id, 'alice', false);
    assert.notEqual(retried.id, run.id);
    assert.equal(retried.retryOf, run.id);
    assert.equal(retried.attempt, 2);
    assert.equal(retried.status, 'QUEUED');
  } finally {
    env.close();
  }
});

test('retry rejects non-terminal and completed runs', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    assert.throws(() => env.runService.retry(run.id, 'alice', false), /not terminal/);
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING');
    env.runs.transition(run.id, 'COMPLETED', { completedAt: new Date().toISOString() });
    assert.throws(() => env.runService.retry(run.id, 'alice', false), /completed/);
  } finally {
    env.close();
  }
});
test('retry throws once per-run maxRetries is exhausted (issue #9)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'x',
      agent: 'fake',
      constraints: { maxRetries: 1 },
    });
    // attempt 1 -> FAILED, retry -> attempt 2 (allowed: 1 retry)
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'FAILED', { completedAt: new Date().toISOString() });
    const retried = env.runService.retry(run.id, 'alice', false);
    assert.equal(retried.attempt, 2);
    // attempt 2 -> FAILED, retry -> throws (cap reached)
    env.runs.transition(retried.id, 'STARTING');
    env.runs.transition(retried.id, 'FAILED', { completedAt: new Date().toISOString() });
    assert.throws(() => env.runService.retry(retried.id, 'alice', false), /Max retries reached/);
  } finally {
    env.close();
  }
});

test('retry: the child carries retry_of and the bumped attempt in the INSERT that creates it (issue #987)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'FAILED', { completedAt: new Date().toISOString() });

    // The window #987 is about. The child used to be committed by create()'s transaction and linked
    // by a FOLLOW-UP update, so every reader -- including a worker in another process claiming the
    // child -- could see a fresh attempt 1 with no parent. Observing the INSERT is observing that
    // window: whatever the INSERT writes is what the committed row says, and with the link written
    // outside it, this assertion sees `retryOf: null`.
    const inserted: { id: string; retryOf: string | null; attempt: number }[] = [];
    const realInsert = env.runs.insert.bind(env.runs);
    env.runs.insert = (r) => {
      inserted.push({ id: r.id, retryOf: r.retryOf, attempt: r.attempt });
      realInsert(r);
    };

    const retried = env.runService.retry(run.id, 'alice', false);
    assert.equal(inserted.length, 1, 'a retry must insert exactly one child row');
    assert.equal(inserted[0]!.id, retried.id);
    assert.equal(inserted[0]!.retryOf, run.id, 'the child was inserted without its parent link');
    assert.equal(inserted[0]!.attempt, 2, 'the child was inserted with a reset attempt counter');

    // The same answer from a second connection, i.e. from any other process: the row and its link
    // became visible together, so there is no state in which the child exists unlinked.
    const other = new DatabaseSync(join(env.dir, 'test.db'));
    try {
      const row = other.prepare('SELECT retry_of, attempt FROM runs WHERE id = ?').get(retried.id) as
        | { retry_of: string | null; attempt: number }
        | undefined;
      assert.equal(row?.retry_of, run.id);
      assert.equal(row?.attempt, 2);
    } finally {
      other.close();
    }
  } finally {
    env.close();
  }
});

test('retry: the terminal transition records the intent, and a refusal clears it with the reason (issue #987)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'x',
      agent: 'fake',
      constraints: { maxRetries: 0 },
    });
    env.runs.transition(run.id, 'STARTING');
    // Exactly what the worker does now: the decision rides the same statement as the status, so a
    // terminal attempt and its intent can never disagree.
    const dueAt = new Date(Date.now() + 30_000).toISOString();
    env.runs.transition(run.id, 'FAILED', { completedAt: new Date().toISOString(), retryDueAt: dueAt });
    assert.equal(env.runs.get(run.id)!.retryDueAt, dueAt, 'the intent must be persisted by the transition');

    // maxRetries: 0 means the retry the intent describes can never be honoured.
    assert.throws(() => env.runService.retry(run.id, 'alice', true, { auto: true }), /Max retries reached/);

    assert.equal(env.runs.get(run.id)!.retryDueAt, null, 'a refused retry must not leave the intent recorded');
    const refused = env.events.list(run.id).filter((e) => e.type === 'run.retry_refused');
    assert.equal(refused.length, 1, 'the refusal must be recorded on the Run');
    assert.match(String((refused[0]!.payload as { reason: string }).reason), /Max retries reached/);
  } finally {
    env.close();
  }
});

test('retry: a refusal with no recorded intent records no run.retry_refused (issue #987)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING');
    env.runs.transition(run.id, 'COMPLETED', { completedAt: new Date().toISOString() });
    assert.throws(() => env.runService.retry(run.id, 'alice', false), /completed/);
    assert.equal(env.events.list(run.id).some((e) => e.type === 'run.retry_refused'), false);
  } finally {
    env.close();
  }
});

test('retry: a manual retry clears the recorded intent, so the automatic retry cannot fire twice (issue #987)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'FAILED', {
      completedAt: new Date().toISOString(),
      retryDueAt: new Date(Date.now() + 30_000).toISOString(),
    });

    const manual = env.runService.retry(run.id, 'alice', true);
    assert.equal(manual.retryOf, run.id);
    assert.equal(manual.attempt, 2);
    assert.equal(env.runs.get(run.id)!.retryDueAt, null, 'the operator retried it, so the pending intent is gone');

    // The worker's own automatic retry for the same attempt now finds nothing to claim: no second
    // child, and no run.retry_refused either -- the chain is not final, the retry simply happened.
    assert.throws(() => env.runService.retry(run.id, 'alice', true, { auto: true }), /already claimed/);
    const children = env.runs.list({ ownerId: 'alice', limit: 50 }).runs.filter((r) => r.retryOf === run.id);
    assert.equal(children.length, 1);
    assert.equal(env.events.list(run.id).some((e) => e.type === 'run.retry_refused'), false);
  } finally {
    env.close();
  }
});

test('retry: an unexpected failure leaves the intent recorded, so recovery can try again (issue #987)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.runs.transition(run.id, 'STARTING');
    const dueAt = new Date(Date.now() + 30_000).toISOString();
    env.runs.transition(run.id, 'FAILED', { completedAt: new Date().toISOString(), retryDueAt: dueAt });

    // A failure that is not an answer about whether the retry can happen: the write itself broke.
    const realInsert = env.runs.insert.bind(env.runs);
    env.runs.insert = () => {
      throw new Error('database went away');
    };
    assert.throws(() => env.runService.retry(run.id, 'alice', true, { auto: true }), /database went away/);
    env.runs.insert = realInsert;

    assert.equal(env.runs.get(run.id)!.retryDueAt, dueAt, 'an error nobody decided on must not finalise the chain');
    assert.equal(env.events.list(run.id).some((e) => e.type === 'run.retry_refused'), false);

    // ...and the retry still happens once the write works again.
    const child = env.runService.retry(run.id, 'alice', true, { auto: true });
    assert.equal(child.retryOf, run.id);
  } finally {
    env.close();
  }
});

test('origin: create stamps it from the internal input, and the ROW keeps it (issue #988 acceptance 2)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      origin: { kind: 'a2a', ref: 'task-1' },
    });
    assert.deepEqual(run.origin, { kind: 'a2a', ref: 'task-1' });
    // Re-read through the store: the returned object could be right while the row is not, and the
    // row is what every other reader -- another process, a later request -- actually sees.
    assert.deepEqual(env.runs.get(run.id)!.origin, { kind: 'a2a', ref: 'task-1' });

    // A Run created without one reads null rather than a default kind: "no origin recorded" must
    // not be indistinguishable from "created by a2a".
    const plain = env.runService.create({ ownerId: 'alice', task: 'y', agent: 'fake' });
    assert.equal(plain.origin, null);
    assert.equal(env.runs.get(plain.id)!.origin, null);
  } finally {
    env.close();
  }
});

test('origin: a retry inherits the parent origin and the filter stays owner-scoped (issue #988 acceptance 2, 3)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const parent = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake', origin: { kind: 'a2a', ref: 'task-1' },
    });
    env.runs.transition(parent.id, 'STARTING');
    env.runs.transition(parent.id, 'FAILED', { completedAt: new Date().toISOString() });
    const child = env.runService.retry(parent.id, 'alice', true);
    assert.deepEqual(child.origin, { kind: 'a2a', ref: 'task-1' }, 'a retry is the same work, so the same provenance');
    assert.deepEqual(env.runs.get(child.id)!.origin, { kind: 'a2a', ref: 'task-1' });

    // One plain Run of the same owner, and one A2A Run of a DIFFERENT owner. The filter has to
    // exclude both: the first because it has no origin, the second because an origin filter is
    // never an authorisation.
    const plain = env.runService.create({ ownerId: 'alice', task: 'plain', agent: 'fake' });
    const foreign = env.runService.create({
      ownerId: 'bob', task: 'theirs', agent: 'fake', origin: { kind: 'a2a', ref: 'task-2' },
    });

    const alice = env.runService.list({ ownerId: 'alice', isAdmin: false, origin: 'a2a', limit: 50 });
    assert.deepEqual(alice.runs.map((r) => r.id).sort(), [parent.id, child.id].sort());
    assert.ok(!alice.runs.some((r) => r.id === plain.id), 'a Run with no origin must not match an origin filter');
    assert.ok(!alice.runs.some((r) => r.id === foreign.id), "another owner's A2A Runs must never appear");

    // Admin sees every origin-matching Run, still narrowed by the filter.
    const admin = env.runService.list({ ownerId: 'admin', isAdmin: true, origin: 'a2a', limit: 50 });
    assert.deepEqual(admin.runs.map((r) => r.id).sort(), [parent.id, child.id, foreign.id].sort());

    // No filter is unchanged: everything the caller can see, whatever its origin.
    assert.equal(env.runService.list({ ownerId: 'alice', isAdmin: false, limit: 50 }).runs.length, 3);
  } finally {
    env.close();
  }
});

test('retry: a second manual retry of one attempt is refused, so the chain stays linear (issue #987)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'FAILED', { completedAt: new Date().toISOString() });

    const first = env.runService.retry(run.id, 'alice', true);
    assert.equal(first.retryOf, run.id);
    // Two children of one attempt are two attempts with the same number: `latest` stops being well
    // defined, and a chain that forked this way can report final while a sibling is still running.
    assert.throws(
      () => env.runService.retry(run.id, 'alice', true),
      /already has a retry/,
      'a second child of one attempt must be refused, not silently created',
    );
    const children = env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 20 }).runs.filter((r) => r.retryOf === run.id);
    assert.equal(children.length, 1);
    assert.equal(children[0]!.id, first.id);

    // The chain is still retryable the linear way: retry the CHILD, not the parent again.
    env.runs.transition(first.id, 'STARTING');
    env.runs.transition(first.id, 'FAILED', { completedAt: new Date().toISOString() });
    const second = env.runService.retry(first.id, 'alice', true);
    assert.equal(second.retryOf, first.id);
    assert.equal(second.attempt, 3);
  } finally {
    env.close();
  }
});

test('retry: a stale refusal records no event and does not clear an honoured intent (issue #987)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'FAILED', {
      completedAt: new Date().toISOString(),
      retryDueAt: new Date(Date.now() + 30_000).toISOString(),
    });
    // The snapshot a refuser holds when another worker's child committed in between: the Run as it
    // looked BEFORE that transaction ran -- intent present, budget spent. Reading it before the
    // transaction is exactly what makes an unconditional clear-and-record wrong.
    const beforeChild = env.runs.get(run.id)!;
    assert.notEqual(beforeChild.retryDueAt ?? null, null);
    const child = env.runService.retry(run.id, 'alice', true);
    assert.equal(env.runs.get(run.id)!.retryDueAt, null, 'the child transaction cleared the intent');

    const stale = { ...beforeChild, attempt: beforeChild.constraints.maxRetries + 1 };
    const realGet = env.runs.get.bind(env.runs);
    env.runs.get = (id: string) => (id === run.id ? stale : realGet(id));
    try {
      assert.throws(() => env.runService.retry(run.id, 'alice', true, { auto: true }), /Max retries reached/);
    } finally {
      env.runs.get = realGet;
    }

    assert.equal(
      env.events.list(run.id).some((e) => e.type === 'run.retry_refused'),
      false,
      'a refusal for an intent that was honoured must not be recorded',
    );
    assert.equal(env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 20 }).runs.filter((r) => r.retryOf === run.id).length, 1);
    assert.equal(env.runs.get(child.id)!.retryOf, run.id);
  } finally {
    env.close();
  }
});

test('retry: two refusers of one intent record the reason once (issue #987)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake', constraints: { maxRetries: 0 },
    });
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'FAILED', {
      completedAt: new Date().toISOString(),
      retryDueAt: new Date(Date.now() + 30_000).toISOString(),
    });

    // Two workers that both read the pending intent before either committed. The UPDATE is the
    // arbiter, so exactly one of them may clear it and record why.
    const live = env.runs.get(run.id)!;
    const realGet = env.runs.get.bind(env.runs);
    env.runs.get = (id: string) => (id === run.id ? live : realGet(id));
    try {
      assert.throws(() => env.runService.retry(run.id, 'alice', true, { auto: true }), /Max retries reached/);
      assert.throws(() => env.runService.retry(run.id, 'alice', true, { auto: true }), /Max retries reached/);
    } finally {
      env.runs.get = realGet;
    }

    assert.equal(env.runs.get(run.id)!.retryDueAt, null);
    const refused = env.events.list(run.id).filter((e) => e.type === 'run.retry_refused');
    assert.equal(refused.length, 1, `expected one refusal event, got ${refused.length}`);
  } finally {
    env.close();
  }
});

test('retry: two workers holding the same stale pending read create exactly one child (issue #987)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'FAILED', {
      completedAt: new Date().toISOString(),
      retryDueAt: new Date(Date.now() - 1).toISOString(),
    });

    // What two processes recovering the same attempt both see before either commits. Clearing the
    // intent IS the claim, so the second worker must find it gone and create nothing.
    const dueBefore = new Date().toISOString();
    const seenByA = env.runs.listPendingRetries(dueBefore);
    const seenByB = env.runs.listPendingRetries(dueBefore);
    assert.equal(seenByA.length, 1);
    assert.equal(seenByB.length, 1);

    const winner = env.runService.retry(seenByA[0]!.id, seenByA[0]!.ownerId, true, { auto: true });
    assert.throws(
      () => env.runService.retry(seenByB[0]!.id, seenByB[0]!.ownerId, true, { auto: true }),
      /already claimed/,
      'the second worker must lose the claim rather than create a second retry',
    );
    const children = env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 20 }).runs.filter((r) => r.retryOf === run.id);
    assert.equal(children.length, 1);
    assert.equal(children[0]!.id, winner.id);
  } finally {
    env.close();
  }
});

test('listPendingRetries returns due intents with no child, and nothing else (issue #987)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const mk = (retryDueAt: string | null) => {
      const r = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
      env.runs.transition(r.id, 'STARTING');
      env.runs.transition(r.id, 'FAILED', { completedAt: new Date().toISOString(), retryDueAt });
      return r;
    };
    const future = mk(new Date(Date.now() + 60_000).toISOString());
    const due = mk(new Date(Date.now() - 1).toISOString());
    const noIntent = mk(null);

    const found = env.runs.listPendingRetries(new Date().toISOString()).map((r) => r.id);
    assert.deepEqual(found, [due.id], 'only the due intent is recoverable');
    assert.equal(found.includes(future.id), false, 'a backoff that has not elapsed is not due');
    assert.equal(found.includes(noIntent.id), false, 'no intent means no retry was decided');

    // Once the retry exists, the attempt stops being recoverable -- otherwise every sweep would
    // create another child.
    env.runService.retry(due.id, 'alice', true, { auto: true });
    assert.deepEqual(env.runs.listPendingRetries(new Date().toISOString()).map((r) => r.id), []);
  } finally {
    env.close();
  }
});

test('submitInput only allowed in NEEDS_INPUT', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    assert.throws(() => env.runService.submitInput(run.id, 'alice', false, 'go'), /not waiting/);
  } finally {
    env.close();
  }
});

test('list filters by owner and status with pagination', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    env.runService.create({ ownerId: 'alice', task: 'a', agent: 'fake' });
    env.runService.create({ ownerId: 'alice', task: 'b', agent: 'fake' });
    env.runService.create({ ownerId: 'bob', task: 'c', agent: 'fake' });
    const alice = env.runService.list({ ownerId: 'alice', isAdmin: false, limit: 10 });
    assert.equal(alice.runs.length, 2);
    const all = env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 10 });
    assert.equal(all.runs.length, 3);
    const page1 = env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 2 });
    assert.equal(page1.runs.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 2, cursor: page1.nextCursor! });
    assert.equal(page2.runs.length, 1);
  } finally {
    env.close();
  }
});

test('waitFor helper sanity', async () => {
  await waitFor(() => true);
});

test('idempotency-key race: UNIQUE violation returns the existing run (issue #24)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    // first run with the key
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', idempotencyKey: 'race-key' });
    // Simulate a concurrent POST winning between create()'s dedup SELECT and
    // INSERT: patch the SELECT so it misses (as if the winner had not yet
    // committed), while the key row exists in the table — the INSERT then hits
    // UNIQUE and the catch must recover by re-reading the existing run.
    const origPrepare = env.db.prepare.bind(env.db);
    let dedupMissed = false;
    env.db.prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      // the FIRST idempotency-key lookup (the dedup SELECT) misses; the catch's
      // re-read (second lookup) must still see the row
      if (!dedupMissed && /FROM idempotency_keys/.test(sql)) {
        dedupMissed = true;
        return { ...stmt, get: () => undefined };
      }
      return stmt;
    }) as typeof env.db.prepare;
    const result = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', idempotencyKey: 'race-key' });
    assert.equal(result.id, run.id, 'returns the existing run instead of throwing');
    // no duplicate run was created
    const all = env.runService.list({ ownerId: 'alice', isAdmin: true, limit: 10 });
    assert.equal(all.runs.filter((r) => r.task === 'x').length, 1);
  } finally {
    env.close();
  }
});

test('create rejects malformed constraints (issue #28)', () => {
  const env = makeEnv({ workerEnabled: false });
  const loose = (c: unknown) => c as unknown as Partial<RunConstraints>;
  try {
    // non-numeric maxRetries
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ maxRetries: 'abc' }) }),
      /maxRetries must be a finite integer/,
    );
    // fractional maxDurationMs
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ maxDurationMs: 1.5 }) }),
      /maxDurationMs must be a finite integer/,
    );
    // negative maxRetries
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ maxRetries: -1 }) }),
      /maxRetries must be >= 0/,
    );
    // unknown constraint key
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ bogus: 1 }) }),
      /Unknown constraint: bogus/,
    );
    // Inherited Object.prototype keys must read as unknown, not as a rename. A bare
    // RENAMED_CONSTRAINTS[key] lookup resolves 'toString' to the toString function, which is
    // truthy, and produced a nonsense "renamed to function toString()" error.
    for (const protoKey of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      assert.throws(
        () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ [protoKey]: 1 }) }),
        new RegExp(`Unknown constraint: ${protoKey}`),
        `${protoKey} must be rejected as unknown, not treated as a renamed constraint`,
      );
    }
    // malformed resourceLimits
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ resourceLimits: { gpu: '1' } }) }),
      /Unknown resourceLimits key: gpu/,
    );
    // malformed allowedNetworks
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ allowedNetworks: ['ok', 42] }) }),
      /allowedNetworks must be an array of strings/,
    );
    // Section 3.3 (#725): malformed resourceLimit VALUES are a 400 at creation, not a container
    // start failure. CPU must be a positive decimal; memory/disk an integer with b/k/m/g suffix.
    for (const [k, v, msg] of [
      ['cpu', 'x', /resourceLimits\.cpu "x" is not a positive decimal/],
      ['cpu', '0', /resourceLimits\.cpu "0" is not a positive decimal/],
      ['cpu', '-1.5', /resourceLimits\.cpu "-1\.5" is not a positive decimal/],
      ['memory', 'abc', /resourceLimits\.memory "abc" is not a positive integer/],
      ['memory', '0m', /resourceLimits\.memory "0m" is not a positive integer/],
      ['memory', '1.5g', /resourceLimits\.memory "1\.5g" is not a positive integer/],
      ['disk', '10x', /resourceLimits\.disk "10x" is not a positive integer/],
      ['cpu', '9'.repeat(400), /resourceLimits\.cpu "9+ is not a positive decimal|not a positive decimal/],
      ['memory', '9'.repeat(400) + 'g', /not a positive integer/],
    ] as [string, string, RegExp][]) {
      assert.throws(
        () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ resourceLimits: { [k]: v } }) }),
        msg,
      );
    }
    // Valid values still admitted (suffixes case-insensitive; bare integers).
    const ok = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ resourceLimits: { cpu: '1.5', memory: '512M', disk: '10' } }) });
    assert.equal(ok.constraints.resourceLimits?.cpu, '1.5');
    // NaN (the literal issue-#28 bug)
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ maxRetries: NaN }) }),
      /maxRetries must be a finite integer/,
    );
    // Infinity
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ maxRetries: Infinity }) }),
      /maxRetries must be a finite integer/,
    );
    // huge integer (would defeat the retry cap / timeout)
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ maxRetries: Number.MAX_SAFE_INTEGER + 1 }) }),
      /maxRetries must be <=/,
    );
    // resourceLimits null (typeof-null pitfall)
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ resourceLimits: null }) }),
      /resourceLimits must be an object/,
    );
    // resourceLimits.cpu non-string value
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ resourceLimits: { cpu: 42 } }) }),
      /resourceLimits.cpu must be a string/,
    );
    // non-object constraints (e.g. a string from req.body.constraints)
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose('nope') }),
      /Unknown constraint/,
    );
    // empty constraints object accepted
    const empty = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: {} });
    assert.ok(empty.id);
    // notAfter (#731): must be an ISO-8601 timestamp WITH an explicit UTC offset — a
    // timezone-less string parses as server-local time, so the same value means different
    // instants on different hosts (Copilot round 1 on PR #750).
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ notAfter: 'not-a-date' }) }),
      /notAfter must be an ISO-8601 timestamp with an explicit UTC offset/,
    );
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ notAfter: 123 }) }),
      /notAfter must be an ISO-8601 timestamp with an explicit UTC offset/,
    );
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ notAfter: new Date(Date.now() + 3_600_000).toISOString().replace('Z', '') }) }),
      /explicit UTC offset/,
      'a timezone-less timestamp must be refused, not silently read as local time',
    );
    // The offset must carry the colon: '...+0200' is refused so the documented ±hh:mm contract
    // and the parser cannot drift (Copilot round 3 on PR #750).
    const colonless = new Date(Date.now() + 3_600_000).toISOString().replace('Z', '') + '+0200';
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ notAfter: colonless }) }),
      /explicit UTC offset/,
    );
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ notAfter: new Date(Date.now() - 60_000).toISOString() }) }),
      /notAfter must be in the future/,
    );
    // valid constraints still accepted (0 is legitimate)
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      constraints: { maxRetries: 0, maxDurationMs: 60_000, resourceLimits: { cpu: '1' }, allowedNetworks: [] },
    });
    assert.ok(run.id);
  } finally {
    env.close();
  }
});

test('notAfter accepts ISO-8601 without seconds (round 8, #731)', () => {
  const env = makeEnv();
  try {
    // ISO-8601 does not require seconds; the contract requires only the explicit offset.
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'x',
      agent: 'fake',
      constraints: {
        maxDurationMs: 60_000,
        // Minute precision, no seconds, explicit Z — valid ISO-8601, valid per the contract.
        notAfter: new Date(Date.now() + 3_600_000).toISOString().replace(/:\d\d\.\d+Z$/, 'Z'),
      },
    });
    const stored = env.runs.get(run.id)!.constraints.notAfter as string;
    assert.match(stored, /T\d\d:\d\dZ$/);
    assert.ok(!Number.isNaN(Date.parse(stored)));
  } finally {
    env.close();
  }
});

test('notAfter is persisted verbatim and inherited by retries (#731, B0-3)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const notAfter = new Date(Date.now() + 3_600_000).toISOString();
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      constraints: { maxDurationMs: 60_000, notAfter },
    });
    assert.equal(run.constraints.notAfter, notAfter, 'stored exactly as given');
    // retry() requires a terminal run; take it through the sanctioned QUEUED -> STARTING -> FAILED.
    env.runs.transition(run.id, 'STARTING', { leaseOwner: 'w' });
    env.runs.transition(run.id, 'FAILED', { completedAt: new Date().toISOString() });
    const retried = env.runService.retry(run.id, 'alice', true);
    assert.equal(retried.constraints.notAfter, notAfter, 'retry inherits the same absolute deadline');
    // A retry of a run whose deadline already passed cannot sneak past validation: the copy is
    // re-validated, so the retry is refused loudly instead of silently extending the window.
    const expired = env.runService.create({
      ownerId: 'alice', task: 'y', agent: 'fake',
      constraints: { maxDurationMs: 60_000, notAfter: new Date(Date.now() + 50).toISOString() },
    });
    await new Promise((r) => setTimeout(r, 120));
    env.runs.transition(expired.id, 'STARTING', { leaseOwner: 'w' });
    env.runs.transition(expired.id, 'FAILED', { completedAt: new Date().toISOString() });
    assert.throws(
      () => env.runService.retry(expired.id, 'alice', true),
      /notAfter must be in the future/,
      'retrying past an expired deadline is a caller error, not a window extension',
    );
  } finally {
    env.close();
  }
});

test('submitInput redacts secrets at write time (issue #36)', () => {
  const env = makeEnv({ workerEnabled: false, redactor: createRedactor(['hush']) });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    // move to NEEDS_INPUT via the legal transition chain
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING');
    env.runs.transition(run.id, 'NEEDS_INPUT');
    env.runService.submitInput(run.id, 'alice', false, { text: 'keep hush quiet' });
    const row = env.db.prepare('SELECT input_json FROM run_inputs WHERE run_id = ?').get(run.id) as { input_json: string };
    assert.ok(!row.input_json.includes('hush'), 'secret removed from input_json');
    assert.ok(row.input_json.includes('[REDACTED]'), 'redacted marker present');
  } finally {
    env.close();
  }
});

test('create redacts task and repository URL at write time (issue #43)', () => {
  // no literal secrets configured: only the default patterns (incl. the new
  // URL-credential regex) can catch these
  const env = makeEnv({ workerEnabled: false, redactor: createRedactor([]) });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'use token=sk-12345 in the script',
      agent: 'fake',
      repository: { localPath: 'https://user:pass123@example.com/repo.git' },
      repositories: [{ localPath: 'https://user:pass456@example.com/extra.git' }],
    });
    assert.ok(!run.task.includes('sk-12345'), 'task secret removed');
    assert.ok(run.task.includes('[REDACTED]'), 'task redacted marker present');
    assert.ok(!JSON.stringify(run.repository).includes('pass123'), 'repository secret removed');
    assert.ok(!JSON.stringify(run.repositories).includes('pass456'), 'repositories secret removed');
    // persisted form is redacted too
    const row = env.db.prepare('SELECT task, repository_json, repositories_json FROM runs WHERE id = ?').get(run.id) as { task: string; repository_json: string; repositories_json: string };
    assert.ok(!row.task.includes('sk-12345'), 'persisted task secret removed');
    assert.ok(!row.repository_json.includes('pass123'), 'persisted repository secret removed');
    assert.ok(!row.repositories_json.includes('pass456'), 'persisted repositories secret removed');
  } finally {
    env.close();
  }
});

test('a concurrent cancellation is not silently overwritten by a later transition (issue #48)', async () => {
  const { Worker } = await import('node:worker_threads');
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.runs.transition(run.id, 'STARTING');
    env.runs.transition(run.id, 'RUNNING');
    const dbPath = join(env.dir, 'test.db');

    // A second connection cancels the run and holds the write lock open. That is exactly the
    // interleaving the old read -> validate -> unconditional UPDATE lost: it wrote COMPLETED
    // over CANCELLED and nothing complained.
    //
    // The contender can now be stopped at either of two points. Its UPDATE is forced to wait
    // until AFTER the cancellation commits, and the guarded write then reports `lost a race`;
    // or, because transition() wraps the write in BEGIN IMMEDIATE, it waits for the lock
    // BEFORE reading and assertTransition rejects `CANCELLED -> COMPLETED` outright. Both are
    // asserted below, so this test keeps failing if the overwrite ever comes back while
    // staying honest about which guard fires.
    const holder = openDatabase(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare("UPDATE runs SET status = 'CANCELLED' WHERE id = ?").run(run.id);

    const workerSrc = `
      import { parentPort, workerData } from 'node:worker_threads';
      import { openDatabase } from ${JSON.stringify(new URL('../src/db/database.ts', import.meta.url).href)};
      import { RunStore } from ${JSON.stringify(new URL('../src/runs/runStore.ts', import.meta.url).href)};
      const db = openDatabase(workerData.path);
      try {
        new RunStore(db).transition(workerData.id, 'COMPLETED');
        parentPort.postMessage({ ok: true });
      } catch (e) {
        parentPort.postMessage({ ok: false, err: String(e instanceof Error ? e.message : e) });
      }
      db.close();
    `;
    const worker = new Worker(new URL(`data:text/javascript;base64,${Buffer.from(workerSrc).toString('base64')}`), {
      workerData: { path: dbPath, id: run.id },
    });
    // Hold long enough that the worker has certainly read RUNNING and is parked on the
    // write lock, then let the cancellation land first.
    //
    // The release is idempotent and runs from a finally block (Copilot on #90). If the
    // worker rejects, or an assertion below throws, a bare clearTimeout would leave this
    // connection holding a write transaction open -- so the failure path would leak a
    // locked database into every later test on this file rather than reporting one
    // failure. Same hazard this repo's own shutdown findings are about.
    let lockOpen = true;
    const unlock = () => {
      if (!lockOpen) return;
      lockOpen = false;
      try {
        holder.exec('COMMIT');
      } catch {
        // transaction already finished; nothing to release
      }
    };
    const release = setTimeout(unlock, 400);
    try {
      const result = await new Promise<{ ok: boolean; err?: string }>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      unlock();

      assert.ok(!result.ok, 'transition should have lost the race, but it committed');
      // Either refusal is acceptable, and which one you get depends on WHEN the contender
      // discovers the truth. The guarded UPDATE reports `lost a race`; since transition()
      // began wrapping its write in BEGIN IMMEDIATE the contender can also block on the lock
      // and then read the real status, so assertTransition rejects it first with `Invalid
      // transition`. That is the earlier of the two detections and the strictly better one --
      // the read is no longer able to be stale. Pinning one message would pin the mechanism,
      // and the invariant this test owns is "COMPLETED never lands on CANCELLED", not which
      // guard catches it.
      assert.match(result.err ?? '', /lost a race|Invalid transition/);
      assert.equal(env.runs.get(run.id)!.status, 'CANCELLED', 'the cancellation must survive');
    } finally {
      clearTimeout(release);
      unlock();
      holder.close();
      await worker.terminate();
    }
  } finally {
    env.close();
  }
});

test('budget constraints are recorded, not enforced, and reject the old max* names (issue #63)', () => {
  const env = makeEnv({ workerEnabled: false });
  const loose = (c: unknown) => c as unknown as Partial<RunConstraints>;
  try {
    // The old names are rejected with a message that names the replacement, rather than the
    // generic "Unknown constraint" that would leave a stale client guessing.
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ maxTokens: 1000 }) }),
      /maxTokens was renamed to budgetTokens.*not enforced/,
    );
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ maxCost: 5 }) }),
      /maxCost was renamed to budgetCost.*not enforced/,
    );

    // The new names are accepted and stored verbatim.
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      constraints: loose({ budgetTokens: 50_000, budgetCost: 2.5 }),
    });
    assert.equal(run.constraints.budgetTokens, 50_000);
    // A money budget must accept cents. Integer-only validation rejected 2.5, which is the normal
    // way to express a two-dollar-fifty cap -- the field could not state its own common case.
    assert.equal(run.constraints.budgetCost, 2.5, 'budgetCost must accept fractional amounts');
    // And they are recorded ONLY: nothing downstream reads them, which is the whole point of the
    // rename. Asserting the absence here is what stops the max* name coming back without
    // enforcement being added alongside it.
    assert.equal((run.constraints as unknown as Record<string, unknown>).maxTokens, undefined);
    assert.equal((run.constraints as unknown as Record<string, unknown>).maxCost, undefined);

    // Still validated as numbers -- the rename does not remove validation.
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ budgetTokens: 'lots' }) }),
      /budgetTokens must be a finite integer/,
    );
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ budgetCost: -1 }) }),
      /budgetCost must be >= 0/,
    );
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ budgetCost: NaN }) }),
      /budgetCost must be a finite number/,
    );
    // budgetTokens stays integral (a token count is a count); budgetCost does not.
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', constraints: loose({ budgetTokens: 1.5 }) }),
      /budgetTokens must be a finite integer/,
    );
  } finally {
    env.close();
  }
});

test('worker.ts does not read the budget constraints, so they cannot be called enforced (issue #63)', () => {
  // This is the assertion that keeps the rename honest. If someone adds enforcement, this test
  // should be DELETED and the fields renamed back to max* -- leaving them named budget* while
  // enforced would be the mirror image of the original lie.
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'worker', 'worker.ts'), 'utf8');
  assert.doesNotMatch(src, /budgetTokens|budgetCost/,
    'worker.ts now reads the budget constraints -- either enforce them properly and rename back '
    + 'to maxTokens/maxCost, or delete this test with a reason');
});

// Issue #459: an explicitly empty skill list must mean "no skills", not "choose for
// me". Before the fix these two callers were indistinguishable, so every Run carried
// the selector's fallback set and Hermes -- which resolves `-s <id>` in its own skill
// store and dies on an unknown name -- could not execute any Run.
test('skills: [] creates a Run with no skills (issue #459)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'smoke', skills: [] });
    assert.deepEqual(env.runService.getSkills(run.id), []);
  } finally {
    env.close();
  }
});

test('omitting skills still auto-selects (issue #459 must not regress)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'smoke' });
    assert.ok(
      env.runService.getSkills(run.id).length > 0,
      'a caller that omits skills must keep getting automatic selection',
    );
  } finally {
    env.close();
  }
});

test('skills: null is treated as omitted, not as none (issue #459)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'smoke', skills: null as unknown as string[] });
    assert.ok(
      env.runService.getSkills(run.id).length > 0,
      'a JSON caller sending null must not silently lose its skills',
    );
  } finally {
    env.close();
  }
});

test('an explicit non-empty skill list is still honoured exactly (issue #459)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'smoke', skills: ['testing'] });
    assert.deepEqual(env.runService.getSkills(run.id).map((s) => s.id), ['testing']);
  } finally {
    env.close();
  }
});

// -- #823: per-Run model (P1-1) --

test('model: accepted on a perRunModel-capable agent, persisted, and returned', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', model: 'GLM-5.3-Flash' });
    assert.equal(run.model, 'GLM-5.3-Flash');
    // The explainability event records which model and where it came from.
    const events = env.events.list(run.id).map((e) => e.type);
    assert.ok(events.includes('run.model_resolved'), `events: ${events.join(', ')}`);
    const ev = env.events.list(run.id).find((e) => e.type === 'run.model_resolved');
    assert.deepEqual(ev!.payload, { model: 'GLM-5.3-Flash', source: 'caller' });
  } finally {
    env.close();
  }
});

test('model: refused on an agent whose static capabilities omit perRunModel (fail closed)', () => {
  // An adapter that declares static capabilities but omits perRunModel: the 'undeclared' case.
  const undeclared: AgentAdapter = {
    capabilities: { static: { skills: 'none', roleInstruction: 'system', humanInput: false } },
    start: async () => { throw new Error('not started'); },
    sendInput: async () => {},
    cancel: async () => {},
  } as AgentAdapter;
  const env = makeEnv({ workerEnabled: false, adapters: { undeclared } });
  try {
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'undeclared', model: 'm1' }),
      /perRunModel: undeclared/,
    );
    assert.equal(env.runs.list({ ownerId: 'alice', limit: 10 }).runs.length, 0, 'no Run row written');
  } finally {
    env.close();
  }
});

test('model: shape validation - empty, overlong, whitespace', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    assert.throws(() => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', model: '' }), /non-empty/);
    assert.throws(() => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', model: 'x'.repeat(201) }), /at most 200/);
    assert.throws(() => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', model: 'two words' }), /whitespace or control/);
    assert.throws(() => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', model: 'a\nb' }), /whitespace or control/);
    // #849: a leading dash would reach argv parsers as a flag-shaped value.
    for (const bad of ['-x', '--dangerously-skip-permissions']) {
      assert.throws(() => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', model: bad }), /must not start with '-'/, bad);
    }
    assert.equal(env.runs.list({ ownerId: 'alice', limit: 10 }).runs.length, 0, 'no Run row written');
    // Real ids still pass, including provider-prefixed and tagged ones.
    for (const ok of ['claude-sonnet-4-5', 'zai/glm-5.3-flash', 'deepseek-v4-flash', 'qwen3.8:32b']) {
      assert.doesNotThrow(() => validateModelShape(ok, 'model'), ok);
    }
  } finally {
    env.close();
  }
});

test('model: a preset model resolves onto the Run; caller wins over a preset default; modelRequired conflict surfaces over the service', () => {
  const presetsDir = tempDir('mercury-presets-823-');
  const dir = join(presetsDir, 'modeled');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), JSON.stringify({
    schemaVersion: 1, id: 'modeled', version: '1.0.0',
    description: 'preset with a model default', role: 'Modeled role',
    agent: { model: 'preset-model' },
  }));
  writeFileSync(join(dir, 'INSTRUCTION.md'), 'MODELED INSTRUCTION');
  const env = makeEnv({ workerEnabled: false, presetsDir });
  try {
    // Preset default, no caller model.
    const a = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', preset: { id: 'modeled' } });
    assert.equal(a.model, 'preset-model');
    const evA = env.events.list(a.id).find((e) => e.type === 'run.model_resolved');
    assert.deepEqual(evA!.payload, { model: 'preset-model', source: 'preset' });
    // Caller wins over the preset default.
    const b = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', preset: { id: 'modeled' }, model: 'caller-model' });
    assert.equal(b.model, 'caller-model');
    const evB = env.events.list(b.id).find((e) => e.type === 'run.model_resolved');
    assert.deepEqual(evB!.payload, { model: 'caller-model', source: 'caller' });
  } finally {
    env.close();
  }
});

test('model: retry copies the model; retry of a model-less run stays model-less', () => {
  const env = makeEnv({ workerEnabled: false, fakeScript: [{ fail: true }] });
  try {
    const parent = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', model: 'keep-me' });
    // Force the run terminal so retry is allowed.
    env.runService.cancel(parent.id, 'alice', false);
    const retried = env.runService.retry(parent.id, 'alice', false);
    assert.equal(retried.model, 'keep-me');

    const parent2 = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.runService.cancel(parent2.id, 'alice', false);
    const retried2 = env.runService.retry(parent2.id, 'alice', false);
    assert.equal(retried2.model ?? null, null);
    assert.equal(env.events.list(retried2.id).some((e) => e.type === 'run.model_resolved'), false);
  } finally {
    env.close();
  }
});

test('model: a Run created without model behaves byte-identically to base (no event, null column)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    assert.equal(run.model ?? null, null);
    assert.equal(env.events.list(run.id).some((e) => e.type === 'run.model_resolved'), false);
  } finally {
    env.close();
  }
});

// -- #854: optional `selection` record (L1-1) --

test('selection: a valid record is stored as run.selection_recorded in the creation transaction; chosen must match the effective agent/model', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const selection = {
      via: 'laya', mode: 'enforce',
      chosen: { agent: 'fake', model: 'm1' },
      laya: { agent: 'fake', model: 'm1' },
      reason: 'selected',
    };
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake', model: 'm1', selection,
    });
    const evs = env.events.list(run.id).filter((e) => e.type === 'run.selection_recorded');
    assert.equal(evs.length, 1);
    assert.deepEqual(evs[0].payload, selection);
    assert.deepEqual(env.runService.getSelection(run.id), selection);
    // A mismatching `chosen` is refused; nothing is stored.
    for (const bad of [
      { ...selection, chosen: { agent: 'other', model: 'm1' } },
      { ...selection, chosen: { agent: 'fake', model: 'm2' } },
    ]) {
      assert.throws(() => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', model: 'm1', selection: bad }));
    }
    // A record that omits `chosen.model` while the run HAS a model is refused too: either half
    // of the disagreement would let the record misreport what ran.
    assert.throws(() => env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake', model: 'm1',
      selection: { ...selection, chosen: { agent: 'fake' } },
    }), /missing, but the run has a model/);
  } finally {
    env.close();
  }
});

test('selection: no-pick reasons carry no laya; pick reasons require it (#866 review)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const base = { via: 'laya', mode: 'shadow', chosen: { agent: 'fake' } };
    // A failure dispatch must be recordable: the L1-3 decision rule emits exactly this shape.
    for (const reason of ['sidecar_unavailable', 'invalid_response', 'single_candidate']) {
      const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', selection: { ...base, reason } });
      assert.equal((env.runService.getSelection(run.id) as { reason: string }).reason, reason);
      // ...and must not invent a pick.
      for (const extra of [{ laya: { agent: 'fake' } }, { answerConfidence: 0.5 }, { distribution: { A: 1 } }]) {
        assert.throws(
          () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', selection: { ...base, reason, ...extra } }),
          /must be absent when reason is/,
          `${reason} + ${Object.keys(extra)[0]}`,
        );
      }
    }
    // Reasons where Laya answered still require its pick.
    for (const reason of ['shadow', 'below_threshold', 'selected']) {
      assert.throws(
        () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', selection: { ...base, reason } }),
        /selection\.laya must be an object/,
        reason,
      );
    }
  } finally {
    env.close();
  }
});

test('selection: replay returns the original Run and record; the new body selection is ignored', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const first = {
      via: 'laya', mode: 'shadow',
      chosen: { agent: 'fake' }, laya: { agent: 'fake' }, reason: 'shadow',
    };
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake', idempotencyKey: 'sel-1', selection: first,
    });
    // Replay with a body whose selection is INVALID: the replay check fires first, so the
    // original Run and its original record come back and nothing is re-validated.
    const replayed = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake', idempotencyKey: 'sel-1',
      selection: { nope: true },
    });
    assert.equal(replayed.id, run.id);
    assert.deepEqual(env.runService.getSelection(run.id), first);
  } finally {
    env.close();
  }
});

test('selection: null is rejected, not treated as omitted (#866 review finding)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    // A present `selection: null` bypasses nothing: the documented schema requires a present
    // `selection` to be an object, so it must fail closed with the ordinary validation error.
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', selection: null }),
      /selection must be an object/,
    );
  } finally {
    env.close();
  }
});

test('selection: a Run created without selection behaves byte-identically to base (no event)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    assert.equal(env.runService.getSelection(run.id), null);
    assert.equal(env.events.list(run.id).some((e) => e.type === 'run.selection_recorded'), false);
  } finally {
    env.close();
  }
});

// -- #832 r1: resolved-model validation, three-way wording on the preset path, retry source --

test('model: a preset-declared model is held to the same shape contract as the caller field (#832 r1)', () => {
  const presetsDir = tempDir('mercury-presets-832a-');
  const dir = join(presetsDir, 'bad-model');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), JSON.stringify({
    schemaVersion: 1, id: 'bad-model', version: '1.0.0',
    description: 'preset with an invalid model', role: 'Bad-model role',
    agent: { model: 'two words' },
  }));
  writeFileSync(join(dir, 'INSTRUCTION.md'), 'BAD-MODEL INSTRUCTION');
  const env = makeEnv({ workerEnabled: false, presetsDir });
  try {
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', preset: { id: 'bad-model' } }),
      /must not contain whitespace or control characters/,
      'a preset model with whitespace is refused at creation',
    );
    assert.equal(env.runs.list({ ownerId: 'alice', limit: 10 }).runs.length, 0, 'no Run row written');
    // A C1 control (U+009F) is also caught - \p{Cc}, not just C0.
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', model: 'a\u009Fb' }),
      /must not contain whitespace or control characters/,
    );
  } finally {
    env.close();
  }
});

test('model: the preset path refuses with the same unknown/undeclared/false wording (#832 r1)', () => {
  const presetsDir = tempDir('mercury-presets-832b-');
  const dir = join(presetsDir, 'modeled-2');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), JSON.stringify({
    schemaVersion: 1, id: 'modeled-2', version: '1.0.0',
    description: 'preset with a model on an incapable agent', role: 'Modeled role',
    agent: { model: 'preset-model' },
  }));
  writeFileSync(join(dir, 'INSTRUCTION.md'), 'MODELED INSTRUCTION');
  const undeclared: AgentAdapter = {
    capabilities: { static: { skills: 'none', roleInstruction: 'system' } },
    start: async () => { throw new Error('not started'); },
    sendInput: async () => {},
    cancel: async () => {},
  } as AgentAdapter;
  const env = makeEnv({ workerEnabled: false, presetsDir, adapters: { undeclared } });
  try {
    // The PRESET path: resolvePreset's own check fires with the reason-specific wording.
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'undeclared', preset: { id: 'modeled-2' } }),
      /perRunModel: undeclared/,
    );
    assert.equal(env.runs.list({ ownerId: 'alice', limit: 10 }).runs.length, 0, 'no Run row written');
  } finally {
    env.close();
  }
});

test('model: retry preserves the parent\'s recorded source (preset stays preset, caller stays caller) (#832 r1)', () => {
  const presetsDir = tempDir('mercury-presets-832c-');
  const dir = join(presetsDir, 'modeled-3');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), JSON.stringify({
    schemaVersion: 1, id: 'modeled-3', version: '1.0.0',
    description: 'preset with a model default', role: 'Modeled role',
    agent: { model: 'preset-model' },
  }));
  writeFileSync(join(dir, 'INSTRUCTION.md'), 'MODELED INSTRUCTION');
  const env = makeEnv({ workerEnabled: false, presetsDir, fakeScript: [{ fail: true }] });
  try {
    // Preset-sourced parent: the retry event must still say 'preset'.
    const parent = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', preset: { id: 'modeled-3' } });
    env.runService.cancel(parent.id, 'alice', false);
    const retried = env.runService.retry(parent.id, 'alice', false);
    const ev = env.events.list(retried.id).find((e) => e.type === 'run.model_resolved');
    assert.ok(ev, 'the retry records the model');
    assert.deepEqual(ev!.payload, { model: 'preset-model', source: 'preset' });

    // Caller-sourced parent stays 'caller'.
    const parent2 = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', model: 'caller-model' });
    env.runService.cancel(parent2.id, 'alice', false);
    const retried2 = env.runService.retry(parent2.id, 'alice', false);
    const ev2 = env.events.list(retried2.id).find((e) => e.type === 'run.model_resolved');
    assert.deepEqual(ev2!.payload, { model: 'caller-model', source: 'caller' });
  } finally {
    env.close();
  }
});

test('model: a modelRequired preset refuses a conflicting caller model through the service (#832 r1)', () => {
  const presetsDir = tempDir('mercury-presets-832d-');
  const dir = join(presetsDir, 'required-model');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), JSON.stringify({
    schemaVersion: 1, id: 'required-model', version: '1.0.0',
    description: 'preset requiring its model', role: 'Required-model role',
    agent: { model: 'the-only-model', modelRequired: true },
  }));
  writeFileSync(join(dir, 'INSTRUCTION.md'), 'REQUIRED-MODEL INSTRUCTION');
  const env = makeEnv({ workerEnabled: false, presetsDir });
  try {
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', preset: { id: 'required-model' }, model: 'caller-model' }),
      /preset requires model "the-only-model"; caller asked for "caller-model"/,
    );
    assert.equal(env.runs.list({ ownerId: 'alice', limit: 10 }).runs.length, 0, 'no Run row written');
  } finally {
    env.close();
  }
});

test('statusChangedAt changes exactly at each transition and survives a NULL pre-migration row (issue #906)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    // Creation is the QUEUED transition: the field is set from the start, never fabricated later.
    assert.equal(run.statusChangedAt, run.createdAt);

    const seen: (string | null | undefined)[] = [run.statusChangedAt];
    // ISO timestamps have millisecond precision; back-to-back transitions in-process can land in
    // the same millisecond legally. Pause between transitions so "changed" is observable, not
    // asserted against a tie the field's precision cannot distinguish.
    const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    for (const to of ['STARTING', 'RUNNING', 'COMPLETED'] as const) {
      pause(5);
      env.runs.transition(run.id, to, to === 'COMPLETED' ? { completedAt: new Date().toISOString() } : undefined);
      const r = env.runs.get(run.id)!;
      seen.push(r.statusChangedAt);
    }
    // Monotonic and strictly changing at every transition.
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] != null);
      assert.ok(new Date(seen[i]!) >= new Date(seen[i - 1]!), 'statusChangedAt must not go back');
      assert.notEqual(seen[i], seen[i - 1], 'statusChangedAt must change at each transition');
    }
    // Terminal timestamp matches the terminal event's timestamp ordering (same append window).
    const terminal = env.runs.get(run.id)!;
    assert.equal(terminal.status, 'COMPLETED');
    assert.ok(terminal.completedAt != null && terminal.statusChangedAt != null);

    // A row written before the migration (status_changed_at NULL) lists cleanly with the field
    // null, never a fabricated timestamp.
    env.db.prepare("UPDATE runs SET status_changed_at = NULL WHERE id = ?").run(run.id);
    const migrated = env.runs.list({ ownerId: 'alice', limit: 10 }).runs.find((r) => r.id === run.id)!;
    assert.equal(migrated.statusChangedAt, null);
    const viaApi = env.runs.get(run.id)!;
    assert.equal(viaApi.statusChangedAt, null);
  } finally {
    env.close();
  }
});

test('transition extra refuses a caller-supplied statusChangedAt (issue #906 review, item 3)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    assert.throws(
      () => env.runs.transition(run.id, 'STARTING', { statusChangedAt: '2000-01-01T00:00:00.000Z' }),
      /statusChangedAt/,
    );
    // The refused transition left the Run untouched: still QUEUED, stamp still the creation one.
    const r = env.runs.get(run.id)!;
    assert.equal(r.status, 'QUEUED');
    assert.equal(r.statusChangedAt, run.createdAt);
  } finally {
    env.close();
  }
});

test('a shutdown requeue clears startedAt but keeps firstStartedAt (A0-4, issue #990)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    const claimed = env.queue.claim('worker-1', 60_000);
    assert.equal(claimed?.id, run.id);
    env.runs.transition(run.id, 'STARTING');
    const startedAt = new Date().toISOString();
    env.runs.transition(run.id, 'RUNNING', { startedAt });
    assert.equal(env.runs.get(run.id)!.firstStartedAt, startedAt, 'the first start rides the startedAt write');

    assert.equal(env.queue.requeueForShutdown(run.id, 'worker-1'), true);
    const requeued = env.runs.get(run.id)!;
    assert.equal(requeued.status, 'QUEUED');
    // Deliberate: the duration and queue-wait metrics measure the CURRENT execution, so the requeue
    // must null this. It is also why the "has this attempt run" fact needs its own column.
    assert.equal(requeued.startedAt, null, 'the requeue clears the current execution start');
    assert.equal(requeued.firstStartedAt, startedAt, 'the fact that this attempt ran must survive the requeue');
    assert.equal(hasStarted(requeued), true);

    // A second execution moves `startedAt` and must NOT move the first-start stamp.
    env.runs.transition(run.id, 'STARTING');
    const second = new Date(Date.now() + 1000).toISOString();
    env.runs.transition(run.id, 'RUNNING', { startedAt: second });
    const rerun = env.runs.get(run.id)!;
    assert.equal(rerun.startedAt, second, 'startedAt follows the current execution');
    assert.equal(rerun.firstStartedAt, startedAt, 'firstStartedAt stays the FIRST');

    // One writer, enforced rather than documented: a caller-supplied value would add a second
    // assignment to the same SET and win silently under last-binding-wins.
    assert.throws(
      () => env.runs.transition(run.id, 'COMPLETED', { firstStartedAt: '2000-01-01T00:00:00.000Z' }),
      /must not set firstStartedAt/,
    );
    // A Run that never reached RUNNING has no first start at all.
    const never = env.runService.create({ ownerId: 'alice', task: 'y', agent: 'fake' });
    assert.equal(env.runs.get(never.id)!.firstStartedAt, null);
    assert.equal(hasStarted(env.runs.get(never.id)!), false);
  } finally {
    env.close();
  }
});

test('every status write stamps statusChangedAt: shutdown requeue and lease reaper included (issue #906 review, item 1)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    // requeueForShutdown matches the lease owner, so take the lease the way a worker would,
    // then move the run to STARTING like a claiming worker does.
    const claimed = env.queue.claim('worker-1', 60_000);
    assert.equal(claimed?.id, run.id);
    env.runs.transition(run.id, 'STARTING');
    const before = env.runs.get(run.id)!.statusChangedAt!;
    const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    pause(5);

    // Shutdown requeue moves STARTING back to QUEUED: a real status change, so the stamp moves.
    assert.equal(env.queue.requeueForShutdown(run.id, 'worker-1'), true);
    const requeued = env.runs.get(run.id)!;
    assert.equal(requeued.status, 'QUEUED');
    assert.ok(requeued.statusChangedAt != null && requeued.statusChangedAt > before,
      'requeueForShutdown must advance statusChangedAt');

    // Lease reaper marks an expired RUNNING run FAILED: also a status change.
    env.runs.transition(run.id, 'STARTING');
    env.db.prepare("UPDATE runs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(run.id);
    const beforeReap = env.runs.get(run.id)!.statusChangedAt!;
    pause(5);
    const reaped = env.queue.reapExpiredLeases(Date.now());
    assert.deepEqual(reaped, { requeued: [], failed: [run.id] });
    const failed = env.runs.get(run.id)!;
    assert.equal(failed.status, 'FAILED');
    assert.ok(failed.statusChangedAt != null && failed.statusChangedAt > beforeReap,
      'lease reaper must advance statusChangedAt');
  } finally {
    env.close();
  }
});

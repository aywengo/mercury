import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, waitFor } from './helpers.ts';

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
    assert.throws(() => env.runService.cancel(run.id, 'bob', false), /Run not found/);
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

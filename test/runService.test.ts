import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, waitFor } from './helpers.ts';
import type { RunConstraints } from '../src/domain/types.ts';
import { createRedactor } from '../src/domain/redact.ts';

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, waitFor } from './helpers.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { EventStore } from '../src/events/eventStore.ts';
import { createRedactor } from '../src/domain/redact.ts';

test('events persist with monotonic sequences across appends', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.events.append(run.id, 'agent.message', { text: 'hello' });
    env.events.append(run.id, 'tool.started', { tool: 'bash' });
    env.events.append(run.id, 'tool.completed', { tool: 'bash' });
    const all = env.events.list(run.id);
    assert.equal(all.length, 3 + 2 + 4); // created + queued + 4 skill.selected + 3 appended
    const seqs = all.map((e) => e.sequence);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
  } finally {
    env.close();
  }
});

test('list with after cursor returns only newer events', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    const first = env.events.list(run.id);
    const last = first[first.length - 1].sequence;
    env.events.append(run.id, 'agent.message', { text: 'after' });
    const newer = env.events.list(run.id, last);
    assert.equal(newer.length, 1);
    assert.equal((newer[0].payload as { text: string }).text, 'after');
  } finally {
    env.close();
  }
});

test('append redacts secrets in payloads when a redactor is configured (issue #3)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    // Direct append without a redactor (test env default): stored as-is.
    env.events.append(run.id, 'agent.message', { text: 'key=sk-12345' });
    // A redactor-equipped store must redact on append.
    const red = createRedactor(['super-secret']);
    const store = new EventStore(env.db, red);
    store.append(run.id, 'tool.failed', {
      error: 'boom super-secret',
      args: { api_key: 'api_key=sk-abc', bearer: 'Authorization: Bearer abc123.def456' },
    });
    const all = env.events.list(run.id);
    const toolFailed = all.find((e) => e.type === 'tool.failed')!;
    const payload = toolFailed.payload as { error: string; args: { api_key: string; bearer: string } };
    assert.equal(payload.error, 'boom [REDACTED]');
    assert.equal(payload.args.api_key, 'api_key= [REDACTED]');
    assert.equal(payload.args.bearer, 'Authorization: [REDACTED]');
    // The unredacted append is untouched.
    const msg = all.find((e) => e.type === 'agent.message')!;
    assert.equal((msg.payload as { text: string }).text, 'key=sk-12345');
  } finally {
    env.close();
  }
});


test('worker-appended events are redacted end-to-end with a redactor-equipped store (issue #3)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'mercury-redact-e2e-'));
  const env = makeEnv({
    redactor: createRedactor(['super-secret']),
    fakeScript: [
      { event: { type: 'agent.message', payload: { text: 'the key is super-secret' } } },
      { event: { type: 'tool.failed', payload: { error: 'api_key=sk-12345' } } },
    ],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'fake',
      repository: { localPath: repo },
    });
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 10_000);
    const all = env.events.list(run.id);
    const msg = all.find((e) => e.type === 'agent.message')!;
    assert.equal((msg.payload as { text: string }).text, 'the key is [REDACTED]');
    const toolFailed = all.find((e) => e.type === 'tool.failed')!;
    assert.equal((toolFailed.payload as { error: string }).error, 'api_key= [REDACTED]');
  } finally {
    env.close();
  }
});

test('append hook delivers events to subscribers immediately (in-process push)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    const stream = new EventStream(env.db, env.events, 10, 10);
    stream.start();
    const received: string[] = [];
    stream.subscribe(run.id, 0, (events) => {
      for (const e of events) received.push(e.type);
    });
    env.events.append(run.id, 'agent.message', { text: 'pushed' });
    // The hook fires synchronously on append — no need to wait for the poller.
    assert.ok(received.includes('agent.message'), `expected push delivery, got ${received.join(',')}`);
    stream.stop();
  } finally {
    env.close();
  }
});

test('append hook only delivers to matching run subscriptions', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const runA = env.runService.create({ ownerId: 'alice', task: 'a', agent: 'fake' });
    const runB = env.runService.create({ ownerId: 'alice', task: 'b', agent: 'fake' });
    const stream = new EventStream(env.db, env.events, 10, 10);
    stream.start();
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    stream.subscribe(runA.id, 0, (events) => {
      for (const e of events) receivedA.push(e.type);
    });
    stream.subscribe(runB.id, 0, (events) => {
      for (const e of events) receivedB.push(e.type);
    });
    env.events.append(runA.id, 'agent.message', { text: 'only A' });
    assert.ok(receivedA.includes('agent.message'));
    assert.ok(!receivedB.includes('agent.message'));
    stream.stop();
  } finally {
    env.close();
  }
});

test('poller catches events appended by another process (cross-process fallback)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    const stream = new EventStream(env.db, env.events, 10, 10);
    stream.start();
    const received: string[] = [];
    stream.subscribe(run.id, 0, (events) => {
      for (const e of events) received.push(e.type);
    });
    // Simulate a foreign append: bypass the hook by writing directly to the DB.
    env.db.prepare('INSERT INTO events (id, run_id, type, sequence, timestamp, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run('evt_foreign', run.id, 'foreign.event', 999, new Date().toISOString(), JSON.stringify({}));
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(received.includes('foreign.event'), `expected poller delivery, got ${received.join(',')}`);
    stream.stop();
  } finally {
    env.close();
  }
});

test('event payloads survive JSON round-trip', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.events.append(run.id, 'input.required', { question: 'Continue?', choices: ['yes', 'no'] });
    const ev = env.events.list(run.id).find((e) => e.type === 'input.required')!;
    assert.deepEqual(ev.payload, { question: 'Continue?', choices: ['yes', 'no'] });
  } finally {
    env.close();
  }
});

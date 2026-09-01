import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, tempDir, waitFor } from './helpers.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { EventStore } from '../src/events/eventStore.ts';
import { EVENT_TYPES } from '../src/domain/types.ts';
import { readdirSync, readFileSync } from 'node:fs';
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
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = tempDir('mercury-redact-e2e-');
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

test('subscribe delivers the existing backlog even with the poller never started (issue #133)', async () => {
  // Regression for real event loss. subscribe() used to only register the subscription and leave
  // the backlog to poll(). That was not merely slow: the append hook advances the subscription
  // cursor for every event it pushes, so events appended BEFORE the subscription were skipped by
  // the hook and then made invisible to poll() by the advanced cursor. A client could receive the
  // tail of a run and never its beginning -- observed on main as a stream opened with ?after=0
  // delivering sequences 14-18 and nothing before.
  //
  // start() is deliberately never called, so there is no poller and no hook: the ONLY way these
  // events can reach the subscriber is the backlog read in subscribe(). A test that allowed the
  // poller to run would pass either way depending on timing, which is exactly why the bug survived.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    for (const text of ['one', 'two', 'three']) {
      env.events.append(run.id, 'agent.message', { text });
    }
    const lastSeq = env.events.lastSequence(run.id);
    assert.ok(lastSeq >= 3, `fixture should have written >=3 events, got ${lastSeq}`);

    const stream = new EventStream(env.db, env.events, 10, 10);
    const received: number[] = [];
    stream.subscribe(run.id, 0, (events) => {
      for (const e of events) received.push(e.sequence);
    });

    assert.deepEqual(received, [...Array(lastSeq).keys()].map((i) => i + 1),
      'subscribe() must hand over every already-persisted sequence, in order, synchronously');

    // A partial cursor must resume exactly where it left off, with no gap and no repeat.
    const resumed: number[] = [];
    stream.subscribe(run.id, 2, (events) => {
      for (const e of events) resumed.push(e.sequence);
    });
    assert.deepEqual(resumed, [...Array(lastSeq - 2).keys()].map((i) => i + 3),
      'resuming from after=2 must start at 3');
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

test('backfillRedact rewrites persisted events containing secrets (issue #18)', () => {
  // store without a redactor: secrets persist as-is
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.events.append(run.id, 'agent.message', { text: 'token=abc123def' });
    env.events.append(run.id, 'tool.started', { tool: 'bash', args: 'Bearer xyz789' });
    env.events.append(run.id, 'agent.message', { text: 'no secrets here' });
    const before = env.events.list(run.id);
    const msg = before.find((e) => e.type === 'agent.message' && (e.payload as { text: string }).text === 'token=abc123def');
    assert.ok(msg, 'secret-bearing event persisted');

    // a redacted store over the same DB backfills
    const redacted = new EventStore(env.db, createRedactor());
    const changed = redacted.backfillRedact();
    assert.ok(changed >= 2, `expected >=2 changed rows, got ${changed}`);

    const after = env.events.list(run.id);
    const redactedMsg = after.find((e) => e.type === 'agent.message' && (e.payload as { text: string }).text.includes('token='));
    assert.ok(redactedMsg, 'event still present');
    assert.ok(!(redactedMsg.payload as { text: string }).text.includes('abc123def'), 'secret removed');
    assert.ok((redactedMsg.payload as { text: string }).text.includes('[REDACTED]'), 'redacted marker present');
    // unchanged rows are untouched
    const clean = after.find((e) => e.type === 'agent.message' && (e.payload as { text: string }).text === 'no secrets here');
    assert.ok(clean, 'clean event unchanged');
  } finally {
    env.close();
  }
});

test('backfillRedact with no redactor is a no-op', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.events.append(run.id, 'agent.message', { text: 'token=abc123def' });
    const changed = env.events.backfillRedact(); // env.events has no redactor
    assert.equal(changed, 0);
  } finally {
    env.close();
  }
});

test('backfillRedact skips malformed rows and is idempotent (issue #18)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.events.append(run.id, 'agent.message', { text: 'token=abc123def' });
    // inject a malformed payload row directly
    env.db.prepare('INSERT INTO events (id, run_id, type, sequence, timestamp, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run('evt_malformed', run.id, 'agent.message', 999, new Date().toISOString(), '{not json');
    const redacted = new EventStore(env.db, createRedactor());
    const changed = redacted.backfillRedact();
    assert.equal(changed, 1, 'only the secret-bearing row changes');
    // malformed row untouched
    const malformed = env.db.prepare('SELECT payload_json FROM events WHERE id = ?').get('evt_malformed') as { payload_json: string };
    assert.equal(malformed.payload_json, '{not json');
    // second pass is a no-op (idempotent)
    const again = redacted.backfillRedact();
    assert.equal(again, 0);
  } finally {
    env.close();
  }
});

test('backfillRedact covers run_inputs.input_json and runs.error (issue #36)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    // simulate pre-fix rows: unredacted input + error
    env.db.prepare('INSERT INTO run_inputs (id, run_id, input_json, created_at) VALUES (?, ?, ?, ?)')
      .run('inp_secret1', run.id, JSON.stringify({ text: 'api_key=sk-12345' }), new Date().toISOString());
    env.db.prepare('UPDATE runs SET error = ? WHERE id = ?').run('worker crashed: Bearer abc123.def456', run.id);

    const redacted = new EventStore(env.db, createRedactor());
    const changed = redacted.backfillRedact();
    assert.ok(changed >= 2, `expected >=2 changed rows, got ${changed}`);

    const input = env.db.prepare('SELECT input_json FROM run_inputs WHERE id = ?').get('inp_secret1') as { input_json: string };
    assert.ok(!input.input_json.includes('sk-12345'), 'input secret removed');
    assert.ok(input.input_json.includes('[REDACTED]'), 'input redacted marker present');

    const row = env.db.prepare('SELECT error FROM runs WHERE id = ?').get(run.id) as { error: string };
    assert.ok(!row.error.includes('abc123.def456'), 'error secret removed');
    assert.ok(row.error.includes('[REDACTED]'), 'error redacted marker present');

    // idempotent: a second pass changes nothing
    const changed2 = redacted.backfillRedact();
    assert.equal(changed2, 0, `second pass should change 0 rows, got ${changed2}`);
  } finally {
    env.close();
  }
});

test('backfillRedact leaves malformed input_json untouched (issue #36)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.db.prepare('INSERT INTO run_inputs (id, run_id, input_json, created_at) VALUES (?, ?, ?, ?)')
      .run('inp_bad1', run.id, '{not valid json', new Date().toISOString());

    const redacted = new EventStore(env.db, createRedactor());
    const changed = redacted.backfillRedact();
    assert.equal(changed, 0, 'malformed row must not be touched');

    const row = env.db.prepare('SELECT input_json FROM run_inputs WHERE id = ?').get('inp_bad1') as { input_json: string };
    assert.equal(row.input_json, '{not valid json', 'malformed row unchanged');
  } finally {
    env.close();
  }
});

test('backfillRedact covers runs.task and runs.repository_json (issue #43)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    // simulate pre-fix rows: unredacted task + credentialed repo URLs (primary + extras)
    env.db.prepare('UPDATE runs SET task = ?, repository_json = ?, repositories_json = ? WHERE id = ?')
      .run(
        'use token=sk-12345 in the script',
        JSON.stringify({ localPath: 'https://user:abc123.def@example.com/repo.git' }),
        JSON.stringify([{ localPath: 'https://user:xyz789.ghi@example.com/extra.git' }]),
        run.id,
      );

    const redacted = new EventStore(env.db, createRedactor());
    const changed = redacted.backfillRedact();
    assert.ok(changed >= 3, `expected >=3 changed rows, got ${changed}`);

    const row = env.db.prepare('SELECT task, repository_json, repositories_json FROM runs WHERE id = ?').get(run.id) as { task: string; repository_json: string; repositories_json: string };
    assert.ok(!row.task.includes('sk-12345'), 'task secret removed');
    assert.ok(row.task.includes('[REDACTED]'), 'task redacted marker present');
    assert.ok(!row.repository_json.includes('abc123.def'), 'repository secret removed');
    assert.ok(row.repository_json.includes('[REDACTED]'), 'repository redacted marker present');
    assert.ok(!row.repositories_json.includes('xyz789.ghi'), 'repositories secret removed');
    assert.ok(row.repositories_json.includes('[REDACTED]'), 'repositories redacted marker present');

    // idempotent: a second pass changes nothing
    const changed2 = redacted.backfillRedact();
    assert.equal(changed2, 0, `second pass should change 0 rows, got ${changed2}`);
  } finally {
    env.close();
  }
});

test('backfillRedact leaves malformed repository_json untouched (issue #43)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.db.prepare('UPDATE runs SET repository_json = ? WHERE id = ?').run('not-json{{', run.id);

    const redacted = new EventStore(env.db, createRedactor());
    const changed = redacted.backfillRedact();
    assert.equal(changed, 0, 'malformed row must not be touched');

    const row = env.db.prepare('SELECT repository_json FROM runs WHERE id = ?').get(run.id) as { repository_json: string };
    assert.equal(row.repository_json, 'not-json{{', 'malformed row unchanged');
  } finally {
    env.close();
  }
});

test('append rejects event types outside the EVENT_TYPES whitelist (issue #60)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    assert.throws(() => env.events.append(run.id, 'not.a.type', {}), /Unknown event type/);
    // The two types the worker already appended while missing from the whitelist.
    for (const t of ['lease.lost', 'sandbox.enabled']) {
      env.events.append(run.id, t, {});
    }
    const types = env.events.list(run.id).map((e) => e.type);
    assert.ok(types.includes('lease.lost') && types.includes('sandbox.enabled'));
    // nothing was persisted for the rejected type
    assert.equal(env.events.list(run.id).filter((e) => e.type === 'not.a.type').length, 0);
  } finally {
    env.close();
  }
});

test('an agent-controlled event type cannot inject an SSE frame (issue #50)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    // routes.ts writes `event: <type>` raw. A type carrying a blank line therefore ends
    // the current frame and starts a forged one, visible to every subscriber of the run.
    const injection = 'agent.message\ndata: {"sequence":9999,"type":"run.completed"}\n\nevent: pwned';
    assert.throws(() => env.events.append(run.id, injection, { text: 'x' }), /Unknown event type/);
    // A newline alone is enough to break the frame, so it must be refused too.
    assert.throws(() => env.events.append(run.id, 'agent.message\n', {}), /Unknown event type/);
    // run.created etc. already exist, so assert on the injection specifically rather than
    // on the total: no event carries the forged type, and no payload gained the forged line.
    const persisted = env.events.list(run.id);
    assert.equal(persisted.filter((e) => e.type.startsWith('agent.message')).length, 0);
    assert.ok(!persisted.some((e) => JSON.stringify(e.payload).includes('pwned')));
  } finally {
    env.close();
  }
});

test('EVENT_TYPES covers every type src/ actually appends (issue #60 drift guard)', () => {
  // #60 was two types appended by the worker that were never in the whitelist, so the
  // documented event contract did not describe what Mercury emits. This guard fails on
  // the next such addition, which is the only cheap way to keep the set honest.
  const src = new URL('../src/', import.meta.url);
  const offenders: string[] = [];
  // Both quote styles, so a call site written with double quotes cannot slip past the
  // guard. Paths are reported relative to src/ so the failure stays locatable when two
  // directories hold files of the same name (Copilot on #93).
  const CALL = /events\.append\(\s*[^,]+,\s*(?:'([^']+)'|"([^"]+)")\s*,/g;
  const walk = (dir: URL, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(url, relPath);
      else if (entry.name.endsWith('.ts')) {
        const text = readFileSync(url, 'utf8');
        for (const m of text.matchAll(CALL)) {
          const type = m[1] ?? m[2];
          if (!EVENT_TYPES.has(type)) offenders.push(`${relPath}: ${type}`);
        }
      }
    }
  };
  walk(src, '');
  assert.deepEqual(offenders, [], `appended types missing from EVENT_TYPES: ${offenders.join(', ')}`);
});

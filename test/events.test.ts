import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, tempDir, waitFor } from './helpers.ts';
import { createLogger } from '../src/logger.ts';
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
// --- issue #139: poll() must not swallow errors ---------------------------------------------
//
// These drive the POLL path, not the in-process append hook, by appending through a SECOND EventStore
// over the same connection. That is the situation poll() exists for (in production the worker is a
// separate process, so the hook never fires), and it is the only way to reach the code under test:
// appending through the stream's own EventStore fires the hook synchronously and never enters poll().
//
// Every stream is stopped in `finally`. A started EventStream holds a live setInterval, so a test
// that fails before its inline stop() keeps the process alive forever -- which is exactly how this
// first draft hung the file instead of failing it.

type Logged = { level: string; msg: string; fields: Record<string, unknown> };

function capturingLogger(): { log: ReturnType<typeof createLogger>; lines: Logged[] } {
  const lines: Logged[] = [];
  const log = createLogger(createRedactor([]), 'debug', (line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    lines.push({
      level: parsed.level as string,
      msg: parsed.msg as string,
      fields: parsed, // the whole record: the point is often in the fields, not the message
    });
  });
  return { log, lines };
}

/** Sequence of the newest persisted event, so a subscribe() after it delivers NO backlog. */
function cursor(env: { events: EventStore }, runId: string): number {
  const all = env.events.list(runId);
  return all.length ? all[all.length - 1].sequence : 0;
}

test('a subscriber whose delivery throws is dropped and logged, not retried forever (issue #139)', async () => {
  const env = makeEnv({ workerEnabled: false });
  const peer = new EventStore(env.db); // its appends do not fire the stream's hook
  const { log, lines } = capturingLogger();
  let stream: EventStream | null = null;
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    stream = new EventStream(env.db, env.events, 10, 10, log);
    stream.start();

    let calls = 0;
    // Subscribe PAST the existing rows: subscribe() delivers its backlog synchronously, so a handler
    // that throws would otherwise throw out of subscribe() and never reach poll().
    stream.subscribe(run.id, cursor(env, run.id), () => {
      calls += 1;
      throw new Error('client socket is gone');
    });
    assert.equal(stream.subscriptionCount, 1, 'precondition: one live subscriber');

    peer.append(run.id, 'agent.message', { text: 'deliver me' });
    await waitFor(() => stream!.subscriptionCount === 0, 5_000);

    assert.ok(calls > 0, 'the delivery callback must have been attempted at least once');
    const drop = lines.find((l) => l.level === 'error' && l.msg.includes('subscriber dropped'));
    assert.ok(drop, `expected a drop logged at error level, got ${JSON.stringify(lines)}`);
    // The message alone is not enough: the logger JSON-serialises fields, and Error.message is not
    // enumerable, so a raw { err } logs as {} and the line says nothing about what failed.
    assert.match(
      String(drop.fields.err),
      /client socket is gone/,
      `the error detail must survive serialisation, got ${JSON.stringify(drop.fields)}`,
    );

    // Dropped means DROPPED: further events must not re-invoke it.
    const callsAtDrop = calls;
    peer.append(run.id, 'agent.message', { text: 'and me' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(calls, callsAtDrop, 'a dropped subscriber must never be called again');
  } finally {
    stream?.stop();
    env.close();
  }
});

test('one throwing subscriber does not disturb the others (issue #139)', async () => {
  const env = makeEnv({ workerEnabled: false });
  const peer = new EventStore(env.db);
  let stream: EventStream | null = null;
  try {
    const runBad = env.runService.create({ ownerId: 'alice', task: 'bad', agent: 'fake' });
    const runGood = env.runService.create({ ownerId: 'alice', task: 'good', agent: 'fake' });
    stream = new EventStream(env.db, env.events, 10, 10, capturingLogger().log);
    stream.start();
    const got: string[] = [];
    stream.subscribe(runBad.id, cursor(env, runBad.id), () => {
      throw new Error('dead client');
    });
    stream.subscribe(runGood.id, cursor(env, runGood.id), (events) => {
      for (const e of events) got.push(e.type);
    });
    assert.equal(stream.subscriptionCount, 2);

    peer.append(runBad.id, 'agent.message', { text: 'boom' });
    peer.append(runGood.id, 'agent.message', { text: 'fine' });

    await waitFor(() => stream!.subscriptionCount === 1, 5_000);
    assert.ok(got.includes('agent.message'), 'the healthy subscriber must still receive');

    // And it must keep working AFTER its neighbour was dropped, not only before.
    peer.append(runGood.id, 'tool.started', { tool: 'bash' });
    await waitFor(() => got.includes('tool.started'), 5_000);
    assert.equal(stream.subscriptionCount, 1, 'exactly the throwing subscriber was removed');
  } finally {
    stream?.stop();
    env.close();
  }
});

test('POSITIVE CONTROL: a healthy subscriber survives many poll ticks (issue #139)', async () => {
  // The other tests here all assert removal or retention of something. Without one asserting that a
  // healthy stream is NEVER dropped, an implementation that dropped every subscriber on every tick
  // would satisfy them all.
  const env = makeEnv({ workerEnabled: false });
  const peer = new EventStore(env.db);
  const { log, lines } = capturingLogger();
  let stream: EventStream | null = null;
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    stream = new EventStream(env.db, env.events, 5, 5, log);
    stream.start();
    const got: number[] = [];
    stream.subscribe(run.id, cursor(env, run.id), (events) => {
      for (const e of events) got.push(e.sequence);
    });
    for (let i = 0; i < 5; i++) peer.append(run.id, 'agent.message', { text: `m${i}` });
    await waitFor(() => got.length >= 5, 5_000);
    await new Promise((r) => setTimeout(r, 150)); // many more ticks, all of them empty

    assert.equal(stream.subscriptionCount, 1, 'a healthy subscriber must never be dropped');
    const errs = lines.filter((l) => l.level === 'error');
    assert.equal(errs.length, 0, `no errors expected, got ${JSON.stringify(errs)}`);
  } finally {
    stream?.stop();
    env.close();
  }
});

test('a failed event READ keeps the subscriber, logs once, and recovers (issue #139)', async () => {
  // A read failure is the database's fault and hits every subscriber at once, so it must NOT be
  // handled like a dead client. A row with unparseable payload_json makes readAfter() throw while
  // leaving the connection usable -- the only way to produce, and then clear, a read failure in a
  // test. Recovery is asserted because "log once per streak" is only correct if the streak ends.
  const env = makeEnv({ workerEnabled: false });
  const peer = new EventStore(env.db);
  const { log, lines } = capturingLogger();
  let stream: EventStream | null = null;
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    stream = new EventStream(env.db, env.events, 5, 5, log);
    stream.start();
    const got: number[] = [];
    stream.subscribe(run.id, cursor(env, run.id), (events) => {
      for (const e of events) got.push(e.sequence);
    });

    // Append and corrupt in ONE synchronous block. The poll runs on a timer, and a timer cannot
    // interleave with synchronous code, so this guarantees the stream's first read of the row is the
    // corrupt one. Corrupting after a waitFor would race the poll and, worse, could corrupt a row the
    // cursor had already moved past -- which fails silently instead of failing the test.
    peer.append(run.id, 'agent.message', { text: 'poison' });
    const poisoned = env.events.list(run.id).slice(-1)[0].sequence;
    env.db.prepare("UPDATE events SET payload_json = '{' WHERE run_id = ? AND sequence = ?").run(run.id, poisoned);
    assert.equal(got.length, 0, 'precondition: the corrupt row has not been delivered yet');

    const readErrors = () => lines.filter((l) => l.msg.includes('poll read failed')).length;
    await waitFor(() => readErrors() >= 1, 5_000);
    const firstErr = lines.find((l) => l.msg.includes('poll read failed'))!;
    assert.match(
      String(firstErr.fields.err),
      /SyntaxError|JSON/,
      `a read failure must say why, got ${JSON.stringify(firstErr.fields)}`,
    );
    await waitFor(() => readErrors() >= 1, 5_000);
    const afterFirst = readErrors();
    await new Promise((r) => setTimeout(r, 200)); // ~40 more ticks at 5ms

    assert.equal(stream.subscriptionCount, 1, 'a read failure must not drop the subscriber');
    assert.equal(readErrors(), afterFirst, `read failures must log once per streak, saw ${readErrors()}`);

    // Clear the fault: the SAME subscription must resume, with nothing skipped.
    env.db
      .prepare("UPDATE events SET payload_json = '{\"text\":\"healed\"}' WHERE run_id = ? AND sequence = ?")
      .run(run.id, poisoned);
    await waitFor(() => lines.some((l) => l.msg.includes('poll read recovered')), 5_000);
    assert.ok(got.includes(poisoned), 'the event is still delivered after recovery -- nothing was skipped');
    assert.equal(stream.subscriptionCount, 1);
  } finally {
    stream?.stop();
    env.close();
  }
});

test('a poisoned run does not make a healthy run log recoveries (issue #139 review)', async () => {
  // Two runs, one with an undecodable row and one healthy, sharing one poll loop. With a single
  // global "was failing" flag cleared by the first successful read, the healthy run's every-tick
  // success would emit a recovery line while the poisoned run kept failing -- so the log would both
  // spam and describe a recovery that never happened. Streaks are per run for exactly this reason.
  const env = makeEnv({ workerEnabled: false });
  const peer = new EventStore(env.db);
  const { log, lines } = capturingLogger();
  let stream: EventStream | null = null;
  try {
    const runBad = env.runService.create({ ownerId: 'alice', task: 'bad', agent: 'fake' });
    const runGood = env.runService.create({ ownerId: 'alice', task: 'good', agent: 'fake' });
    stream = new EventStream(env.db, env.events, 5, 5, log);
    stream.start();
    const good: number[] = [];
    stream.subscribe(runBad.id, cursor(env, runBad.id), () => {});
    stream.subscribe(runGood.id, cursor(env, runGood.id), (events) => {
      for (const e of events) good.push(e.sequence);
    });

    // Poison only runBad, in the same synchronous block as the append so no poll can see it first.
    peer.append(runBad.id, 'agent.message', { text: 'poison' });
    const badSeq = env.events.list(runBad.id).slice(-1)[0].sequence;
    env.db.prepare("UPDATE events SET payload_json = '{' WHERE run_id = ? AND sequence = ?").run(runBad.id, badSeq);
    // And keep runGood genuinely healthy across many ticks.
    peer.append(runGood.id, 'agent.message', { text: 'fine' });

    await waitFor(() => lines.some((l) => l.msg.includes('poll read failed')), 5_000);
    await waitFor(() => good.length >= 1, 5_000);
    await new Promise((r) => setTimeout(r, 200)); // ~40 more ticks: bad keeps failing, good keeps succeeding

    const failures = lines.filter((l) => l.msg.includes('poll read failed'));
    const recoveries = lines.filter((l) => l.msg.includes('poll read recovered'));
    assert.equal(failures.length, 1, `one failure per failing run, saw ${failures.length}`);
    assert.equal(
      recoveries.length,
      0,
      `a run that never failed must not log a recovery, saw ${recoveries.length}: ${JSON.stringify(recoveries)}`,
    );
    assert.equal(stream.subscriptionCount, 2, 'neither subscription may be dropped by a read failure');
  } finally {
    stream?.stop();
    env.close();
  }
});
// --- issue #138: the cursor must advance only after delivery --------------------------------
//
// All three delivery paths used to set `sub.afterSeq` BEFORE handing the events over. A throw
// partway through a batch therefore forfeited the rest of it: poll() reads `WHERE sequence >
// afterSeq`, so the skipped rows were never returned again. What "not lost" means differs per path,
// and each test states which:
//
//   push hook  -- the subscriber is DROPPED, so recovery is a reconnect using the client's own
//                 cursor. It cannot be recovered in place: the cursor is one scalar and the next
//                 successful push moves past the refused sequence. (EventStore.append() does swallow
//                 listener failures, so the append survives -- the subscription does not.)
//   subscribe() backlog -- the throw rethrows to the caller and the subscription is never
//                 registered, so recovery is a RECONNECT with the original ?after=. That is the
//                 documented contract; what must hold is that the rows are still readable.
//   poll()     -- issue #143 drops the dead subscriber, so again recovery is a reconnect.
//
// The trade-off is deliberate: at-least-once. A duplicated row is cosmetic, a missing one is a lie.

test('a throw during a pushed event does not lose it (issue #138)', async () => {
  // The in-process push path: append through the stream's OWN store so the hook fires.
  const env = makeEnv({ workerEnabled: false });
  let stream: EventStream | null = null;
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    const start = env.events.list(run.id).slice(-1)[0].sequence;
    stream = new EventStream(env.db, env.events, 5, 5);
    stream.start();
    const delivered: number[] = [];
    let refused = false;
    stream.subscribe(run.id, start, (events) => {
      for (const e of events) {
        if (e.sequence === start + 3 && !refused) {
          refused = true;
          throw new Error('client died mid-write');
        }
        delivered.push(e.sequence);
      }
    });

    for (let i = 1; i <= 6; i++) env.events.append(run.id, 'agent.message', { text: `m${i}` });

    // The refused event cannot be recovered in place: the cursor is one scalar and the successful
    // pushes for 4,5,6 move past it. So the subscriber must be DROPPED, which is what lets the
    // client's own lastSeq drive a reconnect that re-reads the gap.
    await waitFor(() => stream!.subscriptionCount === 0, 5_000);
    assert.ok(refused, 'precondition: the handler must actually have thrown once');

    const again: number[] = [];
    stream.subscribe(run.id, start, (events) => {
      for (const e of events) again.push(e.sequence);
    });
    const want = [1, 2, 3, 4, 5, 6].map((i) => start + i);
    assert.deepEqual(
      [...again].sort((a, b) => a - b),
      want,
      `a reconnect must recover every event including the refused one, got ${JSON.stringify(again)}`,
    );
  } finally {
    stream?.stop();
    env.close();
  }
});

test('a throw during a backlog page leaves the whole page readable for a reconnect (issue #138)', async () => {
  // The batch path, the expensive one: one throw used to lose the remainder of a 500-row page.
  const env = makeEnv({ workerEnabled: false });
  let stream: EventStream | null = null;
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    const start = env.events.list(run.id).slice(-1)[0].sequence;
    const want: number[] = [];
    for (let i = 1; i <= 5; i++) {
      env.events.append(run.id, 'agent.message', { text: `b${i}` });
      want.push(start + i);
    }

    stream = new EventStream(env.db, env.events, 5, 5);
    stream.start();
    const first: number[] = [];
    let refused = false;
    try {
      stream.subscribe(run.id, start, (events) => {
        for (const e of events) {
          if (e.sequence === start + 2 && !refused) {
            refused = true;
            throw new Error('client died mid-write');
          }
          first.push(e.sequence);
        }
      });
      assert.fail('subscribe() must rethrow when the backlog handler throws (issue #143 relies on it)');
    } catch (err) {
      assert.match(String((err as Error).message), /client died mid-write/);
    }
    assert.ok(refused, 'precondition: the handler must actually have thrown');
    assert.deepEqual(first, [start + 1], 'only the events written before the throw count as delivered');

    // The client reconnects with the SAME ?after= it had. Nothing may have been forfeited.
    const again: number[] = [];
    stream.subscribe(run.id, start, (events) => {
      for (const e of events) again.push(e.sequence);
    });
    assert.deepEqual(
      [...again].sort((a, b) => a - b),
      want,
      `a reconnect must recover the entire page, got ${JSON.stringify(again)}`,
    );
  } finally {
    stream?.stop();
    env.close();
  }
});

test('a throw during a poll delivery drops the subscriber but not the events (issue #138)', async () => {
  // Poll path: #143 removes the dead subscriber, so the guarantee here is that the cursor never
  // claimed what was refused -- a reconnect still sees everything.
  const env = makeEnv({ workerEnabled: false });
  const peer = new EventStore(env.db); // second store: the hook does not fire, so poll() delivers
  let stream: EventStream | null = null;
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    const start = env.events.list(run.id).slice(-1)[0].sequence;
    stream = new EventStream(env.db, env.events, 5, 5);
    stream.start();
    const got: number[] = [];
    stream.subscribe(run.id, start, (events) => {
      for (const e of events) {
        if (e.sequence === start + 2) throw new Error('client died mid-write');
        got.push(e.sequence);
      }
    });
    for (let i = 1; i <= 4; i++) peer.append(run.id, 'agent.message', { text: `p${i}` });

    await waitFor(() => stream!.subscriptionCount === 0, 5_000); // dropped by #143

    const again: number[] = [];
    stream.subscribe(run.id, start, (events) => {
      for (const e of events) again.push(e.sequence);
    });
    const want = [1, 2, 3, 4].map((i) => start + i);
    assert.deepEqual(
      [...again].sort((a, b) => a - b),
      want,
      `a reconnect must still see every event, got ${JSON.stringify(again)}`,
    );
  } finally {
    stream?.stop();
    env.close();
  }
});

test('POSITIVE CONTROL: a healthy subscriber receives each event exactly once (issue #138)', async () => {
  // The fix trades loss for possible duplication, so it must not duplicate on the happy path --
  // otherwise "at-least-once" has quietly become "every poll tick, forever".
  const env = makeEnv({ workerEnabled: false });
  const peer = new EventStore(env.db);
  let stream: EventStream | null = null;
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    const start = env.events.list(run.id).slice(-1)[0].sequence;
    stream = new EventStream(env.db, env.events, 5, 5);
    stream.start();
    const delivered: number[] = [];
    stream.subscribe(run.id, start, (events) => {
      for (const e of events) delivered.push(e.sequence);
    });
    for (let i = 1; i <= 6; i++) peer.append(run.id, 'agent.message', { text: `m${i}` });
    await waitFor(() => delivered.length >= 6, 5_000);
    await new Promise((r) => setTimeout(r, 150)); // many idle ticks that could re-send

    const dupes = delivered.filter((s, i) => delivered.indexOf(s) !== i);
    assert.deepEqual(dupes, [], `a healthy stream must not receive duplicates, got ${JSON.stringify(delivered)}`);
    assert.deepEqual(
      [...delivered].sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6].map((i) => start + i),
      'every event exactly once',
    );
  } finally {
    stream?.stop();
    env.close();
  }
});

test('a throwing push subscriber does not starve the others (issue #138)', async () => {
  // The hook looped over every subscriber with no per-subscriber handling, so the first throw
  // propagated out of the whole callback (EventStore swallows it at the listener level) and every
  // subscriber registered after the bad one silently received nothing -- for the rest of the run.
  // Same isolation the poll path already had; the push path did not.
  const env = makeEnv({ workerEnabled: false });
  let stream: EventStream | null = null;
  try {
    const runBad = env.runService.create({ ownerId: 'alice', task: 'bad', agent: 'fake' });
    const runGood = env.runService.create({ ownerId: 'alice', task: 'good', agent: 'fake' });
    stream = new EventStream(env.db, env.events, 5, 5);
    stream.start();
    const good: string[] = [];
    // Subscribe the bad one FIRST so it is the one that throws first in the loop.
    stream.subscribe(runBad.id, env.events.list(runBad.id).slice(-1)[0].sequence, () => {
      throw new Error('dead client');
    });
    stream.subscribe(runGood.id, env.events.list(runGood.id).slice(-1)[0].sequence, (events) => {
      for (const e of events) good.push(e.type);
    });

    env.events.append(runBad.id, 'agent.message', { text: 'boom' });
    env.events.append(runGood.id, 'agent.message', { text: 'fine' });
    env.events.append(runGood.id, 'tool.started', { tool: 'bash' });

    await waitFor(() => good.includes('tool.started'), 5_000);
    assert.ok(good.includes('agent.message'), 'the healthy subscriber must receive from the start');
    assert.equal(stream.subscriptionCount, 1, 'only the throwing subscriber is removed');
  } finally {
    stream?.stop();
    env.close();
  }
});

// --- issue #146: one poll read per (run, cursor), not one per subscriber ------------------------
//
// poll() used to call readAfter() once per Subscription. Ten tabs on one run issued ten identical
// `SELECT ... LIMIT 500` four times a second and got back the same rows. These tests count reads.

/** Run exactly one poll() tick synchronously, so read counts are not a race with the timer. */
function pollOnce(stream: EventStream): void {
  (stream as unknown as { poll: () => void }).poll();
}

/** Count readAfter() calls on a live stream by wrapping the instance method. */
function countReads(stream: EventStream): { reads: () => number; reset: () => void } {
  const target = stream as unknown as {
    readAfter: (runId: string, after: number) => unknown[];
  };
  const original = target.readAfter.bind(stream);
  let n = 0;
  target.readAfter = (runId: string, after: number) => {
    n += 1;
    return original(runId, after);
  };
  return { reads: () => n, reset: () => { n = 0; } };
}

test('a run with two cursors does not log a recovery that did not happen (issue #146)', () => {
  // Grouping by (runId, cursor) means ONE run can occupy several groups in a single tick. The failure
  // streak is keyed by runId, so clearing it from whichever group read cleanly logged "recovered" while
  // another group on the same run was still failing -- then "failed" again next tick. That is the exact
  // log spam the streak tracker exists to prevent, reintroduced by the grouping.
  const env = makeEnv({ workerEnabled: false });
  const peer = new EventStore(env.db); // its appends do not fire the stream's push hook
  const { log, lines } = capturingLogger();
  let stream: EventStream | null = null;
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    peer.append(run.id, 'agent.message', { i: 1 });
    stream = new EventStream(env.db, env.events, 5, 5, log);

    // A subscribes first, so its backlog read succeeds and it parks at the current head. The run's own
    // lifecycle events occupy the early sequences, so "the head" is NOT sequence 1 -- the lagging cursor
    // has to be constructed relative to the real head, not assumed.
    stream.subscribe(run.id, 0, () => {});
    peer.append(run.id, 'agent.message', { i: 2 });
    peer.append(run.id, 'agent.message', { i: 3 });
    // Capture the head BEFORE poisoning: cursor() reads through EventStore.list(), which is exactly the
    // call that throws on a corrupt payload.
    const head = cursor(env, run.id);
    // Poison the OLDEST row A still has to read. Reads from A's cursor throw; reads from the head do
    // not touch that row at all.
    const poisonSeq = head - 1;
    env.db.prepare("UPDATE events SET payload_json = '{' WHERE run_id = ? AND sequence = ?").run(run.id, poisonSeq);
    // B sits at the head, so its group always reads cleanly.
    stream.subscribe(run.id, head, () => {});

    const failed = () => lines.filter((l) => l.msg.includes('poll read failed')).length;
    const recovered = () => lines.filter((l) => l.msg.includes('poll read recovered')).length;

    for (let i = 0; i < 5; i++) pollOnce(stream!);

    assert.equal(failed(), 1, 'the leading edge of the streak logs once');
    assert.equal(recovered(), 0, 'a clean read on another cursor must not claim recovery');
    assert.equal((stream as unknown as { failingReads: Set<string> }).failingReads.has(run.id), true,
      'the run is still failing and must still be tracked as failing');

    // POSITIVE CONTROL: once the row is readable, recovery IS reported. Without this, "recovered is
    // never logged" would pass even if the recovery path were deleted outright.
    env.db.prepare(`UPDATE events SET payload_json = '{"i":2}' WHERE run_id = ? AND sequence = ?`).run(run.id, poisonSeq);
    for (let i = 0; i < 3; i++) pollOnce(stream!);
    assert.equal(recovered(), 1, 'a genuinely recovered run must still be reported as recovered');
    assert.equal((stream as unknown as { failingReads: Set<string> }).failingReads.has(run.id), false);
  } finally {
    stream?.stop();
    env.close();
  }
});

test('ten subscribers on one run cost ONE poll read (issue #146)', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    // A second store: appending through it does not fire the push hook, so delivery goes through
    // poll() -- which is the path being measured.
    const writer = new EventStore(env.db);
    const run = env.runService.create({ ownerId: 'alice', task: 'fan-out', agent: 'fake' });
    writer.append(run.id, 'agent.message', { i: 1 });
    const caughtUp = env.events.lastSequence(run.id);

    const stream = new EventStream(env.db, env.events, 10, 10);
    const counter = countReads(stream);
    const seen: number[][] = [];
    for (let i = 0; i < 10; i++) {
      stream.subscribe(run.id, caughtUp, (evs) => { seen.push(evs.map((e) => e.sequence)); });
    }

    counter.reset(); // subscribe() reads the backlog; only poll() reads are under test
    for (let i = 2; i <= 4; i++) writer.append(run.id, 'agent.message', { i });
    // One synchronous tick. Driving the timer instead made the expected count depend on how many
    // ticks had fired by the time the assertion ran -- 6 where 3 was expected -- which measures the
    // scheduler, not the grouping.
    pollOnce(stream);
    assert.equal(seen.length, 10, 'every subscriber was served by the single tick');
    assert.equal(counter.reads(), 1,
      `10 subscriptions at the same cursor must share one read, got ${counter.reads()}`);
    // And sharing the read must not mean sharing a subset.
    assert.equal(new Set(seen.map((x) => x.join(','))).size, 1,
      'every subscriber must receive the same batch');
    assert.equal(seen[0].length, 3, 'the whole batch, not a partial page');
  } finally {
    env.close();
  }
});

test('POSITIVE CONTROL: different runs still read separately (issue #146)', async () => {
  // Grouping by (run, cursor) rather than by tick is deliberate: a lazier "one read per tick" would
  // pass the fan-out test above while silently delivering run A's events to run B's subscribers.
  //
  // Cursor divergence within one run is NOT asserted here. subscribe() delivers the backlog
  // synchronously and advances the cursor, so two subscribers on one run converge to the same cursor
  // before poll() ever runs -- an earlier version of this test expected three groups and got two,
  // which was the implementation being correct and the fixture being wrong. Per-subscriber cursors
  // are covered by the issue #133 and #138 tests.
  const env = makeEnv({ workerEnabled: false });
  try {
    const writer = new EventStore(env.db);
    const runs = [1, 2, 3].map((n) => {
      const r = env.runService.create({ ownerId: 'alice', task: `r${n}`, agent: 'fake' });
      writer.append(r.id, 'agent.message', { i: 1 });
      return r;
    });

    const stream = new EventStream(env.db, env.events, 10, 10);
    const counter = countReads(stream);
    for (const r of runs) stream.subscribe(r.id, env.events.lastSequence(r.id), () => {});

    counter.reset();
    for (const r of runs) writer.append(r.id, 'agent.message', { i: 2 });
    pollOnce(stream);
    assert.equal(counter.reads(), 3,
      `three runs must issue three reads in one tick, got ${counter.reads()}`);
  } finally {
    env.close();
  }
});

test('POSITIVE CONTROL: two cursors on one run read separately and get their own batches (issue #146)', async () => {
  // The gap that grouping by runId ALONE would slip through: it would read once from the slowest
  // cursor and hand everyone else that same page. Cursors converge easily (subscribe() delivers the
  // backlog and advances), so divergence has to be constructed: subscribe A early, let events pile up,
  // then subscribe B already caught up. Now A and B genuinely sit at different cursors.
  const env = makeEnv({ workerEnabled: false });
  try {
    const writer = new EventStore(env.db);
    const run = env.runService.create({ ownerId: 'alice', task: 'divergent', agent: 'fake' });
    writer.append(run.id, 'agent.message', { i: 1 });

    const stream = new EventStream(env.db, env.events, 10, 10);
    const aSeen: number[][] = [];
    const bSeen: number[][] = [];
    // Cursor 0 means "deliver everything", so subscribe() drains the backlog synchronously and A
    // lands at the head of it -- which is NOT sequence 1. runService.create() has already written six
    // lifecycle events (run.created, run.queued, 4x skill.selected), so A starts at 6 and the append
    // below is sequence 7. No number is hard-coded here on purpose: the fixture's lifecycle count is
    // free to change, and a comment asserting a specific head is how this line used to mislead.
    stream.subscribe(run.id, 0, (e) => aSeen.push(e.map((x) => x.sequence)));
    for (let i = 2; i <= 6; i++) writer.append(run.id, 'agent.message', { i });
    // Capture B's cursor AFTER the appends, so B really is at the head and A is the only one behind.
    const caughtUp = env.events.lastSequence(run.id);
    stream.subscribe(run.id, caughtUp, (e) => bSeen.push(e.map((x) => x.sequence)));

    const counter = countReads(stream);
    counter.reset();
    pollOnce(stream);

    assert.equal(counter.reads(), 2,
      `A lagging behind the head and B at the head are different groups; got ${counter.reads()} reads`);
    // Sequences include the lifecycle events the run service appends itself, so assert against the
    // store rather than a hand-count of the fixture's own appends.
    const last = env.events.lastSequence(run.id);
    // aSeen accumulates BOTH deliveries: the synchronous backlog drained by subscribe() (the lifecycle
    // events, sequences 1..6) and the poll delivery that follows (everything after them).
    assert.deepEqual(aSeen.flat(), Array.from({ length: last }, (_, k) => k + 1),
      'the lagging subscriber gets everything after its cursor, across both deliveries');
    assert.deepEqual(bSeen, [], 'the caught-up subscriber must NOT be handed the lagging one\'s page');
  } finally {
    env.close();
  }
});

test('POSITIVE CONTROL: one throwing subscriber does not starve the others in its group (issue #146)', async () => {
  // Sharing a read makes the delivery loop shared too, so the per-subscriber isolation from issue
  // #138 has to survive the refactor.
  const env = makeEnv({ workerEnabled: false });
  try {
    const writer = new EventStore(env.db);
    const run = env.runService.create({ ownerId: 'alice', task: 'thrower', agent: 'fake' });
    writer.append(run.id, 'agent.message', { i: 1 });
    const caughtUp = env.events.lastSequence(run.id);

    const stream = new EventStream(env.db, env.events, 10, 10);
    let healthy = 0;
    stream.subscribe(run.id, caughtUp, () => { throw new Error('dead client'); });
    stream.subscribe(run.id, caughtUp, () => { healthy += 1; });

    writer.append(run.id, 'agent.message', { i: 2 });
    stream.start();
    try {
      await waitFor(() => healthy >= 1, 5_000);
      await waitFor(() => stream.subscriptionCount === 1, 5_000);
      assert.equal(stream.subscriptionCount, 1, 'only the throwing subscriber is dropped');
    } finally {
      stream.stop();
    }
  } finally {
    env.close();
  }
});

// --- issue #162 (finding R2-11): the poll cadence must follow whether PUSH served the event ------
//
// Push is the primary delivery path; poll() is the backstop that carries events appended by ANOTHER
// process, which push cannot see. slowDown() exists because a pushed event needs no backstop soon
// after it, so the poller can relax. It was called on EVERY append, including appends with no
// subscriber at all -- so a busy run with nobody watching left the sole delivery path for
// cross-process events running at its SLOWEST cadence, exactly when the system is busiest.
// These two tests point in opposite directions on purpose: one alone would be satisfied by a
// slowDown() that never fires, and the other by one that always fires.

function slowDownCalls(stream: EventStream): () => number {
  const target = stream as unknown as { slowDown: () => void };
  let n = 0;
  const original = target.slowDown.bind(stream);
  target.slowDown = () => { n += 1; original(); };
  return () => n;
}

test('an append nobody is watching does not slow the poller (issue #162)', () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    const stream = new EventStream(env.db, env.events, 5, 5_000);
    const calls = slowDownCalls(stream);
    stream.start();
    try {
      // Must append through the SAME EventStore the stream was built with: a separate instance
      // writing to the same database does not fire the in-process push hook, which would make this
      // test pass without the hook ever running.
      for (let i = 0; i < 5; i++) env.events.append(run.id, 'agent.message', { i });
      assert.equal(calls(), 0,
        'with no subscribers, push delivered nothing, so the poller must stay at its fast cadence');
    } finally {
      stream.stop();
    }
  } finally {
    env.close();
  }
});

test('an append for a run nobody watches does not slow the poller (issue #162)', () => {
  // A subscriber on ANOTHER run is not "served" by this append, so the backstop must stay sharp:
  // cross-process events for the watched run still arrive only via poll().
  const env = makeEnv({ workerEnabled: false });
  try {
    const watched = env.runService.create({ ownerId: 'alice', task: 'watched', agent: 'fake' });
    const noisy = env.runService.create({ ownerId: 'alice', task: 'noisy', agent: 'fake' });
    const stream = new EventStream(env.db, env.events, 5, 5_000);
    const calls = slowDownCalls(stream);
    stream.start();
    try {
      stream.subscribe(watched.id, 0, () => {});
      const before = calls();
      for (let i = 0; i < 5; i++) env.events.append(noisy.id, 'agent.message', { i });
      assert.equal(calls(), before,
        'appends to an unwatched run must not relax the poller that serves the watched one');
    } finally {
      stream.stop();
    }
  } finally {
    env.close();
  }
});

test('a subscriber that throws was not served, so the poller does not relax (issue #162)', () => {
  // "Served" must mean DELIVERED, not attempted. The throwing subscriber is dropped as dead, so after
  // this append there is nobody to push to and poll() is again the only path -- relaxing it would be the
  // same mistake as relaxing on an append nobody subscribed to.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    const { log, lines } = capturingLogger();
    const stream = new EventStream(env.db, env.events, 5, 5_000, log);
    const calls = slowDownCalls(stream);
    stream.start();
    try {
      // Subscribe AT THE HEAD: subscribe() delivers the backlog synchronously, and the run already has
      // lifecycle events, so subscribing from 0 would throw here rather than on the append under test.
      stream.subscribe(run.id, cursor(env, run.id), () => { throw new Error('client socket gone'); });
      const before = calls();
      env.events.append(run.id, 'agent.message', { boom: true });
      assert.ok(lines.some((l) => l.msg.includes('subscriber dropped after delivery failure')),
        'precondition: the throwing subscriber was dropped and logged');
      assert.equal(calls(), before,
        'a failed delivery is not a served event; the backstop must stay sharp');
    } finally {
      stream.stop();
    }
  } finally {
    env.close();
  }
});

test('POSITIVE CONTROL: an append that push DID deliver does slow the poller (issue #162)', () => {
  // Points the other way on purpose. Without it, "never slows down" would pass by deleting slowDown()
  // entirely, and the poller would then spin at its fast cadence forever -- the cost the call exists to
  // avoid.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    const stream = new EventStream(env.db, env.events, 5, 5_000);
    const calls = slowDownCalls(stream);
    stream.start();
    try {
      const seen: number[] = [];
      stream.subscribe(run.id, 0, (evts) => { for (const e of evts) seen.push(e.sequence); });
      const before = calls();
      // subscribe(run.id, 0, ...) already drained the backlog synchronously, so seen is NOT empty
      // before the append -- it holds the six lifecycle events create() wrote. Asserting
      // "seen.length >= 1" therefore proves nothing about the event under test: it passed even when
      // push delivered only the backlog. Pin the precondition to the appended sequence.
      const backlogLen = seen.length;
      assert.ok(backlogLen > 0, 'precondition: subscribe() should have drained the backlog');
      const appended = env.events.append(run.id, 'agent.message', { hello: true });
      assert.ok(seen.length > backlogLen,
        'precondition: push must deliver the NEW event, not merely the backlog');
      assert.ok(seen.includes(appended.sequence),
        `precondition: push must deliver sequence ${appended.sequence}; saw ${JSON.stringify(seen)}`);
      assert.ok(calls() > before,
        'an event that push actually delivered should let the backstop relax');
    } finally {
      stream.stop();
    }
  } finally {
    env.close();
  }
});

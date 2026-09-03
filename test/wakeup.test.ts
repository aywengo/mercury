import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WakeupListener, WakeupWriter, encodeWakeup } from '../src/events/wakeup.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { EventStore } from '../src/events/eventStore.ts';
import { makeEnv, waitFor } from './helpers.ts';

// Source for the second process in the multi-process test. `SRC` is replaced with the repo root so the
// child imports the SAME modules the API process uses -- which is the point: it must be a different
// process, not a different implementation.
const CHILD_SOURCE = `
import { DatabaseSync } from 'node:sqlite';
import { EventStore } from 'SRC/src/events/eventStore.ts';
import { WakeupWriter } from 'SRC/src/events/wakeup.ts';
const [dbPath, sock, runId, countRaw] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
const store = new EventStore(db);
const w = new WakeupWriter(sock);
const n = Number(countRaw);
for (let i = 0; i < n; i++) {
  const e = store.append(runId, 'agent.message', { i, from: 'child' });
  w.notify(runId, e.sequence);
}
// Let the socket flush before tearing down, or the test measures a race instead of the channel.
setTimeout(() => { w.close(); db.close(); process.exit(0); }, 250);
`;

function socketPath(name: string): string {
  // Sockets live outside the repo temp dirs: macOS caps sun_path at 104 bytes and mkdtemp paths
  // routinely exceed it, which fails bind() with a message that looks like a permissions bug.
  return join(tmpdir(), `mercury-wakeup-${name}-${process.pid}.sock`);
}

test('a wake-up travels writer -> listener and coalesces per run per tick', async () => {
  const path = socketPath('coal');
  const woken: string[] = [];
  const listener = new WakeupListener(path, (runId) => woken.push(runId));
  await listener.listen();
  const writer = new WakeupWriter(path);
  try {
    for (let i = 1; i <= 50; i++) writer.notify('run_a', i);
    writer.notify('run_b', 1);
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(woken.sort(), ['run_a', 'run_b'],
      `50 appends to one run must collapse to ONE drain for that run, got ${JSON.stringify(woken)}`);
  } finally {
    writer.close(); listener.close();
  }
});

test('nonsense, duplicate and reordered notifications are absorbed without throwing', async () => {
  // Section 15 requires this explicitly: the channel is advisory, so garbage must cost timing only,
  // never correctness. Written as a listener-level test because the reader must survive arbitrary
  // byte boundaries, not just well-formed lines.
  const path = socketPath('junk');
  const woken: string[] = [];
  const listener = new WakeupListener(path, (runId) => woken.push(runId));
  await listener.listen();
  const { createConnection } = await import('node:net');
  const sock = createConnection({ path });
  await new Promise<void>((res, rej) => { sock.once('connect', () => res()); sock.once('error', rej); });
  try {
    // Split across chunk boundaries, out of order, duplicated, and containing lines with no run id.
    sock.write('run_a:5\nrun_a:2\n');
    sock.write('run_a:9\nnonsense-without-colon\n');
    sock.write(':42\n\n');
    sock.write('run_b:1'); // no trailing newline yet
    await new Promise((r) => setTimeout(r, 120));
    sock.write('\n');
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(woken.sort(), ['run_a', 'run_b'],
      `duplicates collapse and malformed lines are ignored; got ${JSON.stringify(woken)}`);
  } finally {
    sock.destroy(); listener.close();
  }
});

test('a writer with NO listener anywhere never throws and never blocks the caller', () => {
  // The single most dangerous failure mode in section 10: a worker stalling an agent run because a
  // browser hint could not be delivered. There is no peer and no socket file at all here.
  const path = socketPath('absent');
  if (existsSync(path)) unlinkSync(path);
  const writer = new WakeupWriter(path);
  const started = Date.now();
  let threw: unknown = null;
  try {
    for (let i = 0; i < 500; i++) writer.notify('run_x', i);
  } catch (err) {
    threw = err;
  }
  const elapsed = Date.now() - started;
  writer.close();
  assert.equal(threw, null, `notify() must never throw: ${String(threw)}`);
  assert.ok(elapsed < 250, `500 notifies with no peer must not block; took ${elapsed} ms`);
});

// ---- EventStream integration: the properties that actually matter ----

test('wakeRun delivers a cross-process event WITHOUT waiting for a poll tick', async () => {
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'w', agent: 'fake' });
    // slowMs huge: without a wake-up this subscription would essentially never be read, so any
    // delivery here can only have come from wakeRun.
    const stream = new EventStream(env.db, env.events, 60_000, 60_000);
    const other = new EventStore(env.db);
    const seen: number[] = [];
    stream.start();
    try {
      const bl = env.events.list(run.id);
      stream.subscribe(run.id, bl.length ? bl[bl.length - 1].sequence : 0, (e) => {
        for (const x of e) seen.push(x.sequence);
      });
      const ev = other.append(run.id, 'agent.message', { n: 1 });
      assert.deepEqual(seen, [], 'precondition: nothing delivered before the wake-up');
      stream.wakeRun(run.id);
      assert.deepEqual(seen, [ev.sequence], 'wakeRun must deliver immediately via the poll path');
    } finally { stream.stop(); }
  } finally { env.close(); }
});

test('a wake-up for a run with no new rows delivers nothing and advances nothing', async () => {
  // The cursor contract (section 9): a notification is a hint, never a receipt. If a wake-up could
  // advance afterSeq, a spurious or duplicated notification would silently skip rows.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'w', agent: 'fake' });
    const stream = new EventStream(env.db, env.events, 60_000, 60_000);
    const seen: number[] = [];
    stream.start();
    try {
      const bl = env.events.list(run.id);
      const head = bl.length ? bl[bl.length - 1].sequence : 0;
      stream.subscribe(run.id, head, (e) => { for (const x of e) seen.push(x.sequence); });
      for (let i = 0; i < 20; i++) stream.wakeRun(run.id);
      assert.deepEqual(seen, [], 'no new rows means nothing may be delivered');
      const other = new EventStore(env.db);
      const ev = other.append(run.id, 'agent.message', { after: true });
      stream.wakeRun(run.id);
      assert.deepEqual(seen, [ev.sequence],
        'the row appended after 20 spurious wake-ups must still arrive -- the cursor was not moved');
    } finally { stream.stop(); }
  } finally { env.close(); }
});

test('P2 PROOF: with the wake-up channel destroyed mid-run the stream is still complete', async () => {
  // Section 15 calls this out as the direct proof of P2 and asks for it as a permanent test. The
  // channel is killed AFTER some events have already flowed through it, so the test cannot pass by
  // never having used push at all -- it must show the poller picking up exactly where push stopped.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'loss', agent: 'fake' });
    const path = socketPath('loss');
    // Fast poll so the fallback is observable in a test window; the property does not depend on it.
    const stream = new EventStream(env.db, env.events, 20, 1_000);
    const listener = new WakeupListener(path, (id) => stream.wakeRun(id));
    await listener.listen();
    const writer = new WakeupWriter(path);
    const other = new EventStore(env.db); // another process: only poll or push can deliver
    const seen: number[] = [];
    stream.start();
    try {
      const bl = env.events.list(run.id);
      const head = bl.length ? bl[bl.length - 1].sequence : 0;
      stream.subscribe(run.id, head, (e) => { for (const x of e) seen.push(x.sequence); });

      for (let i = 1; i <= 5; i++) other.append(run.id, 'agent.message', { i });
      await waitFor(() => seen.length >= 5, 2_000);

      // Kill the channel completely: peer gone AND socket file removed.
      writer.close(); listener.close();
      if (existsSync(path)) unlinkSync(path);

      for (let i = 6; i <= 25; i++) other.append(run.id, 'agent.message', { i });
      await waitFor(() => seen.length >= 25, 5_000);

      const expected = Array.from({ length: 25 }, (_, i) => head + i + 1);
      assert.deepEqual(seen, expected,
        'losing every notification must cost latency only: no gap, no reorder, no duplicate');
    } finally {
      stream.stop(); writer.close(); listener.close();
    }
  } finally { env.close(); }
});

test('REAL two-process delivery: a separate node process wakes the API over the socket', async () => {
  // The point of Stage 1 is a worker in ANOTHER PROCESS, so the test must involve another process.
  // An in-process EventStore over the same db only proves the SQL; it cannot see the socket, the
  // listener, or the writer, which is where the risk actually lives.
  //
  // Made deterministic rather than timing-based the same way the rest of this file is: the poll
  // interval is 60 s, so the poller CANNOT have delivered anything inside the test window. Every
  // delivered event therefore arrived through the socket, or the test fails.
  const env = makeEnv({ workerEnabled: false });
  const path = socketPath('multiproc');
  const child = join(tmpdir(), `mercury-wakeup-child-${process.pid}.ts`);
  const srcRoot = join(import.meta.dirname, '..');
  // The child source lives HERE, not in a scratch file. An earlier version read it from
  // /tmp/wakeup_child.ts.tpl: that passed locally because the file happened to exist on the author's
  // machine and failed CI with ENOENT. A test may not depend on state it did not create itself.
  writeFileSync(child, CHILD_SOURCE.replaceAll('SRC', srcRoot));
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'multiproc', agent: 'fake' });
    const stream = new EventStream(env.db, env.events, 60_000, 60_000);
    const listener = new WakeupListener(path, (id) => stream.wakeRun(id));
    await listener.listen();
    const seen: number[] = [];
    stream.start();
    try {
      const bl = env.events.list(run.id);
      const head = bl.length ? bl[bl.length - 1].sequence : 0;
      stream.subscribe(run.id, head, (e) => { for (const x of e) seen.push(x.sequence); });

      const N = 12;
      const { spawn } = await import('node:child_process');
      const proc = spawn(process.execPath, [child, join(env.dir, 'test.db'), path, run.id, String(N)],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      const code = await new Promise<number | null>((res) => proc.on('exit', res));
      await waitFor(() => seen.length >= N, 3_000);

      assert.equal(code, 0, `child process failed: ${stderr.slice(0, 400)}`);
      assert.equal(seen.length, N, `expected ${N} events, got ${seen.length}`);
      assert.deepEqual(seen, Array.from({ length: N }, (_, i) => head + i + 1),
        'cross-process delivery must be contiguous and ordered (G3)');
      assert.ok(listener.wakeupsReceived >= 1, 'the listener must actually have received notifications');
    } finally { stream.stop(); listener.close(); }
  } finally {
    unlinkSync(child);
    if (existsSync(path)) unlinkSync(path);
    env.close();
  }
});

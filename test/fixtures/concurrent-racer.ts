#!/usr/bin/env node
/**
 * Second (and third, and fourth) process for the cross-process contention tests (issue #72).
 *
 * The races that actually bite in production are between PROCESSES -- the API server appending
 * events while a worker appends to the same run, or two workers claiming the same queued Run.
 * Until now every such test simulated the interleaving in one process (two claim() calls on one
 * queue object, a monkey-patched idempotency window, a direct SQL insert for the "cross-process"
 * poller). Those exercise the in-process code path only; they cannot observe SQLite's real
 * cross-connection locking, which is what the BEGIN IMMEDIATE change (issue #49) is for.
 *
 * Usage: node test/fixtures/concurrent-racer.ts <mode> <dbPath> <runId> <count> <barrierFile>
 *   mode = append | claim
 * Prints one JSON line on stdout when done.
 *
 * It imports the real production modules rather than reimplementing the queries: a fixture that
 * hand-rolls its own SQL would test the fixture, not the code under review.
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { openDatabase } from '../../src/db/database.ts';
import { EventStore } from '../../src/events/eventStore.ts';
import { RunQueue } from '../../src/queue/runQueue.ts';
import { RunStore } from '../../src/runs/runStore.ts';

const [mode, dbPath, runId, countRaw, barrierFile] = process.argv.slice(2);
const count = Number(countRaw);

const db = openDatabase(dbPath);

/**
 * Spin until every participant has arrived, then release together.
 *
 * A fixed sleep would make the test depend on scheduling luck. The barrier makes simultaneity the
 * thing under test: all processes block on the same file and start within the same tick window.
 */
function waitForBarrier(expected: number): void {
  writeFileSync(barrierFile + '/arrive.' + process.pid, String(process.pid));
  const deadline = Date.now() + 20_000;
  for (;;) {
    const arrived = readdirSync(barrierFile).filter((n) => n.startsWith('arrive.')).length;
    if (arrived >= expected) return;
    if (Date.now() > deadline) throw new Error('barrier timeout: only ' + arrived + '/' + expected + ' arrived');
  }
}

const out: Record<string, unknown> = { mode, pid: process.pid };
try {
  // All participants are already spawned by the time the last one reaches here, so releasing on
  // a full barrier puts every writer into the same window instead of relying on spawn timing.
  waitForBarrier(Number(process.env.BARRIER_EXPECT ?? '1'));

  if (mode === 'append') {
    const events = new EventStore(db);
    const seqs: number[] = [];
    for (let i = 0; i < count; i++) {
      const ev = events.append(runId, 'agent.message', { text: `pid ${process.pid} msg ${i}` });
      seqs.push(ev.sequence);
    }
    out.appended = seqs.length;
    out.sequences = seqs;
  } else if (mode === 'claim') {
    const queue = new RunQueue(db, new RunStore(db));
    // One attempt each: the point is who wins, not how many tries it takes.
    const claimed = queue.claim('child-' + process.pid, 60_000);
    out.claimedRunId = claimed?.id ?? null;
  } else {
    throw new Error('unknown mode ' + mode);
  }
  out.ok = true;
} catch (err) {
  out.ok = false;
  out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
} finally {
  process.stdout.write(JSON.stringify(out) + '\n');
  db.close();
}

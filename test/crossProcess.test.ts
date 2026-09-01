/**
 * Cross-process contention (issue #72).
 *
 * Every other "concurrency" test in this suite simulates the interleaving inside one process: two
 * claim() calls on one queue object, a monkey-patched idempotency window, a direct SQL insert
 * standing in for a second process. Those are useful, but they exercise the in-process code path
 * and cannot observe SQLite's real cross-connection locking -- which is precisely what the
 * BEGIN IMMEDIATE change (issue #49) exists to get right. The production shape is an API process
 * and one or more worker processes sharing one WAL database, and that shape had no coverage.
 *
 * These tests spawn real child processes against the same database file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv } from './helpers.ts';

const RACER = join(import.meta.dirname, 'fixtures', 'concurrent-racer.ts');

interface RacerResult {
  ok: boolean;
  mode: string;
  pid: number;
  error?: string;
  sequences?: number[];
  appended?: number;
  claimedRunId?: string | null;
}

/**
 * Run `n` racer processes that all block on a shared barrier file and release together.
 *
 * Spawning alone does not produce overlap: a child that starts 200ms later would land its writes
 * after the first had finished, and the test would pass without ever contending. The barrier makes
 * simultaneity a property of the test rather than a hope about scheduling.
 */
async function race(mode: string, dbPath: string, runId: string, perProcess: number, n: number): Promise<RacerResult[]> {
  const barrier = join(dbPath, '..', 'race-barrier');
  rmSync(barrier, { recursive: true, force: true });
  mkdirSync(barrier, { recursive: true });

  // Spawn must be concurrent. The first version used spawnSync, which blocks until each child
  // exits -- so racer 1 sat waiting for 4 arrivals while racers 2..4 had not been started, and the
  // barrier could only ever time out. A barrier is only meaningful if everyone can reach it.
  const children = [];
  for (let i = 0; i < n; i++) {
    const child = spawn(process.execPath, [RACER, mode, dbPath, runId, String(perProcess), barrier], {
      env: { ...process.env, BARRIER_EXPECT: String(n) },
    });
    children.push(child);
  }

  const settled = await Promise.all(
    children.map(async (child, i) => {
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => { stdout += d; });
      child.stderr.on('data', (d: string) => { stderr += d; });
      const status = await new Promise<number | null>((resolve) => child.once('close', resolve));
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      if (!line) {
        throw new Error(`racer ${i} produced no output (status ${status}): ${stderr.slice(0, 500)}`);
      }
      return JSON.parse(line) as RacerResult;
    }),
  );
  return settled;
}

test('cross-process: concurrent event appends never produce duplicate or gapped sequences (issue #72)', async () => {
  // EventStore.append assigns sequence with MAX(sequence)+1 inside tx(). Two connections that
  // both read the same MAX would both write the same sequence, and the deferred BEGIN would let
  // them both commit. That is the H4 contention, and it is invisible to a single-process test.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    // Run creation writes events of its own (run.created, run.queued, one skill.selected per
    // auto-selected skill), so sequences do not start at 1. Measure the baseline instead of
    // assuming it -- a hardcoded offset is the kind of constant that silently rots the next time
    // the selection count changes.
    const baseline = env.events.list(run.id, 0, 1000).length;
    const writers = 4;
    const perWriter = 12;
    const results = await race('append', join(env.dir, 'test.db'), run.id, perWriter, writers);

    for (const r of results) {
      assert.ok(r.ok, `racer ${r.pid} failed: ${r.error}`);
      assert.equal(r.appended, perWriter, `racer ${r.pid} lost writes`);
    }

    const all = results.flatMap((r) => r.sequences ?? []);
    assert.equal(all.length, writers * perWriter, 'total appended count');

    // The real assertions: no duplicates, and no gaps. A duplicate means two writers read the
    // same MAX; a gap means a transaction was lost after its sequence was handed out.
    const sorted = [...all].sort((a, b) => a - b);
    const dupes = sorted.filter((v, i) => i > 0 && v === sorted[i - 1]);
    assert.deepEqual(dupes, [], `duplicate sequences across processes: ${dupes}`);
    assert.deepEqual(
      sorted,
      Array.from({ length: writers * perWriter }, (_, i) => baseline + i + 1),
      `sequences must be contiguous with no gaps (baseline ${baseline})`,
    );

    // Cross-check against what the database itself holds, not just what the writers reported: a
    // writer could report a sequence that never committed.
    const stored = env.events.list(run.id, 0, 1000);
    assert.equal(stored.length, baseline + writers * perWriter, 'events missing from the database');
    const storedSeqs = stored.map((e) => e.sequence);
    assert.equal(new Set(storedSeqs).size, storedSeqs.length, 'duplicate sequences in the database');
  } finally {
    env.close();
  }
});

test('cross-process: exactly one process wins a claim for a single queued run (issue #72)', async () => {
  // The in-process equivalent calls claim() twice on one queue object, so it only proves the
  // UPDATE ... WHERE lease_owner IS NULL guard within a connection. Across processes the claim
  // additionally depends on SQLite's write lock, which is what actually stops two workers from
  // running the same Run on two machines.
  const env = makeEnv({ workerEnabled: false });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    const racers = 3;
    const results = await race('claim', join(env.dir, 'test.db'), run.id, 0, racers);
    for (const r of results) {
      assert.ok(r.ok, `racer ${r.pid} failed: ${r.error}`);
    }
    const winners = results.filter((r) => r.claimedRunId === run.id);
    assert.equal(winners.length, 1, `expected exactly one winner, got ${winners.length}: ${JSON.stringify(results)}`);

    // The winner count alone is not enough: assert the lease in the database names exactly that
    // winner, so a bug that let two racers both believe they won cannot hide behind the filter.
    // Note claim() only takes the lease -- the worker moves QUEUED -> STARTING separately -- so
    // status is deliberately still QUEUED here.
    const stored = env.runs.get(run.id);
    assert.equal(stored?.status, 'QUEUED', 'claim() takes a lease but does not transition status');
    assert.ok(stored?.leaseOwner, 'lease owner must be set');
    assert.equal(stored.leaseOwner, `child-${winners[0].pid}`, 'lease owner must be the winning racer');
    assert.ok(stored.leaseExpiresAt, 'lease must carry an expiry');
  } finally {
    env.close();
  }
});

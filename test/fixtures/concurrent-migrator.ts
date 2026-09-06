#!/usr/bin/env node
/**
 * Concurrent schema-migration racer (issue #284).
 *
 * Mercury opens its database with `openDatabase()` in BOTH the API process and every worker
 * process. On a fresh database file those processes race, and the loser used to die with
 * `UNIQUE constraint failed: schema_migrations.version`. No single-process test can see it: the
 * bug is the gap between reading the applied-version set and writing to it, and that gap is only
 * crossed by another process when the two are genuinely separate.
 *
 * Usage: node test/fixtures/concurrent-migrator.ts <dbPath> <barrierFile>
 * Prints one JSON line on stdout when done.
 *
 * It calls the real `openDatabase()` rather than replaying the migration SQL, so the fixture
 * cannot pass while the production entry point is still broken.
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { openDatabase } from '../../src/db/database.ts';

const [dbPath, barrierFile] = process.argv.slice(2);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Block until every participant has arrived, then release together.
 *
 * The window we need to hit is a few hundred microseconds wide. A fixed sleep would turn the test
 * into a coin flip on scheduling; the barrier makes simultaneity a property of the test instead.
 */
async function waitForBarrier(expected: number): Promise<void> {
  writeFileSync(barrierFile + '/arrive.' + process.pid, String(process.pid));
  const deadline = Date.now() + 20_000;
  for (;;) {
    const arrived = readdirSync(barrierFile).filter((n) => n.startsWith('arrive.')).length;
    if (arrived >= expected) return;
    if (Date.now() > deadline) throw new Error('barrier timeout: only ' + arrived + '/' + expected + ' arrived');
    await sleep(2);
  }
}

const result: { ok: boolean; pid: number; error?: string } = { ok: false, pid: process.pid };
try {
  await waitForBarrier(Number(process.env.BARRIER_EXPECT ?? '1'));
  const db = openDatabase(dbPath);
  const applied = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[])
    .map((r) => r.version);
  db.close();
  result.ok = true;
  result.error = undefined;
  process.stdout.write(JSON.stringify({ ...result, applied }) + '\n');
} catch (err) {
  result.error = (err as Error).message;
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = 1;
}

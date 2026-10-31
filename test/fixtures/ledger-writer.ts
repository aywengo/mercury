#!/usr/bin/env node
/**
 * Second (and third) process for the Run-ledger temp-file race test (#1026, item 4).
 *
 * The race is between PROCESSES: two `next.ts` processes sharing one state home both write the
 * ledger, and -- before the fix -- both used the SAME temp file `${p}.tmp`. The loser's
 * renameSync threw ENOENT, which the catch swallowed, silently dropping a claim or a terminal
 * call. A single-process test cannot observe this: saveRunLedger is fully synchronous, so one
 * process can never interleave with itself.
 *
 * Usage: node test/fixtures/ledger-writer.ts <stateHomeDir> <count> <barrierDir>
 * Prints one JSON line on stdout: { pid, ok, cycles, failed, error? }.
 *
 * It imports the real production module rather than reimplementing the write path: a fixture
 * that hand-wrote the ledger would test the fixture, not the code under review (concurrent-racer.ts).
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { recordRunClaim } from '../../.agents/skills/nightly/shared.ts';

const [stateHome, countRaw, barrierDir] = process.argv.slice(2);
const count = Number(countRaw);
const env = { XDG_STATE_HOME: stateHome };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spin until every participant has arrived, then release together (concurrent-racer.ts).
 *
 * Spawning alone does not produce overlap: a child that starts 200ms later would land its writes
 * after the first had finished, and the test would pass without ever contending. The barrier makes
 * simultaneity a property of the test rather than a hope about scheduling.
 */
async function waitForBarrier(expected: number): Promise<void> {
  writeFileSync(barrierDir + '/arrive.' + process.pid, String(process.pid));
  const deadline = Date.now() + 20_000;
  for (;;) {
    const arrived = readdirSync(barrierDir).filter((n) => n.startsWith('arrive.')).length;
    if (arrived >= expected) return;
    if (Date.now() > deadline) throw new Error('barrier timeout: only ' + arrived + '/' + expected + ' arrived');
    // Yield between polls (concurrent-racer.ts): a 2ms pause costs nothing in determinism, while a
    // synchronous busy loop pegs a core for the whole wait and adds scheduler noise to the very
    // contention this test is trying to observe.
    await sleep(2);
  }
}

const out: Record<string, unknown> = { pid: process.pid };
try {
  await waitForBarrier(Number(process.env.BARRIER_EXPECT ?? '1'));
  // Each cycle is one full read-modify-write against the shared file. recordRunClaim returns
  // false when the save throws -- the ENOENT path this test exists to catch -- so a nonzero
  // count is the dropped write, not a crash.
  let failed = 0;
  for (let i = 0; i < count; i++) {
    if (!recordRunClaim(env, { runId: 'run_' + process.pid + '_' + i, issue: i + 1 })) failed += 1;
  }
  out.cycles = count;
  out.failed = failed;
  out.ok = true;
} catch (err) {
  out.ok = false;
  out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
process.stdout.write(JSON.stringify(out) + '\n');

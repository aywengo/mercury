#!/usr/bin/env node
/**
 * `npm run prepr` -- the whole local quality gate in one command.
 *
 * Stages run in cost order, cheapest first, and stop at the first failure:
 *
 *   1. build      the test image (dependency install included)
 *   2. verify     typecheck + the existing suites, INSIDE that image
 *   3. e2e        the Docker system journey
 *
 * Stage 2 is the point of the design: the existing suites run in the same container image
 * the system journey runs in, so "works on my machine" has nowhere to hide. It runs in its
 * own short-lived Compose project that is torn down before stage 3, so a typecheck failure
 * never pays for containers it will not use.
 *
 * Deliberately NOT wired into CI. CI already runs the suites on a Node matrix; this command
 * exists to make a developer's pre-PR check as cheap as one keystroke, and it needs a Docker
 * daemon that CI does not provide here. See docs/local-e2e-design.md.
 *
 * Every stage has its own deadline. A hung stage is killed and reported as a timeout with the
 * stage name, rather than leaving the developer staring at a silent terminal -- the same
 * reasoning AGENTS.md gives for bounded command execution.
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export interface Stage {
  /** Name shown in the summary. */
  name: string;
  /** What the developer needs to know if this stage is the one that failed. */
  hint: string;
  deadlineMs: number;
  argv: string[];
  /** Run after the stage, success or not. Used to tear the verify project down. */
  cleanup?: string[];
  /** Override the teardown deadline. Production uses CLEANUP_DEADLINE_MS; tests need it short. */
  cleanupDeadlineMs?: number;
}

const MINUTE = 60_000;

/**
 * Teardown gets its own, much shorter, deadline. A stage deadline has to tolerate a cold image build;
 * a `compose down` that takes minutes means the daemon is wedged, and waiting longer does not help.
 */
export const CLEANUP_DEADLINE_MS = 2 * MINUTE;

/**
 * Deadlines are generous on purpose: they exist to catch a HANG, not to police a slow
 * machine. The measured costs on a warm laptop are roughly 5s (cached build), 2min (verify)
 * and 1min (e2e), so each deadline is at least 5x its measured cost and the first run on a
 * cold cache still fits.
 */
export const STAGES: Stage[] = [
  {
    name: 'build',
    hint: 'the test image failed to build; `docker compose -f e2e/compose.yml build` shows the layer',
    deadlineMs: 15 * MINUTE,
    argv: ['docker', 'compose', '-f', 'e2e/compose.yml', 'build'],
  },
  {
    name: 'verify',
    hint: 'typecheck or an existing suite failed inside the image; re-run `docker compose -f e2e/compose.yml run --rm verify`',
    deadlineMs: 20 * MINUTE,
    argv: ['docker', 'compose', '-p', 'mercury-e2e-verify', '-f', 'e2e/compose.yml', 'run', '--rm', 'verify'],
    cleanup: ['docker', 'compose', '-p', 'mercury-e2e-verify', '-f', 'e2e/compose.yml', 'down', '-v', '--remove-orphans'],
  },
  {
    name: 'e2e',
    hint: 'the system journey failed; `npm run test:e2e` alone re-runs it with diagnostics',
    deadlineMs: 20 * MINUTE,
    argv: ['npm', 'run', 'test:e2e'],
  },
];

export interface Result {
  stage: Stage;
  code: number;
  timedOut: boolean;
  ms: number;
}

/**
 * The status `prepr` exits with, given its stage results.
 *
 * Pulled out of main() so the rule is testable without spawning containers: a gate that swallows
 * a failing stage's status is worse than no gate, because it still reads as a pass.
 *
 * A timeout reports 124 (the conventional timeout exit) rather than the signal-derived code, so a
 * caller can tell "the tool said no" from "the tool never answered".
 */
export function exitCodeFor(results: Result[]): number {
  const failed = results.find((r) => r.code !== 0);
  if (!failed) return 0;
  return failed.timedOut ? 124 : failed.code;
}

/**
 * Spawn one command under a deadline, killing it if the deadline passes.
 *
 * Shared by stages and by teardown, because teardown has the same failure mode in a worse shape: a
 * `docker compose down` against a wedged daemon blocks forever, and it blocks AFTER the real result
 * is already known -- so an unbounded cleanup can turn a completed run into a hung one.
 */
async function spawnBounded(
  argv: string[],
  deadlineMs: number,
  stdio: 'inherit' | 'ignore',
): Promise<{ code: number; timedOut: boolean }> {
  const child = spawn(argv[0] as string, argv.slice(1), { stdio });

  // One promise, created BEFORE anything can kill the child. The first version of this awaited a
  // fresh `child.on('close')` after escalating, but by then close had usually already fired, so the
  // new listener never ran and the stage hung forever. `child.exitCode !== null` did not catch it
  // either: a process stopped by a signal has exitCode null and signalCode set, so the guard meant
  // to detect "already finished" was false for exactly the processes this path kills.
  let closed = false;
  const onClosed = new Promise<void>((resolve) => {
    child.on('close', () => {
      closed = true;
      resolve();
    });
    child.on('error', (err) => {
      closed = true;
      process.stderr.write(`\n${argv[0]}: cannot start \`${argv.join(' ')}\`: ${err.message}\n`);
      resolve();
    });
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    onClosed.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), deadlineMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!timedOut) return { code: child.exitCode ?? 1, timedOut: false };

  // Escalate, but never wait on something that may have already happened.
  child.kill('SIGTERM');
  await Promise.race([onClosed, delay(5_000)]);
  if (!closed) {
    child.kill('SIGKILL');
    await Promise.race([onClosed, delay(5_000)]);
  }
  return { code: 124, timedOut: true };
}

/**
 * Run one stage, then ALWAYS run its teardown.
 *
 * The teardown used to sit after an early `return` on the timeout path, so the one situation that
 * most needed it -- a stage killed mid-flight with containers still up -- was the one that skipped
 * it. The leaked volume then makes the NEXT run start from dirty state, which is the exact failure
 * the teardown exists to prevent.
 */
export async function runStage(stage: Stage): Promise<Result> {
  const startedAt = Date.now();
  process.stdout.write(`\n\u2500\u2500 ${stage.name} ${'\u2500'.repeat(Math.max(2, 46 - stage.name.length))}\n`);

  // Output is inherited rather than captured: a developer watching a 2-minute stage needs to see it
  // working, and the failing tool already prints its own diagnosis. The deadline is what makes
  // inheriting safe -- an infinite silent stream becomes a named timeout.
  const ran = await spawnBounded(stage.argv, stage.deadlineMs, 'inherit');

  if (stage.cleanup) {
    // Best-effort: a teardown problem must not mask the stage's own result, but it must not stay
    // silent either.
    const down = await spawnBounded(stage.cleanup, stage.cleanupDeadlineMs ?? CLEANUP_DEADLINE_MS, 'ignore');
    if (down.timedOut) {
      process.stderr.write(`\n${stage.name}: cleanup did not finish in `
        + `${seconds(stage.cleanupDeadlineMs ?? CLEANUP_DEADLINE_MS)}; `
        + 'check `docker ps -a` and `docker volume ls`\n');
    } else if (down.code !== 0) {
      process.stderr.write(`${stage.name}: cleanup exited ${down.code}; check \`docker volume ls\`\n`);
    }
  }

  return { stage, code: ran.timedOut ? 124 : ran.code, timedOut: ran.timedOut, ms: Date.now() - startedAt };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export async function main(): Promise<number> {
  const results: Result[] = [];
  const startedAt = Date.now();

  for (const stage of STAGES) {
    const result = await runStage(stage);
    results.push(result);
    if (result.code !== 0) break;
  }

  const failed = results.find((r) => r.code !== 0);
  process.stdout.write(`\n${'\u2500'.repeat(52)}\nprepr summary\n`);
  for (const r of results) {
    const status = r.code === 0 ? 'ok' : r.timedOut ? `TIMEOUT after ${seconds(r.stage.deadlineMs)}` : `FAILED (exit ${r.code})`;
    process.stdout.write(`  ${r.code === 0 ? '\u2713' : '\u2717'} ${r.stage.name.padEnd(8)} ${seconds(r.ms).padStart(8)}  ${status}\n`);
  }
  const skipped = STAGES.length - results.length;
  if (skipped > 0) process.stdout.write(`  ${'\u00b7'.padStart(2)} ${skipped} stage(s) not run\n`);
  process.stdout.write(`  total ${seconds(Date.now() - startedAt)}\n`);

  const code = exitCodeFor(results);
  if (failed) {
    process.stderr.write(`\n${failed.stage.name}: ${failed.stage.hint}\n`);
    return code;
  }
  process.stdout.write('\nprepr: all stages passed\n');
  return 0;
}

// Only run when executed directly, so the guard tests can import STAGES.
const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('prepr.ts');
if (invokedDirectly) {
  process.exitCode = await main();
}

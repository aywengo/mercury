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
}

const MINUTE = 60_000;

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
 * Run one stage under its own deadline.
 *
 * Output is inherited rather than captured: a developer watching a 2-minute stage needs to see
 * it working, and the failing tool already prints its own diagnosis. The deadline is what makes
 * inheriting safe -- an infinite silent stream is turned into a named timeout.
 */
async function runStage(stage: Stage): Promise<Result> {
  const startedAt = Date.now();
  process.stdout.write(`\n\u2500\u2500 ${stage.name} ${'\u2500'.repeat(Math.max(2, 46 - stage.name.length))}\n`);
  const child = spawn(stage.argv[0] as string, stage.argv.slice(1), { stdio: 'inherit' });

  const timedOut = await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(true);
    }, stage.deadlineMs);

    child.on('error', (err) => {
      process.stderr.write(`\n${stage.name}: cannot start \`${stage.argv.join(' ')}\`: ${err.message}\n`);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
      child.kill('SIGKILL');
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
  });

  if (timedOut) {
    // Escalate: a container-aware parent may ignore SIGTERM, and a stage that has already
    // blown a 15-minute deadline is not going to be persuaded.
    child.kill('SIGTERM');
    await delay(5_000);
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.on('close', () => resolve())));
    return { stage, code: 124, timedOut: true, ms: Date.now() - startedAt };
  }

  const code = child.exitCode ?? 1;
  if (stage.cleanup) {
    // Best-effort: a teardown failure must not mask the stage's own result, but it must not
    // stay silent either -- a leaked volume is how the next run starts from a dirty state.
    const down = spawn(stage.cleanup[0] as string, stage.cleanup.slice(1), { stdio: 'ignore' });
    await new Promise<void>((resolve) => down.on('close', (c) => {
      if (c !== 0) process.stderr.write(`${stage.name}: cleanup exited ${c}; check \`docker volume ls\`\n`);
      resolve();
    }));
  }
  return { stage, code, timedOut: false, ms: Date.now() - startedAt };
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

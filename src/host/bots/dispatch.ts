// Manual fire for one bot task (docs/dispatcher-bot-design.md §11; B1-2, issue #736).
//
// `mercury host bot dispatch --alias <a> --task <name>` fires a task NOW through the same
// template resolution the scheduler uses, with an idempotency key derived the same deterministic
// way — scheduled-minute semantics replaced by the dispatch minute: two invocations inside the
// same wall-clock minute replay to one Run, and a retry after a crash replays too. The manual
// key is prefixed `manual-` so it can never collide with a scheduled fire's key.
//
// Writing requires --yes; --dry-run prints everything the dispatch WOULD do (resolved template,
// key, constraints) and touches nothing (§11: the dry-run mode is not optional).

import { botOwnerId, scheduledWallMinuteId } from './keys.ts';
import { resolveTemplate } from './scheduler.ts';
import { parseTz, type CronTz } from './cron.ts';
import type { BotConfig } from './config.ts';
import type { SchedulerClient } from './scheduler.ts';

export interface ManualFire {
  taskName: string;
  key: string;
  /** The plain `w…` wall-minute label in the task's tz (the manual- key carries `manual-` + it). */
  wallMinute: string;
  body: Record<string, unknown>;
}

export interface ManualFireDecision {
  fired: boolean;
  reason?: string;
  fire?: ManualFire;
}

/** Build the manual-fire request for one task at `nowMs` (pure; shared by dispatch and dry-run). */
export function buildManualFire(cfg: BotConfig, taskName: string, nowMs: number): ManualFire {
  const task = cfg.tasks.find((t) => t.name === taskName);
  if (!task) {
    throw new Error(`task '${taskName}' is not defined for bot '${cfg.alias}' (known: ${cfg.tasks.map((t) => t.name).join(', ')})`);
  }
  const tz: CronTz = parseTz(task.tz);
  const wallMinute = scheduledWallMinuteId(nowMs, tz);
  const tzParts = { date: wallMinute.slice(1, 11), time: wallMinute.slice(12, 17), iso: wallMinute };
  const body = resolveTemplate(task, tzParts);
  const constraints = { ...((body.constraints as Record<string, unknown>) ?? {}) };
  constraints.botTask = taskName;
  if (constraints.maxDurationMs === undefined) constraints.maxDurationMs = 3_600_000;
  if (constraints.maxRetries === undefined) constraints.maxRetries = 0;
  body.constraints = constraints;
  // `manual-` + the dispatch wall minute: two calls in one minute replay; a scheduled fire can
  // never collide with this key (its key has no manual- segment). Built from botOwnerId +
  // taskName directly (dispatchKey's third segment would be the scheduled-minute label this key
  // deliberately replaces).
  const key = `${botOwnerId(cfg.alias)}:${taskName}:manual-${wallMinute}`;
  return { taskName, key, wallMinute, body };
}

/**
 * Decide and execute one manual fire. `singleFlight` applies exactly as configured — a manual
 * dispatch is not an override of the §5.3 no-stacking rule; an operator who wants stacking sets
 * `singleFlight: false` on the task (validate already warns about `run` + `singleFlight`).
 */
export async function dispatchTask(
  cfg: BotConfig,
  client: SchedulerClient,
  taskName: string,
  opts: { nowMs: number; dryRun: boolean; yes: boolean },
): Promise<ManualFireDecision> {
  const fire = buildManualFire(cfg, taskName, opts.nowMs);
  if (opts.dryRun) {
    return { fired: false, reason: 'dry-run', fire };
  }
  if (!opts.yes) {
    return { fired: false, reason: 'refused: dispatch writes to the API — pass --yes (or --dry-run to preview)', fire };
  }
  const task = cfg.tasks.find((t) => t.name === taskName)!;
  if (task.singleFlight) {
    // Walk the owner-run list the same way the scheduler does: a parked Run on ANY page blocks,
    // and exhausting the page cap WITHOUT reaching the end fails CLOSED — an old non-terminal
    // Run could be hiding past the cap, and dispatching over it is the one wrong outcome.
    // The blocking Run's id is kept so the refusal is actionable (cancel/wait/inspect THAT Run).
    let blocker: { id: string; status: string } | undefined;
    let capExhausted = false;
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res = await client.listOwnRuns(200, cursor);
      for (const run of res.runs) {
        if (run.constraints?.botTask !== taskName) continue;
        if (runIsNonTerminal(run.status)) { blocker = { id: run.id, status: run.status }; break; }
      }
      if (blocker) break;
      cursor = res.nextCursor ?? null;
      if (!cursor) break;
      if (page === 19) capExhausted = true;
    }
    if (!blocker && capExhausted) {
      return {
        fired: false,
        reason: `singleFlight scan hit the 20-page cap without reaching the end of the run list — refusing to dispatch (an old non-terminal Run could be past the cap)`,
        fire,
      };
    }
    if (blocker) {
      return {
        fired: false,
        reason: `singleFlight: task '${taskName}' has non-terminal Run ${blocker.id} (status ${blocker.status}) — cancel it or wait, or set singleFlight: false for this task`,
        fire,
      };
    }
  }
  const res = await client.createRun({ taskName, fireMs: opts.nowMs, wallMinute: fire.wallMinute, key: fire.key, body: fire.body });
  return { fired: true, fire };
}

// Local copy of the terminal deny-list (same wire-vocabulary rule as scheduler.ts — §15 item 4).
const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const;
function runIsNonTerminal(status: string): boolean {
  return !(TERMINAL_STATUSES as readonly string[]).includes(status);
}

// The bot scheduler core (docs/dispatcher-bot-design.md §5, §10; B1-1, issue #735).
//
// One timer per process ticks once per minute and decides, per task, what to dispatch. Everything
// here is deterministic given (config, state, clock): the cron evaluation comes from cron.ts, the
// idempotency key from keys.ts, and the HTTP layer is injected, so the whole decision surface is
// testable with a fake clock and a scripted client (§5.4) — no LLM, no server needed to decide.
//
// Correctness of non-double-dispatch comes from the derived idempotency key alone (§5.2): the
// state file is an onMiss optimisation, and a crash between dispatch and state-write replays to
// the original Run.

import { due, parseTz, type CronTz } from './cron.ts';
import { dispatchKey, scheduledWallMinuteId } from './keys.ts';
import type { BotConfig, BotTaskConfig } from './config.ts';

// The terminal deny-list is a deliberate wire-vocabulary copy of
// src/domain/stateMachine.ts TERMINAL_STATUSES (the bot boundary forbids src/ internals except
// the redactor — §15 item 4). Drift is made visible by the contract tests that pin the status
// set over HTTP. Because the check is "status IS in the terminal list", a NEW server status is
// NOT in the list and therefore counts as non-terminal: singleFlight blocks on it. Firing while
// a Run sits in an unknown state is the one direction this check must never err toward.
const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const;
type RunStatus = string;
function isTerminal(status: RunStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export interface ScheduledFire {
  task: BotTaskConfig;
  /** The scheduled fire instant (ms epoch). */
  fireMs: number;
  /** The wall-clock minute label in the task's zone (the idempotency key component). */
  wallMinute: string;
}

export interface RunTemplate {
  task: string;
  [key: string]: unknown;
}

export interface DispatchRequest {
  taskName: string;
  fireMs: number;
  wallMinute: string;
  /** The Idempotency-Key header value. */
  key: string;
  body: Record<string, unknown>;
}

/** The bot's view of its own Runs (owner-scoped list). */
export interface BotRunView {
  id: string;
  status: RunStatus;
  constraints?: { botTask?: string };
}

export interface SchedulerClient {
  /**
   * List the bot's own Runs (owner-scoped server-side), one page. `nextCursor` feeds the next
   * call; the caller MUST walk to exhaustion — a long-lived non-terminal Run (a parked
   * NEEDS_INPUT) ages out of the first `created_at DESC` page, and singleFlight misses it.
   */
  listOwnRuns(limit?: number, cursor?: string | null): Promise<{ runs: BotRunView[]; nextCursor: string | null }>;
  /** POST /api/runs with the derived Idempotency-Key; replays return the original Run. */
  createRun(req: DispatchRequest): Promise<{ runId: string; replayed: boolean }>;
}

/** Non-terminal means NOT in the terminal deny-list: a future status is not in the list, so it blocks. */
export function runIsNonTerminal(status: RunStatus): boolean {
  return !isTerminal(status);
}

/**
 * Resolve the task template for a specific fire: `{{fire.date}}` / `{{fire.time}}` /
 * `{{fire.iso}}` placeholders in string values become the fire's wall clock in the task's zone,
 * and `notAfterAt: 'HH:MM'` (template-level helper) becomes `constraints.notAfter` on the fire's
 * date — the §5 nightly window that B0-3's deadline enforces.
 */
export function resolveTemplate(
  task: BotTaskConfig,
  tzParts: { date: string; time: string; iso: string },
): Record<string, unknown> {
  const template: Record<string, unknown> = { ...task.template };
  const substitute = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value
        .replace(/\{\{fire\.date\}\}/g, tzParts.date)
        .replace(/\{\{fire\.time\}\}/g, tzParts.time)
        .replace(/\{\{fire\.iso\}\}/g, tzParts.iso);
    }
    if (Array.isArray(value)) return value.map(substitute);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitute(v);
      return out;
    }
    return value;
  };
  const resolved = substitute(template) as Record<string, unknown>;
  const notAfterAt = resolved.notAfterAt;
  if (typeof notAfterAt === 'string') {
    delete resolved.notAfterAt;
    const m = /^([0-9]{2}):([0-9]{2})$/.exec(notAfterAt);
    if (!m) throw new Error(`notAfterAt must be 'HH:MM', got '${notAfterAt}'`);
    const constraints = { ...(resolved.constraints as Record<string, unknown> | undefined) };
    if (constraints.notAfter === undefined) {
      // The deadline is the fire's LOCAL wall clock (task tz) on the fire's date; resolve that
      // wall time back to an instant with the same zone rules cron.ts uses.
      const [y, mo, d] = tzParts.date.split('-').map(Number);
      const hh = Number(m[1]!);
      const mm = Number(m[2]!);
      const tz: CronTz = parseTz(task.tz);
      let notAfterMs: number;
      if (tz === 'UTC') {
        notAfterMs = Date.UTC(y!, mo! - 1, d!, hh, mm);
      } else if (tz === 'local') {
        notAfterMs = new Date(y!, mo! - 1, d!, hh, mm).getTime();
      } else {
        // Fixed offset: wall clock = UTC + offset, so instant = wall - offset.
        notAfterMs = Date.UTC(y!, mo! - 1, d!, hh, mm) - tz.offsetMinutes * 60_000;
      }
      constraints.notAfter = new Date(notAfterMs).toISOString();
    }
    resolved.constraints = constraints;
  }
  return resolved;
}

export interface TickOutcome {
  dispatched: { task: string; fireMs: number; runId: string; replayed: boolean }[];
  skippedSingleFlight: { task: string; fireMs: number }[];
  /** Missed fires dropped by `onMiss: 'skip'` — visible, not silent. */
  skippedMissed: { task: string; fireMs: number; reason: string }[];
  errors: { task: string; fireMs: number; message: string }[];
}

/**
 * One scheduler tick: decide and execute dispatches for every task due in
 * `(afterMs, nowMs]` (default: since the last tick).
 *
 * Per task fire, in order:
 *  1. `singleFlight` (default true): if a Run of this task (`constraints.botTask`) is in a
 *     non-terminal status, skip the fire entirely — §5.3's NEEDS_INPUT rule.
 *  2. `onMiss`: `skip` drops fires older than this tick's now; `collapse` dispatches ONLY the
 *     newest missed fire, keyed to ITS scheduled minute; `run` dispatches each missed fire
 *     (capped at maxCatchUp, default 3), each keyed to its own minute.
 */
export async function tick(
  cfg: BotConfig,
  client: SchedulerClient,
  opts: {
    nowMs: number;
    afterMs?: number;
  },
): Promise<TickOutcome> {
  const afterMs = opts.afterMs ?? opts.nowMs - 60_000;
  const outcome: TickOutcome = { dispatched: [], skippedSingleFlight: [], skippedMissed: [], errors: [] };
  // One list per tick, not per fire: the bot owns its Runs, so one page holds everything the
  // singleFlight check needs for every task.
  let listFailed: string | undefined;
  let countsCache: Map<string, number> | undefined;
  // Walk EVERY page of the owner-scoped list, not just the first: GET /api/runs is keyset-paged
  // `created_at DESC`, so a long-lived non-terminal Run (a parked NEEDS_INPUT) ages out of page
  // one and would stop blocking dispatches — exactly the stacking singleFlight exists to prevent.
  // The walk is bounded, and hitting the bound is treated like a failed list: refuse to dispatch
  // guarded tasks (fail-closed) rather than guess.
  const PAGE_LIMIT = 200;
  const MAX_PAGES = 20;
  const nonTerminalByTask = async (): Promise<Map<string, number> | null> => {
    if (listFailed) return null;
    if (countsCache) return countsCache;
    const map = new Map<string, number>();
    try {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await client.listOwnRuns(PAGE_LIMIT, cursor);
        for (const run of res.runs) {
          const taskName = run.constraints?.botTask;
          if (!taskName) continue;
          if (runIsNonTerminal(run.status)) map.set(taskName, (map.get(taskName) ?? 0) + 1);
        }
        cursor = res.nextCursor ?? null;
        if (!cursor) return (countsCache = map);
      }
    } catch (err) {
      // If we cannot see our own Runs we cannot honour singleFlight: refuse to dispatch that
      // task rather than risk stacking Runs on a parked one. The next tick retries. Tasks with
      // `singleFlight: false` do not need the list and still dispatch (§5.3: the check exists
      // for tasks that declared it).
      listFailed = `singleFlight list walk failed: ${(err as Error).message}`;
      return null;
    }
    // MAX_PAGES exhausted with more pages remaining: the run list is larger than the walk can
    // prove, so an old non-terminal Run might be hiding past the cap. Fail closed.
    listFailed = `singleFlight list walk hit the ${MAX_PAGES}-page cap; refusing to dispatch guarded tasks`;
    return null;
  };

  // Compute all due fires first (pure), then apply per-task policy.
  const dueFires: ScheduledFire[] = [];
  for (const task of cfg.tasks) {
    const tz: CronTz = parseTz(task.tz);
    const fires = due(task.cron, afterMs, opts.nowMs, tz);
    for (const fireMs of fires) {
      dueFires.push({ task, fireMs, wallMinute: scheduledWallMinuteId(fireMs, tz) });
    }
  }

  const pending = new Map<string, ScheduledFire[]>();
  for (const fire of dueFires) {
    const list = pending.get(fire.task.name) ?? [];
    list.push(fire);
    pending.set(fire.task.name, list);
  }

  for (const [taskName, fires] of pending) {
    const task = fires[0]!.task;
    // A fire older than one tick is MISSED (the host was down or busy at fire time); a fire in
    // the current minute is on-time. onMiss applies to missed fires only — the normal
    // single-fire tick dispatches regardless of policy (§5.3: onMiss is the "starts late" rule).
    const missed = fires.filter((f) => f.fireMs <= opts.nowMs - 60_000);
    const onTime = fires.filter((f) => f.fireMs > opts.nowMs - 60_000);
    let selected = [...onTime];
    let counts: Map<string, number> | null = null;
    if (missed.length > 0) {
      if (task.onMiss === 'skip') {
        for (const f of missed) outcome.skippedMissed.push({ task: taskName, fireMs: f.fireMs, reason: 'onMiss=skip' });
      } else if (task.onMiss === 'collapse') {
        // Fire ONCE, keyed to the MISSED fire's scheduled minute — keying to now would lose the
        // replay property for exactly the restart case the key exists for.
        selected.push(missed[missed.length - 1]!);
      } else {
        // 'run': once per missed interval, capped at maxCatchUp (default 3), newest wins the cap,
        // oldest first so a catch-up batch processes in schedule order.
        const cap = Math.max(0, task.maxCatchUp ?? 3);
        selected.push(...missed.slice(-cap));
      }
    }
    // Deterministic dispatch order: scheduled minute ascending.
    selected.sort((a, b) => a.fireMs - b.fireMs);
    for (const fire of selected) {
      if (task.singleFlight) {
        counts = await nonTerminalByTask();
        if (counts === null) {
          outcome.errors.push({ task: taskName, fireMs: fire.fireMs, message: listFailed ?? 'singleFlight unavailable' });
          continue;
        }
        if ((counts.get(taskName) ?? 0) > 0) {
          outcome.skippedSingleFlight.push({ task: taskName, fireMs: fire.fireMs });
          continue;
        }
      }
      const tzParts = {
        date: fire.wallMinute.slice(1, 11),
        time: fire.wallMinute.slice(12, 17),
        iso: fire.wallMinute,
      };
      let body: Record<string, unknown>;
      try {
        body = resolveTemplate(task, tzParts);
      } catch (err) {
        outcome.errors.push({ task: taskName, fireMs: fire.fireMs, message: (err as Error).message });
        continue;
      }
      const constraints = { ...((body.constraints as Record<string, unknown>) ?? {}) };
      // §4.3: the bot's attribution hint on every scheduled dispatch; the server keeps the real
      // owner attribution from the token.
      constraints.botTask = taskName;
      if (constraints.maxDurationMs === undefined) constraints.maxDurationMs = 3_600_000;
      if (constraints.maxRetries === undefined) constraints.maxRetries = 0;
      body.constraints = constraints;
      const key = dispatchKey(cfg.alias, taskName, fire.fireMs, parseTz(task.tz));
      try {
        const res = await client.createRun({ taskName, fireMs: fire.fireMs, wallMinute: fire.wallMinute, key, body });
        outcome.dispatched.push({ task: taskName, fireMs: fire.fireMs, runId: res.runId, replayed: res.replayed });
        // The dispatch itself is now a non-terminal Run of this task from this tick's point of
        // view: bump the local count so catch-up fire #2 skips without a re-list (the pinned
        // §5.3 interaction: with singleFlight on, `run` collapses to `collapse` in practice).
        if (task.singleFlight) {
          counts?.set(taskName, (counts?.get(taskName) ?? 0) + 1);
        }
      } catch (err) {
        outcome.errors.push({ task: taskName, fireMs: fire.fireMs, message: (err as Error).message });
      }
    }
  }
  return outcome;
}

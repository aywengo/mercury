// Derived idempotency keys for bot dispatches (docs/dispatcher-bot-design.md §5.2).
//
// The key is a pure function of (bot alias, task name, scheduled minute): a crash between dispatch
// and recording replays to the original Run, and a process restart derives the same key again.
// Nothing else may enter the derivation -- a key that varied by attempt count, wall-clock jitter
// or queue state would defeat the replay contract the whole design leans on.

import { wallClock, type CronTz } from './cron.ts';

/** The bot owner-id form is `bot-<alias>` (B0-1, docs/dispatcher-bot-design.md §4.2). */
export function botOwnerId(alias: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(alias)) {
    throw new Error(`bot alias must match ^[a-z][a-z0-9-]{0,31}$, got '${alias}'`);
  }
  return `bot-${alias}`;
}

/**
 * The scheduled fire minute as a WALL-CLOCK LABEL computed in `tz` — the same zone the cron was
 * evaluated in — formatted `w<YYYY>-<MM>-<DD>T<HH>:<MM>`.
 *
 * This (not the discovery wall-clock) is what the key carries, so a late or retried dispatch
 * for the same scheduled fire still derives the same key. Wall-clock rather than raw instant is
 * what makes the key DST-safe: on a fall-back day a `tz: local` schedule matches TWO distinct
 * instants with the SAME local wall-clock minute (the clock repeats), and both must derive the
 * same key — the server's replay then collapses them into one Run, which is exactly the
 * "fires exactly once" semantics §15.1 pins and the cross-window double-dispatch the reviewer
 * flagged needs. UTC and fixed-offset zones have no DST, so their wall minute is unique per
 * instant and the key keeps its instant-derived value.
 *
 * It is deliberately NOT an ISO timestamp: the fields come from the non-UTC wall clock for
 * `local` and fixed-offset zones, so no zone designator (`Z` or an offset) may be attached —
 * a `Z` would claim UTC, and an offset would differ across a DST boundary, re-splitting the two
 * fall-back instants into two keys. The leading `w` marks the string as a wall-clock label so
 * no future caller parses it as an instant. A label alone is ambiguous across zones, which is
 * fine: the key is never interpreted, only compared for equality.
 */
export function scheduledWallMinuteId(instantMs: number, tz: CronTz = 'UTC'): string {
  const w = wallClock(Math.floor(instantMs / 60_000) * 60_000, tz);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `w${w.year}-${pad(w.month)}-${pad(w.dayOfMonth)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** `bot-<alias>:<task-name>:<scheduled-fire-wall-minute>` (§5.2), wall-clock in `tz`. */
export function dispatchKey(alias: string, taskName: string, scheduledFireMs: number, tz: CronTz = 'UTC'): string {
  // The key is colon-delimited, so a colon inside a task name would make one key parse as two
  // different (alias, task, minute) triples. Task names are `[a-z0-9-]` per §12 — enforce it
  // here so the key format stays unambiguous at the point of derivation.
  if (!/^[a-z0-9-]+$/.test(taskName)) {
    throw new Error(`bot task name must match ^[a-z0-9-]+$, got '${taskName}'`);
  }
  return `${botOwnerId(alias)}:${taskName}:${scheduledWallMinuteId(scheduledFireMs, tz)}`;
}

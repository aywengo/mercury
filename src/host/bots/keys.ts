// Derived idempotency keys for bot dispatches (docs/dispatcher-bot-design.md §5.2).
//
// The key is a pure function of (bot alias, task name, scheduled minute): a crash between dispatch
// and recording replays to the original Run, and a process restart derives the same key again.
// Nothing else may enter the derivation -- a key that varied by attempt count, wall-clock jitter
// or queue state would defeat the replay contract the whole design leans on.

/** The bot owner-id form is `bot-<alias>` (B0-1, docs/dispatcher-bot-design.md §4.2). */
export function botOwnerId(alias: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(alias)) {
    throw new Error(`bot alias must match ^[a-z][a-z0-9-]{0,31}$, got '${alias}'`);
  }
  return `bot-${alias}`;
}

/**
 * The scheduled fire minute as an ISO-8601 UTC string, truncated to the minute.
 * This (not the discovery wall-clock) is what the key carries, so a late or retried dispatch
 * for the same scheduled fire still derives the same key.
 */
export function scheduledMinuteIso(instantMs: number): string {
  const minute = Math.floor(instantMs / 60_000) * 60_000;
  return new Date(minute).toISOString();
}

/** `bot-<alias>:<task-name>:<scheduled-fire-iso-minute>` (§5.2). */
export function dispatchKey(alias: string, taskName: string, scheduledFireMs: number): string {
  return `${botOwnerId(alias)}:${taskName}:${scheduledMinuteIso(scheduledFireMs)}`;
}

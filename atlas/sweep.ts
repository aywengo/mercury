/**
 * The periodic maintenance sweep.
 *
 * Atlas had three retention methods and no caller for any of them, so retired notes, stale candidates and
 * replay-guard rows all grew without bound while the code read as though a policy were in force. This is
 * the caller.
 *
 * What it does NOT do is delete notes. `NoteStore.deleteExpiredRetired()` was removed rather than wired:
 * it issued bare `DELETE`s, and a deletion produces no `seq` row, so a replica pulling by cursor would
 * never learn the note was gone. It would keep serving a note Atlas had destroyed, permanently, with no
 * event to reconcile against -- the exact divergence issue #555 was written about. Making deletion safe
 * needs a tombstone that carries a sequence number, which is a change to the replication protocol and not
 * something to slip into a retention fix. Atlas therefore retains retired notes indefinitely; the host
 * side prunes its own replica (MERCURY_KNOWLEDGE_RETIRED_RETENTION_MS), which is safe because the replica
 * is a cache that can be rebuilt from bootstrap.
 */

import type { NoteStore } from './notes.ts';
import type { AtlasConfig } from './config.ts';

export interface SweepLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface MaintenanceSweep {
  /** One pass, exposed so tests and an operator can drive it without waiting for the interval. */
  runOnce(): { retired: number; idempotencyKeys: number };
  stop(): void;
}

export function startMaintenanceSweep(deps: {
  store: NoteStore;
  config: AtlasConfig;
  log: SweepLogger;
}): MaintenanceSweep {
  const { store, config, log } = deps;

  const runPass = () => {
    // Retiring emits a seq row per note through transition(), so replicas see every one of these. That is
    // what makes this half of the retention design safe to run and the delete half not.
    const retired = store.retireStaleCandidates(config.staleCandidateAgeMs);
    // Idempotency keys are a replay guard with no replica counterpart, so dropping them is invisible in
    // the worst possible sense: nothing downstream can be wrong about it.
    const idempotencyKeys = store.deleteExpiredIdempotencyKeys(config.idempotencyRetentionMs);
    if (retired.length || idempotencyKeys) {
      log.info('atlas maintenance sweep', { retired: retired.length, idempotencyKeys });
    }
    return { retired: retired.length, idempotencyKeys };
  };

  // Guarded inside the pass rather than around the timer callback, so every caller is protected and not
  // just the interval. A throw inside a setInterval callback is an uncaught exception, not a failed tick:
  // it would take the process down and end every future sweep with it. An operator driving runOnce() by
  // hand deserves the same guarantee, and a guard placed only at the timer would silently not apply there.
  const runOnce = () => {
    try {
      return runPass();
    } catch (err) {
      log.error('atlas maintenance sweep failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return { retired: 0, idempotencyKeys: 0 };
    }
  };

  const timer = setInterval(runOnce, config.sweepIntervalMs);
  // The sweep must not be the reason a shutting-down process stays alive.
  timer.unref?.();

  return { runOnce, stop: () => clearInterval(timer) };
}

/**
 * The periodic maintenance sweep.
 *
 * Atlas had three retention methods and no caller for any of them, so retired notes, stale candidates and
 * replay-guard rows all grew without bound while the code read as though a policy were in force. This is
 * the caller.
 *
 * Deletion is here, and it is opt-in (#590). `deleteExpiredRetired()` used to be the thing that did this,
 * and it was removed rather than wired: it issued bare `DELETE`s, and a deletion produces no `seq` row, so
 * a replica pulling by cursor would never learn the note was gone -- it would keep serving a note Atlas had
 * destroyed, permanently, with no event to reconcile against. That is the divergence issue #555 was written
 * about. The `deleted` tier is what makes the same retention expressible safely: every removal goes through
 * `transition()`, so it carries a sequence number and every replica applies it like any other write.
 *
 * It stays OFF unless `ATLAS_RETIRED_TOMBSTONE_AGE_MS` is set. The replication fix and the retention policy
 * are two different decisions, and only the first one is settled.
 */

import type { NoteStore } from './notes.ts';
import type { AtlasConfig } from './config.ts';

export interface SweepLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface MaintenanceSweep {
  /** One pass, exposed so tests and an operator can drive it without waiting for the interval. */
  runOnce(): { retired: number; tombstoned: number; idempotencyKeys: number };
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
    // Zero means "never", and it is checked here rather than passed down: a store that tombstoned
    // everything older than epoch would erase the curated set on the first tick after a typo in the
    // environment file, and the operator would find out from a replica that had already caught up.
    const tombstone = config.retiredTombstoneAgeMs > 0
      ? store.tombstoneExpiredRetired(config.retiredTombstoneAgeMs)
      : { tombstoned: [], failed: [] };
    if (retired.length || tombstone.tombstoned.length || tombstone.failed.length || idempotencyKeys) {
      log.info('atlas maintenance sweep', {
        retired: retired.length, tombstoned: tombstone.tombstoned.length, idempotencyKeys,
        // Logged alongside the count, not instead of it: `tombstoned: 0` on its own reads as "nothing
        // was eligible", and a sweep that threw on every candidate would look identical to an idle
        // cycle. The first failure names the note so an operator has somewhere to start.
        ...(tombstone.failed.length
          ? { tombstoneFailures: tombstone.failed.length, firstFailure: tombstone.failed[0] }
          : {}),
      });
    }
    return { retired: retired.length, tombstoned: tombstone.tombstoned.length, idempotencyKeys };
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
        // The name survives because a bare message is not enough to tell an SQLITE_BUSY from an
        // assertion failure once it is one JSON line among thousands. Matches src/api/routes.ts and
        // atlas/server.ts.
        err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      return { retired: 0, tombstoned: 0, idempotencyKeys: 0 };
    }
  };

  const timer = setInterval(runOnce, config.sweepIntervalMs);
  // The sweep must not be the reason a shutting-down process stays alive.
  timer.unref?.();

  return { runOnce, stop: () => clearInterval(timer) };
}

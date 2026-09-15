/**
 * The puller: keeps the local replica current (docs/knowledge-base.md 8.3).
 *
 * It runs on its own timer for the same reason the pusher does, and the reason is worth restating
 * because it is the one thing about this design that is easy to get wrong: work that must continue
 * WHILE a Run executes cannot live in the claim loop, which is blocked inside `await execute(run)`
 * for the whole duration of a Run. A puller driven from there would go silent during exactly the
 * long Run that most needed fresh knowledge.
 */

import type { DatabaseSync } from 'node:sqlite';
import { bumpCounter, OutboxStore, SYNC_KEYS } from './outbox.ts';
import { ReplicaStore } from './replica.ts';
import type { AtlasClient } from './client.ts';
import type { Logger } from '../logger.ts';

export interface PullerDeps {
  db: DatabaseSync;
  client: AtlasClient;
  project: string;
  intervalMs: number;
  /** Notes per page. Atlas caps what it will return; paging continues until a short page. */
  pageSize: number;
  /**
   * How long to retain non-promoted rows before sweeping them (ms).
   * Read from MERCURY_KNOWLEDGE_RETIRED_RETENTION_MS; default 7 days.
   */
  retiredRetentionMs: number;
  log: Logger;
  now?: () => number;
}

export interface PullOutcome {
  /** True when the pull started from an empty cursor and took the bootstrap path (section 13). */
  bootstrapped: boolean;
  pages: number;
  applied: number;
  retired: number;
  /** Tombstones applied during this pull -- rows the feed told this replica to forget (#590). */
  deleted: number;
  /** Retired rows removed from the replica during this pull tick. */
  sweptRetired: number;
  cursor: number;
  failed: boolean;
  lastError: string | null;
}

export class KnowledgePuller {
  private readonly deps: PullerDeps;
  private readonly replica: ReplicaStore;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * A pull in flight. Without this a slow Atlas and a short interval would run two pulls
   * concurrently, and the second could commit an older page after the first committed a newer one --
   * the per-note guard would hold, but the cursor could still land on the lower of the two.
   */
  private running = false;

  constructor(deps: PullerDeps) {
    this.deps = deps;
    this.replica = new ReplicaStore(deps.db);
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    // unref so a process that only wants the API is not held open by a background timer.
    this.timer = setInterval(() => { void this.pullOnce(); }, this.deps.intervalMs);
    this.timer.unref?.();
    void this.pullOnce();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One full pull: bootstrap or page, then keep paging until Atlas returns a short page. */
  async pullOnce(): Promise<PullOutcome> {
    const { client, project, pageSize, log } = this.deps;
    const outcome: PullOutcome = {
      bootstrapped: false, pages: 0, applied: 0, retired: 0, deleted: 0, sweptRetired: 0,
      cursor: this.replica.getCursor(project) ?? 0, failed: false, lastError: null,
    };
    if (this.running) return outcome;
    this.running = true;
    try {
      let cursor = this.replica.getCursor(project);
      if (cursor === null) {
        // First start with Atlas configured: one round trip for the whole promoted set, rather than
        // paging from zero through every revision of every note this project has ever written.
        const page = await client.bootstrap(project);
        const applied = this.replica.applyBatch(project, page.notes, page.nextSeq, new Date(this.now()).toISOString());
        outcome.bootstrapped = true;
        outcome.pages = 1;
        outcome.applied = applied.applied;
        outcome.retired = applied.retired;
        outcome.deleted = applied.deleted;
        outcome.cursor = applied.cursor;
      } else {
        let since = cursor;
        for (;;) {
          const page = await client.pull(project, since, 'promoted', pageSize);
          const applied = this.replica.applyBatch(project, page.notes, page.nextSeq, new Date(this.now()).toISOString());
          outcome.pages += 1;
          outcome.applied += applied.applied;
          outcome.retired += applied.retired;
          outcome.deleted += applied.deleted;
          outcome.cursor = applied.cursor;
          // A short page is the end. Paging on nextSeq alone would loop forever on a project whose
          // seq advances faster than this tier does, since promotions consume sequence numbers
          // without producing promoted rows.
          if (page.notes.length < pageSize || page.nextSeq <= since) break;
          since = page.nextSeq;
        }
      }
      new OutboxStore(this.deps.db).setState(SYNC_KEYS.lastPullAt, new Date(this.now()).toISOString());
      // Sweep retired rows on the same tick as a successful pull. The retention window must be long
      // enough that the cursor has already advanced past any page that could carry an older revision
      // of the swept note; with the default 7-day window and 60-second pull interval this holds
      // with many orders of margin. See ReplicaStore.sweepRetired for the full safety argument.
      outcome.sweptRetired = this.replica.sweepRetired(this.deps.retiredRetentionMs, this.now);
      log.info({
        project, bootstrapped: outcome.bootstrapped, pages: outcome.pages,
        applied: outcome.applied, retired: outcome.retired, deleted: outcome.deleted,
        sweptRetired: outcome.sweptRetired, cursor: outcome.cursor,
      }, 'knowledge replica pulled');
      return outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome.failed = true;
      outcome.lastError = message;
      // A failed pull changes nothing: the cursor stays where it was, so the next tick re-reads the
      // same range. That is the whole reason the replica can be the source for Run creation -- an
      // outage costs freshness and cannot cost correctness.
      bumpCounter(new OutboxStore(this.deps.db), 'pull_failures_total');
      new OutboxStore(this.deps.db).setState(SYNC_KEYS.lastPullError, message);
      log.warn({ project, error: message, cursor: outcome.cursor }, 'knowledge pull failed; replica left at previous cursor');
      return outcome;
    } finally {
      this.running = false;
    }
  }
}

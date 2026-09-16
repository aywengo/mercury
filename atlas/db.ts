/**
 * Atlas's own SQLite database (docs/knowledge-base.md section 11.3).
 *
 * Same engine and same operational shape as the host and Fleet, and deliberately no new
 * infrastructure. The WAL handling in particular is copied in substance from `src/db/database.ts`
 * rather than re-derived, because the failure it prevents is invisible until it happens in
 * production: `PRAGMA busy_timeout` does NOT cover the rollback-journal-to-WAL conversion, which
 * SQLite refuses to wait for. N processes starting against a fresh file otherwise all attempt the
 * same exclusive-lock conversion and all but one die at startup with "database is locked".
 *
 * What this database is: the curated set of claims, their revision history, and the audit trail of
 * what Mercury believed and when (section 2.2). What it is NOT: the project's history, which is in
 * git and which Atlas holds no credential to read (K1).
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Migration {
  version: number;
  sql: string;
  /**
   * Optional JS check that runs before `sql`, inside the same transaction.
   *
   * Needed because a UNIQUE index cannot be added blindly to a table that may already violate it. The
   * failure mode without a precheck is `SQLITE_CONSTRAINT_UNIQUE` naming an index, which tells an operator
   * nothing about which rows to fix and leaves Atlas unable to start. The precheck names the rows instead.
   */
  precheck?: (db: DatabaseSync) => void;
}

export const BUSY_TIMEOUT_MS = 5_000;

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      -- The project registry. repo_identities_json is the set of normalized repository
      -- identities that belong to this project (section 5), and it is the cross-check that stops a
      -- misconfigured host from filing its knowledge into the wrong project.
      CREATE TABLE IF NOT EXISTS projects (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL,
        repo_identities_json  TEXT NOT NULL DEFAULT '[]',
        -- The promotion policy of section 12: {auto: {minRuns, minDistinctHarnessesOrHosts, kinds}}
        -- or null to require a human act for every promotion.
        promotion_policy_json TEXT,
        created_at            TEXT NOT NULL
      );

      -- Contributor tokens. The secret is NEVER stored, only its SHA-256: this file is backed up
      -- along with every note, and a plaintext token in a backup is a token that leaks twice.
      --
      -- host_id is bound here rather than taken from a request body, which is what stops one host
      -- from writing provenance attributed to another (section 11.4).
      CREATE TABLE IF NOT EXISTS contributors (
        token_hash      TEXT PRIMARY KEY,
        host_id         TEXT NOT NULL,
        project_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at      TEXT NOT NULL,
        last_seen_at    TEXT
      );

      -- The current state of each note. One row per note, updated in place; the history is
      -- note_revisions, and a revision row is never edited.
      CREATE TABLE IF NOT EXISTS notes (
        note_id          TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        current_revision INTEGER NOT NULL,
        tier             TEXT NOT NULL,
        kind             TEXT NOT NULL,
        scope            TEXT NOT NULL,
        -- SHA-256 of kind + scope + normalize(claim). The deduplication key: a contribution whose
        -- hash already exists in the project adds a source rather than a note.
        claim_hash       TEXT NOT NULL,
        -- Per-project monotonic, assigned under BEGIN IMMEDIATE. A cursor is only a complete
        -- description of "everything after me" if this never has a gap.
        seq              INTEGER NOT NULL,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );

      -- The replication feed is read as (project_id, seq); the replica's pack selection reads
      -- (project_id, tier, scope); dedup reads (project_id, claim_hash). All three are hot.
      CREATE INDEX IF NOT EXISTS idx_notes_project_seq ON notes(project_id, seq);
      CREATE INDEX IF NOT EXISTS idx_notes_project_tier_scope ON notes(project_id, tier, scope);
      CREATE INDEX IF NOT EXISTS idx_notes_project_claim ON notes(project_id, claim_hash);

      -- Immutable. Every revision, promotion, retirement and contest lands here, which is the audit
      -- trail an operator needs when a promoted note turns out to be wrong (section 2.2).
      CREATE TABLE IF NOT EXISTS note_revisions (
        note_id    TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
        revision   INTEGER NOT NULL,
        note_json  TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (note_id, revision)
      );

      -- Corroboration is COUNT(DISTINCT ...) over this table and nowhere else (K3). There is
      -- deliberately no corroboration column on notes: a cached count would be a second source of
      -- truth that can disagree with the rows it is supposed to summarize.
      CREATE TABLE IF NOT EXISTS note_sources (
        note_id         TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
        host_id         TEXT NOT NULL,
        run_id          TEXT NOT NULL,
        agent           TEXT,
        harness_version TEXT,
        source          TEXT NOT NULL,
        recorded_at     TEXT NOT NULL,
        -- The same Run on the same host contributing the same claim twice is one source. Without
        -- this, a finalize retried after a lost acknowledgement would inflate the number that
        -- section 12 promotes notes on.
        UNIQUE (note_id, host_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_note_sources_note ON note_sources(note_id);

      -- Who promoted or retired what, and why. reason is NOT NULL: a promotion without a reason
      -- is the placement-without-placementReason that crew/teams.md 7.1 refuses, for the same
      -- debugging-at-3am reason.
      CREATE TABLE IF NOT EXISTS promotions (
        note_id   TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
        from_tier TEXT NOT NULL,
        to_tier   TEXT NOT NULL,
        actor     TEXT NOT NULL,
        reason    TEXT NOT NULL,
        seq       INTEGER NOT NULL,
        at        TEXT NOT NULL
      );

      -- Declared conflicts only. Atlas has no model of meaning and detects nothing (section 12).
      CREATE TABLE IF NOT EXISTS contests (
        note_id              TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
        contradicts_note_id  TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
        actor                TEXT NOT NULL,
        seq                  INTEGER NOT NULL,
        at                   TEXT NOT NULL,
        UNIQUE (note_id, contradicts_note_id)
      );

      -- Scoped to the contributor, not global, for the reason the host's migration v3 gives: a
      -- globally unique key lets one caller who guesses another's token receive that caller's
      -- answer. Swept after a bounded retention (section 11.3).
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        contributor    TEXT NOT NULL,
        key            TEXT NOT NULL,
        response_json  TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        PRIMARY KEY (contributor, key)
      );

      -- The per-project sequence counter. Not in section 11.3's table list, and unavoidable: a
      -- promotion and a contest consume a seq without writing a notes row, so MAX(seq) over notes
      -- would hand a later write a seq that a promotion already used and silently create the gap a
      -- cursor cannot survive. One row per project, updated inside the same BEGIN IMMEDIATE.
      CREATE TABLE IF NOT EXISTS project_seq (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    // The one-live-note-per-claim rule (issue #551) was enforced only in application code: `contributeOne()`
    // refuses to insert beside a live note, and `transition()` refuses to revive a retired one beside a live
    // note. Two correct code paths are not a constraint -- a third writer would break the invariant silently.
    //
    // PARTIAL, excluding retired rows, because a retired note and a live note legitimately share a claim: that
    // is what "this claim was retired and later re-earned" looks like, and #551 depends on it.
    precheck: (db) => {
      const clashes = db.prepare(`
        SELECT project_id, claim_hash, COUNT(*) AS n, GROUP_CONCAT(note_id, ', ') AS note_ids
        FROM notes
        WHERE tier != 'retired'
        GROUP BY project_id, claim_hash
        HAVING COUNT(*) > 1
        ORDER BY project_id, claim_hash
        LIMIT 20`).all() as unknown as { project_id: string; claim_hash: string; n: number; note_ids: string }[];
      if (clashes.length === 0) return;
      // Named rows, not a constraint name. And deliberately NOT auto-resolved: section 12 says Atlas does not
      // pick a winner, so retiring all but the newest here would silently choose, which is the behaviour the
      // design forbids. The operator chooses; this only tells them where to look.
      const detail = clashes
        .map((c) => `    project ${c.project_id} claim_hash ${c.claim_hash}: ${c.n} live notes (${c.note_ids})`)
        .join('\n');
      const more = clashes.length === 20 ? '\n    ... (first 20 shown)' : '';
      throw new Error(
        `cannot add the live-claim uniqueness constraint: ${clashes.length} claim(s) already have more than `
        + `one live note.\n${detail}${more}\n`
        + '  Retire all but one note per claim (POST /v1/projects/:project/notes/:noteId/retire with a reason), '
        + 'then start Atlas again. Atlas will not choose which note survives.',
      );
    },
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS ux_notes_live_claim
        ON notes(project_id, claim_hash) WHERE tier != 'retired';
    `,
  },
  {
    version: 3,
    // #590: `deleted` is a terminal, sequence-bearing tier, and it is not a live tier either. The
    // live-claim index was built as `WHERE tier != 'retired'`, which would have made a tombstone hold
    // its claim hostage forever: delete a note today and nothing could ever again carry that claim,
    // because the tombstone would still count as the live holder. That is a worse failure than the one
    // deletion exists to fix -- it makes deletion permanent in a direction nobody asked for.
    //
    // No precheck, unlike v2. The new predicate excludes a strict superset of rows, so any database
    // that passed the v2 clash check satisfies this one; re-checking would only re-report clashes that
    // this change resolves by construction.
    sql: `
      DROP INDEX IF EXISTS ux_notes_live_claim;
      CREATE UNIQUE INDEX ux_notes_live_claim
        ON notes(project_id, claim_hash) WHERE tier NOT IN ('retired', 'deleted');
    `,
  },
];

export { MIGRATIONS };

/** Synchronous pause, used only for startup contention before any connection is serving traffic. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True for the two "someone else holds the lock" results; the primary code is the low byte. */
function isBusy(err: unknown): boolean {
  const code = (err as { errcode?: number })?.errcode;
  if (typeof code !== 'number') return false;
  const primary = code & 0xff;
  return primary === 5 /* SQLITE_BUSY */ || primary === 6 /* SQLITE_LOCKED */;
}

/**
 * Put the database in WAL mode, retrying the one case SQLite refuses to wait for.
 *
 * Copied from the host because the reasoning is not obvious and the failure is a startup crash
 * under exactly the concurrency a real deployment has. See the longer comment in
 * `src/db/database.ts`.
 */
function enableWal(db: DatabaseSync): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      return;
    } catch (err) {
      if (!isBusy(err) || Date.now() >= deadline) throw err;
      sleepSync(10);
    }
  }
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:' && path !== '') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  enableWal(db);
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  // Fast path first: an up-to-date database takes no write lock. Without this, every process that
  // opens the file contends for the exclusive lock on a schema that is already current.
  if (pending(db).length === 0) return;
  // The slow path re-reads under the lock, so a process that LOST the startup race observes the
  // winner's work instead of replaying DDL that already ran. Replaying is not a no-op: the DDL
  // collides, and the loser would die at startup.
  tx(db, () => {
    for (const version of pending(db)) {
      const migration = MIGRATIONS.find((m) => m.version === version);
      if (!migration) throw new Error(`migration ${version} is missing from the MIGRATIONS array`);
      migration.precheck?.(db);
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, new Date().toISOString());
    }
  });
}

function pending(db: DatabaseSync): number[] {
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  return MIGRATIONS.map((m) => m.version).filter((v) => !applied.has(v));
}

/** Run `fn` inside BEGIN IMMEDIATE, rolling back on any throw. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* the rollback is best-effort; the original error wins */ }
    throw err;
  }
}

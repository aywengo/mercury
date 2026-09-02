/**
 * Fleet's own SQLite database. Same engine and same operational shape as Mercury, deliberately no new
 * infrastructure (docs/fleet-design.md section 5).
 *
 * The schema is split by what a crash costs, and that split is structural rather than a comment
 * convention:
 *
 *   TRUTH  -- hosts. Losing it means Fleet does not know what it may talk to.
 *   CACHE  -- host_probe. Rebuildable in one sweep, so it is never worth backing up.
 *
 * Phase 0 has no dispatch, so fleet_runs/run_state (the other truth table, and the one the design says
 * must be backed up as seriously as a Mercury database) arrive with Phase 1.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS hosts (
        id             TEXT PRIMARY KEY,
        base_url       TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        enabled        INTEGER NOT NULL DEFAULT 1,
        labels         TEXT NOT NULL DEFAULT '{}',
        local_paths    TEXT NOT NULL DEFAULT '[]',
        agents_cache   TEXT NOT NULL DEFAULT '[]',
        added_at       TEXT NOT NULL,
        last_seen_at   TEXT
      );

      -- Probe results are a cache, so they live in their own table rather than as extra columns on
      -- hosts. That keeps the truth/cache line visible in the schema: deleting this table is always
      -- safe and costs one sweep, while deleting hosts is not.
      CREATE TABLE IF NOT EXISTS host_probe (
        host_id        TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
        -- One of: ok | unreachable | unauthorized | not_mercury | not_serving | http_error | timeout.
        -- Distinct values on purpose: "down" would collapse failures that need different fixes.
        outcome        TEXT NOT NULL,
        detail         TEXT,
        -- Live capacity, present only on a successful probe.
        active_runs    INTEGER,
        queue_depth    INTEGER,
        worker_count   INTEGER,
        worker_id      TEXT,
        agents         TEXT,
        probed_at      TEXT NOT NULL,
        last_error     TEXT
      );
    `,
  },
];

export interface FleetDb {
  db: DatabaseSync;
  appliedVersions: number[];
}

/** Open Fleet's database and apply any pending migrations. */
export function openFleetDb(path: string): FleetDb {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(path);
  // Fleet may probe hosts from a timer while a CLI command reads, so readers must not block on the writer.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS fleet_meta (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');

  const done = new Set(
    (db.prepare('SELECT version FROM fleet_meta').all() as Array<{ version: number }>).map((r) => r.version),
  );
  const applied: number[] = [];
  const insert = db.prepare('INSERT INTO fleet_meta (version, applied_at) VALUES (?, ?)');
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    // One transaction per migration: a half-applied migration is worse than none, because the version row
    // would claim the schema exists when only part of it does.
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      insert.run(m.version, new Date().toISOString());
      db.exec('COMMIT');
      applied.push(m.version);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`fleet migration ${m.version} failed: ${(err as Error).message}`);
    }
  }
  return { db, appliedVersions: applied };
}

// Schema verification: `schema_migrations` records which MIGRATIONS entry ran, and until now nothing
// checked that the objects those entries create still exist.
//
// That gap is not theoretical (#1032). A database whose `schema_migrations` says "21 applied" while
// `run_workflows` (v14) and `runs.status_changed_at` (v18) were absent accepted every migration as
// current, so `migrate()` returned immediately and `mercury migrate` printed "migrations applied".
// The gap surfaced only when a restarted process reached the first code path that touched the missing
// object -- `RunStore.insert` -- and then every Run creation returned 500. A count of versions cannot
// see that; a comparison of the actual schema can.
//
// The expected schema is built by migrating a fresh in-memory database with the same MIGRATIONS list,
// so there is no second copy of the schema to drift from the migrations themselves.

import { DatabaseSync } from 'node:sqlite';
import { migrate } from './database.ts';

/** One object that the migrations create and the live database does not have. */
export interface SchemaDrift {
  /** What is missing. `column` entries carry `table.column` in `name`. */
  kind: 'table' | 'column' | 'index' | 'trigger' | 'view';
  /** Dotted name: `run_workflows`, `runs.status_changed_at`, `idx_run_workflows_identity`. */
  name: string;
}

/** An object the live database has and the migrations do not create. Reported, never fatal: an
 *  extra nullable column left behind by a removed feature cannot break an insert, and refusing to
 *  start over one would be a worse failure than the drift it reports. */
export type SchemaExtra = SchemaDrift;

interface Snapshot {
  tables: Map<string, string[]>;
  others: Array<{ kind: 'index' | 'trigger' | 'view'; name: string }>;
}

const OBJECT_QUERY =
  "SELECT type, name FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND name NOT LIKE 'sqlite_%'";

function snapshot(db: DatabaseSync): Snapshot {
  const tables = new Map<string, string[]>();
  const others: Snapshot['others'] = [];
  for (const row of db.prepare(OBJECT_QUERY).all() as Array<{ type: string; name: string }>) {
    if (row.type === 'table') {
      const columns = (db.prepare(`PRAGMA table_info("${row.name.replace(/"/g, '""')}")`).all() as Array<{ name: string }>)
        .map((c) => c.name);
      tables.set(row.name, columns);
    } else {
      others.push({ kind: row.type as 'index' | 'trigger' | 'view', name: row.name });
    }
  }
  return { tables, others };
}

/** The schema a database built from scratch by this build has. */
export function expectedSchema(): Snapshot {
  const db = new DatabaseSync(':memory:');
  try {
    // The real entry point, not a replayed list: whatever `migrate` creates (including
    // `schema_migrations` itself) is part of the schema a current database has.
    migrate(db);
    return snapshot(db);
  } finally {
    db.close();
  }
}

/**
 * Compare a live database against the schema its recorded migrations should have produced.
 *
 * `missing` is the failure list: every object the migrations create and the database does not have.
 * `extra` is informational (see SchemaExtra).
 */
export function verifySchema(db: DatabaseSync): { missing: SchemaDrift[]; extra: SchemaExtra[] } {
  const want = expectedSchema();
  const have = snapshot(db);

  const missing: SchemaDrift[] = [];
  for (const [table, columns] of want.tables) {
    const liveColumns = have.tables.get(table);
    if (liveColumns === undefined) {
      missing.push({ kind: 'table', name: table });
      continue;
    }
    for (const column of columns) {
      if (!liveColumns.includes(column)) missing.push({ kind: 'column', name: `${table}.${column}` });
    }
  }
  for (const object of want.others) {
    if (!have.others.some((o) => o.kind === object.kind && o.name === object.name)) {
      missing.push({ kind: object.kind, name: object.name });
    }
  }

  const extra: SchemaExtra[] = [];
  for (const [table, columns] of have.tables) {
    const wantColumns = want.tables.get(table);
    if (wantColumns === undefined) {
      extra.push({ kind: 'table', name: table });
      continue;
    }
    for (const column of columns) {
      if (!wantColumns.includes(column)) extra.push({ kind: 'column', name: `${table}.${column}` });
    }
  }
  for (const object of have.others) {
    if (!want.others.some((o) => o.kind === object.kind && o.name === object.name)) {
      extra.push({ kind: object.kind, name: object.name });
    }
  }

  return { missing, extra };
}

/** One line per drift entry, for a CLI or a log. */
export function describeDrift(drift: SchemaDrift[]): string {
  return drift.map((d) => `${d.kind} ${d.name}`).join(', ');
}

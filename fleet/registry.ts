/**
 * The host registry: Fleet's only piece of truth about what it may talk to.
 *
 * Phase 0 scope from docs/fleet-design.md section 12 is registry plus probe, with no dispatch. Routing
 * does not exist yet, so nothing here decides where a Run goes.
 */

import type { DatabaseSync } from 'node:sqlite';

export type ProbeOutcome =
  | 'ok'
  | 'unreachable'
  | 'unauthorized'
  | 'not_mercury'
  | 'not_serving'
  | 'http_error'
  | 'timeout';

export interface HostRecord {
  id: string;
  baseUrl: string;
  credentialRef: string;
  enabled: boolean;
  labels: Record<string, string>;
  localPaths: string[];
  /** Advisory only (design section 5): refreshed by probe, never the basis of a decision. */
  agentsCache: string[];
  addedAt: string;
  lastSeenAt: string | null;
}

export interface ProbeRecord {
  hostId: string;
  outcome: ProbeOutcome;
  detail: string | null;
  activeRuns: number | null;
  queueDepth: number | null;
  workerCount: number | null;
  workerId: string | null;
  agents: string[] | null;
  probedAt: string;
  lastError: string | null;
}

export interface HostView extends HostRecord {
  probe: ProbeRecord | null;
}

export class RegistryError extends Error {}

/** Operator-assigned and stable: it appears in output and becomes part of every future binding. */
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

/**
 * Validate a base URL.
 *
 * Credentials embedded in the URL are rejected outright. Allowing https://user:token@host would store the
 * secret in the hosts table, which is exactly what credential_ref exists to prevent -- and the table is not
 * written to with 0600 the way the credential file is.
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RegistryError(`base url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RegistryError(`base url must be http or https, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new RegistryError(
      'base url must not embed credentials. Put the token in the credential file and pass its name ' +
        'with --credential; a URL secret lands in the database, where the file has 0600 and the table does not.',
    );
  }
  if (url.search || url.hash) {
    throw new RegistryError('base url must not carry a query or fragment');
  }
  // Strip a trailing slash so callers can append paths without producing //api/agents.
  return url.href.replace(/\/+$/, '');
}

function validateId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new RegistryError(
      `host id ${JSON.stringify(id)} is not usable. Use a stable slug of lowercase letters, digits, ` +
        `dot, dash and underscore, e.g. "mac-studio" or "box-lan-2".`,
    );
  }
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt row must not make the whole registry unreadable; fall back and let the next probe rewrite it.
    return fallback;
  }
}

interface HostRow {
  id: string;
  base_url: string;
  credential_ref: string;
  enabled: number;
  labels: string;
  local_paths: string;
  agents_cache: string;
  added_at: string;
  last_seen_at: string | null;
}

/** Column shapes, written out rather than derived from the domain types: the database speaks snake_case
 * and the API speaks camelCase, and conflating the two is how a mapping bug becomes a type error that
 * nobody sees because the type was derived from the wrong side. */
interface ProbeRow {
  host_id: string;
  outcome: string;
  detail: string | null;
  active_runs: number | null;
  queue_depth: number | null;
  worker_count: number | null;
  worker_id: string | null;
  agents: string | null;
  probed_at: string;
  last_error: string | null;
}

function rowToHost(row: HostRow): HostRecord {
  return {
    id: row.id,
    baseUrl: row.base_url,
    credentialRef: row.credential_ref,
    enabled: row.enabled === 1,
    labels: parseJson<Record<string, string>>(row.labels, {}),
    localPaths: parseJson<string[]>(row.local_paths, []),
    agentsCache: parseJson<string[]>(row.agents_cache, []),
    addedAt: row.added_at,
    lastSeenAt: row.last_seen_at,
  };
}

function rowToProbe(row: ProbeRow): ProbeRecord {
  return {
    hostId: row.host_id,
    outcome: row.outcome as ProbeOutcome,
    detail: row.detail,
    activeRuns: row.active_runs,
    queueDepth: row.queue_depth,
    workerCount: row.worker_count,
    workerId: row.worker_id,
    agents: row.agents === null ? null : parseJson<string[]>(row.agents, null as unknown as string[]),
    probedAt: row.probed_at,
    lastError: row.last_error,
  };
}

export interface AddHostInput {
  id: string;
  baseUrl: string;
  credentialRef: string;
  labels?: Record<string, string>;
  localPaths?: string[];
  enabled?: boolean;
}

export class HostRegistry {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(input: AddHostInput): HostRecord {
    validateId(input.id);
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (!input.credentialRef || !input.credentialRef.trim()) {
      throw new RegistryError('credential_ref is required; pass the NAME of a credential, not the secret');
    }
    for (const p of input.localPaths ?? []) {
      if (!p.startsWith('/')) {
        throw new RegistryError(
          `local path ${JSON.stringify(p)} is not absolute. These paths are declared as they exist on the ` +
            `WORKER, so a relative path has no meaning to resolve against.`,
        );
      }
    }
    const exists = this.db.prepare('SELECT 1 FROM hosts WHERE id = ?').get(input.id);
    if (exists) {
      throw new RegistryError(
        `host ${input.id} already exists. Ids are stable and operator-assigned; remove it first if you ` +
          `really mean to replace it, because a binding refers to it by id.`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO hosts (id, base_url, credential_ref, enabled, labels, local_paths, agents_cache, added_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?)`,
      )
      .run(
        input.id,
        baseUrl,
        input.credentialRef.trim(),
        input.enabled === false ? 0 : 1,
        JSON.stringify(input.labels ?? {}),
        JSON.stringify(input.localPaths ?? []),
        new Date().toISOString(),
      );
    return this.get(input.id)!;
  }

  get(id: string): HostRecord | null {
    const row = this.db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
    return row ? rowToHost(row) : null;
  }

  list(): HostRecord[] {
    const rows = this.db.prepare('SELECT * FROM hosts ORDER BY id').all() as unknown as HostRow[];
    return rows.map(rowToHost);
  }

  /** Registry plus the cached probe snapshot. This is what `fleet hosts list` renders. */
  listWithProbe(): HostView[] {
    return this.list().map((host) => ({ ...host, probe: this.probeFor(host.id) }));
  }

  probeFor(id: string): ProbeRecord | null {
    const row = this.db.prepare('SELECT * FROM host_probe WHERE host_id = ?').get(id) as ProbeRow | undefined;
    return row ? rowToProbe(row) : null;
  }

  setEnabled(id: string, enabled: boolean): HostRecord {
    const res = this.db.prepare('UPDATE hosts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    if (Number(res.changes) === 0) throw new RegistryError(`no such host: ${id}`);
    return this.get(id)!;
  }

  /**
   * Forget a host and its cached probe.
   *
   * Refused while the host still owns Runs. `host_probe` cascades because it is cache and a cache row for a
   * host that no longer exists describes nothing. `fleet_runs` must NOT cascade: deleting it would orphan
   * Runs that are executing right now, on a machine Fleet can no longer name. The caller has to deal with
   * those Runs first, or accept the loss explicitly.
   */
  remove(id: string, opts: { force?: boolean } = {}): boolean {
    if (!opts.force) {
      const owned = this.db
        .prepare('SELECT COUNT(*) AS n, SUM(child_run_id IS NULL) AS unresolved FROM fleet_runs WHERE host_id = ?')
        .get(id) as { n: number; unresolved: number | null };
      const count = Number(owned.n);
      if (count > 0) {
        const unresolved = Number(owned.unresolved ?? 0);
        throw new RegistryError(
          `host ${id} still owns ${count} Fleet Run(s)${unresolved ? `, ${unresolved} of them with no ` +
          `recorded child answer` : ''}. Removing it would delete the only record of those Runs and leave ` +
          `them running on a machine Fleet cannot name. Let them finish, or pass force to accept the loss.`,
        );
      }
    } else {
      // Explicit force: drop the bindings first so the FK does not reject the host row, and say nothing
      // here -- the caller asked for this and the route records it.
      this.db.prepare('DELETE FROM fleet_runs WHERE host_id = ?').run(id);
    }
    const res = this.db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  /**
   * Record a probe. The cache row is always written, including for failures, because "we tried and it
   * refused" is information the operator needs; last_seen_at moves only on success, because it answers
   * "when did we last know this host was alive", and a 401 does not establish that.
   */
  recordProbe(rec: ProbeRecord): void {
    const host = this.get(rec.hostId);
    if (!host) throw new RegistryError(`cannot record probe for unknown host ${rec.hostId}`);
    this.db
      .prepare(
        `INSERT INTO host_probe
           (host_id, outcome, detail, active_runs, queue_depth, worker_count, worker_id, agents, probed_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(host_id) DO UPDATE SET
           outcome = excluded.outcome, detail = excluded.detail,
           active_runs = excluded.active_runs, queue_depth = excluded.queue_depth,
           worker_count = excluded.worker_count, worker_id = excluded.worker_id,
           agents = excluded.agents, probed_at = excluded.probed_at, last_error = excluded.last_error`,
      )
      .run(
        rec.hostId,
        rec.outcome,
        rec.detail,
        rec.activeRuns,
        rec.queueDepth,
        rec.workerCount,
        rec.workerId,
        rec.agents === null ? null : JSON.stringify(rec.agents),
        rec.probedAt,
        rec.lastError,
      );
    if (rec.outcome === 'ok') {
      this.db
        .prepare('UPDATE hosts SET last_seen_at = ?, agents_cache = ? WHERE id = ?')
        .run(rec.probedAt, JSON.stringify(rec.agents ?? []), rec.hostId);
    } else if (rec.agents !== null) {
      // A reachable host that failed a deeper check still told us something about its agents; keep the
      // advisory cache honest without claiming the host was seen healthy.
      this.db.prepare('UPDATE hosts SET agents_cache = ? WHERE id = ?').run(JSON.stringify(rec.agents), rec.hostId);
    }
  }

  /** Drop cached probe rows for hosts that no longer exist. Cheap hygiene after an interrupted delete. */
  pruneProbeCache(): number {
    const res = this.db
      .prepare('DELETE FROM host_probe WHERE host_id NOT IN (SELECT id FROM hosts)')
      .run();
    return Number(res.changes);
  }
}

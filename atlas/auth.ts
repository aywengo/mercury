/**
 * Caller authentication and the two token classes (docs/knowledge-base.md section 11.4).
 *
 * Two classes, as Fleet has, and for the same reason: a host that can contribute must not be able to
 * promote, and the token an operator uses to promote must never be present on a host. A reader class
 * exists so Fleet dashboards and operators who should see but not write get a token that cannot
 * accidentally become a write.
 *
 * The direction of trust is one way. Hosts trust Atlas with claims; Atlas trusts nothing with
 * anything -- it holds no credential for any host, repository or harness, and no route proxies to a
 * host.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { AtlasConfig } from './config.ts';

export type Caller =
  | { class: 'admin' }
  /** `hostId` comes from the TOKEN BINDING, never from a request body. That is what stops one host
   *  writing provenance attributed to another; a body that disagrees is a visible rejection
   *  (`host-mismatch`), not something to silently correct. */
  | { class: 'contributor'; hostId: string; projects: string[] }
  | { class: 'reader'; label: string; projects: string[] };

/** Contributor tokens are stored as hashes, so a backup of the database is not a backup of secrets. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compare two equal-length secrets without leaking position through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, and the length of a hashed token is fixed, so the
 * hash is the thing being compared and the throw is unreachable for well-formed input. It is guarded
 * anyway: a comparison helper that can throw on attacker-controlled input is a way to turn an
 * authentication check into a 500.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AuthIndex {
  private readonly db: DatabaseSync;
  private readonly adminToken: string | null;
  private readonly readers: { token: string; label: string; projects: string[] }[];
  /** The plaintext token values, for seeding the log redactor only. Never printed. */
  private readonly values: string[];

  constructor(db: DatabaseSync, config: AtlasConfig) {
    this.db = db;
    this.adminToken = config.adminToken;
    this.readers = config.readerTokens;
    this.values = [config.adminToken, ...config.readerTokens.map((r) => r.token)].filter((t): t is string => Boolean(t));
  }

  /** Resolve a bearer token to a caller, or null for "matches nothing". */
  resolve(token: string | undefined): Caller | null {
    if (!token) return null;
    if (this.adminToken && safeEqual(token, this.adminToken)) return { class: 'admin' };
    for (const reader of this.readers) {
      if (safeEqual(token, reader.token)) return { class: 'reader', label: reader.label, projects: [...reader.projects] };
    }
    const row = this.db.prepare('SELECT host_id, project_ids_json FROM contributors WHERE token_hash = ?')
      .get(hashToken(token)) as { host_id: string; project_ids_json: string } | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE contributors SET last_seen_at = ? WHERE token_hash = ?')
      .run(new Date().toISOString(), hashToken(token));
    return {
      class: 'contributor',
      hostId: row.host_id,
      projects: JSON.parse(row.project_ids_json) as string[],
    };
  }

  /** True when `caller` may act on `projectId`. Callers answer 404, not 403, when it is false. */
  mayAccess(caller: Caller, projectId: string): boolean {
    if (caller.class === 'admin') return true;
    return caller.projects.includes(projectId);
  }

  /** Token values, for the redactor. A token in a log line is the credential that reaches a host. */
  secrets(): string[] {
    return [...this.values];
  }
}

export interface ContributorSeed {
  hostId: string;
  projects: string[];
}

/**
 * Seed the contributor registry from `ATLAS_CONTRIBUTORS_FILE`.
 *
 * The file form exists so a token can be rotated without a database edit: the operator rewrites a
 * `0600` file and restarts, rather than running SQL against a live store. Seeding is idempotent and
 * additive -- an existing `host_id` for the same token is updated, and tokens absent from the file
 * are LEFT ALONE, because a file that lists only the new token would otherwise silently revoke every
 * host that is not mentioned in it. Revocation is `atlas contributor remove`, an explicit act.
 *
 * Returns the plaintext token values so the caller can seed the log redactor with them.
 */
export function seedContributors(db: DatabaseSync, file: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    // A missing file is the default state, not an error: the registry can be built entirely through
    // `atlas contributor add`. An unreadable file that DOES exist is different, and says so.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`cannot read contributor file ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`contributor file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`contributor file ${file} must be a JSON object mapping token to {hostId, projects}`);
  }
  const tokens: string[] = [];
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO contributors (token_hash, host_id, project_ids_json, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(token_hash) DO UPDATE SET host_id = excluded.host_id, project_ids_json = excluded.project_ids_json`);
  for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = value as Partial<ContributorSeed> | null;
    const hostId = typeof entry?.hostId === 'string' ? entry.hostId.trim() : '';
    const projects = Array.isArray(entry?.projects) ? entry!.projects!.filter((p): p is string => typeof p === 'string' && p !== '') : [];
    // A contributor bound to no project can authenticate and do nothing. That is a safer default than
    // a wildcard, but it is almost certainly a typo in the file, so it is refused loudly at startup
    // rather than discovered by an operator whose host is silently contributing nothing.
    if (!hostId || projects.length === 0) {
      throw new Error(`contributor file ${file}: a token is missing hostId or an empty projects list`);
    }
    stmt.run(hashToken(token), hostId, JSON.stringify(projects), now);
    tokens.push(token);
  }
  return tokens;
}

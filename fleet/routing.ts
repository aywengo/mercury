/**
 * Routing (docs/fleet-design.md section 6).
 *
 * A pure function over declared facts. It is pure deliberately: a router tested only by "a Run got placed"
 * cannot tell a working filter from an inert one, because both place the Run. Every exclusion here is returned
 * as data, so a test can assert not just that a host was chosen but that the WRONG hosts were rejected and
 * for the stated reason.
 */

import { readFileSync } from 'node:fs';
import type { HostView } from './registry.ts';

export interface RouteRepository {
  url?: string;
  localPath?: string;
  ref?: string;
}

export interface RouteRequest {
  /** Explicit placement. When present it wins and no scoring happens. */
  host?: string;
  agent?: string;
  /** Selector: a host must carry every pair listed. */
  labels?: Record<string, string>;
  repository?: RouteRepository;
}

export interface Exclusion {
  hostId: string;
  reason: string;
}

export interface RouteDecision {
  hostId: string;
  score: number;
  /** True when a localPath was replaced by a clone URL, which is what removed the locality constraint. */
  rewroteLocalPath: boolean;
  /** The repository payload to send the child, after any rewrite. */
  repository: RouteRepository | undefined;
  considered: string[];
}

export class RoutingError extends Error {
  readonly status: number;
  readonly exclusions: Exclusion[];
  constructor(message: string, status: number, exclusions: Exclusion[]) {
    super(message);
    this.name = 'RoutingError';
    this.status = status;
    this.exclusions = exclusions;
  }
}

export interface RouterOptions {
  /**
   * Resolve a declared local path to a host-independent clone URL. Returning null means "no known URL", and
   * then locality stays a hard constraint. Injected so the policy (a file, a label, a lookup) is separable
   * from the filter that depends on it.
   */
  resolveCloneUrl?: (localPath: string) => string | null;
}

/**
 * Normalise a path for comparison without touching the filesystem.
 *
 * Fleet cannot see a child's disk (section 4.2), so this is string work on declared values only -- it must not
 * resolve symlinks or stat anything, because the path exists on another machine.
 */
function normalizePath(p: string): string {
  const trimmed = p.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
  return trimmed;
}

function declaresPath(host: HostView, localPath: string): boolean {
  const want = normalizePath(localPath);
  return host.localPaths.some((declared) => {
    const have = normalizePath(declared);
    // A declared path covers itself and anything beneath it: declaring a repo root is the common case and
    // requiring operators to list every subdirectory would push them toward declaring '/' instead.
    return have === want || want.startsWith(`${have}/`);
  });
}

/**
 * Score a host for preference. Lower is better.
 *
 * Only reached when several hosts survive the hard filters, and it can never override one: capacity is a
 * preference, locality is a constraint. A null capacity means the host has not been probed recently, which is
 * treated as neutral rather than free -- an unprobed host must not look like the emptiest machine in the fleet.
 */
function score(host: HostView): number {
  const p = host.probe;
  if (!p || p.outcome !== 'ok') return 1_000;
  const active = p.activeRuns ?? 0;
  const queued = p.queueDepth ?? 0;
  const workers = p.workerCount ?? 1;
  // One unit of headroom per worker keeps a big machine from being penalised for its capacity.
  const headroom = Math.max(0, active + queued - workers);
  return active * 2 + queued + headroom;
}

function bad(field: string, value: unknown): never {
  throw new RoutingError(`${field} must be ${'a non-empty string'}, got ${JSON.stringify(value) ?? typeof value}`, 400, []);
}

function validateRequest(request: RouteRequest): void {
  if (request.host !== undefined && (typeof request.host !== 'string' || !request.host)) bad('host', request.host);
  if (request.agent !== undefined && (typeof request.agent !== 'string' || !request.agent)) bad('agent', request.agent);
  if (request.repository !== undefined) {
    if (typeof request.repository !== 'object' || request.repository === null || Array.isArray(request.repository)) {
      bad('repository', request.repository);
    }
    for (const key of ['url', 'localPath', 'ref'] as const) {
      const v = request.repository[key];
      if (v !== undefined && (typeof v !== 'string' || !v)) bad(`repository.${key}`, v);
    }
  }
  if (request.labels !== undefined) {
    if (typeof request.labels !== 'object' || request.labels === null || Array.isArray(request.labels)) {
      bad('labels', request.labels);
    }
    for (const [k, v] of Object.entries(request.labels)) {
      if (typeof v !== 'string') bad(`labels.${k}`, v);
    }
  }
}

export function routeRun(
  hosts: HostView[],
  request: RouteRequest,
  opts: RouterOptions = {},
): RouteDecision {
  // Types are checked here rather than trusted. A body like {"repository":{"localPath":123}} would otherwise
  // reach a .replace() on a number and surface as a 500 -- sending the operator to the service logs for what
  // is a mistake in their own request.
  validateRequest(request);

  const considered = hosts.map((h) => h.id);
  const exclusions: Exclusion[] = [];

  if (hosts.length === 0) {
    throw new RoutingError('no hosts are registered with Fleet', 400, []);
  }

  // Explicit placement first: an operator who names a host has already made the decision.
  if (request.host) {
    const chosen = hosts.find((h) => h.id === request.host);
    if (!chosen) {
      throw new RoutingError(
        `host ${JSON.stringify(request.host)} is not registered. Known hosts: ${considered.join(', ') || '(none)'}`,
        404, [],
      );
    }
    if (!chosen.enabled) {
      throw new RoutingError(`host ${chosen.id} is disabled`, 409, [{ hostId: chosen.id, reason: 'disabled' }]);
    }
    // The rewrite still applies. Naming a host removes locality as a FILTER, but a localPath handed to a child
    // that does not have it still fails there -- and it fails as a Run failure rather than as a routing
    // decision, which is the worse place to learn it.
    const explicitUrl = !request.repository?.url && request.repository?.localPath
      ? opts.resolveCloneUrl?.(normalizePath(request.repository.localPath)) ?? null
      : null;
    return {
      hostId: chosen.id,
      score: 0,
      rewroteLocalPath: explicitUrl !== null,
      repository: explicitUrl ? { ...request.repository, url: explicitUrl, localPath: undefined } : request.repository,
      considered,
    };
  }

  const repo = request.repository;
  const localPath = repo?.localPath;
  // A caller who supplies a clone URL has already removed the constraint themselves; the design calls the
  // rewrite the most valuable thing in this section precisely because it turns the hardest rule into a non-issue.
  const rewritten = !repo?.url && localPath ? opts.resolveCloneUrl?.(normalizePath(localPath)) ?? null : null;
  const localityConstrained = Boolean(localPath) && !repo?.url && !rewritten;

  const survivors: { host: HostView; score: number }[] = [];
  for (const host of hosts) {
    if (!host.enabled) {
      exclusions.push({ hostId: host.id, reason: 'disabled' });
      continue;
    }
    if (localityConstrained && !declaresPath(host, localPath!)) {
      exclusions.push({
        hostId: host.id,
        reason: `does not declare ${normalizePath(localPath!)} among its local paths `
          + `[${host.localPaths.join(', ') || 'none declared'}]`,
      });
      continue;
    }
    if (request.agent) {
      // Prefer a fresh probe over the cached list; the cache is advisory (section 5) and only used when
      // nothing fresher exists.
      const agents = host.probe?.agents ?? host.agentsCache;
      if (!agents.includes(request.agent)) {
        exclusions.push({
          hostId: host.id,
          reason: `does not offer agent ${JSON.stringify(request.agent)} `
            + `(known: ${agents.join(', ') || 'none'})`,
        });
        continue;
      }
    }
    const unmatched = Object.entries(request.labels ?? {}).filter(
      ([k, v]) => host.labels[k] !== v,
    );
    if (unmatched.length > 0) {
      exclusions.push({
        hostId: host.id,
        reason: `labels do not match: needs ${unmatched.map(([k, v]) => `${k}=${v}`).join(', ')}`
          + `; has ${Object.keys(host.labels).length ? Object.entries(host.labels).map(([k, v]) => `${k}=${v}`).join(', ') : 'no labels'}`,
      });
      continue;
    }
    survivors.push({ host, score: score(host) });
  }

  if (survivors.length === 0) {
    // Section 6: a localPath with no matching host is a submission error, not a scheduling wait. Silently
    // queueing it, or quietly rewriting it to a URL nobody asked for, turns a five-second mistake into an hour
    // of confusion -- so the answer names every host that was considered and why each was ruled out.
    const lines = exclusions.map((e) => `  - ${e.hostId}: ${e.reason}`).join('\n');
    throw new RoutingError(
      `no host can run this task. ${hosts.length} considered:\n${lines}`
        + (localityConstrained
          ? '\nDeclare the path on a host (fleet hosts edit --local-path), or give a git url so locality stops mattering.'
          : ''),
      400,
      exclusions,
    );
  }

  survivors.sort((a, b) => a.score - b.score || a.host.id.localeCompare(b.host.id));
  const chosen = survivors[0];
  const repository: RouteRepository | undefined = rewritten
    ? { ...repo, url: rewritten, localPath: undefined }
    : repo;
  return {
    hostId: chosen.host.id,
    score: chosen.score,
    rewroteLocalPath: rewritten !== null,
    repository,
    considered,
  };
}

/**
 * Load the local-path -> clone-URL map.
 *
 * Returns null when unset so callers keep locality as a hard constraint rather than silently routing
 * everywhere. A malformed file is an operator error worth hearing about, so it throws rather than degrading to
 * "no mapping", which would look like a routing bug.
 */
export function loadRepoUrlMap(file: string | null): ((localPath: string) => string | null) | undefined {
  if (!file) return undefined;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`FLEET_REPO_URLS_FILE ${JSON.stringify(file)} could not be read: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`FLEET_REPO_URLS_FILE is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('FLEET_REPO_URLS_FILE must contain a JSON object of localPath -> git URL');
  }
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string' || !v) throw new Error(`repo url for ${JSON.stringify(k)} must be a non-empty string`);
    map[k.replace(/\/+$/, '') || '/'] = v;
  }
  return (localPath: string) => map[localPath.replace(/\/+$/, '') || '/'] ?? null;
}

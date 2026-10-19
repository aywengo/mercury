/**
 * Routing (docs/fleet-design.md section 6).
 *
 * A pure function over declared facts. It is pure deliberately: a router tested only by "a Run got placed"
 * cannot tell a working filter from an inert one, because both place the Run. Every exclusion here is returned
 * as data, so a test can assert not just that a host was chosen but that the WRONG hosts were rejected and
 * for the stated reason.
 */

import { readFileSync } from 'node:fs';
import type { AvailabilitySnapshot, HostView } from './registry.ts';

export interface RouteRepository {
  url?: string;
  localPath?: string;
  ref?: string;
}

/**
 * The Crew reference a Run names (fleet-bots-design.md section 5.2, FB1 #972).
 *
 * `version` is optional, and an absent one matches ANY enabled version a host carries (section 9.2).
 * "Newest seen anywhere" was rejected there for a reason worth keeping: it would make placement
 * depend on what some OTHER host happens to have, which is not something this request asked about.
 */
export interface RouteCrewReference {
  kind: 'preset' | 'workflow';
  id: string;
  version?: string;
}

export interface RouteRequest {
  /** Explicit placement. When present it wins and no scoring happens. */
  host?: string;
  agent?: string;
  /** Selector: a host must carry every pair listed. */
  labels?: Record<string, string>;
  repository?: RouteRepository;
  /**
   * The preset or workflow the Run names. Derived by the SERVER from the request body's own `preset`
   * or `workflow` block, never from a separate field: a caller who could state the reference twice
   * could contradict itself, and the filter would then place work on a host the child refuses.
   */
  crew?: RouteCrewReference;
}

export interface Exclusion {
  hostId: string;
  reason: string;
}

export interface RouteDecision {
  hostId: string;
  score: number;
  /**
   * Why this host won the soft rank, when the knowledge-freshness penalty decided it. Null when the
   * signal did not change the outcome -- which is the common case, including when the signal is off.
   *
   * Section 4 of crew/harness-capabilities.md requires placement to be explainable, and the reason it
   * gives is operational: a scheduler that moves work to a machine nobody expected, with no stated
   * reason, is not debuggable by an operator at 3am. This is null in the common case precisely so that
   * a non-null value means something -- it appears only when the ranking would have chosen a different
   * host without the knowledge signal, which is the one case worth reading.
   */
  softRankNote: string | null;
  /** True when a localPath was replaced by a clone URL, which is what removed the locality constraint. */
  rewroteLocalPath: boolean;
  /** The repository payload to send the child, after any rewrite. */
  repository: RouteRepository | undefined;
  considered: string[];
  /**
   * Every host the hard filters rejected, with the reason -- the same shape a RoutingError carries.
   *
   * A placement is only explainable if the hosts it did NOT choose are as visible as the one it did:
   * an operator reading "the Run went to gpu-box" learns nothing about the host that was excluded for
   * a missing preset, which is exactly the fact they need when the placement surprises them.
   */
  exclusions: Exclusion[];
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
   * Age beyond which a host's knowledge replica counts against it in the soft rank. 0 or absent
   * disables the signal, which is the default: this changes which machine a Run lands on, and nobody
   * asked for that by upgrading Fleet.
   */
  knowledgeStaleMs?: number;
  /** Injectable clock, so the staleness comparison is testable without waiting for time to pass. */
  now?: () => number;
  /**
   * Resolve a declared local path to a host-independent clone URL. Returning null means "no known URL", and
   * then locality stays a hard constraint. Injected so the policy (a file, a label, a lookup) is separable
   * from the filter that depends on it.
   */
  resolveCloneUrl?: (localPath: string) => string | null;
  /**
   * The per-host availability snapshot (FB0 #970), or null when Fleet has never read one.
   *
   * Injected rather than read from the registry so the router stays pure over the facts it is given:
   * a test states a fleet and its snapshots exactly, and asserts what the router SAID about each host.
   * Absent means "Fleet can see no host's availability", which excludes every host once the request
   * names a Crew reference -- the honest answer, and the same one a host with no snapshot gets.
   */
  availability?: (hostId: string) => AvailabilitySnapshot | null;
  /**
   * Age past which a snapshot counts as stale for the SOFT rank (FLEET_AVAILABILITY_STALE_MS,
   * section 9.3). Stale data can still be right, so it ranks lower rather than being refused.
   *
   * 0 or absent disables the age test. The snapshot's own `stale` flag -- the last read FAILED -- still
   * counts even then, because that is information rather than a clock that has run out.
   */
  availabilityStaleMs?: number;
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
 * How much a stale knowledge replica costs in the soft rank. Large enough that a fresh host reliably
 * beats a stale one, which is what section 14 asks for, and finite, which is what keeps it a preference.
 * It sits below the 1_000 unprobed sentinel on purpose: a host we know nothing about is a worse bet than
 * one we know is running slightly old knowledge, and the signal must not invert that.
 */
const KNOWLEDGE_STALE_PENALTY = 100;

/**
 * Ceiling on what a stale availability snapshot costs in the soft rank.
 *
 * Finite, and below KNOWLEDGE_STALE_PENALTY, because availability is already a HARD filter: this is
 * only the tie-break between hosts that all passed it. An old snapshot can still be right, so it must
 * not outweigh what Fleet knows about the machine's load -- and it must never approach the weight of
 * a signal that is itself deliberately kept softer than every hard constraint.
 */
const AVAILABILITY_STALE_PENALTY_MAX = 50;

/**
 * Age of a host's knowledge replica in ms, or null when Fleet has no opinion.
 *
 * Null is the important answer and it covers four different situations that must all be neutral: the
 * signal is disabled, the host has Atlas switched off, the status route refused or does not exist yet,
 * and the probe itself did not succeed. Treating any of those as stale would demote healthy hosts for
 * reasons that have nothing to do with knowledge, which is exactly how a soft signal becomes an outage.
 */
function knowledgeAgeMs(host: HostView, staleMs: number, now: number): number | null {
  if (staleMs <= 0) return null;
  const p = host.probe;
  if (!p || p.outcome !== 'ok') return null;
  if (p.knowledgeEnabled !== true) return null;
  if (!p.knowledgePullAt) return null;
  const at = Date.parse(p.knowledgePullAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, now - at);
}

/**
 * Age of a host's availability snapshot in ms, or null when the timestamp cannot be read.
 *
 * Null is not treated as fresh: a snapshot Fleet cannot date is exactly the kind of "I do not know"
 * the penalty exists for, and the caller decides what to do with it (the age test simply cannot fire).
 */
function snapshotAgeMs(snapshot: AvailabilitySnapshot, now: number): number | null {
  const at = Date.parse(snapshot.probedAt);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/**
 * Cost of a host's availability snapshot in the soft rank.
 *
 * Zero for a snapshot Fleet read successfully and recently. Otherwise the penalty grows with how stale
 * the snapshot is -- one point per threshold period -- and is capped below KNOWLEDGE_STALE_PENALTY.
 * Graded rather than flat on purpose: #972's acceptance 4 asks for the FRESHEST of several stale hosts
 * to win, and a flat penalty would hand that decision to the capacity score and the id tie-break
 * instead. A snapshot whose last read FAILED (the registry's `stale` flag) always costs at least one
 * point, so a host Fleet could not refresh ranks below one it could, even a second later.
 */
function availabilityPenalty(snapshot: AvailabilitySnapshot | null, staleMs: number, now: number): number {
  if (!snapshot) return 0;
  const age = snapshotAgeMs(snapshot, now);
  const expired = staleMs > 0 && age !== null && age > staleMs;
  if (!snapshot.stale && !expired) return 0;
  const periods = staleMs > 0 && age !== null ? Math.floor(age / staleMs) : 0;
  return Math.min(AVAILABILITY_STALE_PENALTY_MAX, Math.max(1, periods));
}

/**
 * The presets Fleet may route on, or null for "could not see".
 *
 * A stale row holding an EMPTY list is FB0's placeholder for a first availability read that failed
 * (`recordAvailability` writes `[]` with stale=1 when there is no previous snapshot), so it reads as
 * unknown rather than as "this host has nothing" -- the FB0 review note on #972. The direction of the
 * error matters: calling it unknown excludes a host that might have served the Run and says so, while
 * calling it empty would claim a fact Fleet never learned.
 */
function presetEntries(snapshot: AvailabilitySnapshot): AvailabilitySnapshot['presets'] | null {
  if (snapshot.stale && snapshot.presets.length === 0) return null;
  return snapshot.presets;
}

/** Why a host cannot serve the reference, or null when it can. `unknown` marks "Fleet could not see". */
interface CrewProblem {
  reason: string;
  unknown: boolean;
}

function crewProblem(crew: RouteCrewReference, snapshot: AvailabilitySnapshot | null): CrewProblem | null {
  if (!snapshot) {
    return { reason: 'availability unknown: Fleet holds no snapshot for this host', unknown: true };
  }
  const entries = crew.kind === 'preset' ? presetEntries(snapshot) : snapshot.workflows;
  if (entries === null) {
    return {
      reason: `${crew.kind} availability unknown: no ${crew.kind} list was ever read successfully from this host`,
      unknown: true,
    };
  }
  const have = entries.filter((e) => e.id === crew.id);
  if (have.length === 0) {
    const known = entries.length
      ? entries.map((e) => `${e.id}${e.version ? `@${e.version}` : ''}`).join(', ')
      : 'none';
    return { reason: `${crew.kind} ${crew.id} not available (host has ${known})`, unknown: false };
  }
  if (crew.version) {
    // Pinned: the exact version, and enabled (section 9.2).
    if (have.some((e) => e.version === crew.version && e.enabled)) return null;
    const versions = have.map((e) => `${e.version ?? 'no version'}${e.enabled ? '' : ' (disabled)'}`).join(', ');
    return { reason: `${crew.kind} ${crew.id}@${crew.version} not available (host has ${versions})`, unknown: false };
  }
  // Unpinned: any enabled version qualifies (section 9.2).
  if (have.some((e) => e.enabled)) return null;
  const versions = have.map((e) => e.version ?? 'no version').join(', ');
  return { reason: `${crew.kind} ${crew.id} is disabled on this host (versions: ${versions})`, unknown: false };
}

/**
 * Score a host for preference. Lower is better.
 *
 * Only reached when several hosts survive the hard filters, and it can never override one: capacity is a
 * preference, locality is a constraint. A null capacity means the host has not been probed recently, which is
 * treated as neutral rather than free -- an unprobed host must not look like the emptiest machine in the fleet.
 *
 * `availabilityCost` is passed in rather than computed here because the caller needs the same number to
 * explain the placement afterwards; recomputing it would be a second chance to disagree with itself.
 */
function score(host: HostView, staleMs: number, now: number, availabilityCost = 0): number {
  const p = host.probe;
  if (!p || p.outcome !== 'ok') return 1_000 + availabilityCost;
  const active = p.activeRuns ?? 0;
  const queued = p.queueDepth ?? 0;
  const workers = p.workerCount ?? 1;
  // One unit of headroom per worker keeps a big machine from being penalised for its capacity.
  const headroom = Math.max(0, active + queued - workers);
  const age = knowledgeAgeMs(host, staleMs, now);
  return active * 2 + queued + headroom
    + (age !== null && age > staleMs ? KNOWLEDGE_STALE_PENALTY : 0)
    + availabilityCost;
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
  if (request.crew !== undefined) {
    const c = request.crew;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) bad('crew', c);
    if (c.kind !== 'preset' && c.kind !== 'workflow') {
      throw new RoutingError(
        `crew.kind must be "preset" or "workflow", got ${JSON.stringify(c.kind) ?? typeof c.kind}`, 400, []);
    }
    if (typeof c.id !== 'string' || !c.id) bad('crew.id', c.id);
    if (c.version !== undefined && (typeof c.version !== 'string' || !c.version)) bad('crew.version', c.version);
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

  const staleMs = opts.knowledgeStaleMs ?? 0;
  const availStaleMs = opts.availabilityStaleMs ?? 0;
  const now = opts.now?.() ?? Date.now();

  const considered = hosts.map((h) => h.id);
  const exclusions: Exclusion[] = [];
  // Counted so the refusal can tell an operator whose fleet is simply unread ("wait for a probe") apart
  // from one whose hosts genuinely lack the preset -- the same courtesy the locality hint below extends.
  let unknownAvailability = 0;

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
      // Explicit placement is the operator overriding the rank, so there is no rank to explain.
      softRankNote: null,
      rewroteLocalPath: explicitUrl !== null,
      repository: explicitUrl ? { ...request.repository, url: explicitUrl, localPath: undefined } : request.repository,
      considered,
      // No filter ran, so there is nothing to report: naming a host bypasses every one of them
      // (section 6 keeps this escape hatch for exactly that reason).
      exclusions: [],
    };
  }

  const repo = request.repository;
  const localPath = repo?.localPath;
  // A caller who supplies a clone URL has already removed the constraint themselves; the design calls the
  // rewrite the most valuable thing in this section precisely because it turns the hardest rule into a non-issue.
  const rewritten = !repo?.url && localPath ? opts.resolveCloneUrl?.(normalizePath(localPath)) ?? null : null;
  const localityConstrained = Boolean(localPath) && !repo?.url && !rewritten;

  const survivors: { host: HostView; score: number; snapshot: AvailabilitySnapshot | null }[] = [];
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
    // Availability is the last hard filter, and the only one that needs data from outside the request:
    // a Run that names a preset or a workflow can only go where that definition exists (section 5.2).
    // It runs AFTER the cheaper filters so a host ruled out for a missing label is not re-described
    // here, and so the snapshot lookup happens only for hosts still in contention.
    const snapshot = request.crew ? opts.availability?.(host.id) ?? null : null;
    if (request.crew) {
      const problem = crewProblem(request.crew, snapshot);
      if (problem) {
        if (problem.unknown) unknownAvailability += 1;
        exclusions.push({ hostId: host.id, reason: problem.reason });
        continue;
      }
    }
    const availabilityCost = availabilityPenalty(snapshot, availStaleMs, now);
    survivors.push({ host, score: score(host, staleMs, now, availabilityCost), snapshot });
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
          : '')
        + (unknownAvailability > 0
          ? `\n${unknownAvailability} of those hosts have no readable availability snapshot: Fleet learns`
            + ' presets and workflows from its prober (fleet hosts probe <id>).'
          : ''),
      400,
      exclusions,
    );
  }

  survivors.sort((a, b) => a.score - b.score || a.host.id.localeCompare(b.host.id));
  const chosen = survivors[0];

  // Explain the signal only when it actually changed the answer. Recomputing the ranking without it is
  // cheap -- survivors is a handful of hosts -- and it is the only honest way to know: reporting the
  // staleness of every candidate would bury the one case an operator needs, which is "this is why the
  // Run went to the machine you did not expect".
  let softRankNote: string | null = null;
  if (survivors.length > 1) {
    const withoutSignals = [...survivors].sort(
      (a, b) => score(a.host, 0, now) - score(b.host, 0, now) || a.host.id.localeCompare(b.host.id),
    );
    const passedOver = withoutSignals[0]!;
    if (passedOver.host.id !== chosen.host.id) {
      // Whichever soft signals were in play, this host is the one they moved the Run off. Each signal
      // names itself, so a note about availability staleness can never be read as a knowledge one.
      const notes: string[] = [];
      const age = knowledgeAgeMs(passedOver.host, staleMs, now);
      if (age !== null && age > staleMs) {
        notes.push(
          `knowledge staleness: preferred ${chosen.host.id} over ${passedOver.host.id}, ` +
          `whose replica is ${Math.floor(age / 1000)}s old (threshold ${Math.floor(staleMs / 1000)}s)`,
        );
      }
      if (availabilityPenalty(passedOver.snapshot, availStaleMs, now) > 0) {
        const snapshotAge = passedOver.snapshot ? snapshotAgeMs(passedOver.snapshot, now) : null;
        const when = snapshotAge === null ? 'age unknown' : `${Math.floor(snapshotAge / 1000)}s old`;
        notes.push(
          `availability staleness: preferred ${chosen.host.id} over ${passedOver.host.id}, ` +
          `whose snapshot is ${when}`
            + (availStaleMs > 0 ? ` (threshold ${Math.floor(availStaleMs / 1000)}s)` : ''),
        );
      }
      softRankNote = notes.length > 0 ? notes.join('; ') : null;
    }
  }
  const repository: RouteRepository | undefined = rewritten
    ? { ...repo, url: rewritten, localPath: undefined }
    : repo;
  return {
    hostId: chosen.host.id,
    score: chosen.score,
    softRankNote,
    rewroteLocalPath: rewritten !== null,
    repository,
    considered,
    exclusions,
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

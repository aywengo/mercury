/**
 * The sweep: probe every enabled host on a timer and write the results to the cache table.
 *
 * Design section 12 puts this in Phase 0 alongside the registry. Two properties matter more than the
 * details. Hosts are probed concurrently, because a serial sweep over a fleet with one dead host spends its
 * whole budget waiting on the dead one. And the timer is unref'd, so an imported prober never keeps a
 * process alive by itself.
 */

import type { HostRegistry, ProbeRecord } from './registry.ts';
import { probeAndRecord, probeAvailability } from './probe.ts';

export interface ProberOptions {
  registry: HostRegistry;
  /** Resolve a credential_ref to a secret. May throw when the ref is unknown; that is recorded, not fatal. */
  resolveToken: (ref: string) => string;
  intervalMs: number;
  timeoutMs: number;
  /** Passed to each probe; zero (the default) skips the knowledge status call entirely. */
  knowledgeStaleMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (hostId: string, err: Error) => void;
}

export interface Prober {
  /** Probe every enabled host once. Returns one record per host attempted. */
  sweepOnce: () => Promise<ProbeRecord[]>;
  /** Start the repeating sweep. Idempotent. */
  start: () => void;
  stop: () => void;
  readonly running: boolean;
}

/**
 * Outcomes after which the availability endpoints are worth asking. Every excluded outcome means the
 * sweep learned nothing that could have reached the preset catalog: no answer at all (unreachable,
 * timeout), not a Mercury (not_mercury), shapes this build cannot read (incompatible), or the
 * credential refused before any authenticated call could succeed (unauthorized). not_serving and
 * http_error keep it: the host is up and holds a token we hold too, so a failed /api/presets is a
 * real observation about availability and must mark the snapshot stale rather than be skipped.
 */
const CONTACTED: ReadonlySet<ProbeRecord['outcome']> = new Set(['ok', 'not_serving', 'http_error']);

export function createProber(opts: ProberOptions): Prober {
  let timer: ReturnType<typeof setInterval> | null = null;
  let sweeping: Promise<ProbeRecord[]> | null = null;

  async function runSweep(): Promise<ProbeRecord[]> {
    const hosts = opts.registry.list().filter((h) => h.enabled);
    return await (async () => {
      const results = await Promise.all(
        hosts.map(async (host): Promise<ProbeRecord> => {
          let token: string;
          try {
            token = opts.resolveToken(host.credentialRef);
          } catch (err) {
            // A missing ref is Fleet's own misconfiguration, not the host's fault. Recorded as
            // unauthorized because the actionable message is the same: the host may be perfectly healthy,
            // and Fleet is the side that cannot prove otherwise.
            const detail = `credential ref "${host.credentialRef}" could not be resolved: ` +
              `${(err as Error).message}. Host not contacted.`;
            const rec: ProbeRecord = {
              hostId: host.id, outcome: 'unauthorized', detail, activeRuns: null, queueDepth: null,
              workerCount: null, workerId: null, agents: null,
              probedAt: new Date().toISOString(), lastError: detail,
            };
            opts.registry.recordProbe(rec);
            return rec;
          }
          try {
            const rec = await probeAndRecord(
              { hostId: host.id, baseUrl: host.baseUrl, token, timeoutMs: opts.timeoutMs,
                knowledgeStaleMs: opts.knowledgeStaleMs ?? 0 },
              opts.fetchImpl,
            );
            opts.registry.recordProbe(rec);
            // Availability reads ride the sweep (fleet-bots-design.md section 5.1): same timer, same
            // credential, same timeout. Skipped when the sweep never really reached the host or the
            // credential was refused -- both leave the previous snapshot untouched, which is the
            // correct "no new information" answer; a reachable host whose deeper reads fail is the
            // case recordAvailability's keep-previous-and-stale rule exists for.
            if (CONTACTED.has(rec.outcome)) {
              const availability = await probeAvailability(
                { hostId: host.id, baseUrl: host.baseUrl, token, timeoutMs: opts.timeoutMs },
                opts.fetchImpl,
              );
              opts.registry.recordAvailability(host.id, availability, new Date().toISOString());
            }
            return rec;
          } catch (err) {
            // probeAndRecord classifies rather than throwing, so this is a bug or an unexpected rejection.
            // Swallowing it silently would leave the cache showing a stale "up".
            const e = err as Error;
            opts.onError?.(host.id, e);
            const rec: ProbeRecord = {
              hostId: host.id, outcome: 'http_error', detail: `probe raised: ${e.message}`.slice(0, 300),
              activeRuns: null, queueDepth: null, workerCount: null, workerId: null, agents: null,
              probedAt: new Date().toISOString(), lastError: e.message.slice(0, 300),
            };
            opts.registry.recordProbe(rec);
            return rec;
          }
        }),
      );
      return results;
    })();
  }

  /**
   * Overlap guard: a sweep that outlives its interval (many hosts, all slow) must not stack up, or a fleet
   * behind a saturated network spawns a fresh sweep every interval forever.
   *
   * The flag is assigned synchronously, before any await. It used to be set after an `await import()`, so
   * two concurrent callers both read the flag as unset and both started a sweep -- which the overlap test
   * caught as two sweeps one millisecond apart.
   */
  function sweepOnce(): Promise<ProbeRecord[]> {
    if (sweeping) return sweeping;
    sweeping = runSweep().finally(() => {
      sweeping = null;
    });
    return sweeping;
  }

  return {
    sweepOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        // The sweep never rejects (every branch records a result), but an unexpected rejection must not
        // become an unhandled rejection that takes the process down.
        void sweepOnce().catch(() => {});
      }, opts.intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get running() {
      return timer !== null;
    },
  };
}

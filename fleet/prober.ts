/**
 * The sweep: probe every enabled host on a timer and write the results to the cache table.
 *
 * Design section 12 puts this in Phase 0 alongside the registry. Two properties matter more than the
 * details. Hosts are probed concurrently, because a serial sweep over a fleet with one dead host spends its
 * whole budget waiting on the dead one. And the timer is unref'd, so an imported prober never keeps a
 * process alive by itself.
 */

import type { HostRegistry, ProbeRecord } from './registry.ts';
import { probeAndRecord } from './probe.ts';

export interface ProberOptions {
  registry: HostRegistry;
  /** Resolve a credential_ref to a secret. May throw when the ref is unknown; that is recorded, not fatal. */
  resolveToken: (ref: string) => string;
  intervalMs: number;
  timeoutMs: number;
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
              { hostId: host.id, baseUrl: host.baseUrl, token, timeoutMs: opts.timeoutMs },
              opts.fetchImpl,
            );
            opts.registry.recordProbe(rec);
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

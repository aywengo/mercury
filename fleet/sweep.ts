import type { BindingView } from './bindings.ts';
import { UNKNOWN } from './bindings.ts';
import type { DispatchDeps } from './dispatch.ts';
import { resolveHost } from './dispatch.ts';

/**
 * Exactly Mercury's TERMINAL_STATUSES (src/domain/stateMachine.ts). Section 7: these are the ONLY states
 * Fleet may copy from a child. Anything else Fleet either derives (UNKNOWN, LOST) or leaves alone.
 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

/**
 * Fleet's own state for "the binding names a Run the child says it never heard of". Not a Run outcome: the
 * Run may be finished and garbage-collected, or the child's database may have been reset. Either way it is
 * an operator event, which is why it is reported rather than mapped onto FAILED.
 */
export const LOST = 'LOST';

export function isTerminal(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && TERMINAL_STATUSES.has(status);
}

export interface SweepReport {
  /** Bindings the sweep actually asked the child about. */
  examined: number;
  /** Cache rows written from a successful child read. */
  advanced: number;
  /** Reads that failed in a way that leaves the last known status standing. */
  stale: number;
  /** Bindings with no child id yet -- dispatch recovery owns those, not this sweep. */
  pending: number;
  /** Bindings newly classified LOST this pass. */
  lost: number;
  /** Terminal bindings skipped rather than re-read. */
  skippedTerminal: number;
}

export interface SweepEvent {
  kind: 'lost';
  fleetRunId: string;
  hostId: string;
  childRunId: string;
  detail: string;
}

export interface SweepOptions {
  /** Called once per binding the FIRST time it becomes LOST. Repeats are suppressed. */
  onEvent?: (event: SweepEvent) => void;
  hostIds?: '*' | string[];
}

/**
 * Compose an operator-facing reason with the child's own detail when it gave one. Appending unconditionally
 * left a trailing colon on every response with an empty body, which is most 502s from a proxy.
 */
function withDetail(base: string, detail: string): string {
  return detail ? `${base}: ${detail}` : base;
}

function empty(): SweepReport {
  return { examined: 0, advanced: 0, stale: 0, lost: 0, pending: 0, skippedTerminal: 0 };
}

/**
 * One reconciliation pass: for every non-terminal binding, re-read the child and advance the cache.
 *
 * Section 7 is the spec, and the asymmetry in it is the point. A transport failure is not a Run outcome, so
 * the last known status stands and only staleness is recorded; overwriting it with FAILED would destroy a Run
 * that is still running and spending money. A 404 is different in kind -- the binding asserts existence and
 * the child denies it -- so it becomes LOST and is reported, never silently kept.
 */
export async function sweepOnce(deps: DispatchDeps, opts: SweepOptions = {}): Promise<SweepReport> {
  const report = empty();
  const views = deps.bindings.list(opts.hostIds ?? '*');
  const now = new Date().toISOString();

  for (const view of views) {
    if (isTerminal(view.state?.status)) {
      report.skippedTerminal++;
      continue;
    }
    if (!view.childRunId) {
      // No child answer yet. This sweep has nothing to read; recoverPending owns getting an answer.
      report.pending++;
      continue;
    }

    let host: { baseUrl: string; token: string };
    try {
      host = resolveHost(deps, view.hostId);
    } catch (err) {
      // Host gone from the registry or disabled. Keep the last known status and say why it is stale; the
      // registry refuses deletion while Runs are bound precisely so this stays rare and recoverable.
      report.stale++;
      deps.bindings.recordState({
        fleetRunId: view.fleetRunId,
        status: view.state?.status ?? UNKNOWN,
        cursor: view.state?.cursor ?? 0,
        lastSeenAt: view.state?.lastSeenAt ?? null,
        lastError: (err as Error).message,
      });
      continue;
    }

    report.examined++;
    const childRunId = view.childRunId;
    const result = await deps.child.getRun(host, childRunId);

    if (result.kind === 'ok') {
      deps.bindings.recordState({
        fleetRunId: view.fleetRunId,
        status: result.value.status,
        cursor: view.state?.cursor ?? 0,
        lastSeenAt: now,
        lastError: result.value.error ?? null,
      });
      report.advanced++;
      continue;
    }

    if (result.kind === 'rejected' && result.status === 404) {
      const wasLost = view.state?.status === LOST;
      deps.bindings.recordState({
        fleetRunId: view.fleetRunId, status: LOST, cursor: view.state?.cursor ?? 0,
        lastSeenAt: now,
        lastError: withDetail('child reports no such Run (HTTP 404)', result.detail),
      });
      if (!wasLost) {
        report.lost++;
        opts.onEvent?.({ kind: 'lost', fleetRunId: view.fleetRunId, hostId: view.hostId, childRunId, detail: result.detail });
      }
      continue;
    }

    // 5xx, or the child is unreachable. Keep whatever we last knew and record the reason for doubt.
    report.stale++;
    deps.bindings.recordState({
      fleetRunId: view.fleetRunId,
      status: view.state?.status ?? UNKNOWN,
      cursor: view.state?.cursor ?? 0,
      lastSeenAt: view.state?.lastSeenAt ?? null,
      lastError: result.kind === 'unknown'
        ? result.reason
        : withDetail(`child said HTTP ${result.status}`, result.detail),
    });
  }

  return report;
}

export interface SweeperHandle {
  stop(): void;
  /** True while a pass is in flight. Exposed so a test can prove passes cannot overlap. */
  readonly running: boolean;
}

/**
 * Run the sweep on a timer, from startup, until stopped.
 *
 * Its own timer rather than a hook in the request path: section 7 says reconciliation is what makes
 * everything else recoverable, so it must keep working when nobody is asking. A sweep that only runs when an
 * operator opens the page reports exactly the staleness it exists to prevent.
 */
export function startSweeper(
  deps: DispatchDeps,
  opts: { intervalMs: number; onEvent?: (e: SweepEvent) => void; onError?: (e: unknown) => void; hostIds?: '*' | string[] },
): SweeperHandle {
  let running = false;
  let stopped = false;
  const tick = async () => {
    // Set synchronously, before the first await. An await between the check and the set lets two timers both
    // see false and run concurrent passes that fight over the same cache rows.
    if (running || stopped) return;
    running = true;
    try {
      await sweepOnce(deps, { hostIds: opts.hostIds, onEvent: opts.onEvent });
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs);
  // A pending timer must not be the reason the process stays alive during shutdown.
  timer.unref?.();
  void tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    get running() {
      return running;
    },
  };
}

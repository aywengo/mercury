/**
 * Resolves what each registered agent can actually do, by combining the static
 * capability each adapter declares with the harness version detected at startup
 * (docs/goals.md section 13).
 *
 * Probing is **detached**: `start()` kicks the probes off and returns. Boot does not
 * wait for them, and a missing, slow, or unparsable harness never delays or fails
 * startup. The consequence is honest and deliberate -- for the first moment after boot
 * the version is unknown, so goals report `version-unknown` rather than guessing. That
 * is a better answer than either "supported" (assume-yes, which is #459) or "unsupported"
 * (which would make goals unusable on a server that restarted).
 *
 * Capability can never prevent an agent from running. It only gates the goal feature
 * (13.5); refusing to execute an agent because its version string changed would brick
 * every harness upgrade until a parser caught up.
 */

import { resolveGoalCapability } from '../domain/goalSupport.ts';
import type {
  AgentAdapter,
  AgentCapabilitySummary,
  AgentGoalCapability,
  AgentVersionInfo,
} from '../domain/types.ts';

export class AgentCapabilityRegistry {
  private readonly adapters: Record<string, AgentAdapter>;
  private readonly detected = new Map<string, AgentVersionInfo>();
  private started = false;
  /** Called after each probe settles, so a caller can log or invalidate a cache. */
  private readonly onChange?: () => void;

  constructor(adapters: Record<string, AgentAdapter>, opts: { onChange?: () => void } = {}) {
    this.adapters = adapters;
    this.onChange = opts.onChange;
  }

  /**
   * Fire every probe without awaiting it. Adapters with no local binary to ask simply
   * stay unknown -- that is a legitimate steady state for remote agents, not an error.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const [id, adapter] of Object.entries(this.adapters)) {
      if (!adapter.detectVersion) continue;
      // Each probe is isolated: one adapter throwing must not strand the others' results.
      void Promise.resolve()
        .then(() => adapter.detectVersion!())
        .then(
          (info) => { this.detected.set(id, info ?? { version: null, raw: null, error: 'probe returned nothing' }); },
          (err: unknown) => {
            this.detected.set(id, { version: null, raw: null, error: `probe threw: ${String(err)}` });
          },
        )
        .finally(() => this.onChange?.());
    }
  }

  /** Await every in-flight probe. For tests and for callers that need a settled answer. */
  async settle(): Promise<void> {
    // Probes are fire-and-forget by design; polling until they land keeps that property
    // while still giving callers a deterministic point to read from.
    const deadline = Date.now() + 15_000;
    const pending = (): number =>
      Object.keys(this.adapters).filter((id) => this.adapters[id].detectVersion && !this.detected.has(id)).length;
    while (pending() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  goalCapability(agent: string): AgentGoalCapability | null {
    const adapter = this.adapters[agent];
    if (!adapter) return null;
    return resolveGoalCapability(adapter.capabilities.goals, this.detected.get(agent) ?? null);
  }

  snapshot(): Record<string, AgentCapabilitySummary> {
    const out: Record<string, AgentCapabilitySummary> = {};
    for (const id of Object.keys(this.adapters)) {
      const goals = this.goalCapability(id);
      if (!goals) continue;
      out[id] = {
        version: goals.detectedVersion ?? null,
        versionRaw: goals.detectedRaw ?? null,
        goals,
      };
    }
    return out;
  }
}

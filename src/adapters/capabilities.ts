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

import { GOAL_CAPABILITY_FIELDS, resolveGoalCapability } from '../domain/goalSupport.ts';
import type {
  AgentAdapter,
  AgentCapabilitySummary,
  AgentGoalCapability,
  AgentVersionInfo,
  GoalCapabilityField,
} from '../domain/types.ts';

/**
 * One-line rendering of what Mercury may actually do with an agent's goals, for the boot log.
 *
 * `agent=claude-local goals=none` is the whole point: validation catches a misspelled key, but
 * only the log line catches the class of problem behind it -- wrong file loaded, an env override
 * pointing at another directory, or an adapter that legitimately has no goal support and whose
 * operator assumed otherwise. Without it the answer to "why does this agent refuse goals" is
 * "read the config", and the config is what we just stopped trusting.
 *
 * Version thresholds are included because `goals=set` and `goals=set@0.3.3` answer different
 * questions: the first says the operator claimed it, the second says what will be verified
 * against the detected version at admission time (docs/goals.md 13.4).
 */
export function describeGoalCapabilities(adapter: AgentAdapter): string {
  const goals = adapter.capabilities?.goals;
  if (!goals) return 'none';
  const parts = Object.entries(goals)
    .filter(([, min]) => typeof min === 'string' && min.length > 0)
    .map(([field, min]) => `${field}@${min}`);
  return parts.length > 0 ? parts.sort().join(',') : 'none';
}

/**
 * Emit the resolved capability set for every registered agent, once, at load.
 *
 * Extracted from cli.ts rather than inlined for the same reason `selectAgentAdapter` was: the
 * composition root starts a server the moment it is imported, so wiring that lives only there
 * cannot be tested, and a deleted line reads as a passing suite. See test/configUnknownKeys.test.ts.
 */
export function logAdapterCapabilities(
  adapters: Record<string, AgentAdapter>,
  log: { info: (fields: Record<string, unknown>, msg: string) => void },
): void {
  for (const [id, adapter] of Object.entries(adapters)) {
    log.info({ agent: id, goals: describeGoalCapabilities(adapter) }, 'adapter goal capabilities resolved');
  }
}

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
    const info = this.detected.get(agent) ?? null;
    const goals = resolveGoalCapability(adapter.capabilities.goals, info);
    // Resolve every field, not just `set`. Admission needs to refuse `goal.gates` on a backend
    // that has no gate concept, and the answer comes from the same matrix and the same detected
    // version -- computing it here keeps one snapshot consistent, so a probe landing between two
    // reads cannot make `set` look new and `gates` look old.
    const fields: Partial<Record<GoalCapabilityField, AgentGoalCapability>> = {};
    for (const field of GOAL_CAPABILITY_FIELDS) {
      fields[field] = resolveGoalCapability(adapter.capabilities.goals, info, field);
    }
    return { ...goals, fields };
  }

  /** Resolution for one goal field. Null when the agent is not registered. */
  goalFieldCapability(agent: string, field: GoalCapabilityField): AgentGoalCapability | null {
    return this.goalCapability(agent)?.fields?.[field] ?? null;
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

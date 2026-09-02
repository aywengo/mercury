import type { AgentAdapter } from './agentAdapter.ts';
import { DaemonAgentAdapter, type DaemonAgentAdapterOptions } from './daemonAgentAdapter.ts';
import { PrimeAgentAdapter } from './primeAgentAdapter.ts';

/**
 * Choose the adapter for the `primeagent` agent name.
 *
 * This lives in its own module, and is exported, for one reason: the selection is a single ternary in
 * the CLI entry point, and the CLI entry point starts a server the moment it is imported, so nothing
 * could test it. A swapped branch or a typo in the mode string would leave every test in the repository
 * green while daemon mode was never reachable -- the same "wiring is not typed" failure that left this
 * adapter talking a fictional protocol for its entire existence.
 */
export function selectPrimeAgentAdapter(
  agentMode: 'rpc' | 'daemon',
  cmd: string,
  opts: DaemonAgentAdapterOptions,
): AgentAdapter {
  // Anything that is not exactly 'daemon' is RPC. loadConfig() already collapses the env var this way;
  // repeating the rule here means a caller that passes a raw value cannot silently get daemon mode.
  return agentMode === 'daemon'
    ? new DaemonAgentAdapter(cmd, opts)
    : new PrimeAgentAdapter(cmd, opts);
}

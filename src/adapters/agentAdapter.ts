// AgentAdapter contract (Mercury.md section 8).
// Mercury MUST NOT call agent-specific APIs outside this boundary.

import type { AgentHandle, AgentInput, RunContext } from '../domain/types.ts';

export interface AgentAdapter {
  start(context: RunContext): Promise<AgentHandle>;
  sendInput(runId: string, input: AgentInput): Promise<void>;
  cancel(runId: string): Promise<void>;
  /** Resume a run's agent session (worker retry path). Returns a handle to drive. */
  resume?(runId: string, context?: RunContext): Promise<AgentHandle>;
}

export type { AgentHandle, AgentInput, RunContext };

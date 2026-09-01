// Core domain types for Mercury (mirrors Mercury.md sections 5-9, 14).

export type RunStatus =
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'NEEDS_INPUT'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT';

export type ErrorKind = 'infrastructure' | 'agent' | 'task' | null;

export interface RepositoryContext {
  url?: string;
  localPath?: string;
  baseBranch?: string;
  baseCommit?: string;
}

export interface RunConstraints {
  // maxDurationMs and maxRetries are ENFORCED (worker.ts reads both).
  //
  // budgetTokens / budgetCost are RECORDED ONLY (issue #63). Nothing enforces them: no adapter
  // reports token or cost usage, so there is nothing to compare a budget against mid-run. They
  // were previously named maxTokens / maxCost, which sat next to two genuinely enforced max*
  // fields and so read as promises. Renaming is the honest fix; enforcement needs per-run usage
  // reporting from every adapter, which does not exist.
  //
  // If usage reporting is ever added, enforcement belongs in the drive loop next to the
  // maxDurationMs deadline, and these should be renamed back to max* at that point.
  maxDurationMs: number;
  maxRetries: number;
  budgetTokens?: number;
  budgetCost?: number;
  resourceLimits?: { cpu?: string; memory?: string; disk?: string };
  allowedNetworks?: string[];
}

export interface Run {
  id: string;
  ownerId: string;
  task: string;
  repository: RepositoryContext;
  /** Additional repositories (roadmap #6); backward compatible (optional). */
  repositories?: RepositoryContext[];
  workspaceBranch: string | null;
  workspacePath: string | null;
  agent: string;
  status: RunStatus;
  attempt: number;
  retryOf: string | null;
  error: string | null;
  errorKind: ErrorKind;
  constraints: RunConstraints;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  cancellationRequestedAt: string | null;
  finalCommits: string[];
  prUrl: string | null;
}

export interface ResolvedSkill {
  id: string;
  version: string;
  description: string;
  capabilities: string[];
  path: string;
  content: string;
  files: Record<string, string>;
  hash: string;
}

export interface RunSkill {
  runId: string;
  skillId: string;
  skillVersion: string;
  skillHash: string;
  snapshot: ResolvedSkill;
}

export interface MercuryEvent {
  id: string;
  runId: string;
  type: string;
  sequence: number;
  timestamp: string;
  payload: unknown;
}

export interface AgentInput {
  value: unknown;
  at: string;
}

export type AgentExitReason = 'completed' | 'failed' | 'cancelled' | 'terminated' | 'timeout';

export interface AgentExit {
  code: number | null;
  signal: string | null;
  reason: AgentExitReason;
}

export interface AgentEvent {
  type: string;
  payload: unknown;
}

export interface AgentHandle {
  runId: string;
  events: AsyncIterable<AgentEvent>;
  exit: Promise<AgentExit>;
  terminate(): Promise<void>;
}

export interface Workspace {
  path: string;
  branch: string;
  baseCommit: string;
  mode: 'git-worktree' | 'copy';
}

export interface RunContext {
  run: Run;
  repository: RepositoryContext;
  /** Additional repositories (roadmap #6). */
  repositories?: RepositoryContext[];
  workspace: Workspace;
  skills: ResolvedSkill[];
  constraints: RunConstraints;
  /** Persisted agent session file from the parent run (set by the worker when
   *  executing a retry run with resume support). Adapters use it to resume the
   *  parent's agent session instead of starting fresh. */
  resumeSessionFile?: string;
}

export interface AgentAdapter {
  start(context: RunContext): Promise<AgentHandle>;
  sendInput(runId: string, input: AgentInput): Promise<void>;
  cancel(runId: string): Promise<void>;
  /** Resume a run's agent session. Called by the worker for retry runs when the
   *  adapter supports it; `context` carries the new run + workspace and, for
   *  retries, `resumeSessionFile` (the parent run's persisted session file).
   *  Returns a handle to drive, like start(). */
  resume?(runId: string, context?: RunContext): Promise<AgentHandle>;
  /**
   * Drop any per-run state the adapter keeps. Called by the worker AFTER handle.terminate()
   * has resolved, on every exit path (issues #62, #97).
   *
   * The ordering is load-bearing and must not be "optimised". Adapters look the session up by
   * runId inside terminate(), so pruning earlier -- for instance when the exit promise settles
   * -- makes terminate() find nothing and return without stopping the process. That is exactly
   * the leak #46 fixed: a live `prime-agent --mode rpc` left behind per completed run.
   * Settling the exit and releasing the session are different moments; only the second is safe
   * to prune at.
   */
  dispose?(runId: string): void;
}

// Allowed Mercury event types (Mercury.md section 14).
export const EVENT_TYPES = new Set([
  'run.created',
  'run.queued',
  'run.started',
  'run.resuming',
  'run.cancelling',
  'skill.selected',
  'skill.started',
  'skill.completed',
  'skill.failed',
  'step.started',
  'step.completed',
  'step.failed',
  'agent.message',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'git.changed',
  'git.commit',
  'git.pr',
  'test.started',
  'test.completed',
  'input.required',
  'input.received',
  'error',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.timed_out',
  // Both were already being appended by the worker -- sandbox.enabled when a run's
  // sandbox policy is applied, lease.lost when a lost lease is finalised -- while
  // missing from the whitelist, so the set did not describe the events Mercury actually
  // emits (issue #60). A test now fails if any append uses a type absent from this set.
  'lease.lost',
  'sandbox.enabled',
]);

/**
 * True for types the section 14 event contract allows.
 *
 * Enforced by EventStore.append, the single write choke point (issue #60). Until then
 * this was defined and never called anywhere in src/, which is what let an
 * agent-controlled event type reach an SSE frame unvalidated (issue #50).
 */
export function isEventType(t: string): boolean {
  return EVENT_TYPES.has(t);
}

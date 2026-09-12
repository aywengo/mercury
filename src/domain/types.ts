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
  /**
   * The harness version that actually executed this Run, and the raw string it printed
   * (docs/goals.md 13.1). Recorded once at claim time, from the same probe the capability
   * registry cached, so the Run keeps the answer even after the server restarts or the operator
   * upgrades.
   *
   * Null means the probe produced nothing usable -- binary missing, output unparsable, or the
   * adapter has no probe. That is a distinct answer from a version, and 13.7 requires it to
   * render as itself rather than as a blank or as "unknown latest". `agentVersionRaw` is kept
   * because when a parse is wrong, the raw string is the only evidence of why.
   *
   * Optional rather than required because rows written before this column existed are NULL in
   * exactly the same way, and no sentinel can recover a version nobody recorded. Both render as
   * "unknown", which is the truth in either case; the distinction would be a state with no
   * action behind it.
   */
  agentVersion?: string | null;
  agentVersionRaw?: string | null;
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
  /**
   * Who to blame when `reason` is a failure. Defaults to `agent`.
   *
   * Without this, an adapter can only report an infrastructure failure by throwing from `start()`,
   * which the worker's catch path classifies correctly. A failure discovered *while driving* -- the
   * PrimeAgent supervisor shutting down mid-run is the case that prompted this -- had nowhere to go, so
   * it landed as an agent failure: no automatic retry, and an operator told the agent exited badly.
   */
  errorKind?: ErrorKind;
  /**
   * Adapter-supplied explanation, used instead of the generic "Agent exited with code N" when the
   * worker records the failure. Only meaningful alongside `errorKind`; an infrastructure failure that
   * reports "Agent exited with code null (signal SIGTERM)" blames the wrong party twice over.
   */
  message?: string;
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
  /**
   * The goal this Run is trying to achieve, when it has one.
   *
   * Passed in rather than read by the adapter because adapters must not touch the database: an
   * adapter that could read Run state could also invent it. Adapters use this to seed the
   * harness's own goal tracking, and nothing more.
   */
  goal?: GoalState;
}

/**
 * What the caller asked to be achieved, and how "achieved" is decided
 * (docs/goals.md section 5).
 *
 * A goal is NOT Run status. `Run.status` describes what happened to the process; a goal
 * describes whether the work was achieved, and the two are never derived from each other.
 * The combination that matters -- Run COMPLETED with the goal still active -- is the whole
 * reason this exists, and collapsing the two would erase it.
 */
export interface GoalContract {
  /** What must be true at the end. */
  outcome?: string;
  /** How that gets checked: a command, a test, an artifact. */
  verification?: string;
  /** What the agent must not do. */
  constraints?: string;
  /** What is out of scope. */
  boundaries?: string;
  /** When to stop even if the outcome is only partly met. */
  stopWhen?: string;
}

/**
 * A deterministic check that must pass before the objective can be declared met.
 *
 * Execution belongs to the harness, which can fail a gate DURING the run so the agent
 * iterates against it. Mercury records outcomes only: running gates afterwards would turn
 * the mechanism into a post-hoc test report, which `test.*` events already cover.
 */
export interface GoalGate {
  command: string;
  /** Mandatory. An unbounded gate is indistinguishable from a hung one. */
  timeoutMs: number;
  maxRetries: number;
}

export interface GoalSpec {
  /**
   * Omitted or empty means "the Run's task is the objective" (docs/goals.md section 14).
   * The caller still opts in by sending `goal`, so defaulting does not imply a judgement
   * was made -- the judgement stays the harness's.
   *
   * The 4000-char cap matches PrimeAgent's MAX_THREAD_GOAL_OBJECTIVE_CHARS and applies to
   * the RESOLVED value. A task longer than the cap with no explicit objective is a 400,
   * not a silent truncation: a truncated objective is a different objective.
   */
  objective?: string;
  contract?: GoalContract;
  gates?: GoalGate[];
  /** Positive integer; absent means unbounded. PrimeAgent enforces this itself. */
  tokenBudget?: number;
  /** Maps to Hermes' --goal-max-turns; ignored by adapters that have no such notion. */
  maxTurns?: number;
}

/**
 * Goal lifecycle. Orthogonal to RunStatus and never derived from it.
 *
 * `unmet` is the only value Mercury originates, and it is deliberately not a judgement about
 * the work: it means the harness stopped reporting before it ever said `complete`. It must
 * render distinctly from `paused`, which is the harness asking for help.
 */
export type GoalStatus =
  | 'absent'
  | 'active'
  | 'paused'
  | 'budget_limited'
  | 'error'
  | 'complete'
  | 'cancelled'
  | 'unmet';

/** Persisted goal state: the spec plus whatever the harness has reported back. */
export interface GoalState {
  runId: string;
  status: GoalStatus;
  objective: string;
  contract?: GoalContract;
  gates?: GoalGate[];
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  /** Hermes only; PrimeAgent has no judge verdict. */
  lastVerdict?: 'done' | 'continue' | 'skipped';
  /** Harness-supplied agent text: redacted and length-bounded before persistence. */
  lastReason?: string;
  /** PrimeAgent's `error` status detail. Agent-controlled text: redact and bound it too. */
  lastError?: string;
  pausedReason?: string;
  /**
   * Turn/continuation count. PrimeAgent reports continuationsUsed, Hermes counts turns
   * against --goal-max-turns. Same idea, different denominators: never compare the two
   * across backends or render them in one column.
   */
  turnsUsed?: number;
  /** Who last changed it. Only a harness may set `complete`; an operator may cancel. */
  source: 'harness' | 'operator';
  /**
   * Whether the Run ever reached RUNNING, recorded when Mercury settles an abandoned goal.
   *
   * `undefined` means the question has no answer yet: the goal has not been settled. It must not
   * be read as false -- every live goal would then look never-started, which is the same mistake
   * as coercing an unreported tokensUsed to zero.
   *
   * This exists because `unmet` covers two very different facts: the harness had the objective,
   * worked, and never declared it met (the signal the feature exists to surface), versus the Run
   * died before the harness ever received the goal (noise). Both are genuinely unmet, so the
   * status is right and the aggregate needs to tell them apart. Issue #489.
   */
  attempted?: boolean;
  updatedAt: string;
}

/**
 * What the run list reports about a Run's goal: enough to render the row, not the whole state.
 *
 * A status alone cannot distinguish the two kinds of `unmet`, and the list is the most-scanned
 * view there is -- showing both identically hides the one case an operator needs to act on behind
 * an infrastructure artefact (issue #492). So the map carries the one extra field that separates
 * them, and nothing else: objective, usage and gates belong on the detail endpoint.
 *
 * `attempted` is absent when the goal has not been settled, which is NOT the same as false.
 */
export interface GoalSummary {
  status: GoalStatus;
  attempted?: boolean;
}

/**
 * Fields a caller may change after a goal row exists.
 *
 * `objective` is written at creation and may then be replaced by a harness report: PrimeAgent
 * replaces a live objective deliberately, so that it survives context compaction (docs/goals.md
 * 9). A replacement is redacted and bounded on the way in, exactly as the original was -- the
 * harness value is agent-controlled text and gets no weaker treatment for arriving later.
 */
export interface GoalPatch {
  status?: GoalStatus;
  objective?: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  turnsUsed?: number;
  lastVerdict?: GoalState['lastVerdict'];
  lastReason?: string;
  lastError?: string;
  pausedReason?: string;
  source?: 'harness' | 'operator';
  /** Set only by goal settlement. See GoalState.attempted. */
  attempted?: boolean;
}

/** Maximum accepted objective length; mirrors PrimeAgent's MAX_THREAD_GOAL_OBJECTIVE_CHARS. */
export const MAX_GOAL_OBJECTIVE_CHARS = 4000;

/**
 * Ceiling on a gate's `timeoutMs`.
 *
 * The design requires `timeoutMs` to be "bounded" (docs/goals.md 5), and a positive-number
 * check does not deliver that: a year passes it, and a gate that may run for a year is
 * indistinguishable from a hung one, which is the reason the field is mandatory in the first
 * place. Mercury does not execute gates, so this is not a runtime limit -- it is a limit on
 * what Mercury will record as a sane request, and it keeps a typo (`timeoutMs: 3600000000`)
 * from being persisted and rendered as a legitimate expectation.
 *
 * One hour is deliberately generous: a gate is a deterministic check at a turn boundary that
 * the agent iterates against, so anything slower than a full test suite is a pipeline and
 * belongs elsewhere. Set higher only with a reason, since the value's whole job is to be a
 * ceiling.
 */
export const MAX_GOAL_GATE_TIMEOUT_MS = 3_600_000;

/**
 * Goal support for one agent backend, expressed as the MINIMUM harness version at
 * which Mercury can exercise each feature. Absent means Mercury cannot do it at any
 * version.
 *
 * These are Mercury-side features, NOT harness features. Hermes has goals -- a
 * GoalContract, deterministic gates, an auxiliary judge -- and every field here is
 * absent for it, because nothing about that machinery is reachable from the
 * `hermes chat -Q` invocation Mercury drives. A matrix keyed on what the harness can
 * do would advertise a capability the serving path does not honour, which is issue
 * #459 rebuilt inside a compatibility table. See docs/goals.md section 13.2.
 *
 * Thresholds are version strings in whatever scheme the harness itself prints; the
 * adapter owns parsing its own output (docs/goals.md section 13.3), so there is no
 * single grammar this has to fit.
 */
export interface AgentGoalSupport {
  /** Mercury can set an objective at launch. */
  set?: string;
  /** Mercury can observe objective status. */
  track?: string;
  /** Mercury can pass a token budget through. */
  tokenBudget?: string;
  /** The objective carries a verification contract. */
  contract?: string;
  /** Deterministic gates are reported back to Mercury. */
  gates?: string;
  /** A per-goal turn cap can be passed through. Distinct from the adapter's own global
   *  MERCURY_HERMES_MAX_TURNS, which applies to every Run regardless of goal. */
  maxTurns?: string;
}

/**
 * How a backend receives the skills a Run carries. Measured per adapter, not assumed:
 *
 *   workspacePaths -- Mercury materialises skill files into the workspace and the backend reads
 *                     them from there (PrimeAgent: written to .agents/skills AND passed as paths).
 *   nativeNames    -- Mercury passes skill NAMES and the backend resolves them in its own store
 *                     (Hermes: `-s <id>`; the daemon protocol sends id/version/hash).
 *   none           -- the backend is told nothing. Mercury still writes the workspace snapshot, but
 *                     nothing in the backend reads it, so claiming otherwise would advertise a
 *                     capability nobody implemented.
 *
 * This is the field #507 needs. A backend on `nativeNames` cannot be handed a Mercury skill id that
 * it does not have installed -- that is a fatal exit for Hermes, not a warning -- so selection has
 * to know which namespace it is choosing from.
 */
export type AgentSkillDelivery = 'workspacePaths' | 'nativeNames' | 'none';

/** Static capability declarations. Unlike `goals`, these are NOT version-resolved: they describe
 *  what the ADAPTER does, which is a property of Mercury's integration rather than of the installed
 *  harness. A field is absent when it is unverified, which is deliberately different from false. */
export interface AgentStaticCapabilities {
  skills?: AgentSkillDelivery;
  /** Can Mercury append text to the agent's persona/system prompt? */
  personaAppend?: boolean;
  /** Workspace-relative files the backend reads as persona/context, if any. */
  personaFiles?: string[];
  /** The backend accepts mid-Run human input. Derived from the adapter's input support. */
  humanInput?: boolean;
  /** The backend can resume a session after a restart. Derived from resume support. */
  resume?: boolean;
  /** Can Mercury hand this backend a knowledge base? Unverified for every shipped backend. */
  knowledge?: boolean;
}

/** What Mercury can do with an adapter, independent of which version is installed. */
export interface AgentCapabilities {
  goals?: AgentGoalSupport;
  /**
   * Static, non-version-gated capabilities (issue #508). Kept separate from `goals` rather than
   * flattened into it because `goals` is a version MATRIX -- each field is a minimum version string
   * resolved against the detected harness -- while these are plain declarations about the adapter.
   * Merging them would force every consumer to know which kind each field is.
   */
  static?: AgentStaticCapabilities;
}

/** Result of asking a harness binary which version it is. `raw` is kept because when
 *  a parse is wrong the raw string is the only evidence of why (docs/goals.md 13.3). */
export interface AgentVersionInfo {
  version: string | null;
  raw: string | null;
  /** Set when the probe ran but produced nothing usable (binary missing, unparsable
   *  output). Reported to the operator as "cannot tell", which is deliberately not the
   *  same as "too old" -- one means upgrade, the other means fix the probe. */
  error?: string;
}

/** Resolved goal support for one agent, after comparing the matrix against the
 *  detected version. `unknown` is a real answer and must render as one. */
export interface AgentGoalCapability {
  supported: boolean;
  /** Why not, when it is not. Stable machine-readable values. */
  reason?: 'unsupported' | 'version-too-old' | 'version-unknown';
  /** Minimum version Mercury needs for `set`, when the matrix declares one. */
  requiredVersion?: string;
  /** What the harness reported, for the operator to act on. */
  detectedVersion?: string | null;
  detectedRaw?: string | null;
  /**
   * Per-field resolution, so a caller can ask whether one PART of a goal spec means anything
   * to this backend. `supported` above answers only "can it carry a goal" (the `set` field),
   * and that is not the same question: PrimeAgent carries objectives and has no gate or
   * contract concept at all.
   *
   * Nested inside `goals` rather than added beside it because `/api/agents`' top-level key set
   * is pinned by test/fleetContract.test.ts, which compares the keys Fleet parses against the
   * keys the host sends.
   */
  fields?: Partial<Record<GoalCapabilityField, AgentGoalCapability>>;
}

/** One entry per goal capability question. Mirrors the matrix columns in docs/goals.md 13.2. */
export type GoalCapabilityField =
  | 'set' | 'track' | 'tokenBudget' | 'contract' | 'gates' | 'maxTurns';

export interface AgentCapabilitySummary {
  /** null while the detached probe is still in flight, or if it never resolved. */
  version: string | null;
  versionRaw: string | null;
  goals: AgentGoalCapability;
  /**
   * The adapter's static declarations, passed through unresolved. Present even when `goals` is empty,
   * because "no goals" and "no skills" are different statements and a consumer choosing a skill
   * namespace must see the latter.
   */
  static?: AgentStaticCapabilities;
}

export interface AgentAdapter {
  /**
   * What Mercury can do with this backend. REQUIRED, with no default: an adapter that
   * forgets to declare it is a compile error rather than a runtime guess. Absent goal
   * support is declared as `{}`, which is a statement ("never"), not an omission.
   *
   * Making this optional would reintroduce the failure this whole surface exists to
   * prevent -- silently advertising a capability nobody implemented -- so it is
   * deliberately not defaulted and not optional.
   */
  capabilities: AgentCapabilities;
  /**
   * Report the installed harness version. Probed once at startup, detached from boot
   * (docs/goals.md 13.3): a missing or slow binary must not delay or fail startup.
   *
   * Optional because not every backend has a local binary to ask (remote HTTP agents).
   * Absent means the version stays unknown, which fails closed for goals but must never
   * stop the agent from running.
   */
  detectVersion?(): Promise<AgentVersionInfo>;
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
  // Goal lifecycle (docs/goals.md section 6). Appended by the worker and by adapters that
  // can observe a goal; NEVER by anything that judges whether the work was done. Mercury
  // records what the harness reported -- `goal.unmet` is the sole exception and it asserts
  // only that the harness stopped reporting, not that the work failed.
  //
  // Named `goal.completed` rather than the doc's `goal.complete` to match the existing
  // past-participle convention (run.completed, skill.completed, test.completed).
  //
  // Gate events (goal.gate.passed / goal.gate.failed) are deliberately NOT added here yet:
  // nothing emits them until Phase 4, and an event type with no emitter is a vocabulary
  // claim with no evidence behind it.
  'goal.created',
  'goal.updated',
  'goal.paused',
  'goal.budget_limited',
  'goal.error',
  'goal.completed',
  'goal.cancelled',
  'goal.unmet',
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

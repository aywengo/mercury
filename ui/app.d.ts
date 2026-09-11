// Ambient types for the dashboard's shared helpers (imported by tests only).
export interface AuthUser {
  ownerId: string;
  isAdmin: boolean;
}
export function login(token: string): Promise<AuthUser & { ok: boolean }>;
export function logout(): Promise<void>;
export function currentUser(): Promise<AuthUser | null>;
export function api(path: string, opts?: Record<string, unknown>): Promise<unknown>;
export function sse(
  url: string,
  onEvent: (type: string, data: unknown) => void,
  onError?: (err: Error) => void,
): () => void;
export function fmtTime(iso: string | null): string;
export function fmtDuration(startIso: string | null, endIso: string | null): string;
export function esc(s: unknown): string;
export function statusClass(status: string): string;
export function repoLabel(repo: { localPath?: string; url?: string } | null): string;
export function shortId(id: string): string;
export function pretty(v: unknown): string;

/** Goal status as the API reports it. `absent` is never sent; no goal means no key. */
export type UiGoalStatus =
  | 'active' | 'paused' | 'budget_limited' | 'error' | 'complete' | 'cancelled' | 'unmet';

export interface UiGoal {
  status: UiGoalStatus;
  objective?: string;
  source?: string;
  gates?: UiGoalGate[];
  /**
   * Whether the Run ever reached RUNNING. Absent means no answer yet, which is NOT false --
   * an unsettled goal has none to give.
   */
  attempted?: boolean;
}

/**
 * Badge markup for a list row. `goals` is the parallel map from the API: undefined means the
 * server predates goals, a missing key means the run has no goal. Both render, differently.
 */
export interface UiGoalSummary {
  status: UiGoalStatus;
  /** Absent means no answer yet, which is NOT false. */
  attempted?: boolean;
}

export function goalBadge(goals: Record<string, UiGoalSummary> | undefined, runId: string): string;

/** A declared gate spec. Mercury records these and never runs them. */
export interface UiGoalGate {
  command: string;
  timeoutMs: number;
  maxRetries: number;
}

/**
 * Gate specs as escaped markup for the run page. Returns '' when there is nothing to say -- no
 * goal, or a goal with no gates -- so the caller can hide the row entirely. Renders the SPEC and
 * never an outcome: no pass/fail styling, because Mercury does not execute gates.
 */
/** The harness build that executed a Run, as display text. Never a guessed version. */
export function harnessLabel(run: { agentVersion?: string | null; agentVersionRaw?: string | null } | null | undefined): string;

export function goalGatesHtml(goal: ({ gates?: UiGoalGate[] } & Record<string, unknown>) | null | undefined): string;

/** Badge text/class/title for the run page. Same three states as goalBadge. */
export function goalLabel(goal: UiGoal | null | undefined): { text: string; cls: string; title: string };

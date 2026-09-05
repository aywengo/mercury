// Exit codes are part of the public CLI surface (docs/cli-tui-design.md §10.2).
//
// They are stable contract, not implementation detail: automation branches on them, so changing
// one is a breaking change that needs compatibility review. That is also why they live in their own
// module with no imports -- a test can assert the numeric values without dragging in the transport,
// and a refactor cannot silently renumber them.

export const EXIT = {
  /** Command succeeded. For `runs watch`, the watched Run completed. */
  OK: 0,
  /** Usage error or unusable local configuration. Detected before any request is sent. */
  USAGE: 2,
  /** Credential missing or rejected (HTTP 401). */
  AUTH: 3,
  /** Run absent or not visible to this caller (HTTP 404). */
  NOT_FOUND: 4,
  /** Lifecycle conflict, e.g. cancelling an already-terminal Run (HTTP 409). */
  CONFLICT: 5,
  /** Rate limited and the allowed wait was exhausted (HTTP 429). */
  RATE_LIMITED: 6,
  /** Transport, TLS, timeout or server failure (network-level, or HTTP 5xx). */
  TRANSPORT: 7,
  /** Event stream could not recover within its retry budget. */
  STREAM_UNRECOVERABLE: 8,
  /** `runs watch` only: the watched Run FAILED. A status, not a client error. */
  RUN_FAILED: 10,
  /** `runs watch` only: the watched Run was CANCELLED. */
  RUN_CANCELLED: 11,
  /** `runs watch` only: the watched Run TIMED_OUT. */
  RUN_TIMED_OUT: 12,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Shell convention for signal termination: 128 + signal number.
 *
 * Ctrl-C during a watch must release sockets and leave the Run untouched (design §11.3), and the
 * exit status has to distinguish that from a Run outcome -- otherwise `mercuryctl runs watch ...
 * || echo failed` cannot tell "the operator interrupted" from "the Run failed".
 */
export const EXIT_SIGINT = 130;

const TERMINAL_OUTCOME_EXIT: Record<string, number> = {
  COMPLETED: EXIT.OK,
  FAILED: EXIT.RUN_FAILED,
  CANCELLED: EXIT.RUN_CANCELLED,
  TIMED_OUT: EXIT.RUN_TIMED_OUT,
};

export const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminalStatus(status: string): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Map a terminal Run status to the exit code `runs watch` reports.
 *
 * Deliberately NOT applied to `runs show`/`runs list`/`runs events`: those exit 0 whatever the Run's
 * status is, because showing a failed Run is a successful read. Only a command that explicitly waits
 * for an outcome encodes that outcome in its exit status.
 *
 * Returns undefined for a non-terminal status rather than guessing: a caller that treats "not
 * terminal yet" as "failed" would report a running Run as broken.
 */
export function exitCodeForTerminalStatus(status: string): number | undefined {
  return TERMINAL_OUTCOME_EXIT[status];
}

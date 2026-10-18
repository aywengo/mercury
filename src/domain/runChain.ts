// Run chains (A0-2, issue #987): a Run and the attempts that retry it, read as one unit.
//
// A2A reports a task as a chain and calls it terminal only when no further attempt will be made
// (docs/a2a-design.md section 6.4), and that question cannot be answered from one Run row: the
// answer is the latest attempt's status AND whether a retry has been decided AND whether that
// retry already happened. `chainState` is the single place that reads those three together.

import type { Run } from './types.ts';
import { isTerminal } from './stateMachine.ts';

export interface ChainState {
  /**
   * The newest attempt in the chain: the highest `attempt`, ties broken by `createdAt` then `id` so
   * the answer is deterministic rather than "whichever row the query returned first".
   */
  latest: Run;
  /**
   * The latest attempt is terminal, no child exists for it, and a retry is still INTENDED
   * (`retryDueAt` recorded by the terminal transition). The chain is not over: it is waiting.
   */
  retryPending: boolean;
  /** No further attempt will be made: the latest attempt is terminal, childless and not pending. */
  final: boolean;
}

/**
 * Pure over persisted Run rows: the whole chain in, its state out. No clock, no database, no
 * events -- every input is a field of a row the caller already read, which is what makes the
 * answer reproducible for a reader that has no access to the worker that produced the chain.
 *
 * `chain` is the chain in any order and must include at least one Run. A chain is linear by
 * construction since #987 (the retry link is written in the same transaction that inserts the
 * child), so "the tail" and "the highest attempt" are the same row; a chain that forks -- data
 * written before #987, or a caller passing a partial chain -- resolves to the highest attempt
 * rather than throwing, and the childless checks below keep the answer honest either way.
 */
export function chainState(chain: readonly Run[]): ChainState {
  if (chain.length === 0) throw new Error('chainState requires at least one attempt');
  const latest = chain.reduce((best, run) => (isNewer(run, best) ? run : best));
  const childless = !chain.some((run) => run.retryOf === latest.id);
  const terminal = isTerminal(latest.status);
  const retryPending = terminal && childless && (latest.retryDueAt ?? null) !== null;
  return {
    latest,
    retryPending,
    // A terminal attempt that already has a child is not final: the further attempt exists, it is
    // simply not in the `latest` slot. Both flags false is the honest reading of that state.
    final: terminal && childless && !retryPending,
  };
}

function isNewer(candidate: Run, best: Run): boolean {
  if (candidate.attempt !== best.attempt) return candidate.attempt > best.attempt;
  if (candidate.createdAt !== best.createdAt) return candidate.createdAt > best.createdAt;
  return candidate.id > best.id;
}

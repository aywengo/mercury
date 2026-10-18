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
  const childless = (run: Run): boolean => !chain.some((candidate) => candidate.retryOf === run.id);
  /** Terminal, childless and still holding a recorded retry intent: waiting, not finished. */
  const pending = (run: Run): boolean =>
    isTerminal(run.status) && childless(run) && (run.retryDueAt ?? null) !== null;
  const terminal = isTerminal(latest.status);
  const retryPending = pending(latest);
  // "No further attempt will be made" is a statement about the WHOLE chain, not about the latest
  // attempt. For a linear chain the two are the same -- and every chain this codebase writes is
  // linear, because #987 writes the link in the child's insert and refuses a second child of one
  // attempt. A forked chain does not: the newest attempt can be terminal and quiet while a SIBLING
  // is still running or has a retry pending, and calling that final tells a client the work is over
  // while it is not. So no attempt may be live -- non-terminal, or waiting on a retry.
  const live = chain.some((run) => !isTerminal(run.status) || pending(run));
  return {
    latest,
    retryPending,
    // `retryPending` implies `live`, so a pending chain is never final; a terminal attempt that
    // already has a child in the chain is not final either -- the further attempt exists, it is
    // simply not in the `latest` slot. Both flags false is the honest reading of those states.
    final: terminal && childless(latest) && !live,
  };
}

function isNewer(candidate: Run, best: Run): boolean {
  if (candidate.attempt !== best.attempt) return candidate.attempt > best.attempt;
  if (candidate.createdAt !== best.createdAt) return candidate.createdAt > best.createdAt;
  return candidate.id > best.id;
}

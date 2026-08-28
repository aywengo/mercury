// Run lifecycle state machine (Mercury.md section 6).

import type { RunStatus } from './types.ts';

const TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  QUEUED: ['STARTING', 'CANCELLED'],
  STARTING: ['RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  RUNNING: ['NEEDS_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  NEEDS_INPUT: ['RUNNING', 'CANCELLED', 'TIMED_OUT', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
};

export const TERMINAL_STATUSES: RunStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid transition ${from} -> ${to}`);
  }
}

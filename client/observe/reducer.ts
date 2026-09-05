// Run presentation model (§11.3 boundary: "projects Run plus events into a presentation model").
//
// Pure: no I/O, no clock, no client. Both the CLI and the future TUI fold the same inputs into the same
// model, which is the reason this module exists as a boundary rather than living inside a command -- the
// TUI must not re-derive Run state from raw events and drift from what the CLI prints.
//
// It is deliberately not a cache of every event. The CLI keeps the event list; this projects the few
// things a screen needs, so a long-lived watch does not have to retain a full transcript in memory.

import type { MercuryEvent } from '../api/protocol.ts';
import { isTerminalStatus } from '../exitCodes.ts';

/** The subset of a Run row this projection needs, so it is not coupled to the full DTO. */
export interface ReducibleRun {
  id: string;
  status: string;
  agent?: string;
  task?: string;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  retryOf?: string | null;
  idempotencyKey?: string | null;
}

export interface RunPresentation {
  runId: string;
  status: string;
  terminal: boolean;
  agent: string;
  task: string;
  retryOf: string | null;

  /** Monotonic progress markers, taken from the events actually seen. */
  lastSequence: number;
  lastActivityType: string | null;
  eventCount: number;

  /** Counts a screen shows without re-scanning the transcript. */
  stepsCompleted: number;
  stepsFailed: number;
  toolsCompleted: number;
  toolsFailed: number;
  skills: string[];
  messages: number;

  /**
   * A question from the Run that has not been answered.
   *
   * `input.required` and `input.received` pair up by sequence order, not by id, because the server
   * appends them independently. A Run waiting on input is actionable, so this is surfaced rather than
   * left for a screen to infer from two event types.
   */
  pendingInput: { required: true; sequence: number } | null;

  /** The first error seen, which is usually the reason a Run failed. */
  error: string | null;
  terminalEvent: string | null;
}

const STEP_DONE = new Set(['step.completed']);
const STEP_FAIL = new Set(['step.failed']);
const TOOL_DONE = new Set(['tool.completed']);
const TOOL_FAIL = new Set(['tool.failed']);
const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.timed_out']);

/**
 * Fold a Run and its observed events into a presentation model.
 *
 * Events are processed in the order supplied. Callers that paged history and then followed the stream
 * already deliver them in sequence order; sorting here would hide an ordering bug in the observer, so
 * the reducer trusts the order it is given and only guards the monotonic markers.
 */
export function reduceRun(input: {
  run: ReducibleRun;
  events: readonly MercuryEvent[];
}): RunPresentation {
  const { run, events } = input;
  const out: RunPresentation = {
    runId: run.id,
    status: run.status,
    terminal: isTerminalStatus(run.status),
    agent: run.agent ?? '',
    task: run.task ?? '',
    retryOf: run.retryOf ?? null,
    lastSequence: 0,
    lastActivityType: null,
    eventCount: 0,
    stepsCompleted: 0,
    stepsFailed: 0,
    toolsCompleted: 0,
    toolsFailed: 0,
    skills: [],
    messages: 0,
    pendingInput: null,
    error: null,
    terminalEvent: null,
  };

  const seenSkills = new Set<string>();
  for (const event of events) {
    out.eventCount += 1;
    // Guarded rather than assumed: a caller that fed events out of order would otherwise report a
    // sequence that is behind what it has already shown, and a resume from that value would re-read.
    if (event.sequence > out.lastSequence) {
      out.lastSequence = event.sequence;
      out.lastActivityType = event.type;
    }
    switch (event.type) {
      case 'step.completed': out.stepsCompleted += 1; break;
      case 'step.failed': out.stepsFailed += 1; break;
      case 'tool.completed': out.toolsCompleted += 1; break;
      case 'tool.failed': out.toolsFailed += 1; break;
      case 'agent.message': out.messages += 1; break;
      case 'skill.selected': {
        const name = (event.payload as { name?: unknown } | null)?.name;
        if (typeof name === 'string' && !seenSkills.has(name)) { seenSkills.add(name); out.skills.push(name); }
        break;
      }
      case 'input.required':
        out.pendingInput = { required: true, sequence: event.sequence };
        break;
      case 'input.received':
        // Answers the question. Only clears a pending prompt that is earlier, so a late-arriving
        // received event cannot dismiss a newer question.
        if (out.pendingInput && event.sequence > out.pendingInput.sequence) out.pendingInput = null;
        break;
      case 'error': {
        const text = errorText(event.payload);
        if (text && out.error === null) out.error = text;
        break;
      }
      default:
        if (TERMINAL_EVENTS.has(event.type)) {
          out.terminalEvent = event.type;
          const text = errorText(event.payload);
          if (text && out.error === null) out.error = text;
        }
    }
  }
  return out;
}

function errorText(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    for (const key of ['error', 'message', 'reason']) {
      if (typeof o[key] === 'string') return o[key] as string;
    }
  }
  return null;
}

/** One-line human summary of the projection. Used by `runs watch` so the reducer is on the live path. */
export function summarizePresentation(p: RunPresentation): string {
  const parts = [
    `${p.eventCount} event(s)`,
    p.stepsCompleted || p.stepsFailed ? `steps ${p.stepsCompleted}/${p.stepsCompleted + p.stepsFailed} ok` : '',
    p.toolsCompleted || p.toolsFailed ? `tools ${p.toolsCompleted}/${p.toolsCompleted + p.toolsFailed} ok` : '',
    p.skills.length ? `skills ${p.skills.length}` : '',
    p.messages ? `${p.messages} message(s)` : '',
  ].filter(Boolean);
  if (p.pendingInput) parts.push('WAITING FOR INPUT');
  return parts.join(', ');
}

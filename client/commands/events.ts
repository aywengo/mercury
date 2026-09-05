// `runs events` and `runs watch` (§6.1, §10.1, §10.2).
//
// The two commands share an observer but differ in one important way: `events` is a READ and exits 0
// whatever the Run's status, while `watch` explicitly waits for an outcome and therefore encodes that
// outcome in its exit status. Conflating them would make `mercuryctl runs events $id || alert` fire on
// every failed Run, which is not a failure to read anything.

import type { MercuryEvent } from '../api/protocol.ts';
import { EXIT, exitCodeForTerminalStatus } from '../exitCodes.ts';
import { makeColorizer, sanitizeForTerminal, statusColor } from '../output/human.ts';
import { eventLine } from '../output/json.ts';
import { observeRun } from '../observe/runObserver.ts';
import { reduceRun, summarizePresentation, type RunPresentation } from '../observe/reducer.ts';
import type { CommandContext } from './context.ts';

export interface EventRenderContext {
  json: boolean;
  noColor: boolean;
  isTty: boolean;
}

/**
 * One event, one line.
 *
 * Payload text is sanitised in human mode and left alone in JSON mode, for the usual reason: the
 * terminal must not be handed control sequences, and a jq consumer must get the real bytes.
 */
export function renderEventLine(event: MercuryEvent, ctx: EventRenderContext): string {
  if (ctx.json) return eventLine(event).replace(/\n$/, '');
  const { color } = makeColorizer({ noColor: ctx.noColor, isTty: ctx.isTty, json: false });
  const summary = summarizePayload(event.payload);
  return `${color('dim', String(event.sequence).padStart(6))}  ${color('cyan', event.type.padEnd(22))} ${sanitizeForTerminal(summary)}`.trimEnd();
}

/** Short, single-line rendering of an event payload. Never more than one line, by construction. */
function summarizePayload(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return collapse(payload);
  if (typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    for (const key of ['text', 'message', 'status', 'reason', 'error', 'command', 'path']) {
      const value = o[key];
      if (typeof value === 'string' && value.trim() !== '') return collapse(`${key}=${value}`);
    }
    return collapse(JSON.stringify(payload));
  }
  return collapse(String(payload));
}

function collapse(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 110 ? `${oneLine.slice(0, 109)}\u2026` : oneLine;
}

export interface WatchOutcome {
  finalStatus: string | null;
  lastSequence: number;
  eventsDelivered: number;
  reconnects: number;
  gapsRecovered: number;
}

/** Exit code for a finished watch: the Run's outcome, not the client's health. */
export function watchExitCode(outcome: WatchOutcome): number {
  if (outcome.finalStatus === null) return EXIT.STREAM_UNRECOVERABLE;
  return exitCodeForTerminalStatus(outcome.finalStatus) ?? EXIT.STREAM_UNRECOVERABLE;
}

/**
 * Final line of a watch.
 *
 * The presentation model is passed in rather than re-derived here: the reducer is the single place that
 * turns events into counts, and a second tally in the output layer is how a summary and a screen start
 * to disagree.
 */
export function renderWatchSummary(
  outcome: WatchOutcome,
  presentation: RunPresentation | null,
  ctx: EventRenderContext,
): string {
  if (ctx.json) {
    return eventLine({
      type: 'client.watch.summary',
      finalStatus: outcome.finalStatus,
      lastSequence: outcome.lastSequence,
      eventsDelivered: outcome.eventsDelivered,
      reconnects: outcome.reconnects,
      gapsRecovered: outcome.gapsRecovered,
      ...(presentation ? { summary: presentation } : {}),
    }).replace(/\n$/, '');
  }
  const { color } = makeColorizer({ noColor: ctx.noColor, isTty: ctx.isTty, json: false });
  const status = outcome.finalStatus ?? 'UNKNOWN';
  const extras = [
    presentation ? summarizePresentation(presentation) : `${outcome.eventsDelivered} event(s)`,
    outcome.reconnects ? `${outcome.reconnects} reconnect(s)` : '',
    outcome.gapsRecovered ? `${outcome.gapsRecovered} gap(s) recovered` : '',
  ].filter(Boolean).join(', ');
  const errorLine = presentation?.error
    ? `\n${color('red', 'error:')} ${sanitizeForTerminal(presentation.error)}`
    : '';
  return `\n${color(statusColor(status), status)} ${color('dim', `(${extras})`)}${errorLine}`;
}

/** Exposed for the CLI's dispatch so both commands build the same observer options. */
export const observerOptions = { pageSize: 200 };

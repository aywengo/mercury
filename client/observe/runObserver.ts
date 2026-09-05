// Run observation: history, then live stream, with gap recovery (§6.1, §11.3).
//
// This is the piece the whole `runs watch` promise rests on, and the failure modes are all silent:
//
// - Resuming from the server's `lastSequence` instead of `nextCursor` SKIPS events whenever a page was
//   truncated. The watch looks complete and is missing a chunk of the Run. The server source calls this
//   out explicitly (issue #54), and the client's own EventPage type documents it, so the only defence is
//   discipline at the one place that advances a cursor.
// - A reconnect that starts from "now" loses everything between the disconnect and the reconnect.
// - A reconnect that starts from the wrong side of a duplicate re-shows events, so a consumer counting
//   them gets a wrong total.
//
// So: page history from nextCursor, follow the stream from the last sequence actually PROCESSED, drop
// anything at or below that, and if the stream jumps ahead, fall back to history paging to close the
// gap rather than pretending the missing events never existed.

import { isTerminalStatus } from '../exitCodes.ts';
import { MercuryClientError, StreamUnrecoverableError, TransportError } from '../api/errors.ts';
import { AbortError } from '../api/client.ts';
import { ProtocolError, parseEvent } from '../api/protocol.ts';
import type { MercuryEvent } from '../api/protocol.ts';
import type { MercuryClient } from '../api/client.ts';

/** Event types that mean the Run is finished. Used as a fast path only; see finishReason below. */
const TERMINAL_EVENT_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.timed_out']);

export interface ObserverDeps {
  client: MercuryClient;
  runId: string;
  onEvent: (event: MercuryEvent) => void | Promise<void>;
  /** Written to on every reconnect so the caller can surface retries on stderr, never stdout. */
  onReconnect?: (info: { attempt: number; reason: string; after: number; waitMs: number }) => void;
  signal?: AbortSignal;
  maxReconnects?: number;
  pageSize?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ObservationResult {
  /** Terminal status of the Run, or null if the Run was still running when observation stopped. */
  finalStatus: string | null;
  lastSequence: number;
  eventsDelivered: number;
  reconnects: number;
  gapsRecovered: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export class AbortedError extends Error {
  readonly exitCode = 130;
  constructor() { super('interrupted'); this.name = 'AbortedError'; }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

/**
 * Observe a Run to a terminal status, or until the caller aborts.
 *
 * Returns the Run's terminal status so the caller can map it to an exit code. It does NOT decide
 * whether a failed Run is an error: `runs watch` reports the outcome in its exit status, while
 * `runs events --follow` exits 0 whatever happens, because reading history is a successful read.
 */
export async function observeRun(deps: ObserverDeps): Promise<ObservationResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const maxReconnects = deps.maxReconnects ?? 5;
  const pageSize = deps.pageSize ?? 200;
  let cursor = 0;
  let delivered = 0;
  let reconnects = 0;
  let gapsRecovered = 0;

  const emit = async (event: MercuryEvent): Promise<void> => {
    await deps.onEvent(event);
    delivered += 1;
    cursor = event.sequence;
  };

  /**
   * Page history forward from `cursor`.
   *
   * Advances from `page.nextCursor` -- the last sequence actually RETURNED -- and never from
   * `lastSequence`, which is the Run's true maximum and skips whatever the page cap left out.
   */
  const drainHistory = async (): Promise<{ terminal: boolean }> => {
    // The cursor we REQUEST and the cursor we have DELIVERED are different quantities, and conflating
    // them lost events. emit() advances `cursor` to the last event shown, which on a full page equals
    // page.nextCursor, so the old guard `page.nextCursor <= cursor` was true after every page and the
    // loop stopped after one page no matter what hasMore said. A Run with more history than one page
    // therefore showed only its first page before following the stream.
    let requested = cursor;
    for (;;) {
      throwIfAborted(deps.signal);
      const page = await deps.client.listEvents(deps.runId, { after: requested, limit: pageSize });
      for (const raw of page.events) {
        const event = parseEvent(raw);
        if (event.sequence <= cursor) continue;
        await emit(event);
        if (TERMINAL_EVENT_TYPES.has(event.type)) return { terminal: true };
      }
      if (!page.hasMore) return { terminal: false };
      // The anti-loop guard belongs on the request cursor: a server that keeps answering with the same
      // cursor would otherwise spin here forever. Comparing it to the delivered cursor is what made the
      // loop exit early.
      if (page.nextCursor <= requested) return { terminal: false };
      requested = page.nextCursor;
    }
  };

  // History first, always. Starting on the live stream and back-filling later would show events out of
  // order, and an operator piping NDJSON into another program cannot re-sort them.
  let history = await drainHistory();

  // An already-terminal Run must exit without waiting. Reading the status rather than inferring it from
  // events means a Run that reached a terminal state without emitting a recognised terminal event still
  // finishes promptly instead of hanging until the reconnect budget runs out.
  let finalStatus: string | null = null;
  const detail = await deps.client.getRun(deps.runId);
  if (isTerminalStatus(detail.run.status)) {
    if (!history.terminal) await drainHistory();
    return { finalStatus: detail.run.status, lastSequence: cursor, eventsDelivered: delivered, reconnects, gapsRecovered };
  }

  while (!history.terminal) {
    throwIfAborted(deps.signal);
    let sawTerminal = false;
    try {
      for await (const frame of deps.client.streamEvents(deps.runId, { after: cursor, signal: deps.signal })) {
        throwIfAborted(deps.signal);
        // Keepalive comments never reach here: the parser drops them rather than emitting an empty
        // frame. An empty data payload is still possible from a different server, and there is no
        // event to deliver, so it is skipped rather than parsed.
        if (frame.data === '') continue;
        let event: MercuryEvent;
        try {
          event = parseEvent(JSON.parse(frame.data));
        } catch (err) {
          // A frame we cannot parse is a protocol problem, not a reason to reconnect: the next frame
          // will be equally unparseable, and reconnecting would turn a clear error into a silent loop.
          if (err instanceof ProtocolError) throw err;
          throw new ProtocolError(`event frame is not valid JSON: ${(err as Error).message}`);
        }
        if (event.sequence <= cursor) continue;                    // duplicate after a reconnect
        if (event.sequence > cursor + 1) {
          // The stream jumped ahead. Rather than accept the hole, close it from history: the events in
          // between are persisted, so skipping them would be losing data we could have had.
          gapsRecovered += 1;
          await drainHistory();
          if (event.sequence <= cursor) continue;                  // recovery already delivered it
        }
        await emit(event);
        if (TERMINAL_EVENT_TYPES.has(event.type)) { sawTerminal = true; break; }
      }
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      // A local abort surfaces as AbortError from the transport, not as a network fault. Reporting it
      // as a transport failure would be wrong twice over: nothing failed, and the exit code must be 130.
      if (err instanceof AbortError || (err as { aborted?: boolean })?.aborted === true) throw new AbortedError();
      if (err instanceof ProtocolError) throw err;
      if (!(err instanceof MercuryClientError)) throw new TransportError(String((err as Error).message));
      // A 404 mid-watch means the Run stopped being visible; reconnecting cannot fix that.
      if (err.exitCode === 4) throw err;
    }

    if (sawTerminal) break;

    // The stream ended without a terminal event. Ask the Run itself: the server closes the stream on
    // terminal transitions, so a closed stream plus a terminal status is a normal, complete watch.
    const after = await deps.client.getRun(deps.runId);
    if (isTerminalStatus(after.run.status)) { finalStatus = after.run.status; break; }

    reconnects += 1;
    if (reconnects > maxReconnects) {
      throw new StreamUnrecoverableError(
        `event stream did not recover after ${maxReconnects} reconnect(s); the Run is unaffected. ` +
          `Last sequence was ${cursor}; rerun to continue from there.`,
      );
    }
    const waitMs = Math.min(1000 * 2 ** (reconnects - 1), 15_000);
    deps.onReconnect?.({ attempt: reconnects, reason: 'stream ended before a terminal status', after: cursor, waitMs });
    await sleep(waitMs);
    history = await drainHistory();
    const refreshed = await deps.client.getRun(deps.runId);
    if (isTerminalStatus(refreshed.run.status)) { finalStatus = refreshed.run.status; break; }
  }

  if (finalStatus === null) {
    const last = await deps.client.getRun(deps.runId);
    finalStatus = isTerminalStatus(last.run.status) ? last.run.status : null;
  }
  return { finalStatus, lastSequence: cursor, eventsDelivered: delivered, reconnects, gapsRecovered };
}

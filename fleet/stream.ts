import type { ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { BindingStore } from './bindings.ts';
import { listMirroredEvents } from './events.ts';
import { isTerminal } from './sweep.ts';

/**
 * Fleet-side SSE (docs/fleet-design.md section 8), deliberately thin.
 *
 * The stream is a view onto the mirror, not a second path to the child. Fleet never holds a child SSE open as
 * its source of truth: a child drops wedged subscribers on purpose (Mercury issue #145), so treating that as
 * authoritative would mean silently missing events. Everything here reads the same cursor the poll path uses,
 * which is why losing a stream costs latency and nothing else -- a client reconnects with ?after=<cursor> and
 * resumes exactly where it was.
 */

export interface StreamHandle {
  stop: () => void;
  readonly closed: boolean;
}

export interface StreamOptions {
  db: DatabaseSync;
  bindings: BindingStore;
  fleetRunId: string;
  /** How often to look for newly mirrored events. The mirror itself advances on the reconciliation timer. */
  pollIntervalMs?: number;
  /** Comment frames keep proxies from closing an idle stream and browsers from stalling. */
  keepAliveMs?: number;
  /**
   * Give up on a subscriber that has stopped reading. Mercury does the same for the same reason: a wedged
   * browser tab must not pin a response open forever.
   */
  drainTimeoutMs?: number;
  /** Resume point: everything up to and including this sequence is treated as already delivered. */
  after?: number;
  onEnd?: (reason: string) => void;
  /** Surfaced for logging. A stream failure is never a client error; the cursor still works. */
  onError?: (err: unknown) => void;
}

function write(res: ServerResponse, event: string, data: unknown, id?: number): boolean {
  // writeHead must precede the first write; the caller does that so status and headers go out together.
  // Framing is explicit rather than relying on newlines inside a template literal, which reads as a bug even
  // when it happens to produce the right bytes.
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  return res.write(`event: ${event}\n${idLine}data: ${JSON.stringify(data)}\n\n`);
}

export function startEventStream(res: ServerResponse, opts: StreamOptions): StreamHandle {
  const pollMs = opts.pollIntervalMs ?? 1000;
  const keepAliveMs = opts.keepAliveMs ?? 15000;
  const drainTimeoutMs = opts.drainTimeoutMs ?? 30000;

  let closed = false;
  // Set before the first pump. Doing this by calling back into the handle afterwards cannot work: the backlog
  // is written synchronously inside startEventStream, so it would already have been sent.
  let cursor = opts.after ?? 0;
  let backlogDone = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let keepTimer: ReturnType<typeof setInterval> | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    if (keepTimer) clearInterval(keepTimer);
    if (drainTimer) clearTimeout(drainTimer);
    pollTimer = null;
    keepTimer = null;
    drainTimer = null;
  };

  const stop = (reason: string): void => {
    if (closed) return;
    closed = true;
    clearTimers();
    opts.onEnd?.(reason);
    // res.end() throws on a destroyed socket, which is often the very reason this path is running. Nothing
    // can act on it, and letting it escape would surface as an uncaught exception during teardown.
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* already gone */
    }
  };

  /**
   * A subscriber that has stopped reading gets its socket torn down rather than a graceful end. Ending lets
   * the kernel keep buffering a transcript nobody will read, and the event whose write returned false has not
   * been recorded in the cursor, so a reconnect could receive it twice. Same reasoning as Mercury's own SSE
   * backpressure handling.
   */
  const abortUnreadable = (reason: string): void => {
    if (closed) return;
    closed = true;
    clearTimers();
    opts.onEnd?.(reason);
    try {
      res.destroy();
    } catch {
      /* already gone */
    }
  };

  const armDrainWatch = (): void => {
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = setTimeout(() => stop('subscriber stopped reading'), drainTimeoutMs);
    // A stream nobody is watching must not be the reason the process stays alive.
    drainTimer.unref?.();
  };

  const pump = (): void => {
    if (closed) return;
    // A throw inside a timer callback is an uncaught exception, not a failed request, and would take the whole
    // service down over one bad read. Every other periodic task here (sweep, prober) wraps its body likewise.
    try {
      pumpInner();
    } catch (err) {
      opts.onError?.(err);
      stop('read failed');
    }
  };

  const pumpInner = (): void => {
    const page = listMirroredEvents(opts.db, opts.fleetRunId, cursor, 500);
    for (const ev of page.events) {
      if (!write(res, 'event', ev, ev.sequence)) {
        // The kernel buffer is full: the subscriber has stopped reading.
        abortUnreadable('backpressure');
        return;
      }
      cursor = ev.sequence;
    }
    armDrainWatch();
    if (!backlogDone) {
      backlogDone = true;
      // Tell the client where it stands before any live events, so a UI can distinguish "caught up" from
      // "still replaying".
      write(res, 'snapshot', { cursor, hasMore: page.hasMore });
    }
    // A terminal Run whose log is drained has nothing left to send; end rather than hold the socket.
    const state = opts.bindings.state(opts.fleetRunId);
    if (!page.hasMore && state && isTerminal(state.status) && state.eventsDrained) {
      write(res, 'done', { cursor, status: state.status });
      stop('terminal');
    }
  };

  res.on('close', () => stop('client disconnected'));
  armDrainWatch();
  pump();
  if (!closed) {
    pollTimer = setInterval(pump, pollMs);
    pollTimer.unref?.();
    keepTimer = setInterval(() => {
      if (closed) return;
      if (!res.write(': keep-alive\n\n')) stop('backpressure');
    }, keepAliveMs);
    keepTimer.unref?.();
  }

  return {
    stop: () => stop('stopped'),
    get closed() {
      return closed;
    },
  };
}

/**
 * Public-interface helpers for the E2E journeys.
 *
 * Nothing here imports a Mercury store, database module or worker internal. The whole point of the
 * gate is that it observes the system the way an operator does, so the only inputs are a base URL,
 * a bearer token, and the documented HTTP and SSE surfaces.
 */

import { LIMITS } from './preflight.ts';

export interface RunView {
  id: string;
  status: string;
  agent?: string;
  workspacePath?: string | null;
  workspaceBranch?: string | null;
  error?: string | null;
  errorKind?: string | null;
}

export interface RunEvent {
  /** Per-run monotonic sequence assigned by the event store; starts at 1. */
  sequence: number;
  type: string;
  runId?: string;
  ts?: string;
  payload?: Record<string, unknown>;
}

export class HttpError extends Error {
  // Declared as fields rather than constructor parameter properties: tsconfig sets
  // erasableSyntaxOnly, which rejects the latter because it emits real code.
  readonly status: number;
  readonly bodyText: string;

  constructor(status: number, bodyText: string, label: string) {
    super(`${label}: HTTP ${status} ${bodyText.slice(0, 400)}`);
    this.status = status;
    this.bodyText = bodyText;
  }
}

export interface Client {
  get<T>(path: string, label: string): Promise<T>;
  post<T>(path: string, body: unknown, label: string): Promise<{ status: number; body: T }>;
  base: string;
  token: string;
}

/** A token-bound client. Every request carries its own abort signal; none of them is unbounded. */
export function client(base: string, token: string): Client {
  const send = async (method: string, path: string, body: unknown, label: string) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(LIMITS.requestMs),
    });
    const text = await res.text();
    return { res, text };
  };
  return {
    base,
    token,
    async get<T>(path: string, label: string): Promise<T> {
      const { res, text } = await send('GET', path, undefined, label);
      if (!res.ok) throw new HttpError(res.status, text, label);
      return (text ? JSON.parse(text) : {}) as T;
    },
    async post<T>(path: string, body: unknown, label: string) {
      const { res, text } = await send('POST', path, body, label);
      if (!res.ok) throw new HttpError(res.status, text, label);
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
    },
  };
}

export const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/**
 * The Run reached a terminal state other than the one the caller was waiting for.
 *
 * This is a distinct type rather than an Error whose message happens to start with "run ", because
 * pollRun() has to tell its own control-flow signal apart from transient request failures. Matching
 * on a message prefix means that rewording the message -- a change that looks cosmetic -- silently
 * turns "give up at once and say why" into "spin until the deadline and say less".
 */
export class TerminalStateError extends Error {}

/**
 * Poll until a predicate holds or an absolute deadline passes.
 *
 * Polling is by deadline, never by a guessed sleep, and the timeout error carries the run id and
 * the last thing actually observed. "Timed out after 60000ms" on its own sends someone to read
 * container logs; naming the last status usually tells them the worker never claimed the Run.
 */
export async function pollRun(
  api: Client,
  runId: string,
  until: (run: RunView) => boolean,
  what: string,
  deadlineMs: number,
): Promise<RunView> {
  const deadline = Date.now() + deadlineMs;
  let last: RunView | undefined;
  let lastError = '';
  for (;;) {
    try {
      const { run } = await api.get<{ run: RunView }>(`/api/runs/${runId}`, `poll run ${runId}`);
      last = run;
      if (until(run)) return run;
      // Stop early once the Run is terminal but not the state we wanted: waiting longer cannot help.
      if (TERMINAL.has(run.status)) {
        throw new TerminalStateError(`run ${runId} reached terminal ${run.status} while waiting for ${what}`
          + (run.error ? ` (error: ${run.error})` : ''));
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) throw err;
      if (err instanceof TerminalStateError) throw err;
      lastError = (err as Error).message;
    }
    if (Date.now() >= deadline) {
      throw new Error(`run ${runId} did not reach ${what} within ${deadlineMs}ms; `
        + `last observed status=${last?.status ?? 'unknown'}`
        + (lastError ? `; last request error: ${lastError}` : '')
        + '; see the api.log and worker.log written beside the diagnostics summary');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Read the Run's SSE stream until a terminal event or the deadline.
 *
 * The fake agent can finish before a client attaches, so the backlog is delivered on connect and
 * intermediate states may never be visible over REST. That is why the lifecycle is asserted from
 * durable events rather than from status snapshots.
 */
export async function readSse(
  base: string,
  token: string,
  runId: string,
  deadlineMs: number,
): Promise<{ events: RunEvent[]; closed: boolean }> {
  const res = await fetch(`${base}/api/runs/${runId}/stream`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal: AbortSignal.timeout(deadlineMs),
  });
  if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''), 'sse connect');
  const events: RunEvent[] = [];
  const reader = res.body?.getReader();
  if (!reader) throw new Error('sse: no response body');
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { events, closed: true };
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseFrame(frame);
        if (!parsed) continue;
        events.push(parsed);
        if (parsed.type.startsWith('run.') && /\.(completed|failed|cancelled)$/.test(parsed.type)) {
          return { events, closed: false };
        }
      }
    }
  } finally {
    // Always release the body, including on timeout, or the connection outlives the test.
    reader.cancel().catch(() => {});
  }
}

/**
 * One SSE frame -> event.
 *
 * The stream opens with `event: hello` whose data is `{"runId":...,"after":...}` -- a subscription
 * acknowledgement, not a Run event. It carries no `sequence`, and treating it as an event invents a
 * phantom row at sequence 0 that then looks like a duplicate or a gap. Frames without a sequence are
 * therefore skipped rather than coerced.
 */
function parseFrame(frame: string): RunEvent | undefined {
  let name = '';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return undefined;
  const raw = dataLines.join('\n');
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`sse: malformed JSON frame from event "${name}": ${raw.slice(0, 300)}`);
  }
  if (typeof payload.sequence !== 'number') return undefined;
  return {
    sequence: payload.sequence,
    type: String(payload.type ?? name),
    runId: payload.runId as string | undefined,
    ts: payload.ts as string | undefined,
    payload,
  };
}

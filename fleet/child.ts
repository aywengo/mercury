/**
 * The slice of a child Mercury's HTTP API that Fleet uses.
 *
 * Only the enumerated endpoints (design section 9: Fleet must not proxy arbitrary paths). A caller can never
 * widen this surface; it is fixed here, so a child growing an internal route does not hand Fleet a new way to
 * be pointed at it.
 */

export interface ChildRunCreated {
  runId: string;
  status: string;
}

export interface ChildRun {
  id: string;
  status: string;
  task?: string;
  createdAt?: string;
  completedAt?: string | null;
  error?: string | null;
}

/** GET /api/runs/:runId answers `{ run, skills }`, not a bare run. */
interface ChildRunEnvelope {
  run?: ChildRun;
}

/**
 * Outcome of a child call, kept as data rather than exceptions.
 *
 * The distinction Fleet needs is not "did it throw" but "could a Run have been created":
 *
 *   created / ok       the child answered definitively.
 *   rejected           4xx. No Run exists; the request was bad. Safe to fail the binding.
 *   unknown            transport failure or 5xx. A Run MAY exist. Never treated as failure.
 *
 * Collapsing `unknown` into `rejected` is how a federation layer orphans Runs or, worse, reports a Run that
 * is happily spending agent budget as FAILED.
 */
export type ChildResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'rejected'; status: number; detail: string }
  | { kind: 'unknown'; reason: string };

/** One event as the child reports it. Mirrors Mercury's RunEvent. */
export interface ChildEvent {
  id: string;
  runId: string;
  type: string;
  sequence: number;
  timestamp: string;
  payload?: unknown;
}

/**
 * The events page. `nextCursor` is the ONLY safe resume point: it is the last sequence actually returned,
 * whereas `lastSequence` is the run's true maximum and resuming from it skips whatever a truncated page left
 * out. Mercury had exactly that bug (issue #54) and the response shape exists to prevent it.
 */
export interface ChildEventPage {
  events: ChildEvent[];
  lastSequence: number;
  nextCursor: number;
  hasMore: boolean;
}

export interface ChildClient {
  createRun: (host: { baseUrl: string; token: string }, payload: unknown, idempotencyKey: string)
    => Promise<ChildResult<ChildRunCreated>>;
  getRun: (host: { baseUrl: string; token: string }, runId: string) => Promise<ChildResult<ChildRun>>;
  getEvents: (host: { baseUrl: string; token: string }, runId: string, after: number, limit: number)
    => Promise<ChildResult<ChildEventPage>>;
  submitInput: (host: { baseUrl: string; token: string }, runId: string, input: unknown)
    => Promise<ChildResult<{ ok: boolean }>>;
  cancelRun: (host: { baseUrl: string; token: string }, runId: string)
    => Promise<ChildResult<{ runId: string; status: string }>>;
  retryRun: (host: { baseUrl: string; token: string }, runId: string)
    => Promise<ChildResult<{ runId: string; status: string; retryOf: string | null }>>;
}

export interface ChildClientOptions {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

async function call<T>(
  opts: ChildClientOptions,
  url: string,
  init: RequestInit,
): Promise<ChildResult<T>> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (err) {
    // Transport failure after a POST means the request may have been fully processed. The caller must not
    // conclude anything from this except "ask again later".
    return { kind: 'unknown', reason: (err as Error).message.slice(0, 200) };
  }
  if (res.status >= 500) {
    return { kind: 'unknown', reason: `HTTP ${res.status} from child` };
  }
  if (res.status >= 400) {
    let detail = '';
    try {
      const body = await res.json() as { error?: string };
      detail = body.error ?? '';
    } catch { /* body was not JSON; the status still stands */ }
    return { kind: 'rejected', status: res.status, detail: detail.slice(0, 300) };
  }
  try {
    return { kind: 'ok', value: await res.json() as T };
  } catch (err) {
    // A 2xx with an unreadable body is genuinely ambiguous for a create: the Run may exist.
    return { kind: 'unknown', reason: `child response was not JSON: ${(err as Error).message}`.slice(0, 200) };
  }
}

export function createChildClient(opts: ChildClientOptions): ChildClient {
  const headers = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`, accept: 'application/json',
  });
  return {
    async createRun(host, payload, idempotencyKey) {
      return call<ChildRunCreated>(opts, `${host.baseUrl}/api/runs`, {
        method: 'POST',
        headers: { ...headers(host.token), 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
      });
    },
    async getRun(host, runId) {
      // The id comes from Fleet's own binding table, never from a caller, so this cannot be aimed at an
      // arbitrary path on a child.
      const safe = encodeURIComponent(runId);
      const res = await call<ChildRunEnvelope>(opts, `${host.baseUrl}/api/runs/${safe}`,
        { method: 'GET', headers: headers(host.token) });
      if (res.kind !== 'ok') return res;
      // Unwrap here rather than at every call site. Reading `.status` off the envelope yields undefined,
      // which then reaches a SQLite bind as a 500 -- which is exactly what this line used to do, because
      // the fake child in the tests had the same wrong shape as this client.
      if (!res.value || typeof res.value.run !== 'object' || res.value.run === null) {
        return { kind: 'unknown', reason: 'child run response had no run object' };
      }
      return { kind: 'ok', value: res.value.run };
    },
    async submitInput(host, runId, input) {
      const safe = encodeURIComponent(runId);
      return call<{ ok: boolean }>(opts, `${host.baseUrl}/api/runs/${safe}/input`, {
        method: 'POST', headers: { ...headers(host.token), 'content-type': 'application/json' },
        body: JSON.stringify({ input }),
      });
    },
    async cancelRun(host, runId) {
      const safe = encodeURIComponent(runId);
      return call<{ runId: string; status: string }>(opts, `${host.baseUrl}/api/runs/${safe}/cancel`,
        { method: 'POST', headers: headers(host.token) });
    },
    async retryRun(host, runId) {
      const safe = encodeURIComponent(runId);
      return call<{ runId: string; status: string; retryOf: string | null }>(
        opts, `${host.baseUrl}/api/runs/${safe}/retry`, { method: 'POST', headers: headers(host.token) });
    },
    async getEvents(host, runId, after, limit) {
      const safe = encodeURIComponent(runId);
      const url = `${host.baseUrl}/api/runs/${safe}/events?after=${encodeURIComponent(String(after))}`
        + `&limit=${encodeURIComponent(String(limit))}`;
      return call<ChildEventPage>(opts, url, { method: 'GET', headers: headers(host.token) });
    },
  };
}

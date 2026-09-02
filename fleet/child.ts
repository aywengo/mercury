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
  /**
   * Raw Prometheus exposition text. Mounted at the ROOT of a Mercury, not under /api -- a detail easy to get
   * wrong and silent when you do, since the child answers 404 and the rollup just reports nothing.
   */
  getMetrics: (host: { baseUrl: string; token: string }) => Promise<ChildResult<string>>;
}

export interface ChildClientOptions {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Describe a transport failure usefully.
 *
 * undici wraps everything as `fetch failed` and puts the actual reason in `cause`, so reporting only the
 * message tells an operator nothing about why a host is unreachable. The distinction they need -- refused,
 * timed out, name not resolving, TLS -- lives in the cause.
 */
function describeTransportError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  const detail = e.cause?.code ?? e.cause?.message;
  return `${e.message}${detail ? `: ${detail}` : ''}`.slice(0, 200);
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
    return { kind: 'unknown', reason: describeTransportError(err) };
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

/**
 * Same classification as `call`, but the success body is text.
 *
 * Kept separate rather than parameterised because the failure meanings differ: a 2xx with an unreadable JSON
 * body after a POST is ambiguous about whether a Run was created, whereas a body that cannot be read here is
 * simply a scrape that produced nothing usable.
 */
async function callText(
  opts: ChildClientOptions,
  url: string,
  init: RequestInit,
): Promise<ChildResult<string>> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (err) {
    return { kind: 'unknown', reason: describeTransportError(err) };
  }
  if (res.status >= 500) return { kind: 'unknown', reason: `HTTP ${res.status} from child` };
  if (res.status >= 400) return { kind: 'rejected', status: res.status, detail: `HTTP ${res.status}` };
  try {
    return { kind: 'ok', value: await res.text() };
  } catch (err) {
    return { kind: 'unknown', reason: `child metrics body unreadable: ${(err as Error).message}`.slice(0, 200) };
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
    async getMetrics(host) {
      // Text, not JSON: the value is returned verbatim rather than parsed here, so an unexpected metric family
      // reaches the merge layer intact and can be reported as dropped instead of vanishing.
      return callText(opts, `${host.baseUrl}/metrics`, {
        method: 'GET',
        // The shared helper asks for JSON because every other endpoint returns it. Asking a metrics endpoint
        // for JSON is a latent trap: harmless while the child ignores Accept, wrong the day it honours it.
        headers: { ...headers(host.token), accept: 'text/plain' },
      });
    },
    async getEvents(host, runId, after, limit) {
      const safe = encodeURIComponent(runId);
      const url = `${host.baseUrl}/api/runs/${safe}/events?after=${encodeURIComponent(String(after))}`
        + `&limit=${encodeURIComponent(String(limit))}`;
      return call<ChildEventPage>(opts, url, { method: 'GET', headers: headers(host.token) });
    },
  };
}

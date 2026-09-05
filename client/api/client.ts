// HTTP transport (docs/cli-tui-design.md §7, §11.2, §13).
//
// Built on node:http/node:https rather than global fetch, deliberately. The design requires three
// things fetch makes awkward: a per-profile custom CA, a hard bound on response body size, and a
// total per-request deadline. fetch routes through undici's global dispatcher, so a custom CA means
// installing a dispatcher globally -- which would silently apply one profile's trust store to every
// other request in the process. Doing the socket work here keeps each request's trust and limits its
// own, and adds no dependency (§11.1).
//
// The bearer token is attached in exactly one place, buildHeaders(), and is never returned to any
// caller. Nothing above this layer ever sees it.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { SseParser } from './sse.ts';
import type { SseFrame } from './sse.ts';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import {
  AuthError, MercuryClientError, TransportError, errorFromStatus,
} from './errors.ts';
import {
  ProtocolError, parseAgentsResponse, parseCreateRunResponse, parseEventPage, parseOkResponse,
  parseRetryRunResponse, parseRunActionResponse, parseRunDetailResponse, parseRunListResponse,
} from './protocol.ts';
import type {
  AgentsResponse, CreateRunRequest, CreateRunResponse, EventPage, EventQuery, OkResponse,
  RetryRunResponse, RunActionResponse, RunDetailResponse, RunListQuery, RunListResponse,
} from './protocol.ts';

export interface ClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  caFile?: string;
}

/** Non-secret client identity (§14). Must never contain a credential. */
export const USER_AGENT = 'mercuryctl/0.1';

/**
 * Cap on a single response body.
 *
 * A Run's task text and event payloads are operator-supplied and can be large, but they are not
 * arbitrarily large; an unbounded read means a broken or hostile endpoint can exhaust client memory
 * while a script waits for a JSON document that never ends.
 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export class MercuryClient {
  private readonly url: URL;
  private readonly ca?: string;
  // Assigned explicitly rather than as a constructor parameter property: tsconfig sets
  // erasableSyntaxOnly, which forbids the shorthand because it emits runtime code.
  private readonly options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
    this.url = new URL(options.baseUrl);
    if (options.caFile) {
      // Read once at construction: a missing or unreadable CA file is a configuration error that
      // should surface before the first request, not as a confusing TLS failure on attempt one.
      try {
        this.ca = readFileSync(options.caFile, 'utf8');
      } catch (err) {
        throw new TransportError(`cannot read CA file ${options.caFile}: ${(err as Error).message}`, false);
      }
    }
  }

  /**
   * The ONLY place the Authorization header is built.
   *
   * Kept tiny and separate so that "does the token ever leak?" has one answer to audit rather than
   * one per call site.
   */
  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${this.options.token}`,
      ...extra,
    };
  }

  /**
   * Send one request and return the raw response.
   *
   * `extraHeaders` exists for `Idempotency-Key`; it is a parameter rather than a second near-identical
   * method, because two copies of the timeout, body-bound and error paths is how one of them stops
   * being maintained.
   */
  private request(
    method: 'GET' | 'POST',
    path: string,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      extraHeaders?: Record<string, string>;
    } = {},
  ): Promise<RawResponse> {
    const url = new URL(path, this.url);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise<RawResponse>((resolve, reject) => {
      let settled = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const settleReject = (err: unknown): void => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        reject(err instanceof MercuryClientError ? err : new TransportError(String((err as Error).message ?? err)));
      };
      const settleResolve = (value: RawResponse): void => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        resolve(value);
      };

      // A TOTAL deadline, armed here rather than by req.setTimeout below.
      //
      // req.setTimeout is an IDLE timeout: it measures time since the last byte, so a server that
      // trickles one byte every 200ms resets it forever and the request never completes. That is not
      // a theoretical case -- it was reproduced against a stub that drips a valid JSON prefix and
      // then spaces out single spaces, and the client hung past a 1s timeout for as long as the
      // probe was willing to wait. The size bound does not cover it either, since a slow drip stays
      // under 16MB indefinitely. For a CLI run inside shell scripts and CI, "hangs forever despite
      // --timeout 1s" is the worst available failure mode, so the wall-clock bound is enforced here.
      deadlineTimer = setTimeout(() => {
        req.destroy(new TransportError(`request exceeded its ${this.options.timeoutMs}ms deadline`));
      }, this.options.timeoutMs);

      const req = transport(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method,
          headers: this.buildHeaders({
            ...(payload === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
            ...(options.extraHeaders ?? {}),
          }),
          ...(this.ca ? { ca: this.ca } : {}),
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let received = 0;
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) {
              // Destroy rather than end(): the point is to stop reading immediately.
              res.destroy(new TransportError(
                `response exceeded the ${MAX_RESPONSE_BYTES} byte client limit`,
              ));
            }
            chunks.push(chunk);
          });
          res.on('end', () => settleResolve({
            status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
          }));
          res.on('error', settleReject);
        },
      );

      // No req.setTimeout here, deliberately. It measures idle time, and at the same duration as the
      // deadline above it can never fire first: the wall-clock bound always wins, so the idle handler
      // is unreachable in practice. Mutation testing confirmed this -- deleting it changes no test
      // result -- and code that cannot be observed is code that cannot be trusted to still work in six
      // months. If a separate idle bound is ever wanted, it needs its own shorter duration and its own
      // test, not a duplicate of this one.
      req.on('error', settleReject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /**
   * Send a request and turn the response into a parsed, validated value.
   *
   * Non-2xx becomes a typed error carrying the server's own message. A 2xx whose body does not
   * validate becomes a protocol error rather than a partially-populated object: half a Run is worse
   * than no Run, because the caller cannot tell which fields it is inventing.
   */
  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    validate: (value: unknown) => T,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      extraHeaders?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const res = await this.request(method, path, options);
    if (res.status < 200 || res.status >= 300) {
      throw errorFromStatus(res.status, parseJsonLenient(res.body), res.headers['retry-after']);
    }
    let parsed: unknown;
    try {
      parsed = res.body === '' ? {} : JSON.parse(res.body);
    } catch {
      throw new TransportError(`server returned a non-JSON body for ${method} ${path}`);
    }
    try {
      return validate(parsed);
    } catch (err) {
      if (err instanceof ProtocolError) throw err;
      throw err;
    }
  }

  listAgents(): Promise<AgentsResponse> {
    return this.call('GET', '/api/agents', parseAgentsResponse);
  }

  listRuns(query: RunListQuery = {}): Promise<RunListResponse> {
    return this.call('GET', '/api/runs', parseRunListResponse, {
      query: { status: query.status, limit: query.limit, cursor: query.cursor },
    });
  }

  getRun(runId: string): Promise<RunDetailResponse> {
    return this.call('GET', `/api/runs/${encodeURIComponent(runId)}`, parseRunDetailResponse);
  }

  listEvents(runId: string, query: EventQuery = {}): Promise<EventPage> {
    return this.call('GET', `/api/runs/${encodeURIComponent(runId)}/events`, parseEventPage, {
      query: { after: query.after, limit: query.limit },
    });
  }

  createRun(runRequest: CreateRunRequest, idempotencyKey: string): Promise<CreateRunResponse> {
    return this.call('POST', '/api/runs', parseCreateRunResponse, {
      body: runRequest,
      extraHeaders: { 'idempotency-key': idempotencyKey },
    });
  }

  submitInput(runId: string, value: unknown): Promise<OkResponse> {
    return this.call('POST', `/api/runs/${encodeURIComponent(runId)}/input`, parseOkResponse, {
      body: { input: value },
    });
  }

  cancelRun(runId: string): Promise<RunActionResponse> {
    return this.call('POST', `/api/runs/${encodeURIComponent(runId)}/cancel`, parseRunActionResponse, { body: {} });
  }

  retryRun(runId: string): Promise<RetryRunResponse> {
    return this.call('POST', `/api/runs/${encodeURIComponent(runId)}/retry`, parseRetryRunResponse, { body: {} });
  }

  /**
   * Open the SSE event stream for a Run and yield raw frames.
   *
   * Returns an async iterable rather than a callback soup so that cancellation composes: the consumer
   * breaks out of a for-await loop, the generator's finally block destroys the request, and the socket
   * is released. That matters for `runs watch`, where Ctrl-C must stop the CLIENT and leave the Run
   * untouched (§11.3) -- a callback design makes it easy to leave the socket half-alive.
   *
   * `after` is the resume point and is sent as `?after=`. The caller supplies it from the last
   * sequence it actually processed, never from the server's `lastSequence`, which is not a safe resume
   * point on a truncated page.
   *
   * No total deadline is armed here, unlike request(). A watch is legitimately long-lived -- the
   * design says so explicitly -- so the bound that matters is "no bytes for N ms", which is what the
   * idle timeout gives us. Applying the JSON request deadline would kill a healthy watch.
   */
  streamEvents(
    runId: string,
    options: { after?: number; signal?: AbortSignal; idleTimeoutMs?: number } = {},
  ): AsyncIterable<SseFrame> {
    const url = new URL(`/api/runs/${encodeURIComponent(runId)}/stream`, this.url);
    if (options.after !== undefined) url.searchParams.set('after', String(options.after));
    const idleMs = options.idleTimeoutMs ?? this.options.timeoutMs;

    return {
      [Symbol.asyncIterator]: (): AsyncIterator<SseFrame> => {
        const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = transport(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            headers: this.buildHeaders({ accept: 'text/event-stream' }),
            ...(this.ca ? { ca: this.ca } : {}),
          },
          () => { /* handled below */ },
        );

        const parser = new SseParser();
        const queue: SseFrame[] = [];
        let pending: { resolve: (r: IteratorResult<SseFrame>) => void; reject: (e: unknown) => void } | null = null;
        let failure: unknown = null;
        let done = false;

        const asClientError = (err: unknown): unknown =>
          err instanceof MercuryClientError || err instanceof AbortError
            ? err
            : new TransportError(String((err as Error).message ?? err));

        const fail = (err: unknown): void => {
          if (done) return;
          done = true;
          // Clear the idle timer on every terminal path, not only on break. A stream the server ends
          // after a terminal transition never calls return(), so without this the timer stays armed for
          // the whole idle window. The CLI hides the symptom because bin.ts calls process.exit(), which
          // also hides it from the subprocess tests -- but the client is a library, and a consumer that
          // embeds it (the TUI, per §12) would keep a live handle after the watch was over.
          stopIdle();
          failure = err;
          wake();
        };
        // Wakes a parked next(). The failure branch MUST settle the promise: an earlier version left a
        // comment saying "rejections surface below" and did nothing, so a consumer blocked in next()
        // when the socket died or the caller aborted stayed blocked forever. That is why Ctrl-C on a
        // watch hung instead of exiting 130 -- the abort closed the socket and nothing told the reader.
        const wake = (): void => {
          if (!pending) return;
          const settle = pending;
          pending = null;
          if (queue.length > 0) { settle.resolve({ value: queue.shift()!, done: false }); return; }
          if (failure) { settle.reject(asClientError(failure)); return; }
          if (done) settle.resolve({ value: undefined as never, done: true });
        };

        req.on('response', (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            // The stream endpoint answers non-2xx with a JSON error body, so read a little and map it
            // like any other response. A 404 here must be NOT_FOUND, not a stream failure.
            const bits: Buffer[] = [];
            res.on('data', (c: Buffer) => { if (bits.join('').length < 4096) bits.push(c); });
            res.on('end', () => {
              fail(errorFromStatus(status, parseJsonLenient(Buffer.concat(bits).toString('utf8')), res.headers['retry-after']));
            });
            res.on('error', () => {
              fail(errorFromStatus(status, undefined, res.headers['retry-after']));
            });
            return;
          }
          res.on('data', (chunk) => {
            resetIdle();
            // Decoded explicitly rather than via setEncoding: the parser is fed strings, and leaving
            // the stream in Buffer mode keeps that contract visible at the call site.
            const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
            for (const frame of parser.push(text)) {
              queue.push(frame);
              wake();
            }
          });
          res.on('end', () => {
            for (const frame of parser.end()) { queue.push(frame); wake(); }
            if (!done) { stopIdle(); done = true; wake(); }
          });
          res.on('error', fail);
        });
        req.on('error', fail);

        // Idle-only bound: a stream that stops carrying bytes at all is dead, but one that trickles
        // keepalives for hours is healthy.
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        // One place that disarms the idle timer, called from every path that ends the stream. The timer
        // is armed before the response arrives, so it must be cleared on normal completion too: a stream
        // the server ends after a terminal transition never calls return(), and the armed timer would
        // otherwise hold the event loop open for the whole idle window. The CLI hides that behind
        // process.exit(); a library consumer such as the TUI would not.
        const stopIdle = (): void => {
          if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
        };
        const resetIdle = (): void => {
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            req.destroy(new TransportError(`event stream was silent for ${idleMs}ms`));
          }, idleMs);
        };
        resetIdle();

        // Destroying with an error, not bare destroy(). A bare destroy() emits 'close' but neither
        // 'end' nor 'error', so a consumer parked in next() would never be woken: Ctrl-C on a watch
        // would leave the process hanging with the socket closed and nothing reported. Passing an
        // error routes through fail(), which resolves the pending promise and lets the abort surface.
        const onAbort = (): void => { req.destroy(new AbortError()); };
        if (options.signal) {
          if (options.signal.aborted) onAbort();
          else options.signal.addEventListener('abort', onAbort, { once: true });
        }

        // The request must be ended or it is never sent. A GET with no body still has to be closed:
        // until then the client has written only a half-request, the server never answers, and the
        // iterator sits waiting for a response that will not arrive until the idle bound fires. This
        // was invisible for a while because every watch test used an already-terminal Run, which the
        // observer finishes from the history drain and the status read without ever entering the
        // streaming loop -- so the follow path had never been exercised end to end.
        req.end();

        return {
          next(): Promise<IteratorResult<SseFrame>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            if (failure) return Promise.reject(asClientError(failure));
            if (done) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise<IteratorResult<SseFrame>>((resolve, reject) => {
              pending = { resolve, reject };
            });
          },
          return(): Promise<IteratorResult<SseFrame>> {
            // Breaking out of for-await lands here. Release everything, including the abort listener,
            // so a watch that ends does not keep the process or the socket alive.
            done = true;
            stopIdle();
            options.signal?.removeEventListener('abort', onAbort);
            req.destroy();
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };
  }
}


/**
 * Parse a body that may be JSON or may be plain text.
 *
 * Error bodies are `{ error: string }` today, but a proxy or load balancer in front of Mercury can
 * answer with an HTML error page -- and the operator needs to see that something said something,
 * rather than "unexpected token <".
 */
function parseJsonLenient(body: string): unknown {
  if (body === '') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body.slice(0, 500);
  }
}

export { AuthError };

/**
 * Raised locally when the caller aborts, so a pending read resolves instead of hanging.
 *
 * Deliberately not a TransportError: an interrupt is not a network fault, and the observer must be able
 * to report exit 130 rather than "transport failure" after the operator pressed Ctrl-C.
 */
export class AbortError extends Error {
  readonly aborted = true;
  constructor(message = 'aborted by caller') {
    super(message);
    this.name = 'AbortError';
  }
}

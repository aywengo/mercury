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
      const settleReject = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(err instanceof MercuryClientError ? err : new TransportError(String((err as Error).message ?? err)));
      };

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
          res.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
          });
          res.on('error', settleReject);
        },
      );

      // A total deadline, not an idle timeout: a server that accepts the socket and then stalls
      // forever must not hang the client indefinitely.
      req.setTimeout(this.options.timeoutMs, () => {
        req.destroy(new TransportError(`request timed out after ${this.options.timeoutMs}ms`));
      });
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

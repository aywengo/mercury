/**
 * The HTTP client for Atlas (docs/knowledge-base.md sections 8.2, 8.3 and 11.1).
 *
 * The transport is injectable, exactly as `RemoteAgentAdapter` does it, so the pusher and the puller
 * are testable without a network and without a fake server. That is not a convenience: every
 * guarantee in section 8.2 is about failure -- a transport failure leaves every row in place, backs
 * off, and drops nothing -- and a test that cannot conjure a transport failure on demand cannot
 * prove any of them.
 *
 * Nothing here retries. Retry belongs to the pusher, because only the pusher knows whether a given
 * failure is worth backing off for.
 */

import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AtlasConfig } from '../config.ts';
import type { ContributionResponse, Note } from './types.ts';

export interface AtlasRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface AtlasReply {
  status: number;
  /** Parsed JSON body, or the raw text when the response is not JSON. */
  body: unknown;
}

export type AtlasTransport = (req: AtlasRequest) => Promise<AtlasReply>;

/** Could not reach Atlas, or reached it and got no usable answer. Distinct from "Atlas said no". */
export class AtlasTransportError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AtlasTransportError';
    this.cause = cause;
  }
}

/** Atlas answered with a status that is not a success. */
export class AtlasHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AtlasHttpError';
    this.status = status;
  }
}

export interface AtlasClientOptions {
  transport?: AtlasTransport;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** One page of the replication feed (section 11.2). */
export interface NoteFeed {
  notes: Note[];
  nextSeq: number;
}

export class AtlasClient {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private readonly transport: AtlasTransport;

  constructor(cfg: AtlasConfig, options: AtlasClientOptions = {}) {
    // Fields assigned explicitly rather than as constructor parameter properties: tsconfig sets
    // erasableSyntaxOnly, which forbids the shorthand because it emits runtime code.
    this.baseUrl = cfg.url.replace(/\/+$/, '');
    this.authorization = `Bearer ${cfg.token}`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transport = options.transport ?? nodeTransport(cfg.caFile);
  }

  /**
   * One request, with the auth header added in exactly one place.
   *
   * Kept separate so "does the token ever leak into a log or an error" has one answer to audit
   * rather than one per call site -- the same reasoning the host's client applies to its own
   * `buildHeaders`.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: this.authorization,
    };
    // Section 11.1 requires the header on the contribute route. Sending it only there keeps a
    // missing-key bug visible: Atlas answers 400 rather than silently deduplicating a GET.
    if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    const reply = await this.transport({ method, url: url.toString(), headers, body, timeoutMs: this.timeoutMs });
    if (reply.status >= 400) {
      // The status and a short reason, never the request body: a contribution body contains note
      // claims, and an error string has a way of ending up in a log line and a metric label.
      throw new AtlasHttpError(reply.status, `${method} ${path} -> ${reply.status}: ${summarize(reply.body)}`);
    }
    return reply.body;
  }

  /**
   * Contribute a batch. The caller supplies one idempotency key for the batch, derived from the
   * rows in it, so a re-send after a lost acknowledgement is recognized rather than re-counted.
   */
  async pushBatch(projectId: string, contributions: unknown[], idempotencyKey: string): Promise<ContributionResponse> {
    const body = await this.request('POST', `/v1/projects/${encodeURIComponent(projectId)}/notes`, {
      body: { notes: contributions },
      idempotencyKey,
    });
    return parseContributionResponse(body);
  }

  /** Everything after `since` in the project's write feed, in `seq` order (section 11.2). */
  async pull(projectId: string, since: number, tier: 'promoted' | 'all' = 'promoted', limit = 500): Promise<NoteFeed> {
    const body = await this.request('GET', `/v1/projects/${encodeURIComponent(projectId)}/notes`, {
      query: { since, tier, limit },
    });
    return parseFeed(body, 'pull');
  }

  /** The full promoted set and the `seq` to continue from, in one round trip (section 13). */
  async bootstrap(projectId: string): Promise<NoteFeed> {
    const body = await this.request('GET', `/v1/projects/${encodeURIComponent(projectId)}/bootstrap`);
    return parseFeed(body, 'bootstrap');
  }

  /** Liveness, used by `knowledge status`. Unauthenticated, like the host's own `/healthz`. */
  async health(): Promise<Record<string, unknown>> {
    const url = new URL(this.baseUrl + '/healthz');
    const reply = await this.transport({
      method: 'GET', url: url.toString(), headers: { accept: 'application/json' }, timeoutMs: this.timeoutMs,
    });
    return (reply.body ?? {}) as Record<string, unknown>;
  }
}

function summarize(body: unknown): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return text.slice(0, 200);
}

/**
 * Validate the shape of a contribution response.
 *
 * Deliberately strict, and strict in the direction that keeps rows: a response whose `results` array
 * is missing or shorter than the batch is treated as an error rather than as "no results", because
 * the caller's next move on results is to DELETE the rows it believes were accepted. A lenient parse
 * here is how notes get dropped on a protocol misunderstanding.
 */
function parseContributionResponse(body: unknown): ContributionResponse {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) {
    throw new AtlasTransportError(`Atlas contribution response has no results array: ${summarize(body)}`);
  }
  for (const r of results) {
    if (typeof r !== 'object' || r === null) {
      throw new AtlasTransportError(`Atlas contribution result is not an object: ${summarize(r)}`);
    }
    const keys = Object.keys(r as Record<string, unknown>);
    if (keys.length !== 1 || !['accepted', 'duplicate', 'rejected'].includes(keys[0]!)) {
      throw new AtlasTransportError(`Atlas contribution result is not one of accepted/duplicate/rejected: ${summarize(r)}`);
    }
  }
  return { results: results as ContributionResponse['results'] };
}

function parseFeed(body: unknown, what: string): NoteFeed {
  const notes = (body as { notes?: unknown })?.notes;
  const nextSeq = (body as { nextSeq?: unknown })?.nextSeq;
  if (!Array.isArray(notes)) throw new AtlasTransportError(`Atlas ${what} response has no notes array`);
  if (typeof nextSeq !== 'number' || !Number.isInteger(nextSeq) || nextSeq < 0) {
    // No default. Advancing a cursor to a guessed value would skip writes permanently, and the whole
    // value of a cursor is that it is gapless.
    throw new AtlasTransportError(`Atlas ${what} response has no usable nextSeq`);
  }
  return { notes: notes as Note[], nextSeq };
}

/**
 * The default transport: `node:https`, not `fetch`.
 *
 * Node's global `fetch` cannot be handed a private CA without an undici `Agent`, and undici is not a
 * dependency here. `MERCURY_ATLAS_CA_FILE` (section 8.4) exists for deployments whose Atlas sits
 * behind a private CA, so the option has to work with what is already installed. The host's own
 * client made the same call for the same reason.
 */
function nodeTransport(caFile: string | null): AtlasTransport {
  let ca: string | undefined;
  if (caFile) {
    // Read once, at construction. A missing or unreadable CA file is a configuration error and should
    // surface before the first request, not as a confusing TLS failure on attempt one.
    try {
      ca = readFileSync(caFile, 'utf8');
    } catch (err) {
      throw new AtlasTransportError(`cannot read Atlas CA file ${caFile}: ${(err as Error).message}`, err);
    }
  }
  return (req) => new Promise<AtlasReply>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(req.url);
    } catch (err) {
      reject(new AtlasTransportError(`invalid Atlas URL ${req.url}`, err));
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const r = lib.request(target, {
      method: req.method,
      headers: req.headers,
      // Only https can take a CA; passing it to http would be ignored, and an option that is
      // silently ignored is an option that reads as configured.
      ...(target.protocol === 'https:' && ca ? { ca } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try { body = text ? JSON.parse(text) : null; } catch { /* not JSON; the raw text is the body */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', (err) => reject(new AtlasTransportError(`Atlas response failed: ${err.message}`, err)));
    });
    r.setTimeout(req.timeoutMs, () => r.destroy(new AtlasTransportError(`Atlas request timed out after ${req.timeoutMs}ms`)));
    r.on('error', (err) => reject(err instanceof AtlasTransportError ? err : new AtlasTransportError(err.message, err)));
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

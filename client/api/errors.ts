// Typed client errors and the exit-code mapping (docs/cli-tui-design.md §7.1, §10.2).
//
// The rule that shapes this file: a lifecycle conflict must never be reported as a transport
// failure. They call for opposite responses -- a 409 means refresh state and reconsider the action,
// a transport error means the server may not have received anything at all. Collapsing them into
// one code is how an operator ends up retrying a cancel that already succeeded, or assuming a Run
// is untouched when it was cancelled.

import { EXIT } from '../exitCodes.ts';

export class MercuryClientError extends Error {
  /** Stable machine-readable discriminator, safe to switch on. */
  readonly kind: string;
  /** Process exit status for this failure. */
  readonly exitCode: number;
  /**
   * True when the request may have reached the server and been acted upon. Callers use this to
   * decide whether an automatic retry is safe; it is deliberately conservative.
   */
  readonly maybeApplied: boolean;

  constructor(kind: string, message: string, exitCode: number, maybeApplied = false) {
    super(message);
    this.name = 'MercuryClientError';
    this.kind = kind;
    this.exitCode = exitCode;
    this.maybeApplied = maybeApplied;
  }
}

export class UsageError extends MercuryClientError {
  constructor(message: string) {
    super('usage', message, EXIT.USAGE, false);
    this.name = 'UsageError';
  }
}

export class AuthError extends MercuryClientError {
  constructor(message = 'authentication failed') {
    super('auth', message, EXIT.AUTH, false);
    this.name = 'AuthError';
  }
}

export class NotFoundError extends MercuryClientError {
  constructor(message = 'run not found') {
    super('not_found', message, EXIT.NOT_FOUND, false);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends MercuryClientError {
  constructor(message = 'lifecycle conflict') {
    super('conflict', message, EXIT.CONFLICT, true);
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends MercuryClientError {
  /** Seconds from `Retry-After`, when the server sent a usable one. */
  readonly retryAfterSeconds: number | undefined;
  constructor(message = 'rate limited', retryAfterSeconds?: number) {
    super('rate_limited', message, EXIT.RATE_LIMITED, true);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TransportError extends MercuryClientError {
  constructor(message: string, maybeApplied = true) {
    super('transport', message, EXIT.TRANSPORT, maybeApplied);
    this.name = 'TransportError';
  }
}

export class ServerError extends MercuryClientError {
  readonly status: number;
  constructor(status: number, message: string) {
    super('server', message, EXIT.TRANSPORT, true);
    this.name = 'ServerError';
    this.status = status;
  }
}

export class ProtocolMismatchError extends MercuryClientError {
  constructor(message: string) {
    super('protocol', message, EXIT.TRANSPORT, true);
    this.name = 'ProtocolMismatchError';
  }
}

export class StreamUnrecoverableError extends MercuryClientError {
  constructor(message = 'event stream could not recover within its retry budget') {
    super('stream_unrecoverable', message, EXIT.STREAM_UNRECOVERABLE, true);
    this.name = 'StreamUnrecoverableError';
  }
}

/**
 * Map an HTTP response to a typed error.
 *
 * `body` is the parsed JSON body when it parsed, otherwise the raw text. Mercury answers every
 * error with `{ error: string }` and keeps 500 detail server-side on purpose, so the server message
 * is surfaced for 4xx and the opaque one is preserved for 5xx rather than invented.
 *
 * 400 maps to USAGE: the request was well-formed enough to reach validation and was rejected, which
 * is the same operator-facing situation as a local usage error -- fix the arguments and retry. It is
 * NOT a transport failure, because retrying unchanged cannot help.
 *
 * 404 is never rewritten as "owned by someone else". Mercury deliberately does not disclose that
 * distinction, and a client that inferred it would leak ownership across accounts.
 */
export function errorFromStatus(status: number, body: unknown, retryAfter?: string | null): MercuryClientError {
  const message = extractServerMessage(body) ?? `HTTP ${status}`;
  switch (status) {
    case 400:
      return new UsageError(message);
    case 401:
    case 403:
      // 403 shares the auth exit code: from a script's point of view the credential is not good
      // enough for this call, and the remedy is the same.
      return new AuthError(message);
    case 404:
      return new NotFoundError(message);
    case 409:
      return new ConflictError(message);
    case 429:
      return new RateLimitError(message, parseRetryAfter(retryAfter));
    default:
      return new ServerError(status, message);
  }
}

function extractServerMessage(body: unknown): string | undefined {
  if (typeof body === 'string' && body.trim() !== '') return body.trim();
  if (typeof body === 'object' && body !== null) {
    const err = (body as Record<string, unknown>).error;
    if (typeof err === 'string' && err.trim() !== '') return err.trim();
  }
  return undefined;
}

/**
 * Parse `Retry-After`, which may be delta-seconds or an HTTP-date.
 *
 * Returns undefined rather than 0 for anything unparseable: treating a malformed header as "wait 0
 * seconds" would hammer the endpoint that just asked us to slow down, which is the opposite of what
 * the header is for.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return undefined;
}

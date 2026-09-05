// Idempotent Run creation (docs/cli-tui-design.md §8).
//
// Every create carries an Idempotency-Key. The reason is specific: a create that times out in
// transit is INDETERMINATE -- the Run may or may not exist -- and a retry with a fresh key would
// create a second Run. The server deduplicates on the key (RunService.create returns the existing Run
// when the key was seen before), so reusing the key turns an ambiguous retry into a safe one.
//
// Two consequences that shape this module:
//
// 1. The key must survive a failed attempt. If the client gives up, the operator has to be able to
//    rerun with the SAME key, so the key is reported on the error path as well as the success path.
//    A generated key that is only printed on success is useless for the one case it exists for.
// 2. The key must NOT go in the request body. It is transport metadata; the server reads the header.

import { randomUUID } from 'node:crypto';
import { makeColorizer, sanitizeForTerminal, statusColor } from '../output/human.ts';
import { RateLimitError, TransportError } from '../api/errors.ts';
import type { MercuryClientError } from '../api/errors.ts';
import type { CreateRunRequest, CreateRunResponse } from '../api/protocol.ts';

export interface CreateRunClient {
  createRun(request: CreateRunRequest, idempotencyKey: string): Promise<CreateRunResponse>;
}

export interface CreateOptions {
  /** Operator-supplied key. When absent, one is generated before the first request. */
  idempotencyKey?: string;
  /** Extra attempts after the first. One is enough: two independent transport failures in a row
   *  means the endpoint is down, and retrying further just delays the operator. */
  maxRetries?: number;
  /** Injectable so tests do not sleep for the server's requested backoff. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; reason: string; key: string; waitMs: number }) => void;
}

export interface CreateOutcome {
  response: CreateRunResponse;
  /** The key that was actually sent. Always present, including on failure paths via the error. */
  key: string;
  /** True when the operator supplied the key, so output can say so rather than implying we chose it. */
  keyWasSupplied: boolean;
  attempts: number;
}

/**
 * A create that failed after its attempts were exhausted.
 *
 * Carries the key because the operator needs it to retry safely. Without this, the only honest advice
 * after "the server did not answer" is "you might have two Runs now" -- with it, rerunning with
 * --idempotency-key is guaranteed to be safe.
 */
export class CreateUncertainError extends Error {
  readonly exitCode: number;
  readonly key: string;
  readonly attempts: number;

  constructor(message: string, key: string, attempts: number, exitCode: number) {
    super(message);
    this.name = 'CreateUncertainError';
    this.key = key;
    this.attempts = attempts;
    this.exitCode = exitCode;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * POST /api/runs, retrying only where a retry is safe.
 *
 * Retried: transport failures (the request may never have arrived) and 429 with a bounded
 * Retry-After. NOT retried: 4xx validation, auth, conflicts -- retrying those unchanged cannot help,
 * and for 409 it would be wrong to imply the conflict might clear.
 */
export async function createRunIdempotent(
  client: CreateRunClient,
  request: CreateRunRequest,
  options: CreateOptions = {},
): Promise<CreateOutcome> {
  const key = options.idempotencyKey ?? generateKey();
  const keyWasSupplied = options.idempotencyKey !== undefined;
  const maxRetries = options.maxRetries ?? 1;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: MercuryClientError | undefined;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      const response = await client.createRun(request, key);
      return { response, key, keyWasSupplied, attempts: attempt };
    } catch (err) {
      const failure = err as MercuryClientError;
      lastError = failure;
      const retryable = failure instanceof TransportError || failure instanceof RateLimitError;
      if (!retryable || attempt > maxRetries) break;

      // Honour the server's Retry-After when it sent one, capped so a hostile or misconfigured value
      // cannot park the command for hours.
      const requested = failure instanceof RateLimitError ? failure.retryAfterSeconds : undefined;
      const waitMs = Math.min(requested === undefined ? 500 : requested * 1000, 10_000);
      options.onRetry?.({ attempt, reason: failure.message, key, waitMs });
      await sleep(waitMs);
    }
  }

  // A DEFINITE rejection must propagate unchanged.
  //
  // Wrapping a 400 in CreateUncertainError would tell the operator "the Run may or may not have been
  // created, rerun with this key" when the server has said plainly that it was not created. That is not
  // merely untidy: it invites a pointless rerun, and it reports a validation or permission problem under
  // a transport-shaped message. Only an INDETERMINATE outcome earns the key advice, so only those reach
  // CreateUncertainError.
  if (!(lastError instanceof TransportError) && !(lastError instanceof RateLimitError)) {
    throw lastError;
  }

  const reason = lastError.message;
  throw new CreateUncertainError(
    `create did not complete after ${maxRetries + 1} attempt(s): ${reason}\n` +
      `The Run may or may not have been created. To retry safely, rerun with:\n` +
      `  --idempotency-key ${key}`,
    key,
    maxRetries + 1,
    lastError.exitCode,
  );
}

/** RFC 4122 v4. Unique enough that two invocations never collide, and opaque to the server. */
export function generateKey(): string {
  return randomUUID();
}

/**
 * Render a successful create.
 *
 * The idempotency key is NOT printed on stdout in human mode. It is a transport detail that the
 * operator does not need on every success, and putting it in the primary line would push the two facts
 * they came for -- which Run, what status -- off the first line. It goes to stderr as a diagnostic, and
 * into the JSON object, which is what §8 asks for ("verbose diagnostics" and "structured command
 * metadata"). On FAILURE the key is on stderr too, and there it is the most important line in the
 * output, because it is the only way to retry without risking a duplicate Run.
 */
export function renderCreate(
  outcome: CreateOutcome,
  ctx: { json: boolean; noColor: boolean },
  isTty: boolean,
): string {
  if (ctx.json) {
    return JSON.stringify({
      runId: outcome.response.runId,
      status: outcome.response.status,
      idempotencyKey: outcome.key,
      keyWasSupplied: outcome.keyWasSupplied,
      attempts: outcome.attempts,
    });
  }
  const { color } = makeColorizer({ noColor: ctx.noColor, isTty, json: ctx.json });
  return `${color('green', 'created')} ${color('cyan', sanitizeForTerminal(outcome.response.runId))} ` +
    `is now ${color(statusColor(outcome.response.status), outcome.response.status)}`;
}

/** The stderr diagnostic that accompanies a successful create in human mode. */
export function createKeyDiagnostic(outcome: CreateOutcome): string {
  const origin = outcome.keyWasSupplied ? 'supplied key' : 'generated key';
  const retry = outcome.attempts > 1 ? ` after ${outcome.attempts} attempt(s)` : '';
  return `idempotency ${origin} ${outcome.key}${retry}`;
}

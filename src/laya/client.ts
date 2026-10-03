/**
 * The HTTP client for the Laya sidecar (docs/laya-integration-design.md §5.2).
 *
 * Zero dependencies (`node:http`), the same shape as the Atlas client but STRICTER, because a Laya
 * answer selects what Mercury runs: no retry (a missed decision falls back), a total per-request
 * deadline (default 500 ms — selection sits on the dispatch path), a 64 KiB response cap, a request
 * built from an allowlist, and the state passed through the host redactor BEFORE it leaves the
 * process.
 *
 * Every failure — transport, deadline, HTTP status, malformed or invalid body — comes back as the
 * `{ok: false, reason}` arm of the discriminated union. Nothing here throws past the caller for a
 * Laya failure: the §6.4 decision rule turns each reason into "fallback, reason recorded".
 */

import * as http from 'node:http';
import { createRedactor, type Redactor } from '../domain/redact.ts';
import type { LayaAnswer, LayaFailureReason, LayaOption, LayaRequest, LayaResult, LayaState } from './types.ts';

/** 64 KiB (§5.2): the response is a pick and a distribution, not a document. */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
/** §5.2 / §10: selection sits on the dispatch path; half a second, not the Atlas 15 s. */
export const DEFAULT_TIMEOUT_MS = 500;
/** §6.3: at most 12 candidates — options share a fixed token budget upstream. */
export const MAX_OPTIONS = 12;

export interface LayaClientOptions {
  /** Base URL, e.g. `http://127.0.0.1:8302` (no path; the client appends `/v1/systemone`). */
  baseUrl: string;
  /** Bearer token (`LAYA_API_KEY`). */
  apiKey: string;
  /** Total per-request deadline in ms (default 500). */
  timeoutMs?: number;
  /** Response body cap in bytes (default 64 KiB). */
  maxResponseBytes?: number;
  /** Secret literal patterns for the redactor (the host's `MERCURY_SECRETS`-shaped list). */
  secrets?: string[];
  /** Injectable transport (tests); defaults to `node:http`. */
  transport?: LayaTransport;
  /** Injectable redactor (defaults to one built from `secrets`). */
  redactor?: Redactor;
  /** Injectable monotonic clock for latency (tests). */
  now?: () => number;
}

export interface LayaCall {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** The cap the transport enforces while reading the response (§5.2). */
  maxResponseBytes: number;
}

export type LayaTransport = (req: LayaCall) => Promise<{ status: number; body: Buffer }>;

/**
 * The default transport. Resolves only when the response is COMPLETE and within the cap; a body
 * that exceeds the cap rejects with `over_cap` (the socket is destroyed — an over-cap answer is
 * dropped, never truncated into a plausible-looking smaller one).
 */
export function layaNodeTransport(): LayaTransport {
  return (req) => new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(req.url);
    } catch (err) {
      reject({ reason: 'unreachable', detail: `invalid Laya URL: ${(err as Error).message}` });
      return;
    }
    const r = http.request(target, { method: 'POST', headers: req.headers }, (res) => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let total = 0;
      let capped = false;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > req.maxResponseBytes) {
          capped = true;
          r.destroy();
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (capped) {
          reject({ reason: 'over_cap', detail: `response exceeded ${req.maxResponseBytes} bytes` });
          return;
        }
        resolve({ status, body: Buffer.concat(chunks) });
      });
      res.on('error', () => {
        if (capped) {
          reject({ reason: 'over_cap', detail: `response exceeded ${req.maxResponseBytes} bytes` });
        } else {
          reject({ reason: 'unreachable', detail: 'response failed' });
        }
      });
    });
    // ONE total deadline for the whole call (§5.2): connect + send + receive. `request.setTimeout`
    // is an inactivity timeout; the timer below is the contract's total deadline.
    const timer = setTimeout(() => {
      r.destroy();
      reject({ reason: 'timeout', detail: `deadline ${req.timeoutMs}ms exceeded` });
    }, req.timeoutMs);
    r.on('close', () => clearTimeout(timer));
    r.on('error', (err) => {
      clearTimeout(timer);
      reject({ reason: 'unreachable', detail: err.message });
    });
    r.write(req.body);
    r.end();
  });
}

/** Build the state block from an allowlist (§6.3) and redact it before it can leave the process.
 *  Redaction failure is a TYPED failure (`redaction_failed`), never a throw past the caller. */
export function buildLayaState(input: { task: string; template: string; repository: string; skills: string[] }, redactor: Redactor): { ok: true; state: LayaState } | { ok: false; reason: LayaFailureReason; detail: string } {
  try {
    const state: LayaState = {
      // §6.3 allowlist, in this order, nothing else. EVERY string field passes the redactor
      // (#837 r1): the boundary must not depend on where a secret appears -- a declared secret
      // inside a template name, a repository basename or a skill id leaves otherwise.
      task: redactor.redact(input.task),
      template: redactor.redact(input.template),
      // URL or path basename only (§6.3).
      repository: redactor.redact(basenameOf(input.repository)),
      skills: input.skills.map((s) => redactor.redact(s)),
    };
    return { ok: true, state };
  } catch (err) {
    return { ok: false, reason: 'redaction_failed', detail: (err as Error).message };
  }
}

function basenameOf(repository: string): string {
  if (repository.length === 0) return repository;
  // URL-like input (#837 r2): query and fragment must never reach the sidecar - a signed URL can
  // carry credentials in its query. Parse and keep the pathname; a non-URL string fails the parse
  // and is treated as a plain path.
  let candidate = repository;
  try {
    const parsed = new URL(repository);
    candidate = parsed.pathname;
  } catch {
    // not a URL - keep the raw string
  }
  const trimmed = candidate.replace(/\/+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** Validate a parsed response body against the OFFERED options, fail-closed (§5.2). */
export function validateLayaBody(body: unknown, offeredKeys: Set<string>): { ok: true; answers: LayaAnswer[]; checkpoint: string } | { ok: false; reason: LayaFailureReason; detail: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'malformed', detail: 'response is not a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.checkpoint !== 'string' || b.checkpoint.length === 0) {
    return { ok: false, reason: 'malformed', detail: 'checkpoint missing or not a string' };
  }
  if (!Array.isArray(b.answers)) {
    return { ok: false, reason: 'malformed', detail: 'answers missing or not an array' };
  }
  if (b.answers.length === 0) {
    return { ok: false, reason: 'empty_answers', detail: 'answers array is empty' };
  }
  const answers: LayaAnswer[] = [];
  for (const raw of b.answers) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: 'malformed', detail: 'answer is not an object' };
    }
    const a = raw as Record<string, unknown>;
    if (typeof a.key !== 'string' || !offeredKeys.has(a.key)) {
      return { ok: false, reason: 'unknown_answer_key', detail: `answer key ${JSON.stringify(a.key)} was not offered` };
    }
    if (typeof a.choice !== 'string' || !offeredKeys.has(a.choice)) {
      return { ok: false, reason: 'choice_not_offered', detail: `choice ${JSON.stringify(a.choice)} is not among the offered keys` };
    }
    if (typeof a.probability !== 'number' || !Number.isFinite(a.probability)) {
      return { ok: false, reason: 'non_finite_probability', detail: `probability ${JSON.stringify(a.probability)} is not finite` };
    }
    answers.push({ key: a.key, choice: a.choice, probability: a.probability });
  }
  return { ok: true, answers, checkpoint: b.checkpoint };
}

export class LayaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly transport: LayaTransport;
  private readonly redactor: Redactor;
  private readonly now: () => number;

  constructor(opts: LayaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.transport = opts.transport ?? layaNodeTransport();
    this.redactor = opts.redactor ?? createRedactor(opts.secrets ?? []);
    this.now = opts.now ?? Date.now;
  }

  /** Ask the sidecar one `choice` question. Never throws for a Laya failure (§5.2). */
  async ask(question: { options: LayaOption[] }, stateInput: { task: string; template: string; repository: string; skills: string[] }): Promise<LayaResult> {
    const started = this.now();
    // >12 options is refused before any request (§6.3): a config written beyond the cap is an
    // operator error the caller must see at its own layer, not a sidecar round-trip.
    if (question.options.length === 0 || question.options.length > MAX_OPTIONS) {
      return { ok: false, reason: 'malformed', detail: `1-${MAX_OPTIONS} options required, got ${question.options.length}`, latencyMs: this.now() - started };
    }
    const built = buildLayaState(stateInput, this.redactor);
    if (!built.ok) {
      return { ok: false, reason: built.reason, detail: built.detail, latencyMs: this.now() - started };
    }
    // Rebuild each option from its allowlisted fields (#837 r3): structural typing would forward
    // whatever extra fields the caller's objects carry (agent, model, credential...), and the
    // request allowlist (§6.3) is the boundary, not the caller's type.
    const options = question.options.map((o) => ({ key: o.key, describe: o.describe }));
    const body: LayaRequest = { question: { options }, state: built.state };
    const offeredKeys = new Set(question.options.map((o) => o.key));
    const url = `${this.baseUrl}/v1/systemone`;
    let reply: { status: number; body: Buffer };
    try {
      reply = await this.transport({
        url,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        timeoutMs: this.timeoutMs,
        maxResponseBytes: this.maxResponseBytes,
      });
    } catch (err) {
      const e = err as { reason?: LayaFailureReason; detail?: string };
      const reason: LayaFailureReason = e?.reason ?? 'unreachable';
      return { ok: false, reason, detail: e?.detail, latencyMs: this.now() - started };
    }
    if (reply.status < 200 || reply.status >= 300) {
      return { ok: false, reason: 'http_status', detail: `POST /v1/systemone -> ${reply.status}`, latencyMs: this.now() - started };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(reply.body.toString('utf8'));
    } catch (err) {
      return { ok: false, reason: 'malformed', detail: `body is not JSON: ${(err as Error).message}`, latencyMs: this.now() - started };
    }
    const validated = validateLayaBody(parsed, offeredKeys);
    if (!validated.ok) {
      return { ok: false, reason: validated.reason, detail: validated.detail, latencyMs: this.now() - started };
    }
    return { ok: true, answers: validated.answers, checkpoint: validated.checkpoint, latencyMs: this.now() - started };
  }
}

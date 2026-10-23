/**
 * `nightly/model.ts` — the model-endpoint preflight (#1040).
 *
 * A crashed or reloading model server does not fail a Run at creation: the Run starts, the agent
 * follows the skill, `next.ts run` CLAIMS an issue `nightly:in-progress`, and only then does the
 * first model call fail. On 2026-10-23 that pattern cost a whole night: oMLX was down, 17 Runs
 * failed, and every one of them had already claimed its issue, so the morning had nothing to show
 * but failures and stale claims.
 *
 * This check runs BEFORE the claim. It answers one question -- "would a model call work right
 * now?" -- and answers it with a record, not an exception:
 *
 *   {"status":"ok","model":"…","endpoint":"…"}
 *   {"status":"model-missing","model":"…","endpoint":"…","reason":"…"}
 *   {"status":"unreachable","model":"…","endpoint":"…","reason":"…"}
 *   {"status":"unauthorized","model":"…","endpoint":"…","reason":"…"}
 *
 * Exit codes: 0 ok, 1 not usable (unreachable/timeout/unauthorized/5xx), 2 model not listed,
 * 64 usage. The caller decides what to do; `next.ts run --task` refuses to claim on any non-ok.
 *
 * The model id is read from the bot config that RUNS the task (`template.model`), so the pin stays
 * in one place. The endpoint and key default to the operator's local oMLX; both are overridable.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Bounded: an endpoint that does not answer in this window is DOWN for our purposes. */
export const MODEL_CHECK_TIMEOUT_MS = 5_000;

export type ModelStatus = 'ok' | 'model-missing' | 'unreachable' | 'unauthorized';

export interface ModelCheck {
  status: ModelStatus;
  model: string;
  endpoint: string;
  reason?: string;
}

export interface ModelCheckIo {
  /** Returns status + parsed body. Transport failures (DNS, refused, timeout) THROW and are
   * caught by the checker, which reports them as `unreachable`. */
  fetchJson(url: string, init: { headers: Record<string, string>; timeoutMs: number }): Promise<{ status: number; body: unknown }>;
}

export interface CheckModelOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  io?: ModelCheckIo;
}

/** The admin listing is the authoritative one (it knows every model on disk, loaded or not); the
 * OpenAI-compatible `/v1/models` is the fallback for a server that does not expose admin routes. */
const LIST_PATHS = ['/admin/api/models', '/v1/models'];

function modelIds(body: unknown): string[] | null {
  if (Array.isArray(body)) {
    return body.flatMap((m) => (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string' ? [(m as { id: string }).id] : []));
  }
  if (body && typeof body === 'object') {
    const models = (body as { models?: unknown }).models;
    if (Array.isArray(models)) return modelIds(models);
    const data = (body as { data?: unknown }).data;
    if (Array.isArray(data)) return modelIds(data);
  }
  return null;
}

const defaultIo: ModelCheckIo = {
  async fetchJson(url, init) {
    const res = await fetch(url, {
      headers: init.headers,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = text === '' ? null : JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  },
};

/**
 * Ask the endpoint whether `model` is available. Never throws: every failure becomes a record,
 * because the caller's whole job is to report one.
 */
export async function checkModel(opts: CheckModelOptions): Promise<ModelCheck> {
  const io = opts.io ?? defaultIo;
  const endpoint = opts.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  let last: { status: number; body: unknown } | null = null;
  for (const path of LIST_PATHS) {
    let res: { status: number; body: unknown };
    try {
      res = await io.fetchJson(`${endpoint}${path}`, { headers, timeoutMs: MODEL_CHECK_TIMEOUT_MS });
    } catch (e) {
      // Refused / DNS / timeout: the server is not answering, and no other path will change that.
      return { status: 'unreachable', model: opts.model, endpoint, reason: describe(e) };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 'unauthorized', model: opts.model, endpoint, reason: `${path} -> ${res.status}` };
    }
    if (res.status === 404) { last = res; continue; } // no admin routes: try the next shape
    if (res.status < 200 || res.status >= 300) {
      return { status: 'unreachable', model: opts.model, endpoint, reason: `${path} -> ${res.status}` };
    }
    const ids = modelIds(res.body);
    if (ids === null) {
      return { status: 'unreachable', model: opts.model, endpoint, reason: `${path} returned no model list` };
    }
    if (ids.includes(opts.model)) return { status: 'ok', model: opts.model, endpoint };
    return {
      status: 'model-missing',
      model: opts.model,
      endpoint,
      reason: `${ids.length} model(s) listed, none named '${opts.model}'`,
    };
  }
  return { status: 'unreachable', model: opts.model, endpoint, reason: `no model listing at ${endpoint}${last ? ` (last -> ${last.status})` : ''}` };
}

function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  // AbortSignal.timeout produces a TimeoutError; a refused socket arrives as `fetch failed` whose
  // cause is an AggregateError over the per-address errors (localhost tries ::1 and 127.0.0.1), so
  // the useful code is one level deeper than `cause.code` -- without it the record says only
  // "fetch failed", which is exactly the unhelpful line this check exists to replace.
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return `no answer within ${MODEL_CHECK_TIMEOUT_MS}ms`;
  const code = errorCode(e);
  if (code) return `${e.message} (${code})`;
  // No errno at all (undici's "bad port", a TLS handshake refusal): the cause's message is the only
  // specific text there is, and it is far better than repeating "fetch failed".
  const causeMessage = (e as { cause?: { message?: unknown } }).cause?.message;
  if (typeof causeMessage === 'string' && causeMessage !== '' && causeMessage !== e.message) {
    return `${e.message} (${causeMessage})`;
  }
  return e.message;
}

function errorCode(e: unknown, depth = 0): string | undefined {
  if (!e || typeof e !== 'object' || depth > 3) return undefined;
  const direct = (e as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const nested = (e as { errors?: unknown }).errors;
  if (Array.isArray(nested)) {
    for (const inner of nested) {
      const code = errorCode(inner, depth + 1);
      if (code) return code;
    }
  }
  return errorCode((e as { cause?: unknown }).cause, depth + 1);
}

/** Read the model a bot task pins, from the bot config that schedules it. The pin has exactly one
 * home; a preflight that took its own copy of the model id would drift from the Run's. */
export function resolveTaskModel(task: string, configPath?: string): string {
  const path = configPath ?? join(process.env.MERCURY_CONFIG_HOME ?? join(homedir(), '.config', 'mercury'), 'bots', 'nightly.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as { schedule?: { tasks?: { name?: string; template?: { model?: string } }[] } };
  const tasks = cfg.schedule?.tasks ?? [];
  const found = tasks.find((t) => t.name === task);
  if (!found) throw new Error(`${path} has no task named '${task}' (tasks: ${tasks.map((t) => t.name).join(', ') || 'none'})`);
  const model = found.template?.model;
  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error(`task '${task}' in ${path} pins no model; the preflight has nothing to check`);
  }
  return model;
}

/** The operator's local oMLX by default; the key comes from the same file the agent runtime reads. */
export function defaultEndpoint(): string {
  return (process.env.OMLX_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');
}

export function defaultApiKey(provider = 'omlx'): string | undefined {
  if (process.env.OMLX_API_KEY) return process.env.OMLX_API_KEY;
  try {
    const p = join(homedir(), '.prime', 'agent', 'models.json');
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as { providers?: Record<string, { apiKey?: string }> };
    const key = cfg.providers?.[provider]?.apiKey;
    return typeof key === 'string' && key !== '' ? key : undefined;
  } catch {
    return undefined;
  }
}

/** One JSON line, the nightly scripts' output contract. */
export function exitCodeFor(check: ModelCheck): number {
  if (check.status === 'ok') return 0;
  return check.status === 'model-missing' ? 2 : 1;
}

// ---- CLI ----

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const cmd = args[0] ?? 'check';
  try {
    if (cmd !== 'check') throw new Error('usage: model.ts check [--task <name>] [--model <id>] [--bot-config <path>] [--base-url <url>] [--api-key <key>]');
    const task = flag('--task');
    const model = flag('--model') ?? (task ? resolveTaskModel(task, flag('--bot-config')) : undefined);
    if (!model) throw new Error('pass --task <bot task> (reads its pinned model) or --model <id>');
    const check = await checkModel({
      model,
      baseUrl: flag('--base-url') ?? defaultEndpoint(),
      apiKey: flag('--api-key') ?? defaultApiKey(),
    });
    process.stdout.write(JSON.stringify(check) + '\n');
    if (check.status !== 'ok') {
      process.stderr.write(`model ${check.status}: ${check.model} at ${check.endpoint}${check.reason ? ` — ${check.reason}` : ''}\n`);
      process.exit(exitCodeFor(check));
    }
  } catch (e) {
    process.stderr.write(String(e instanceof Error ? e.message : e) + '\n');
    process.exit(64);
  }
}

/**
 * A minimal HTTP layer: bearer auth, JSON bodies, and a route table with no dependencies.
 *
 * Atlas declares no runtime dependencies, exactly as Fleet does (section 11.6 applies Fleet's coupling
 * rule a second time). The host uses express; Atlas cannot import it, and adding it would make Atlas a
 * second web framework to keep patched for a surface this small. `node:http` plus this file is enough,
 * and "enough" is checked by the tests rather than asserted here.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Caller } from './auth.ts';
import type { Logger } from './logger.ts';

export interface RequestContext {
  caller: Caller;
  /** Only the CAPTURED pattern segments, in order -- not the full path. Indexing past the captures
   *  must be impossible, which is why `params` is typed as a tuple-ish array the router fills. */
  params: string[];
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  log: Logger;
}

export type Handler = (ctx: RequestContext, res: ServerResponse) => Promise<void> | void;

export interface Route {
  method: string;
  /** Pattern segments; a leading ':' captures that position. */
  pattern: string[];
  /** Registry administration and curation require the admin class, not merely a contributor. */
  admin?: boolean;
  /** Contributor OR reader -- the read surface. Absent means any authenticated class. */
  readOnly?: boolean;
  /** Skip caller authentication entirely -- only /healthz. */
  public?: boolean;
  handle: Handler;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Decode one path segment, refusing a malformed one instead of throwing.
 *
 * `decodeURIComponent` throws `URIError` on input like `%zz` or a truncated UTF-8 escape. Called from
 * route matching, that throw happens BEFORE authentication and before the request handler's try/catch,
 * so it escapes to the process: the socket is never answered and the connection hangs until the client
 * gives up. An unauthenticated caller could hold a listener's sockets open at will with a single
 * character in the URL.
 *
 * A malformed escape is the client's mistake, so it is a 400 rather than a 404. Returning "no such
 * route" would be a lie about a route that does exist, and would hide a broken client behind a
 * not-found.
 */
export function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'the request path contains a malformed percent-escape');
  }
}

export function matchRoute(routes: Route[], method: string, path: string): { route: Route; params: string[] } | null {
  const parts = path.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.pattern.length !== parts.length) continue;
    const params: string[] = [];
    let ok = true;
    for (let i = 0; i < route.pattern.length; i++) {
      const p = route.pattern[i]!;
      if (p.startsWith(':')) params.push(decodeSegment(parts[i]!));
      else if (p !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

/**
 * The request body ceiling.
 *
 * A batch is bounded by `ATLAS_MAX_BATCH` ITEMS, which says nothing about their SIZE: a caller could
 * send 500 notes at the claim and detail ceilings and still arrive in one request. The byte bound is
 * what actually protects the process, and it is read while streaming rather than after, so an
 * oversized body is refused rather than buffered first.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    throw new HttpError(400, `request body is not valid JSON: ${(err as Error).message}`);
  }
}

export interface AuthDeps {
  callers: { resolve(token: string | undefined): Caller | null };
}

/**
 * Resolve the caller from the Authorization header.
 *
 * Returns null rather than responding, so the caller decides the status. A missing credential is 401;
 * a credential that is valid but not bound to the named project is 404, not 403 -- section 11.1 is
 * explicit that the existence of a project is itself information, for the same reason the host's owner
 * scoping answers 404 for a foreign Run.
 */
export function authenticate(req: IncomingMessage, deps: AuthDeps): Caller | null {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  return deps.callers.resolve(match[1]!);
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2) + '\n';
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

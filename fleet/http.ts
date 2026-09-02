/**
 * A minimal HTTP layer: bearer auth, JSON bodies, and a route table with no dependencies.
 *
 * Fleet deliberately declares no runtime dependencies (docs/fleet-design.md section 11, enforced by
 * fleet/test/coupling.test.ts). Mercury uses express; Fleet cannot import it and adding it would make Fleet
 * a second web framework to keep patched for a surface this small. node:http plus this file is enough, and
 * "enough" is checked by the tests rather than asserted here.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Caller } from './auth.ts';
import { isAdminToken } from './auth.ts';
import type { Logger } from './logger.ts';

export interface RequestContext {
  caller: Caller;
  /**
   * Only the CAPTURED pattern segments, in order. For pattern ['fleet','hosts',':id'] against
   * /fleet/hosts/box-1 this is ['box-1'] -- NOT the full path. Indexing past the captures yields undefined,
   * which previously reached a SQLite bind as a 500 rather than a 404.
   */
  params: string[];
  query: URLSearchParams;
  body: unknown;
  log: Logger;
}

export type Handler = (ctx: RequestContext, res: ServerResponse) => Promise<void> | void;

export interface Route {
  method: string;
  /** Pattern segments; a leading ':' captures that position. */
  pattern: string[];
  /** Registry administration requires the admin token, not merely a caller token. */
  admin?: boolean;
  /** Skip caller authentication entirely -- only /healthz. */
  public?: boolean;
  handle: Handler;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function matchRoute(routes: Route[], method: string, path: string):
  { route: Route; params: string[] } | null {
  const parts = path.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.pattern.length !== parts.length) continue;
    const params: string[] = [];
    let ok = true;
    for (let i = 0; i < route.pattern.length; i++) {
      const p = route.pattern[i]!;
      if (p.startsWith(':')) params.push(decodeURIComponent(parts[i]!));
      else if (p !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

const MAX_BODY_BYTES = 1024 * 1024;

/** Read and parse a JSON body, bounded. An unbounded read is a memory-exhaustion route. */
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
  callers: { resolve(token: string): Caller | null };
  adminToken: string | null;
}

/**
 * Resolve the caller from the Authorization header.
 *
 * Returns null rather than responding, so the caller of this function decides the status: a missing
 * credential is 401 and a credential that names a host the caller may not touch is 403. Collapsing those
 * tells an operator nothing about which of the two problems they have.
 */
export function authenticate(req: IncomingMessage, deps: AuthDeps): Caller | null {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const token = m[1]!;
  if (isAdminToken(deps.adminToken, token)) {
    return { ownerId: 'admin', isAdmin: true, allowedHosts: '*' };
  }
  return deps.callers.resolve(token);
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2) + '\n';
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// Credential resolution for the Mercury API (Mercury.md section 24).
//
// Accepts EITHER:
//   - `Authorization: Bearer <token>` — token maps to an owner via MERCURY_API_TOKENS
//     (or matches MERCURY_ADMIN_TOKEN for an admin session), OR
//   - an `mercury_session` cookie issued by POST /api/auth/login (see sessions.ts).
//
// The middleware is PERMISSIVE: it only populates `req.auth` when a valid
// credential is present and never blocks the request. Gating is done by
// requireAuth() (mounted on the /api routes) and by the public auth endpoints
// themselves. This is what keeps POST /api/auth/login reachable without auth.

import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE, parseCookies, type SessionStore } from './sessions.ts';

export interface AuthContext {
  ownerId: string;
  isAdmin: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * Constant-time secret comparison. `timingSafeEqual` throws on unequal lengths, so the lengths are
 * compared first -- that leaks only the token's length, not any prefix byte, which is the standard
 * trade-off. `===` short-circuits on the first differing byte, so a caller able to measure response
 * timing could walk the admin token one byte at a time. Over a network that is a hard attack to pull
 * off, which is why this was filed Low; it is cheap enough that there is no reason to leave it.
 */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * The ONE credential resolver. Both callers must use it.
 *
 * There used to be two: this logic inline in the middleware with `token === adminToken`, and a
 * constant-time copy in authRoutes.ts. Round 1's timing-safe fix (#124) landed on the authRoutes copy
 * only, so the path every /api request takes kept the byte-at-a-time comparison for a whole release
 * (issue #140). The duplication is the finding; the `===` was only the symptom it produced, and a
 * third caller added today would have had two equally plausible places to copy from.
 */
export function resolveCredential(
  tokens: Map<string, string>,
  adminToken: string | null,
  token: string,
): AuthContext | null {
  // Belt and braces. This is NOT currently load-bearing: the bearer regex requires at least one
  // character, parseTokens refuses an empty key, and the `adminToken &&` below is falsy for the empty
  // string that MERCURY_ADMIN_TOKEN='' produces (it does NOT become null). All three hold in other
  // files, which is why the guard stays -- and why the empty-token case is asserted in the test
  // rather than relying on this line. Deleting it changes no observable behaviour today.
  if (!token) return null;
  if (adminToken && secretsEqual(token, adminToken)) return { ownerId: '*', isAdmin: true };
  const ownerId = tokens.get(token);
  return ownerId ? { ownerId, isAdmin: false } : null;
}

export function createAuthMiddleware(
  tokens: Map<string, string>,
  adminToken: string | null,
  sessions?: SessionStore,
) {
  return function auth(req: Request, _res: Response, next: NextFunction): void {
    // 1) Bearer token (API clients, curl, CI).
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match) {
      // One shared resolver, deliberately: this used to be an inline `token === adminToken` while
      // POST /api/auth/login had a constant-time copy of the same logic. The security fix reached the
      // lower-traffic path only, and this is the path EVERY /api request takes (issue #140).
      const auth = resolveCredential(tokens, adminToken, match[1]);
      if (auth) {
        req.auth = auth;
        next();
        return;
      }
      // Invalid bearer token: leave req.auth unset; the route gate 401s.
      next();
      return;
    }

    // 2) Session cookie (dashboard).
    if (sessions) {
      const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (sid) {
        const session = sessions.get(sid); // Map lookup with lazy expiry
        if (session) {
          req.auth = { ownerId: session.ownerId, isAdmin: session.isAdmin };
          next();
          return;
        }
      }
    }

    // No (valid) credentials — public endpoints may proceed; gated routes 401 via requireAuth.
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  next();
}

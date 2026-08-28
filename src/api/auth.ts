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
      const token = match[1];
      if (adminToken && token === adminToken) {
        req.auth = { ownerId: '*', isAdmin: true };
        next();
        return;
      }
      const ownerId = tokens.get(token);
      if (ownerId) {
        req.auth = { ownerId, isAdmin: false };
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

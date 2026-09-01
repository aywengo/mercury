// Public auth endpoints: session login/logout/identity (Mercury.md section 24).
//
//   POST /api/auth/login   { token }  -> issues mercury_session cookie (HttpOnly)
//   POST /api/auth/logout  (cookie)   -> deletes session, clears cookie
//   GET  /api/auth/me                       -> { ownerId, isAdmin } | 401
//
// Mounted at /api/auth BEFORE the gated /api router, so login is reachable
// without any credential. Login is additionally rate-limited by the caller
// (see server.ts). The 401 body is generic on purpose: it must not reveal
// whether a submitted token is known to the server.

import { Router, type Request, type Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  parseCookies,
  sessionClearCookie,
  sessionCookie,
  sessionIsSecure,
  type SessionStore,
} from './sessions.ts';

export interface AuthRoutesDeps {
  tokens: Map<string, string>;
  adminToken: string | null;
  sessions: SessionStore;
  /**
   * Force `Secure` on the session cookie even when the request does not look encrypted
   * (MERCURY_COOKIE_SECURE=true). For deployments behind a proxy that does not forward
   * `X-Forwarded-Proto`. Off by default; encryption is otherwise detected per request.
   */
  cookieSecure?: boolean;
}

/**
 * Constant-time secret comparison. `timingSafeEqual` throws on unequal lengths, so the lengths are
 * compared first -- that leaks only the token's length, not any prefix byte, which is the standard
 * trade-off. `===` short-circuits on the first differing byte, so a caller able to measure response
 * timing could walk the admin token one byte at a time. Over a network that is a hard attack to
 * pull off, which is why this was filed Low; it is cheap enough that there is no reason to leave it.
 */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function resolveCredential(tokens: Map<string, string>, adminToken: string | null, token: string): { ownerId: string; isAdmin: boolean } | null {
  if (!token) return null;
  if (adminToken && secretsEqual(token, adminToken)) return { ownerId: '*', isAdmin: true };
  const ownerId = tokens.get(token);
  return ownerId ? { ownerId, isAdmin: false } : null;
}

export function createAuthRoutes(deps: AuthRoutesDeps): Router {
  const router = Router();

  router.post('/login', (req: Request, res: Response) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const auth = resolveCredential(deps.tokens, deps.adminToken, token);
    if (!auth) {
      // Generic error (no 'token not found' vs 'empty token' distinction).
      res.status(401).json({ error: 'invalid token' });
      return;
    }
    // 256-bit random session id; stored server-side (sessions.ts).
    const sid = randomBytes(32).toString('hex');
    deps.sessions.set(sid, {
      ownerId: auth.ownerId,
      isAdmin: auth.isAdmin,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    res.setHeader(
      'Set-Cookie',
      sessionCookie(sid, { secure: sessionIsSecure(req, deps.cookieSecure), maxAgeMs: SESSION_TTL_MS }),
    );
    res.json({ ok: true, ownerId: auth.ownerId, isAdmin: auth.isAdmin });
  });

  router.post('/logout', (req: Request, res: Response) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) deps.sessions.delete(sid);
    res.setHeader('Set-Cookie', sessionClearCookie({ secure: sessionIsSecure(req, deps.cookieSecure) }));
    res.json({ ok: true });
  });

  router.get('/me', (req: Request, res: Response) => {
    if (!req.auth) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    res.json({ ownerId: req.auth.ownerId, isAdmin: req.auth.isAdmin });
  });

  return router;
}

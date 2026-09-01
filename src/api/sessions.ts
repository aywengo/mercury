// Server-side session store for the dashboard (Mercury.md section 24).
//
// Sessions are issued on POST /api/auth/login by exchanging a configured API
// token for a random session id. The id is a 256-bit random value looked up
// directly in a Map — no timing-safe comparison needed (ids are never
// enumerated or compared byte-wise).
//
// STORAGE: in-memory Map. A DB-backed store (e.g. a mercury_sessions table in
// the existing SQLite database) is the scale path: it survives restarts and
// works across multiple API processes. For the single-process deployment this
// slice targets, the Map is correct and simple.

export const SESSION_COOKIE = 'mercury_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface Session {
  ownerId: string;
  isAdmin: boolean;
  expiresAt: number; // epoch ms; checked lazily on every access
}

export interface SessionStore {
  /** Returns the live session for an id, or null if unknown/expired (lazy expiry). */
  get(sid: string): Session | null;
  set(sid: string, session: Session): void;
  delete(sid: string): void;
}

export function createSessionStore(): SessionStore {
  const map = new Map<string, Session>();
  return {
    get(sid: string): Session | null {
      const session = map.get(sid);
      if (!session) return null;
      if (session.expiresAt <= Date.now()) {
        map.delete(sid); // lazy expiry: drop on access, no periodic sweep needed
        return null;
      }
      return session;
    },
    set(sid: string, session: Session): void {
      map.set(sid, session);
    },
    delete(sid: string): void {
      map.delete(sid);
    },
  };
}

/** Parse a Cookie request header into a name -> value record. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * Build the session Set-Cookie value.
 *
 * `secure` is not optional-by-omission (issue #64): the cookie used to be written without
 * `Secure` unconditionally, so a TLS deployment still sent the session id in cleartext on any
 * plain http:// request to the same host. Callers decide per request -- see
 * `sessionIsSecure` -- because "is this request encrypted" is not knowable at startup when TLS
 * terminates at a reverse proxy.
 */
export function sessionCookie(sid: string, opts: { secure: boolean; maxAgeMs: number }): string {
  return `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/`
    + `${opts.secure ? '; Secure' : ''}; Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`;
}

/** Set-Cookie value that clears the session cookie client-side. */
export function sessionClearCookie(opts: { secure: boolean }): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/`
    + `${opts.secure ? '; Secure' : ''}; Max-Age=0`;
}

/**
 * Whether a request arrived over an encrypted channel, and so whether the session cookie may
 * carry `Secure`.
 *
 * `req.secure` covers TLS terminated by THIS process (MERCURY_TLS_*). The forwarded-proto
 * header covers the documented production shape, where TLS terminates at a reverse proxy and
 * this process speaks plain http on loopback.
 *
 * Trusting the header when there is no proxy is a deliberate trade: the failure direction is
 * safe. A spoofed `X-Forwarded-Proto: https` yields a cookie that is MORE protected, not less
 * -- it simply will not be sent over http, which fails loudly in local dev rather than
 * silently weakening a session. The reverse (omitting Secure on a real HTTPS deployment) is the
 * bug being fixed. Operators behind a proxy that does not set the header can force it.
 */
export function sessionIsSecure(
  req: { secure?: boolean; headers: Record<string, unknown> },
  forceSecure = false,
): boolean {
  if (forceSecure) return true;
  if (req.secure) return true;
  const fwd = req.headers['x-forwarded-proto'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  return typeof first === 'string' && first.split(',')[0].trim().toLowerCase() === 'https';
}

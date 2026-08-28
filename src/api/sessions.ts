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

/** Set-Cookie value that clears the session cookie client-side. */
export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

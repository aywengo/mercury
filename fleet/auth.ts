/**
 * Caller authentication and the per-caller host allowlist (docs/fleet-design.md sections 9 and 15.3).
 *
 * Two credential boundaries exist and must not be conflated:
 *
 *   caller -> Fleet    tokens in FLEET_API_TOKENS. Never forwarded to a child.
 *   Fleet  -> child    credential_ref entries in the credential file.
 *
 * The allowlist is authorisation, not a filter. A caller permitted only for `box-lan-2` gets 403 when it
 * names another host; it does not get a silently narrowed choice, and it does not get to learn whether the
 * other host exists. Without this, one leaked Fleet token is every Mercury on the LAN, which is the whole
 * reason section 9 exists.
 */

import { timingSafeEqual } from 'node:crypto';

export interface Caller {
  ownerId: string;
  isAdmin: boolean;
  /** Hosts this caller may act on. `'*'` means every registered host. */
  allowedHosts: '*' | string[];
}

export interface CallerIndex {
  /** Resolve a bearer token. Null when it matches nothing. */
  resolve(token: string): Caller | null;
  /** Names only, for startup logging. Never the tokens. */
  owners(): string[];
  /** Owners whose token grants access to every host, for the startup warning. */
  unrestrictedOwners(): string[];
  /**
   * The token VALUES, for seeding the log redactor only -- nothing may print them.
   *
   * Needed for the same reason CredentialStore.secrets() is: a pattern pass cannot recognise a bare token
   * it has no label for, and a caller token in a log is the credential that reaches a whole fleet.
   */
  secrets(): string[];
  readonly size: number;
}

/**
 * Parse FLEET_API_TOKENS.
 *
 * Format: `token:owner[:hosts]`, entries separated by commas, where hosts is `*` or `host1+host2`.
 *
 * Omitting the hosts field grants NOTHING rather than everything. The permissive default would be the
 * convenient one, and it is the one that turns a single leaked token into fleet-wide access, so the safe
 * reading is the default and an operator has to type `:*` to widen it.
 */
export function parseCallerTokens(raw: string | undefined): CallerIndex {
  const map = new Map<string, Caller>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    const [token, owner, hosts] = parts;
    if (!token || !owner) continue;
    if (parts.length > 3) continue; // malformed rather than guessed at
    let allowed: '*' | string[];
    if (hosts === undefined || hosts === '') {
      allowed = [];
    } else if (hosts === '*') {
      allowed = '*';
    } else {
      const list = hosts.split('+').map((h) => h.trim()).filter(Boolean);
      allowed = list.length ? list : [];
    }
    map.set(token, { ownerId: owner, isAdmin: false, allowedHosts: allowed });
  }
  return {
    resolve(token: string) {
      return map.get(token) ?? null;
    },
    owners() {
      return [...map.values()].map((c) => c.ownerId).sort();
    },
    unrestrictedOwners() {
      return [...map.values()].filter((c) => c.allowedHosts === '*').map((c) => c.ownerId).sort();
    },
    secrets() {
      return [...map.keys()];
    },
    get size() {
      return map.size;
    },
  };
}

/**
 * Compare a bearer token against the admin token without leaking content through timing.
 *
 * A length mismatch returns false immediately. That discloses the length of the configured secret and
 * nothing about its content; padding to a common length would risk a comparison that reports equality on a
 * shared prefix, which is the worse failure.
 */
export function isAdminToken(adminToken: string | null, token: string): boolean {
  if (!adminToken) return false;
  const a = Buffer.from(adminToken, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function hostAllowed(caller: Caller, hostId: string): boolean {
  if (caller.isAdmin) return true;
  if (caller.allowedHosts === '*') return true;
  return caller.allowedHosts.includes(hostId);
}

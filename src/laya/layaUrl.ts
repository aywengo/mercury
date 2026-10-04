/**
 * The `MERCURY_LAYA_URL` shape contract (#830/#831, docs/configuration.md 'Laya sidecar').
 *
 * One validator for every boundary that accepts the variable: the setup wizard's answers, the
 * shared config loader (hand-written / service-provided env files bypass the wizard), and the
 * doctor (which reads and SENDS the sidecar credential — it must refuse before the bearer key
 * leaves the host). The rules:
 *
 * - absolute `http://` URL (the sidecar has no TLS; `https` would promise a listener that
 *   does not exist),
 * - loopback host only — the sidecar binds 127.0.0.1 and the bearer must not leave the host,
 * - BASE URL without a route path (LayaClient appends `/v1/systemone` itself),
 * - no query or fragment, no embedded user:password (the key lives in bot-credentials.json),
 * - no surrounding whitespace (only the empty string means "wizard-managed default").
 */

export function validateLayaBaseUrl(value: unknown, varName = 'MERCURY_LAYA_URL'): string | null {
  if (typeof value !== 'string') return `${varName} must be a string`;
  if (value.trim() === '') {
    // Whitespace-only is NOT the empty sentinel: only '' means "not configured / default".
    return value === '' ? null : `${varName} must not have leading or trailing whitespace`;
  }
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return `${varName} must be an absolute URL (e.g. http://127.0.0.1:8302)`;
  }
  if (u.protocol !== 'http:') return `${varName} must use http:// (the sidecar is loopback-only)`;
  // NOTE: not ::1 — Node's URL host for a bracketed IPv6 literal is '[::1]', which the env
  // value charset then rejects; advertising it would promise an input that can never pass
  // (Copilot #840 r24). The sidecar binds 127.0.0.1 anyway.
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
    return `${varName} must be a loopback host (127.0.0.1 or localhost), got '${u.hostname}'`;
  }
  if (u.pathname !== '/' && u.pathname !== '') return `${varName} must be a base URL without a route path (the client appends /v1/systemone), got '${u.pathname}'`;
  if (u.search || u.hash) return `${varName} must not carry a query or fragment`;
  // Bare delimiters parse away ('http://h:p?' → search '') but still change the request the
  // client builds — reject the literal characters too (Copilot #840 r44).
  if (value.includes('?')) return `${varName} must not carry a query or fragment`;
  if (value.includes('#')) return `${varName} must not carry a query or fragment`;
  // Padded URLs would pass the trimmed parse and then fail wherever the ORIGINAL value is
  // checked (renderEnv charset) — refuse at the boundary.
  if (value !== value.trim()) return `${varName} must not have leading or trailing whitespace`;
  // URL-only contract: an embedded user:password would be written to the env file and printed
  // by the external/dry-run paths — a credential smuggled into a 'plain URL' (Copilot #840 r23).
  if (u.username || u.password) return `${varName} must not contain a username or password (the key lives in bot-credentials.json)`;
  return null;
}

/** True when the value is the wizard-managed local default endpoint, compared CANONICALLY
 *  (parsed host/port/root path) so `http://127.0.0.1:8302/` classifies the same as the bare
 *  form (Copilot #840 r44). Only call on values that passed validateLayaBaseUrl. */
export function isWizardManagedLayaDefault(value: string, defaultPort: number): boolean {
  try {
    const u = new URL(value.trim());
    // Only the NUMERIC loopback the wizard emits/binds: localhost is a documented EXTERNAL
    // form — classifying it wizard-managed would install a competing unit over it (r45).
    return u.protocol === 'http:'
      && u.hostname === '127.0.0.1'
      && (u.port === '' ? 80 : Number(u.port)) === defaultPort
      && (u.pathname === '/' || u.pathname === '')
      && !u.search && !u.hash && !u.username && !u.password
      && !value.includes('?') && !value.includes('#');
  } catch {
    return false;
  }
}

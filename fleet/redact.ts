/**
 * Redaction for Fleet's own logs.
 *
 * Fleet cannot import Mercury's redactor -- the coupling rule in docs/fleet-design.md section 11 forbids it
 * -- and this is not cosmetic parity. Fleet holds a credential for every Mercury on the network, so a single
 * bearer token reaching a log file is a fleet-wide compromise sitting in a file with journald's retention.
 * The realistic path is mundane: an HTTP client error can echo request headers, and a stack trace that
 * carries a request object carries the Authorization header with it.
 *
 * Two mechanisms, because they fail differently:
 *
 *   - a generic pattern pass catches `Authorization: Bearer ...` wherever it appears, including in text
 *     written by code that forgot to be careful;
 *   - an exact-value pass over the known secrets catches a token that appears BARE, with no header name to
 *     anchor on. This is why the store is seeded at startup from the credential file: a pattern pass alone
 *     cannot recognise a secret it has no label for.
 */

export const REDACTED = '[REDACTED]';

export interface Redactor {
  redact(text: string): string;
  /** Number of distinct secrets seeded. Never the values. */
  readonly seededCount: number;
}

/**
 * Header-shaped secrets, matched structurally so unknown token formats are still caught.
 *
 * The value class stops at whitespace and quotes so a match cannot run past the end of the header into
 * surrounding text and redact a whole line, which would turn a leak into an unreadable log.
 */
const PATTERNS: RegExp[] = [
  /\b(authorization|proxy-authorization|x-api-key|x-auth-token)\b\s*[:=]\s*(?:bearer|basic|token)?\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // A URL that embedded credentials, e.g. after a fetch failure echoes the request target.
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"'`]+:[^@\s@"'`]+@/gi,
];

export function createRedactor(secrets: Iterable<string> = []): Redactor {
  // Longest first. Redacting a short secret before a longer one that contains it would leave the tail of
  // the long secret visible, which is still enough to correlate a leak.
  const values = [...new Set([...secrets].filter((s) => typeof s === 'string' && s.length >= 4))]
    .sort((a, b) => b.length - a.length);

  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const literal = values.length === 0 ? null : new RegExp(values.map(escapeRe).join('|'), 'g');

  return {
    redact(text: string): string {
      if (typeof text !== 'string' || text.length === 0) return text;
      let out = text;
      for (const re of PATTERNS) {
        out = out.replace(re, (m) => {
          const sep = m.match(/[:=]/);
          // Keep the header name so the log still says WHAT leaked, without saying what it leaked.
          return sep ? `${m.slice(0, m.indexOf(sep[0]!))}=${REDACTED}`.replace('=', ': ') : REDACTED;
        });
      }
      if (literal) out = out.replace(literal, REDACTED);
      return out;
    },
    get seededCount() {
      return values.length;
    },
  };
}

/**
 * Build the redactor a running Fleet service needs.
 *
 * Extracted from the serve path so that "every secret class Fleet holds is seeded" is a tested invariant
 * rather than a comment. It used to be a comment that was wrong: the code seeded child credentials only,
 * so a bare caller or admin token reaching a log line through an exception message went unredacted.
 */
export function createServiceRedactor(sources: {
  childSecrets: Iterable<string>;
  callerTokens: Iterable<string>;
  adminToken: string | null;
}): Redactor {
  return createRedactor([
    ...sources.childSecrets,
    ...sources.callerTokens,
    ...(sources.adminToken ? [sources.adminToken] : []),
  ]);
}

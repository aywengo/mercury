// Secret redaction for events and logs (Mercury.md section 24).

const DEFAULT_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(api[_-]?key|apikey|token|secret|password|passwd|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]+/gi,
  /xox[baprs]-[A-Za-z0-9-]+/g,
];

export interface Redactor {
  redact(text: string): string;
  redactJson(value: unknown): unknown;
}

export function createRedactor(secrets: string[] = []): Redactor {
  const literalPatterns = secrets
    .filter((s) => s.length > 0)
    .map((s) => new RegExp(escapeRegExp(s), 'g'));

  function redact(text: string): string {
    let out = text;
    for (const re of literalPatterns) out = out.replace(re, '[REDACTED]');
    for (const re of DEFAULT_PATTERNS) out = out.replace(re, (m) => {
      const idx = m.search(/[:=]\s*/);
      return idx >= 0 ? m.slice(0, idx + 1) + ' [REDACTED]' : '[REDACTED]';
    });
    return out;
  }

  function redactJson(value: unknown): unknown {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(redactJson);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = redactJson(v);
      }
      return out;
    }
    return value;
  }

  return { redact, redactJson };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

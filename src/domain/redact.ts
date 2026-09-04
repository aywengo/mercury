// Secret redaction for events and logs (ARCHITECTURE.md section 24.1).

/**
 * A secret shape, and whether its match carries a `name:`/`name=` label whose prefix should be
 * kept. The label is kept so an operator reading an event can still tell WHICH credential leaked;
 * an unlabelled match is replaced whole.
 *
 * `labelled` is explicit rather than inferred from the match because inferring it (the first
 * version searched the match for `:` or `=`) silently truncates any unlabelled pattern whose own
 * character class can contain `:` or `=`. Unlabelled patterns must not match those characters.
 */
interface SecretPattern {
  re: RegExp;
  labelled: boolean;
}

const DEFAULT_PATTERNS: SecretPattern[] = [
  { re: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, labelled: false },
  {
    re: /(api[_-]?key|apikey|token|secret|password|passwd|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]+/gi,
    labelled: true,
  },
  { re: /xox[baprs]-[A-Za-z0-9-]+/g, labelled: false },
  // URL-embedded credentials (https://user:pass@host/...; issue #43)
  { re: /\/\/[^\/\s:@]+:[^\/\s@]+@/g, labelled: false },
  // Provider key SHAPES (issue #214). The patterns above only catch a secret that is labelled
  // `something: <value>`; a bare key reaching an event passed through untouched. That is the
  // realistic shape, because an agent that runs `env`, `printenv`, `gh auth token` or
  // `cat ~/.aws/credentials` puts the value in a tool result with no label in front of it.
  //
  // Scoped deliberately to the providers Mercury forwards (see DEFAULT_ENV_ALLOWLIST in
  // sandboxManager) plus GitHub, since Runs run git and print remotes. This is a FLOOR, not a
  // catalogue: a secret of an unrecognised shape with no label still passes through. The exact
  // layer that actually closes that gap is forwardedCredentialValues(), which redacts the real
  // values Mercury hands to the sandbox whatever their shape. Claiming more than that is how
  // NEVER_FORWARD ended up promising Bedrock and Azure support the code never had.
  // Anthropic. Redundant with the OpenAI pattern below TODAY (its `sk-` class is a strict
  // superset of this shape), and no test can distinguish the two -- deleting this line changes no
  // behaviour. Kept deliberately: the likely future refinement is narrowing `sk-` to cut false
  // positives, at which point this becomes the only thing catching an Anthropic key.
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, labelled: false }, // Anthropic
  { re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, labelled: false }, // OpenAI, DeepSeek, Mistral
  { re: /AIza[0-9A-Za-z_-]{30,}/g, labelled: false }, // Google / Gemini
  { re: /gsk_[A-Za-z0-9_-]{20,}/g, labelled: false }, // Groq
  { re: /xai-[A-Za-z0-9_-]{20,}/g, labelled: false }, // xAI
  { re: /sk-or-v1-[A-Za-z0-9_-]{20,}/g, labelled: false }, // OpenRouter
  { re: /hf_[A-Za-z0-9]{30,}/g, labelled: false }, // Hugging Face
  { re: /gh[pousr]_[A-Za-z0-9]{30,}/g, labelled: false }, // GitHub classic
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, labelled: false }, // GitHub fine-grained
];

export interface Redactor {
  redact(text: string): string;
  redactJson(value: unknown): unknown;
}

export function createRedactor(secrets: string[] = []): Redactor {
  // No length floor here on purpose. These are secrets the CALLER declared: an operator listing
  // MERCURY_SECRETS=hush said so explicitly, and honouring that at any length is the contract.
  // A floor belongs on values we GUESS are secrets (see forwardedCredentialValues), where a short
  // one would blank ordinary text everywhere it appears.
  const literalPatterns = secrets
    .filter((s) => s.length > 0)
    .map((s) => new RegExp(escapeRegExp(s), 'g'));

  function redact(text: string): string {
    let out = text;
    for (const re of literalPatterns) out = out.replace(re, '[REDACTED]');
    for (const { re, labelled } of DEFAULT_PATTERNS) {
      out = out.replace(re, (m) => {
        if (!labelled) return '[REDACTED]';
        const idx = m.search(/[:=]\s*/);
        return idx >= 0 ? m.slice(0, idx + 1) + ' [REDACTED]' : '[REDACTED]';
      });
    }
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

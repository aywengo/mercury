/**
 * Note validation on the host, at ingest (docs/knowledge-base.md sections 3, 7.5 and K2).
 *
 * Two things run here and they are deliberately separate. Bounds and vocabulary come first because
 * they are cheap and mechanical; the K2 scan comes second because it is a judgement encoded in
 * patterns and its reason string has to name the specific rule that fired.
 *
 * Rejection, never truncation. A truncated claim is a different claim, and a note is replicated to
 * every host and retained far longer than the workspace it came from, so a silently shortened
 * sentence is a wrong fact with good provenance. Section 7.5 says this about bounds and section
 * 7.5 says the same about secrets; the same rule is applied to the vocabularies.
 */

import { createHash } from 'node:crypto';
import {
  EVIDENCE_REQUIRED_KINDS, EVIDENCE_TYPES, NOTE_KINDS,
  type EvidenceRef, type NoteDraft, type NoteKind,
} from './types.ts';

/** Bounds, each one an environment variable in section 7.5. */
export interface KnowledgeBounds {
  maxNotesPerRun: number;
  maxClaimBytes: number;
  maxDetailBytes: number;
  maxEvidence: number;
  harvestTimeoutMs: number;
}

export const DEFAULT_BOUNDS: KnowledgeBounds = {
  maxNotesPerRun: 50,
  maxClaimBytes: 1024,
  maxDetailBytes: 4096,
  maxEvidence: 8,
  harvestTimeoutMs: 10_000,
};

/**
 * Why a note was refused, as it appears in `knowledge.rejected`.
 *
 * A closed set on purpose: an operator reading a timeline needs to grep for the reason, and a free
 * text reason is a reason nobody will ever aggregate.
 */
export const REJECT_REASONS = [
  'malformed-json',
  'empty-claim',
  'invalid-kind',
  'invalid-scope',
  'claim-too-long',
  'detail-too-long',
  'invalid-evidence',
  'too-much-evidence',
  'missing-evidence',
  'invalid-contradicts',
  'k2-violation',
  'invalid-override',
  'secret-detected',
  'over-limit',
  'harvest-timeout',
  'repo-not-in-project',
  'host-mismatch',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export type Validation = { ok: true; draft: NoteDraft } | { ok: false; reason: RejectReason; detail?: string };

/** `repo:<hash>` and `repo:<hash>#<path>` -- the hash is 16 hex chars, from identityHash(). */
const SCOPE_REPO = /^repo:([0-9a-f]{16})(?:#(.+))?$/;
/** `agent:<id>` -- ids are the registry's own slugs, so the same character class it uses. */
const SCOPE_AGENT = /^agent:([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

/** Validate a scope key against the closed grammar of section 3. */
export function parseScope(scope: string): { ok: boolean; kind?: 'project' | 'repo' | 'agent'; hash?: string; path?: string; agent?: string } {
  if (scope === 'project') return { ok: true, kind: 'project' };
  const repo = SCOPE_REPO.exec(scope);
  if (repo) {
    const path = repo[2];
    // A path must be a plain relative path. An absolute path or a `..` segment would let a scope
    // key name a location outside the repository, which is the same class of escape
    // `resolveContained()` already refuses for skills.
    if (path === undefined) return { ok: true, kind: 'repo', hash: repo[1] };
    if (path.startsWith('/') || path.split('/').includes('..')) return { ok: false };
    return { ok: true, kind: 'repo', hash: repo[1], path };
  }
  if (scope.includes('#')) return { ok: false };
  const agent = SCOPE_AGENT.exec(scope);
  if (agent) return { ok: true, kind: 'agent', agent: agent[1] };
  return { ok: false };
}

/**
 * The K2 scan: a note may not carry a harness-specific path, flag or model id.
 *
 * Each rule is named so the rejection can say which one fired, and the set is deliberately narrow.
 * The concrete failure K2 exists to prevent is recorded in crew/teams.md section 3: Mercury handing
 * skill ids into Hermes's namespace, where none of them existed, so every Hermes Run failed in under
 * a second. A note containing `--skill planning` or `~/.hermes/profiles/x` reproduces it exactly, so
 * those two shapes are caught by name.
 *
 * What is NOT matched, and why, is as important as what is:
 *
 * - **Native skill names in prose.** Mercury cannot check these. Each harness owns its registry, and
 *   knowing it would mean reading `~/.hermes` and friends -- which section 7.3 forbids outright. A
 *   bare word like "planning" appears in legitimate project knowledge constantly. The flag rule
 *   catches the only form that actually breaks a Run, which is a note instructing a harness to load
 *   one.
 * - **Product names without a digit.** `claude-code` and `ClaudeCodeAdapter` are legitimate subjects:
 *   a note about how this repository's Claude adapter behaves is project knowledge, not an
 *   instruction to a harness. Real model ids carry a version digit (`claude-opus-4-5`, `gpt-5.1`,
 *   `o3-mini`), so the digit is what separates the two. This is a heuristic and is written down as
 *   one rather than presented as a guarantee.
 */
export const K2_RULES: ReadonlyArray<{ id: string; why: string; re: RegExp }> = [
  {
    id: 'harness-home',
    why: 'a harness home store is host state owned by the harness, not a project path',
    re: /(?:~|\$HOME|\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|C:\\Users\\[^\\]+)[/\\]\.(?:hermes|prime|pi|omp|claude|codex|cursor)\b|(?:^|[/\\])\.(?:hermes|prime|omp|codex)[/\\]/i,
  },
  {
    id: 'harness-flag',
    why: 'a CLI flag is an instruction to one harness, and the harness may not recognise it',
    re: /(?:^|\s)--(?:skill|skills|agent|model|persona|append-system-prompt|system-prompt|profile|settings)(?=\s|=|$)/i,
  },
  {
    id: 'harness-short-flag',
    why: '`-s <name>` is how the skill-namespace failure was actually delivered',
    re: /(?:^|\s)-s[=\s]\S/,
  },
  {
    id: 'model-id',
    why: 'a model id names a backend the next Run may not have',
    re: /\b(?:claude|gpt|gemini|llama|qwen|deepseek|mistral|grok|sonnet|opus|haiku|command-r|o[1-9])(?:[-.][A-Za-z0-9]+)*[-.]?\d[\w.]*/i,
  },
];

/** Run the K2 rules over one string. Returns the first rule that fired, or null. */
export function findK2Violation(text: string): { id: string; why: string } | null {
  for (const rule of K2_RULES) if (rule.re.test(text)) return { id: rule.id, why: rule.why };
  return null;
}

/**
 * `claim_hash`: the deduplication key (section 11.3).
 *
 * `normalize` lowercases, collapses whitespace and strips trailing punctuation, so the same claim
 * typed with different spacing corroborates the existing note instead of creating a second one.
 * `kind` and `scope` are hashed with it because "the same sentence about two different files" is two
 * claims, and collapsing them would attach corroboration to the wrong note.
 */
export function claimHash(kind: string, scope: string, claim: string): string {
  return createHash('sha256')
    .update(`${kind}\n${scope}\n${normalizeClaim(claim)}`, 'utf8')
    .digest('hex');
}

export function normalizeClaim(claim: string): string {
  return claim.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.,;:!?]+$/, '');
}

function validEvidence(ref: unknown): ref is EvidenceRef {
  if (typeof ref !== 'object' || ref === null) return false;
  const r = ref as Record<string, unknown>;
  if (typeof r.type !== 'string' || !(EVIDENCE_TYPES as readonly string[]).includes(r.type)) return false;
  switch (r.type) {
    case 'commit': return typeof r.repo === 'string' && typeof r.sha === 'string';
    case 'pr': case 'issue': return typeof r.url === 'string' && /^https?:\/\//.test(r.url);
    case 'run-event': return typeof r.hostId === 'string' && typeof r.runId === 'string' && typeof r.seq === 'number';
    case 'repo-file': return typeof r.repo === 'string' && typeof r.path === 'string' && typeof r.sha === 'string';
    default: return false;
  }
}

/**
 * Options for one validateDraft call.
 *
 * `k2Override` is how the OPERATOR path grants an exception to the K2 scan (section 7.5). It is an
 * option to this function and never a field of the raw note on purpose: an agent writing
 * `operatorOverride` into `.mercury/notes.jsonl` must not be able to grant itself an exception, so
 * the harvest path never passes this option and the raw field is refused upstream of it. The shape
 * and the rule-match are checked here so both implementations of the validator (host and Atlas, kept
 * in agreement by test/atlasAgreement.test.ts) accept and refuse the same notes.
 */
export interface ValidateOptions {
  /** The operator's recorded exception: the rule that fired and why the note is served anyway. */
  k2Override?: { rule: string; reason: string };
}

/**
 * Shape-check one operator override against the rule that actually fired.
 *
 * The caller passes the override from the request body (the operator path) or undefined; `fired` is
 * what findK2Violation found, or null. Four refusals, each named for what an operator reading the
 * response needs to fix: an override with nothing firing, a wrong rule, a missing reason, an
 * over-long reason. The reason gets the claim bound -- operator prose is prose, and the note's own
 * claim bound is the one the pack budget already prices.
 */
export function checkK2Override(
  k2Override: { rule: string; reason: string } | undefined,
  fired: { id: string; why: string } | null,
  bounds: KnowledgeBounds,
): { ok: true; override: { rule: string; reason: string } | undefined } | { ok: false; reason: RejectReason; detail?: string } {
  if (k2Override === undefined) {
    if (fired) return { ok: false, reason: 'k2-violation', detail: fired.id };
    return { ok: true, override: undefined };
  }
  const rule = k2Override.rule;
  const reason = k2Override.reason;
  if (!fired) return { ok: false, reason: 'invalid-override', detail: 'no K2 rule fired, so there is nothing to override' };
  if (typeof rule !== 'string' || rule === '') return { ok: false, reason: 'invalid-override', detail: 'override names no rule' };
  if (rule !== fired.id) return { ok: false, reason: 'invalid-override', detail: `override names ${rule}, but ${fired.id} fired` };
  if (typeof reason !== 'string' || reason.trim() === '') return { ok: false, reason: 'invalid-override', detail: 'a reason is required' };
  if (Buffer.byteLength(reason, 'utf8') > bounds.maxClaimBytes) {
    return { ok: false, reason: 'invalid-override', detail: `reason ${Buffer.byteLength(reason, 'utf8')} > ${bounds.maxClaimBytes}` };
  }
  return { ok: true, override: { rule, reason } };
}

/**
 * Validate one draft against the closed vocabularies and the bounds.
 *
 * Order matters for the reason that reaches the operator: vocabulary first, then bounds, then K2.
 * A note that is both malformed and contains a secret is reported as malformed, because fixing the
 * shape is the step the author has to take first, and because the secret check runs on the *body*
 * fields that only make sense once they exist.
 *
 * `opts.k2Override` skips ONLY the K2 scan, and only when the note actually trips a rule and the
 * override names that rule with a non-empty bounded reason. The secret check is separate and is
 * never overridable: it runs at harvest (the redactor) and again at Atlas (section 11.5), and
 * "we stored the token but with stars in it" is not a property anyone should have to defend.
 */
export function validateDraft(raw: unknown, bounds: KnowledgeBounds = DEFAULT_BOUNDS, opts: ValidateOptions = {}): Validation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'malformed-json' };
  }
  const o = raw as Record<string, unknown>;

  const kind = o.kind;
  if (typeof kind !== 'string' || !(NOTE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: 'invalid-kind', detail: typeof kind === 'string' ? kind : typeof kind };
  }

  const scope = o.scope;
  if (typeof scope !== 'string' || !parseScope(scope).ok) {
    return { ok: false, reason: 'invalid-scope', detail: typeof scope === 'string' ? scope.slice(0, 120) : typeof scope };
  }

  const claim = o.claim;
  if (typeof claim !== 'string' || claim.trim() === '') return { ok: false, reason: 'empty-claim' };
  // Bytes, not characters: the bound exists to keep a pack inside a context window, and a context
  // window is billed in tokens over UTF-8, not in JS code units.
  if (Buffer.byteLength(claim, 'utf8') > bounds.maxClaimBytes) {
    return { ok: false, reason: 'claim-too-long', detail: `${Buffer.byteLength(claim, 'utf8')} > ${bounds.maxClaimBytes}` };
  }

  const detail = o.detail;
  if (detail !== undefined) {
    if (typeof detail !== 'string') return { ok: false, reason: 'detail-too-long', detail: 'not a string' };
    if (Buffer.byteLength(detail, 'utf8') > bounds.maxDetailBytes) {
      return { ok: false, reason: 'detail-too-long', detail: `${Buffer.byteLength(detail, 'utf8')} > ${bounds.maxDetailBytes}` };
    }
  }

  const evidence = o.evidence ?? [];
  if (!Array.isArray(evidence)) return { ok: false, reason: 'invalid-evidence' };
  if (evidence.length > bounds.maxEvidence) {
    return { ok: false, reason: 'too-much-evidence', detail: `${evidence.length} > ${bounds.maxEvidence}` };
  }
  for (const ref of evidence) if (!validEvidence(ref)) return { ok: false, reason: 'invalid-evidence' };

  if (evidence.length === 0 && (EVIDENCE_REQUIRED_KINDS as readonly string[]).includes(kind)) {
    // Named for the kind rather than generic, because the harvester's job is to tell the author what
    // is missing. Section 6.2 uses this exact reason for a decision record with no evidence.
    return { ok: false, reason: 'missing-evidence', detail: kind };
  }

  const contradicts = o.contradicts;
  if (contradicts !== undefined) {
    if (!Array.isArray(contradicts) || contradicts.some((x) => typeof x !== 'string' || x === '')) {
      return { ok: false, reason: 'invalid-contradicts' };
    }
  }

  // K2 last: it is the only rule whose reason needs the text to be otherwise well-formed.
  const k2 = findK2Violation(claim) ?? (typeof detail === 'string' ? findK2Violation(detail) : null);
  let override: { rule: string; reason: string } | undefined;
  if (opts.k2Override !== undefined || k2 !== null) {
    const checked = checkK2Override(opts.k2Override, k2, bounds);
    if (!checked.ok) return { ok: false, reason: checked.reason, detail: checked.detail };
    override = checked.override;
  }

  const draft: NoteDraft = { kind: kind as NoteKind, scope, claim };
  if (typeof detail === 'string') draft.detail = detail;
  if (evidence.length > 0) draft.evidence = evidence as EvidenceRef[];
  if (Array.isArray(contradicts)) draft.contradicts = contradicts as string[];
  if (override) draft.operatorOverride = override;
  return { ok: true, draft };
}

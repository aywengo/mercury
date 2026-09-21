/**
 * Decision-record parser (docs/knowledge-base.md §6.1, §6.2; issue #683).
 *
 * Turns one `docs/decisions/NNNN-<slug>.md` file into either a note draft or a rejection with a
 * stated reason. This is the single door every §6 consumer goes through — the finalize harvester
 * (A5-2) and the operator `knowledge index` command (A5-3) both call it and neither parses
 * frontmatter itself.
 *
 * The frontmatter reader is a deliberate subset, not a YAML dependency: scalar `key: value` lines,
 * one optional list (`evidence:`) whose entries are a bare URL or `commit: <sha>`, and a trailing
 * ` # comment` on a value line. Anything outside the subset is `decision-malformed` rather than a
 * best-effort read — a record that a stricter parser would read differently must not become
 * knowledge on this host's more forgiving one. The subset is closed and every accepted form has a
 * fixture in `test/knowledgeDecisionRecord.test.ts`.
 *
 * The result passes through `validateDraft()` like any other draft, so K2, the bounds and the
 * vocabulary checks apply unchanged; this module adds no second validation path, only the
 * record-specific rules §6.2 states.
 */

import { validateDraft, type KnowledgeBounds, type RejectReason } from './validation.ts';
import { identityHash, repoIdentity as repoIdentityOf } from './identity.ts';
import type { EvidenceRef, NoteDraft } from './types.ts';

export interface DecisionRecordInput {
  /** Repository-relative path of the record file, e.g. `docs/decisions/0007-claims.md`. */
  path: string;
  /** The primary repository identity string, as the workspace manager computed it. */
  repoIdentity: string;
  /** The commit the record was read at; the self-referencing evidence points here. */
  headSha: string;
  bounds?: KnowledgeBounds;
}

export type DecisionRecordResult =
  | { ok: true; draft: NoteDraft }
  | { ok: false; reason: RejectReason; detail?: string; skipped?: boolean };

/** The record statuses that produce a note. `proposed` is skipped, not rejected. */
const INDEXABLE_STATUSES = ['accepted', 'superseded', 'rejected'] as const;

/** The self-evidence entry: the record file itself at the commit it was read at. */
function selfEvidence(repoIdentity: string, path: string, headSha: string): EvidenceRef {
  const id = repoIdentityOf(repoIdentity);
  return { type: 'repo-file', repo: id ? id.identity : repoIdentity, path, sha: headSha };
}

/** Strip one trailing ` # comment` from a scalar value. `#` needs leading whitespace, so a bare
 *  `#` inside a value (a URL fragment) survives — that is what keeps `…/issues/459#x` intact. */
function stripComment(value: string): string {
  const m = value.match(/\s#.*$/);
  return m ? value.slice(0, m.index).trim() : value.trim();
}

export interface ParsedFrontmatter {
  scalars: Map<string, string>;
  evidence: string[];
}

/**
 * Read the restricted frontmatter subset. Returns null on anything the subset does not define —
 * unknown list keys, nested structures, block scalars, duplicate keys — so the caller can reject
 * the record as malformed instead of guessing.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const lines = match[1]!.split(/\r?\n/);
  const scalars = new Map<string, string>();
  const evidence: string[] = [];
  let inEvidence = false;
  let evidenceSeen = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') { inEvidence = false; continue; }
    // List entries are exactly the §6.1 shape: two-space indent, `- `, value. A deeper or absent
    // indent would be read differently by a real YAML parser (a nested list), and a record this
    // parser reads differently than `yaml` would is a record this parser must refuse.
    if (/^ {2}- .+$/.test(raw)) {
      if (!inEvidence) return null; // a list under a key we do not define
      const entry = stripComment(raw.trim().slice(2));
      if (entry === '') return null;
      evidence.push(entry);
      continue;
    }
    if (raw.startsWith('- ') || /^ {2,}[^ ]/.test(raw)) return null; // stray list or deeper nesting
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/);
    if (!kv) return null; // block scalar, anchored value, anything else: outside the subset
    const key = kv[1]!;
    if (scalars.has(key)) return null; // duplicate key
    if (key === 'evidence') {
      if (evidenceSeen) return null; // duplicate `evidence:` key
      const inline = stripComment(kv[2]!);
      if (inline !== '') return null; // `evidence: [...]` flow style is not in the subset
      evidenceSeen = true;
      inEvidence = true;
      continue;
    }
    inEvidence = false;
    scalars.set(key, stripComment(kv[2]!));
  }
  return { scalars, evidence };
}

/** One evidence entry, restricted to what §6.1 allows: a URL or `commit: <sha>`. A commit entry
 *  names no repository in the record file (§6.1's example is bare), so it is attributed to the
 *  record's own repository — the same repository the record's scope names. */
function parseEvidenceEntry(entry: string, repoIdentity: string): EvidenceRef | null {
  if (/^commit:\s*[0-9a-f]{7,40}$/i.test(entry)) {
    const sha = entry.slice(entry.indexOf(':') + 1).trim();
    const id = repoIdentityOf(repoIdentity);
    return { type: 'commit', repo: id ? id.identity : repoIdentity, sha };
  }
  if (/^https?:\/\//i.test(entry)) {
    // Only the two link shapes §6.1 shows: a pull request URL or an issue URL. Any other URL
    // (a discussion, a host root, a pastebin) is outside the subset — a link whose type the
    // parser guessed at is evidence that says less than it appears to.
    if (/\/pull\/\d+/.test(entry)) return { type: 'pr', url: entry };
    if (/\/issues\/\d+/.test(entry)) return { type: 'issue', url: entry };
    return null;
  }
  return null;
}

/** The first paragraph under a `## Decision` heading, as the raw lines between it and the next
 *  blank line or heading. Returned verbatim — the claim is the author's bytes, not a reflow. */
export function decisionParagraph(text: string): string | null {
  const body = text.replace(/^---[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  // Line endings are the ONE normalization (documented): a CRLF checkout and an LF checkout of the
  // same record must produce the same claim, because claim_hash is computed over the claim and two
  // hashes for one sentence would split corroboration across hosts. Nothing else is altered — no
  // reflow, no reindent, no trailing-whitespace trim — so the claim is the author's characters.
  const lines = body.split(/\r\n|\r|\n/).map((l) => l.replace(/\r$/, ''));
  let inDecision = false;
  const para: string[] = [];
  for (const raw of lines) {
    const probe = raw.trim();
    if (/^##\s+Decision\s*$/i.test(probe)) { inDecision = true; continue; }
    if (!inDecision) continue;
    if (probe === '' && para.length === 0) continue; // blank lines before the paragraph start
    if (probe === '' || probe.startsWith('#')) break; // paragraph ends at a blank line or heading
    para.push(raw);
  }
  if (!inDecision || para.length === 0) return null;
  return para.join('\n');
}

/**
 * Parse one decision record into a note draft, or say exactly why not.
 *
 * Never throws and never reads the filesystem: the caller owns I/O (git show, or a real file) and
 * hands the text in, so the same function serves the finalize harvester and the operator index.
 */
export function parseDecisionRecord(text: string, input: DecisionRecordInput): DecisionRecordResult {
  // Resolve the identity first: an unparseable repository identity must be a rejection with a
  // reason, never a thrown error from a non-null assertion — the caller harvests in the worker's
  // finalize path, and "the parser threw" is not a harvest outcome.
  const identity = repoIdentityOf(input.repoIdentity);
  if (!identity) {
    return { ok: false, reason: 'decision-malformed', detail: `repository identity does not parse: ${input.repoIdentity.slice(0, 80)}` };
  }
  const fm = parseFrontmatter(text);
  if (!fm) {
    return { ok: false, reason: 'decision-malformed', detail: 'frontmatter is missing or outside the supported subset' };
  }
  const scalars = fm.scalars;
  const missing = ['id', 'title', 'status', 'date'].filter((k) => !scalars.get(k));
  if (missing.length > 0) {
    return { ok: false, reason: 'decision-malformed', detail: `missing required key(s): ${missing.join(', ')}` };
  }
  const status = scalars.get('status')!;
  if (status === 'proposed') {
    // Not wrong, only early: callers report this as skipped, and the PR that flips the status
    // makes the record indexable without any change here.
    return { ok: false, reason: 'decision-proposed', detail: scalars.get('id')!, skipped: true };
  }
  if (!(INDEXABLE_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, reason: 'decision-malformed', detail: `status is "${status}", expected accepted | superseded | rejected | proposed` };
  }
  const paragraph = decisionParagraph(text);
  if (paragraph === null) {
    return { ok: false, reason: 'decision-malformed', detail: 'no `## Decision` heading with a paragraph under it' };
  }
  const claim = status === 'rejected' ? `Rejected: ${paragraph}` : paragraph;

  const evidence: EvidenceRef[] = [];
  for (const entry of fm.evidence) {
    const ref = parseEvidenceEntry(entry, input.repoIdentity);
    if (!ref) {
      return { ok: false, reason: 'decision-malformed', detail: `evidence entry is neither a URL nor "commit: <sha>": ${entry.slice(0, 80)}` };
    }
    evidence.push(ref);
  }
  if (evidence.length === 0) {
    // §6.2 names this reason for exactly this case (K1 applied at the source).
    return { ok: false, reason: 'decision-without-evidence' };
  }
  evidence.push(selfEvidence(input.repoIdentity, input.path, input.headSha));

  const draft: NoteDraft = {
    kind: 'decision',
    scope: `repo:${identityHash(identity.identity)}`,
    claim,
    ...(scalars.get('title') ? { detail: scalars.get('title')! } : {}),
    evidence,
  };

  // K2, bounds and vocabulary apply unchanged: the record's own prose is untrusted input too.
  const validated = validateDraft(draft, input.bounds);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason, ...(validated.detail ? { detail: validated.detail } : {}) };
  }
  return { ok: true, draft: validated.draft };
}

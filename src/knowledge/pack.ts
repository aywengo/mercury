/**
 * Deterministic pack selection (docs/knowledge-base.md 9.1).
 *
 * Determinism is not a nicety here. It is what lets a test assert what a Run was given, and what lets a
 * person reading a Run's transcript later see the same pack the agent saw. So this module takes no
 * clock, no randomness, no set iteration order, and no network. The task text participates in exactly
 * one way -- the path prefix match in step 1 -- and nothing else about the task influences ranking.
 *
 * There is deliberately no relevance model. This is the same posture `skillSelector` takes: cheap,
 * explainable, and improvable later without changing the contract.
 */

import { createHash } from 'node:crypto';
import { repoIdentity } from './identity.ts';
import type { ReplicaRow, ReplicaStore } from './replica.ts';
import type { Note } from './types.ts';

/** Scope specificity, most specific first (9.1 step 2). */
const SPECIFICITY: Record<'path' | 'repo' | 'project' | 'agent', number> = { path: 0, repo: 1, project: 2, agent: 3 };

/**
 * Kinds that outrank the rest at equal specificity (9.1 step 3).
 *
 * The spec's reason, which is why this is a rule rather than a weight: a convention and a pitfall are
 * what stop a Run doing the wrong thing, and that is worth more than what helps it do the right thing
 * faster. It therefore ranks ABOVE corroboration, so a thinly-corroborated pitfall still precedes a
 * heavily-corroborated fact at the same specificity.
 */
const PRECEDING_KINDS = new Set(['convention', 'pitfall']);

export interface SelectionRequest {
  projectId: string;
  task: string;
  agent: string;
  /** Raw repository identities, primary first. Normalized and hashed here (section 5). */
  repositories: string[];
  /** Narrows the candidate scopes. Cannot widen them (9.1 step 1). */
  scopes?: string[];
  maxBytes: number;
}

export interface PackSelection {
  packHash: string;
  notes: Note[];
  /** Notes that matched a scope and were then dropped by the byte budget. */
  omitted: number;
  byteSize: number;
  /** The scopes selection actually considered, for `knowledge.selected`. */
  scopes: string[];
}

interface Scored {
  note: Note;
  specificity: number;
  kindRank: number;
  runs: number;
  seq: number;
}

/**
 * Path-like tokens in free text.
 *
 * Deliberately dumb and total: split on whitespace and quote characters, drop trailing punctuation that
 * prose attaches to a path, keep what has a slash or a file extension. A smarter parser would be a
 * second opinion about what a task "means", and the whole point of step 1 is that it has no opinion.
 */
export function pathTokens(task: string): string[] {
  const out = new Set<string>();
  for (const raw of task.split(/[\s,;()[\]{}<>"'`]+/)) {
    let token = raw.replace(/[.,:!?]+$/, '');
    if (!token) continue;
    if (token.startsWith('./')) token = token.slice(2);
    // A leading slash is how a person writes a repo-relative path in prose; the scope is repo-relative.
    if (token.startsWith('/')) token = token.slice(1);
    if (token.length < 2) continue;
    const hasSlash = token.includes('/');
    const hasExtension = /\.[A-Za-z0-9]{1,10}$/.test(token);
    if (!hasSlash && !hasExtension) continue;
    // Reject things that are clearly not paths: a URL has a scheme, and a version or a sentence
    // fragment with a dot in it has no slash and an implausible extension.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) continue;
    if (!hasSlash && !/^\.[A-Za-z0-9]{1,10}$/.test(token.split('.').pop() ?? '')) continue;
    out.add(token);
  }
  return [...out].sort();
}

/** True when the note's scope is one this Run should see. */
function matchesScope(
  scope: string,
  allowed: Set<string>,
  repoHashes: Set<string>,
  tokens: string[],
): { ok: boolean; specificity: number } {
  if (scope === 'project') return allowed.has('project') ? { ok: true, specificity: SPECIFICITY.project } : { ok: false, specificity: 0 };
  if (scope.startsWith('agent:')) return allowed.has(scope) ? { ok: true, specificity: SPECIFICITY.agent } : { ok: false, specificity: 0 };
  if (scope.startsWith('repo:')) {
    const rest = scope.slice(5);
    const hashSep = rest.indexOf('#');
    const hash = hashSep < 0 ? rest : rest.slice(0, hashSep);
    // The Run must actually carry that repository. A note about another repo is not made relevant by
    // being well-corroborated, and handing it over would teach this Run another repo's conventions.
    if (!repoHashes.has(hash)) return { ok: false, specificity: 0 };
    // The repository note itself is a candidate scope, so narrowing applies to it too. Checking only the
    // path form would let `scopes: ["project"]` still deliver every note about this repository, which
    // makes the filter a no-op for the scope most notes actually use.
    if (hashSep < 0) {
      return allowed.has(`repo:${hash}`) ? { ok: true, specificity: SPECIFICITY.repo } : { ok: false, specificity: 0 };
    }
    const path = rest.slice(hashSep + 1);
    // Prefix, not equality: a note scoped to `src/knowledge` is relevant to a task naming
    // `src/knowledge/pack.ts`, which is the case that actually happens. The candidate set carries the
    // whole path token, so membership is tested against that rather than against the note's own scope.
    const relevant = tokens.some((t) => t === path || t.startsWith(path.endsWith('/') ? path : `${path}/`) || path.startsWith(t));
    if (!relevant) return { ok: false, specificity: 0 };
    // The candidate set holds one entry per path TOKEN the task named, e.g. `repo:<hash>#src/knowledge/pack.ts`,
    // while this note is scoped to a directory inside it. So "permitted" means some allowed token relates
    // to this path the same way the relevance test above relates them -- not that the strings share a prefix.
    const permitted = [...allowed].some((a) => {
      if (!a.startsWith(`repo:${hash}#`)) return false;
      const t = a.slice(hash.length + 6);
      return t === path || t.startsWith(`${path}/`) || path.startsWith(`${t}/`) || t === path;
    });
    return permitted ? { ok: true, specificity: SPECIFICITY.path } : { ok: false, specificity: 0 };
  }
  return { ok: false, specificity: 0 };
}

/** The byte cost of a note as it will appear in the pack. */
function noteBytes(note: Note): number {
  return Buffer.byteLength(JSON.stringify(note), 'utf8');
}

/**
 * sha256 over the ordered (noteId, revision) pairs.
 *
 * Revision is included because it is the difference between "the same notes" and "the same knowledge":
 * a note revised in place keeps its id, and a hash over ids alone would call two different packs equal.
 * The order is included because NOTES.md renders in this order, so a reordering is a visible change.
 */
export function packHashOf(notes: readonly Note[]): string {
  const hash = createHash('sha256');
  for (const note of notes) hash.update(`${note.noteId}\u0000${note.revision}\n`, 'utf8');
  return hash.digest('hex').slice(0, 32);
}

export function selectPack(replica: ReplicaStore, request: SelectionRequest): PackSelection {
  const tokens = pathTokens(request.task);
  const identities = request.repositories
    .map((raw) => repoIdentity(raw))
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const repoHashes = new Set(identities.map((r) => r.hash));

  // Candidate scopes, before narrowing (9.1 step 1).
  const candidates = new Set<string>(['project']);
  for (const identity of identities) {
    candidates.add(`repo:${identity.hash}`);
    for (const token of tokens) candidates.add(`repo:${identity.hash}#${token}`);
  }
  candidates.add(`agent:${request.agent}`);

  // A caller's scopes narrow the candidate set and cannot widen it. An unknown scope therefore removes
  // nothing and adds nothing, which is the honest behaviour for a filter that names a scope no note has.
  const allowed = new Set(
    request.scopes && request.scopes.length > 0
      ? [...new Set(request.scopes)].filter((s) => candidates.has(s))
      : candidates,
  );

  const scored: Scored[] = [];
  for (const row of replica.promoted(request.projectId) as ReplicaRow[]) {
    const match = matchesScope(row.scope, allowed, repoHashes, tokens);
    if (!match.ok) continue;
    scored.push({
      note: toNote(row),
      specificity: match.specificity,
      kindRank: PRECEDING_KINDS.has(row.kind) ? 0 : 1,
      runs: row.corroboration.runs,
      seq: row.seq,
    });
  }

  scored.sort((a, b) =>
    a.specificity - b.specificity
    || a.kindRank - b.kindRank
    || b.runs - a.runs
    || b.seq - a.seq
    || a.note.noteId.localeCompare(b.note.noteId),
  );

  const notes: Note[] = [];
  let bytes = 0;
  let omitted = 0;
  for (const entry of scored) {
    const cost = noteBytes(entry.note);
    if (bytes + cost > request.maxBytes) {
      // Stop rather than skip ahead -- the spec says so, and the reason is worth the comment. A smaller
      // note further down the list WOULD fit, and taking it would make this Run's pack depend on what
      // else happened to be in the replica: the same task and the same top-ranked notes would produce
      // different packs as unrelated notes arrived and left, which destroys the property the whole
      // ordering exists to give.
      omitted = scored.length - scored.indexOf(entry);
      break;
    }
    bytes += cost;
    notes.push(entry.note);
  }

  return {
    packHash: packHashOf(notes),
    notes,
    omitted,
    byteSize: bytes,
    scopes: [...allowed].sort(),
  };
}

function toNote(row: ReplicaRow): Note {
  const note: Note = {
    noteId: row.noteId,
    revision: row.revision,
    projectId: row.projectId,
    kind: row.kind,
    scope: row.scope,
    claim: row.claim,
    ...(row.detail ? { detail: row.detail } : {}),
    evidence: row.evidence,
    tier: row.tier,
    // Read from the row, not invented. This line used to be a constant -- every note was served as
    // `agent-reported` from host `''` -- which made an operator note and a note curated in git look like
    // an agent's unverified observation, in the snapshot an operator reads to answer "why should this Run
    // have believed it". Absent is now the answer for a row that predates migration v11; the cursor reset
    // in that migration makes the gap close on the next pull rather than persist forever.
    ...(row.source !== null
      ? { provenance: { source: row.source, hostId: row.hostId ?? '', recordedAt: row.recordedAt } }
      : {}),
    corroboration: row.corroboration,
    seq: row.seq,
    ...(row.contested ? { contested: true } : {}),
  };
  return note;
}

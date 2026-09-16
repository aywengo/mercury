/**
 * The knowledge record, as a TypeScript type (docs/knowledge-base.md section 3).
 *
 * This is the host half of a wire contract. Atlas holds its own copy of these shapes and imports
 * nothing from here -- the coupling rule of section 11.6 forbids it, the same rule Fleet lives
 * under -- so the two definitions are kept in agreement by `test/atlasContract.test.ts`, which
 * asserts the wire shapes rather than trusting a shared import to do it. A shared import would
 * have been the cheaper choice and would have made the boundary unenforceable.
 *
 * Everything here is an identifier, an enumeration or a pointer. `claim` and `detail` are the only
 * free text in the record, and that is what makes notes deduplicable (section 12) and packs
 * deterministic (section 9.1). An open vocabulary anywhere else would degrade into prose, which can
 * be neither matched nor budgeted.
 */

/** Closed vocabulary (section 3). Adding a kind is a spec change, not a local one. */
export const NOTE_KINDS = [
  'fact',
  'convention',
  'pitfall',
  'command',
  'decision',
  'artifact-pointer',
] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/**
 * Which kinds require an evidence reference before Atlas will hold them.
 *
 * K1 in one line: a decision or a pitfall with nothing behind it is an opinion. The other four are
 * cheap enough to be worth holding on the agent's word and are checked by corroboration instead.
 */
export const EVIDENCE_REQUIRED_KINDS: readonly NoteKind[] = ['decision', 'pitfall'];

/**
 * Section 12. Only promoted notes are served into Runs; everything else lands as candidate.
 *
 * `deleted` is the tombstone tier of #590. It is terminal, it is reached only through `deleteNote()`,
 * it always carries a fresh `seq`, and it is the last write a replica will ever see for that note.
 * It exists because a bare DELETE produces no `seq` row, and a replica advances by cursor: a note
 * destroyed with a DELETE would keep being served by every replica that had already received it, with
 * nothing to reconcile against. A note in this tier has had its claim, detail and evidence emptied;
 * what survives is the identity, the audit trail and the sequence number.
 *
 * It is NOT a live tier. The one-live-note-per-claim rule and the dedup query treat it exactly as they
 * treat `retired`, so a claim deleted today can be re-earned tomorrow.
 */
export const NOTE_TIERS = ['candidate', 'promoted', 'retired', 'deleted'] as const;
export type NoteTier = (typeof NOTE_TIERS)[number];

/** Section 3, `Provenance`. Which of the three ingest tiers produced the note. */
export const NOTE_SOURCES = ['agent-reported', 'distilled', 'repo-record', 'operator'] as const;
export type NoteSource = (typeof NOTE_SOURCES)[number];

/**
 * A pointer into history, never a copy of the thing pointed at (K1).
 *
 * The set is closed for the same reason the kinds are: a note that could carry arbitrary
 * structured data would eventually carry a diff, and the diff is exactly what section 2 argues
 * must stay in git.
 */
export type EvidenceRef =
  | { type: 'commit'; repo: string; sha: string }
  | { type: 'pr'; url: string }
  | { type: 'issue'; url: string }
  | { type: 'run-event'; hostId: string; runId: string; seq: number }
  | { type: 'repo-file'; repo: string; path: string; sha: string };

export const EVIDENCE_TYPES = ['commit', 'pr', 'issue', 'run-event', 'repo-file'] as const;

/**
 * Measured, never estimated (K3).
 *
 * Distinct harnesses are counted alongside Runs and hosts on purpose: two PrimeAgent Runs agreeing
 * says something about the project, one PrimeAgent Run and one Claude Run agreeing says more,
 * because a single vendor's quirk is much less likely to explain both.
 */
export interface Corroboration {
  runs: number;
  hosts: number;
  harnesses: number;
}

export interface NoteProvenance {
  source: NoteSource;
  hostId: string;
  runId?: string;
  agent?: string;
  /** Null when the harness version was never resolved. Distinct from absent: section 7.4. */
  harnessVersion?: string | null;
  recordedAt: string;
}

/** The full record, as it crosses the wire and as it sits in the replica. */
export interface Note {
  noteId: string;
  /** 1..n. Each revision is immutable once written. */
  revision: number;
  projectId: string;
  kind: NoteKind;
  /** `project` | `repo:<hash>` | `repo:<hash>#<path>` | `agent:<id>` -- see `scopeOf` below. */
  scope: string;
  claim: string;
  detail?: string;
  evidence: EvidenceRef[];
  tier: NoteTier;
  supersededBy?: string;
  /** Note ids this note was DECLARED to conflict with. Atlas never infers a conflict (section 12). */
  contradicts?: string[];
  /**
   * Absent when the note reached a replica before migration v11, which stored no provenance.
   *
   * Optional is the honest shape, not a convenience. The alternative -- filling the gap with a value --
   * is what #553 was: the replica invented `{ source: 'agent-reported', hostId: '' }` for every note, so
   * an operator note and a note curated in git were both presented as an agent's unverified observation.
   * A reader that has to handle absence cannot be lied to.
   *
   * The gap is transient by construction: v11 resets the pull cursors, so the next pull re-fetches every
   * row with its real provenance.
   */
  provenance?: NoteProvenance;
  corroboration: Corroboration;
  /** Per-project monotonic, assigned by Atlas. A replica never assigns one itself. */
  seq: number;
  /**
   * Present when a contest is open on this note. A pack that includes the note includes the flag,
   * so a Run sees "these two disagree" rather than one side presented as settled (section 12).
   */
  contested?: boolean;
}

/**
 * What an agent writes into `.mercury/notes.jsonl` (section 7.1): the record minus every field
 * Mercury fills in.
 *
 * The subtraction is the point. An agent is not trusted to assign a `noteId`, a `tier` or a
 * `seq`, and letting it try would mean a Run could promote its own notes.
 */
export interface NoteDraft {
  kind: NoteKind;
  scope: string;
  claim: string;
  detail?: string;
  evidence?: EvidenceRef[];
  contradicts?: string[];
}

/**
 * What the host puts in an outbox row and POSTs to Atlas: a validated draft plus the provenance the
 * host knows and the agent does not.
 *
 * This is a distinct shape from `Note` because a contribution has no `noteId`, `revision`, `tier`,
 * `corroboration` or `seq` yet -- those are Atlas's answers, not the host's assertions. Keeping the
 * two types separate is what stops a host from being able to promote its own notes by filling in a
 * field, which is the same reason `NoteDraft` subtracts them from an agent.
 */
export interface NoteContribution {
  projectId: string;
  kind: NoteKind;
  scope: string;
  claim: string;
  detail?: string;
  evidence: EvidenceRef[];
  contradicts?: string[];
  provenance: NoteProvenance;
  /**
   * Identity of `run.repository`, normalized per section 5. Atlas accepts the note only if this is
   * in the project's repo identity set; a mismatch is `repo-not-in-project`, which is the cross-check
   * that stops a misconfigured host from polluting another project.
   */
  repoIdentity?: string;
  /** Set when the note is scoped to an extra repository rather than the primary one. */
  extraRepoIdentities?: string[];
}

/** One item in a `POST /v1/projects/:id/notes` response (section 11.1). */
export type ContributionResult =
  | { accepted: string }
  | { duplicate: string }
  | { rejected: string };

/** Per-item results, in request order. One bad note never fails a batch. */
export interface ContributionResponse {
  results: ContributionResult[];
}

/** The `knowledge` block a create request may carry (section 8.5). */
export interface KnowledgeRequest {
  enabled?: boolean;
  /** Narrows the scopes selection considers. It cannot widen them (section 9.1 step 1). */
  scopes?: string[];
  maxBytes?: number;
  /**
   * Refuse creation with 400 if the agent cannot receive a pack (section 7.4).
   *
   * The default is the other way round on purpose: ingest fails OPEN, so an unknown harness version
   * never bricks a Run, while an explicit requirement fails CLOSED, because silently running without
   * the pack is the degradation invariant 9 forbids.
   */
  require?: boolean;
}

/** What `knowledge.selected` carries, and what `GET /api/runs/:id/knowledge` is built from. */
export interface PackSnapshot {
  packHash: string;
  selectedAt: string;
  notes: Note[];
}

/** The pointer written into `.mercury-context.json` (section 9.2). */
export interface ContextKnowledgeBlock {
  packHash: string;
  path: string;
  count: number;
}

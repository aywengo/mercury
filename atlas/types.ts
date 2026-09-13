/**
 * The note record, as Atlas stores and serves it (docs/knowledge-base.md section 3).
 *
 * A second copy of the host's `src/knowledge/types.ts`, for the reason given in
 * `atlas/identity.ts`: the coupling rule of section 11.6, and a contract test that checks the wire
 * shapes rather than trusting a shared import.
 *
 * Everything here is an identifier, an enumeration or a pointer. `claim` and `detail` are the only
 * free text, and that is what makes notes deduplicable (section 12) and packs deterministic
 * (section 9.1).
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

/** Section 12. Only promoted notes are served into Runs; everything else lands as candidate. */
export const NOTE_TIERS = ['candidate', 'promoted', 'retired'] as const;
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
  provenance: NoteProvenance;
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

/**
 * Host ids that mean something to Atlas itself and therefore cannot belong to a contributor.
 *
 * `contribute()` records an operator batch under the coalesced value `hostId ?? 'admin'`, because the
 * `contributor` column is part of a PRIMARY KEY and SQL NULLs are never equal to each other -- storing
 * NULL would let every admin retry look like a first attempt and re-count corroboration. That makes
 * `'admin'` a name Atlas has already taken.
 *
 * Without this guard a host registered as `admin` shares an idempotency namespace with the operator path.
 * The two then replay each other's cached responses: the host's batch is silently discarded and answered
 * with the admin's recorded result, or the reverse. Nothing errors, and the notes are simply gone.
 *
 * This became reachable rather than merely theoretical when the idempotency reads started using the same
 * coalesced value as the insert (#552). Before that the admin reads never matched anything, so a colliding
 * host could not be served the wrong cache entry.
 */
export const RESERVED_CONTRIBUTOR_IDS: readonly string[] = ['admin'];

/**
 * Validate a contributor host id, returning it trimmed.
 *
 * Throws rather than coercing. Both callers run at configuration time -- the contributor file is read at
 * startup and `contributor add` is an explicit operator command -- so a loud failure here is strictly
 * better than a host that authenticates, contributes, and has its work silently attributed to someone
 * else's idempotency key.
 */
export function assertUsableHostId(hostId: string, context: string): string {
  const trimmed = hostId.trim();
  if (RESERVED_CONTRIBUTOR_IDS.includes(trimmed)) {
    throw new Error(
      `${context}: host id "${trimmed}" is reserved by Atlas for operator contributions. `
      + 'Contributions from a host with this id would share an idempotency namespace with operator notes '
      + 'and be silently discarded. Choose another host id.',
    );
  }
  return trimmed;
}

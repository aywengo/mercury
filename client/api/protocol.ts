// Client-side wire types and validation (docs/cli-tui-design.md §11.1, §14).
//
// This is a DELIBERATE copy of Mercury's server-side shapes. The coupling rule forbids importing
// anything from src/, even types, so the client stays deployable against a Mercury built from a
// different checkout and cannot quietly acquire database or worker dependencies. The cost of the
// copy is drift risk; the counterweight is contract tests that run against the real API.
//
// Validation policy: unknown FIELDS and unknown event TYPES are tolerated, because Mercury adds
// both without a version bump. Fields needed for CORRECTNESS are required and reported as a
// protocol incompatibility when absent. The distinction matters: defaulting a missing event
// `sequence` to 0 would make every event look like a duplicate, and the observer would drop the
// whole stream while reporting success.

export type RunStatus =
  | 'QUEUED' | 'STARTING' | 'RUNNING' | 'NEEDS_INPUT'
  | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

export const RUN_STATUSES: readonly string[] = [
  'QUEUED','STARTING','RUNNING','NEEDS_INPUT','COMPLETED','FAILED','CANCELLED','TIMED_OUT',
];

export interface RepositoryContext {
  url?: string;
  localPath?: string;
  baseBranch?: string;
  baseCommit?: string;
}

export interface RunConstraints {
  maxDurationMs: number;
  maxRetries: number;
  budgetTokens?: number;
  budgetCost?: number;
  resourceLimits?: { cpu?: string; memory?: string; disk?: string };
  allowedNetworks?: string[];
}

export interface Run {
  id: string;
  ownerId: string;
  task: string;
  repository: RepositoryContext;
  repositories?: RepositoryContext[];
  workspaceBranch: string | null;
  workspacePath: string | null;
  agent: string;
  status: RunStatus;
  attempt: number;
  retryOf: string | null;
  error: string | null;
  errorKind: string | null;
  constraints: RunConstraints;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  cancellationRequestedAt: string | null;
  finalCommits: string[];
  prUrl: string | null;
}

export interface ResolvedSkill {
  id: string;
  version: string;
  description: string;
  capabilities: string[];
  path: string;
  content: string;
  files: Record<string, string>;
  hash: string;
}

export interface MercuryEvent {
  id: string;
  runId: string;
  type: string;
  sequence: number;
  timestamp: string;
  payload: unknown;
}

export interface AgentsResponse { agents: string[]; defaultAgent: string }
export interface CreateRunResponse { runId: string; status: RunStatus }
export interface RunListResponse { runs: Run[]; nextCursor: string | null }
export interface RunDetailResponse { run: Run; skills: ResolvedSkill[] }

export interface EventPage {
  events: MercuryEvent[];
  /** Informational maximum. NOT a resume point on a truncated page -- use nextCursor. */
  lastSequence: number;
  nextCursor: number;
  hasMore: boolean;
}

export interface OkResponse { ok: true }
export interface RunActionResponse { runId: string; status: RunStatus }
export interface RetryRunResponse { runId: string; status: RunStatus; retryOf: string | null }

export interface CreateRunRequest {
  task: string;
  repository?: string;
  repositories?: RepositoryContext[];
  agent?: string;
  skills?: string[];
  constraints?: Partial<RunConstraints>;
}

export interface RunListQuery { status?: RunStatus; limit?: number; cursor?: string }
export interface EventQuery { after?: number; limit?: number }

/** Raised when a response is missing something the client cannot operate without. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}
// ---------------------------------------------------------------------------
// Runtime validation
//
// Every parser below answers one question: can the client still be CORRECT with
// this response? Anything it merely displays is passed through untouched.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asObject(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError(`expected ${what} to be a JSON object`);
  }
  return value as Json;
}

function reqString(value: unknown, field: string, what: string): string {
  if (typeof value !== 'string') {
    throw new ProtocolError(`${what}.${field} must be a string, got ${typeof value}`);
  }
  return value;
}

function reqNumber(value: unknown, field: string, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError(`${what}.${field} must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function reqArray(value: unknown, field: string, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProtocolError(`${what}.${field} must be an array, got ${typeof value}`);
  }
  return value;
}

/**
 * Validate the fields a Run must carry for the client to be correct, and pass the rest through.
 *
 * `status` is required because the whole presentation model keys off it, and a missing status
 * would render as an empty cell rather than an error. `id` is required because it is the key used
 * to fetch events and to build follow-up commands. Unknown extra fields are preserved verbatim so
 * a newer server stays readable by an older client.
 */
export function parseRun(value: unknown): Run {
  const o = asObject(value, 'run');
  const status = reqString(o.status, 'status', 'run');
  if (!RUN_STATUSES.includes(status)) {
    // An unrecognised status is NOT tolerated: treating it as non-terminal would make `runs watch`
    // wait forever on a Run that already finished, and treating it as terminal would invent an
    // outcome. The client cannot know, so it must say so.
    throw new ProtocolError(`run.status ${JSON.stringify(status)} is not a status this client knows`);
  }
  return { ...(o as unknown as Run), id: reqString(o.id, 'id', 'run'), status: status as RunStatus };
}

export function parseAgentsResponse(value: unknown): AgentsResponse {
  const o = asObject(value, 'agents response');
  return {
    agents: reqArray(o.agents, 'agents', 'agents response').map((a) => reqString(a, 'agent', 'agents response')),
    defaultAgent: reqString(o.defaultAgent, 'defaultAgent', 'agents response'),
  };
}

export function parseCreateRunResponse(value: unknown): CreateRunResponse {
  const o = asObject(value, 'create response');
  const status = reqString(o.status, 'status', 'create response');
  if (!RUN_STATUSES.includes(status)) {
    throw new ProtocolError(`create response status ${JSON.stringify(status)} is unknown`);
  }
  return { runId: reqString(o.runId, 'runId', 'create response'), status: status as RunStatus };
}

export function parseRunActionResponse(value: unknown): RunActionResponse {
  const o = asObject(value, 'run action response');
  const status = reqString(o.status, 'status', 'run action response');
  if (!RUN_STATUSES.includes(status)) {
    throw new ProtocolError(`run action status ${JSON.stringify(status)} is unknown`);
  }
  return { runId: reqString(o.runId, 'runId', 'run action response'), status: status as RunStatus };
}

export function parseRetryRunResponse(value: unknown): RetryRunResponse {
  const base = parseRunActionResponse(value);
  const o = asObject(value, 'retry response');
  // retryOf is the only thing that proves this is a NEW Run rather than a transition of the old
  // one, which the command contract forbids presenting as the latter. Null is legal (retrying a
  // Run that was itself an original), so it is required to be PRESENT, not non-null.
  if (!('retryOf' in o)) {
    throw new ProtocolError('retry response.retryOf must be present (string or null)');
  }
  const retryOf = o.retryOf;
  if (retryOf !== null && typeof retryOf !== 'string') {
    throw new ProtocolError(`retry response.retryOf must be a string or null, got ${typeof retryOf}`);
  }
  return { ...base, retryOf };
}

/**
 * Validate the `{ ok: true }` acknowledgement.
 *
 * The body must actually SAY ok. Returning success for any object would report a failed `runs input`
 * as accepted whenever the server answered 200 with an unexpected or error-shaped body -- the client
 * would tell the operator the Run was answered, the Run would stay NEEDS_INPUT, and nothing would
 * explain the difference.
 */
export function parseOkResponse(value: unknown): OkResponse {
  const o = asObject(value, 'ok response');
  if (o.ok !== true) {
    throw new ProtocolError(`expected { ok: true }, got ${JSON.stringify(value).slice(0, 200)}`);
  }
  return { ok: true };
}

export function parseRunListResponse(value: unknown): RunListResponse {
  const o = asObject(value, 'run list response');
  const runs = reqArray(o.runs, 'runs', 'run list response').map(parseRun);
  // nextCursor is opaque and may legitimately be null. It must still be PRESENT: a server that
  // omits it cannot be paged safely, and silently reading it as null would truncate the list
  // while looking like a complete result.
  if (!('nextCursor' in o)) {
    throw new ProtocolError('run list response.nextCursor must be present (string or null)');
  }
  const nextCursor = o.nextCursor;
  if (nextCursor !== null && typeof nextCursor !== 'string') {
    throw new ProtocolError(`run list response.nextCursor must be a string or null, got ${typeof nextCursor}`);
  }
  return { runs, nextCursor };
}

export function parseRunDetailResponse(value: unknown): RunDetailResponse {
  const o = asObject(value, 'run detail response');
  return {
    run: parseRun(o.run),
    // Skills are display data; a server that has not snapshotted any returns [].
    skills: reqArray(o.skills, 'skills', 'run detail response').map((s) => {
      const so = asObject(s, 'skill');
      return { ...(so as unknown as ResolvedSkill), id: reqString(so.id, 'id', 'skill') };
    }),
  };
}

export function parseEvent(value: unknown): MercuryEvent {
  const o = asObject(value, 'event');
  return {
    ...(o as unknown as MercuryEvent),
    id: reqString(o.id, 'id', 'event'),
    runId: reqString(o.runId, 'runId', 'event'),
    // type is intentionally NOT checked against a known list (§14): an unknown event type stays
    // available in JSON and gets a generic human rendering. Failing here would break a complete
    // Run just because Mercury learned a new event.
    type: reqString(o.type, 'type', 'event'),
    // sequence is the load-bearing field. Duplicate suppression, gap detection and the resume
    // cursor are all derived from it, so a missing or non-numeric sequence is a protocol break,
    // not a cosmetic gap -- and it must never default to 0.
    sequence: reqNumber(o.sequence, 'sequence', 'event'),
    timestamp: reqString(o.timestamp, 'timestamp', 'event'),
  };
}

export function parseEventPage(value: unknown): EventPage {
  const o = asObject(value, 'event page');
  const events = reqArray(o.events, 'events', 'event page').map(parseEvent);
  const lastSequence = reqNumber(o.lastSequence, 'lastSequence', 'event page');
  if (typeof o.nextCursor !== 'number' || !Number.isFinite(o.nextCursor)) {
    // Paging from lastSequence instead is the exact bug issue #54 describes: on a capped page it
    // skips every event the cap left out. So nextCursor is required, not defaulted.
    throw new ProtocolError(`event page.nextCursor must be a finite number, got ${JSON.stringify(o.nextCursor)}`);
  }
  return { events, lastSequence, nextCursor: o.nextCursor, hasMore: Boolean(o.hasMore) };
}

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
  /**
   * The harness version that executed this Run, and the raw string it printed
   * (docs/goals.md 13.1). Absent on a server that predates the field, null when the probe
   * produced nothing usable -- both render as "unknown", and neither may be shown as a version.
   */
  agentVersion?: string | null;
  agentVersionRaw?: string | null;
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

/**
 * Goal support for one agent, as reported by the server. Mirrors the server's
 * AgentGoalCapability; declared here because the client package does not import from
 * src/domain.
 */
export interface AgentGoalCapability {
  supported: boolean;
  reason?: 'unsupported' | 'version-too-old' | 'version-unknown';
  requiredVersion?: string;
  detectedVersion?: string | null;
  detectedRaw?: string | null;
}

export interface AgentCapabilitySummary {
  /** null while the server's detached version probe is still in flight. */
  version: string | null;
  versionRaw: string | null;
  goals: AgentGoalCapability;
}

export interface AgentsResponse {
  agents: string[];
  defaultAgent: string;
  /**
   * Optional: an older server omits it, and a newer client must not treat that as
   * "no agent supports goals". Render as unknown, not as false.
   */
  capabilities?: Record<string, AgentCapabilitySummary>;
}
export interface CreateRunResponse { runId: string; status: RunStatus }
export interface RunListResponse {
  runs: Run[];
  nextCursor: string | null;
  /**
   * Goal status keyed by run id. Absent key means the Run has no goal -- that is not the same
   * as a goal of status `absent`, and a renderer must not draw the two the same way.
   */
  goals?: Record<string, GoalSummary>;
}
/**
 * The subset of goal state a list row needs: the status, plus the one field that makes the
 * status actionable.
 *
 * Status alone renders the two kinds of `unmet` the same way -- the harness held the objective and
 * never declared it met, versus the Run died before the harness received it -- and the list is the
 * view an operator actually scans, so that is where hiding the distinction hurt most (issue #492).
 * Nothing else from the goal row belongs here; objectives would put 4000 chars per row into every
 * dashboard poll.
 *
 * `attempted` absent means no answer yet, which is NOT false.
 */
export interface GoalSummary {
  status: GoalStatus;
  attempted?: boolean;
}

/**
 * Full persisted goal state. Mirrors the host's `GoalState`; `objective` is what Mercury
 * stored (validated and redacted at admission), not whatever the harness echoed back.
 */
/**
 * A deterministic gate the harness was asked to run at turn boundaries. Mercury records the
 * spec and never executes it (docs/goals.md 5), so this is a statement of what the harness was
 * expected to check -- not evidence that anything was checked.
 */
export interface GoalGate {
  command: string;
  timeoutMs: number;
  maxRetries: number;
}

/**
 * What "met" means, as the operator stated it at creation (docs/goals.md 5). Mercury records
 * the contract and never evaluates it -- judging completion is the harness' job, and Mercury
 * judging it would be the thing the whole feature refuses to do.
 *
 * Every field is free-form prose and every one is optional; an all-empty contract is
 * normalised to absent, because `{}` and "no contract" must not be two ways to say the same
 * thing.
 */
export interface GoalContract {
  outcome?: string;
  verification?: string;
  constraints?: string;
  boundaries?: string;
  stopWhen?: string;
}

export interface GoalState {
  runId: string;
  status: GoalStatus;
  objective: string;
  /** The completion contract, if one was set. Absent means none, not empty. */
  contract?: GoalContract;
  /**
   * Declared gates, in the order they were requested. Absent means none were requested; an
   * empty array is normalised away server-side, so both read as "no gates".
   */
  gates?: GoalGate[];
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  turnsUsed?: number;
  lastVerdict?: 'done' | 'continue' | 'skipped';
  lastReason?: string;
  lastError?: string;
  pausedReason?: string;
  source?: 'harness' | 'operator';
  /**
   * Whether the Run ever reached RUNNING, present once Mercury settles an abandoned goal.
   * Absent means no answer yet, which is NOT false: an unsettled goal has no answer to give.
   */
  attempted?: boolean;
  updatedAt: string;
}

/**
 * Goal statuses. `unmet` is the only one Mercury originates; the rest are harness reports and
 * `cancelled` is an operator action. `absent` is not a state -- no goal means the field is
 * null or the run id is missing from the map.
 */
export type GoalStatus =
  | 'absent'
  | 'active'
  | 'paused'
  | 'budget_limited'
  | 'error'
  | 'complete'
  | 'cancelled'
  | 'unmet';

export interface RunDetailResponse {
  run: Run;
  skills: ResolvedSkill[];
  /**
   * Sibling of `run`, never a field on it. Goal status and Run status are orthogonal, and the
   * pair (Run COMPLETED, goal unmet) is the thing a reader must see together.
   *
   * Three states, and the third is not optional to honour:
   *   GoalState -- the Run has a goal
   *   null      -- the server answered, and the Run has no goal
   *   undefined -- the server predates goals, so nothing is known
   * Collapsing undefined into null would render "no goal" for an old server, which is the
   * same lie as rendering an undetected capability as "unsupported".
   */
  goal?: GoalState | null;
}

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
  // An OBJECT, not a URL string. The server does not validate this shape: POST /api/runs stores
  // whatever it is given, so sending the convenient `"repository": "https://..."` returns 201 and
  // stores a string where Run.repository is typed as an object. The Run then has no `repository.url`,
  // so the workspace has nothing to check out and `runs show` renders `-` -- created successfully and
  // unusable, with no error anywhere. Verified against a live server. Hence validateCreateRunRequest
  // below, which rejects the string form rather than forwarding it.
  repository?: RepositoryContext;
  repositories?: RepositoryContext[];
  agent?: string;
  skills?: string[];
  constraints?: Partial<RunConstraints>;
}

export interface RunListQuery { status?: RunStatus; limit?: number; cursor?: string }
export interface EventQuery { after?: number; limit?: number }

/** Raised when a response is missing something the client cannot operate without. */
// A malformed request the OPERATOR supplied is a usage error, not a protocol error: the client never
// spoke to anyone. Reporting it as a protocol error mapped it to exit 7 (transport), which tells the
// operator the endpoint is unhealthy when the real answer is "your file is wrong". protocol.ts depends
// on nothing today; this import is protocol -> errors -> exitCodes, and errors.ts does not import
// protocol, so there is no cycle.
import { UsageError } from './errors.ts';

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
  // Parallel map, optional for the same reason as the detail field: an older server simply
  // does not know about goals, and that must stay distinguishable from "no goals exist".
  let goals: Record<string, GoalSummary> | undefined;
  if (o.goals !== undefined) {
    const go = asObject(o.goals, 'run list response.goals');
    goals = {};
    for (const [runId, entry] of Object.entries(go)) {
      // The value is an object, not a bare status string. Both shapes are NOT accepted: no
      // released client reads this key at all (the published 0.1.1 artifact contains no goal
      // code), so there is nothing to be compatible with, and a parser that quietly accepts two
      // shapes keeps the ambiguity alive forever. A string here is a version skew to fail on.
      // A bare string is the shape this map used to have. Naming it beats "expected a JSON
      // object": the operator reading the failure is almost certainly running a new client
      // against an old server (or the reverse), and "expected an object" sends them looking in
      // the wrong place.
      if (typeof entry === 'string') {
        throw new ProtocolError(
          `run list response.goals.${runId} is a bare status string "${entry}"; `
          + 'this client expects { status, attempted? } -- the server and mercuryctl are out of step');
      }
      const eo = asObject(entry, `run list response.goals.${runId}`);
      const status = eo.status;
      if (typeof status !== 'string' || !GOAL_STATUSES.has(status)) {
        throw new ProtocolError(`unknown goal status "${String(status)}" for run ${runId}`);
      }
      // Absent, not false: an unsettled goal has no answer to whether the Run started.
      goals[runId] = typeof eo.attempted === 'boolean'
        ? { status: status as GoalStatus, attempted: eo.attempted }
        : { status: status as GoalStatus };
    }
  }
  return { runs, nextCursor, ...(goals === undefined ? {} : { goals }) };
}

export function parseRunDetailResponse(value: unknown): RunDetailResponse {
  const o = asObject(value, 'run detail response');
  // `goal` is optional on the wire so a client can talk to a server that predates goals. An
  // absent key stays undefined rather than becoming null: "this server never told us" and
  // "this Run has no goal" are different answers, and drawing them the same is how a UI starts
  // lying about a Run it has no information about.
  const goal = o.goal === undefined ? undefined : o.goal === null ? null : parseGoal(o.goal);
  return {
    run: parseRun(o.run),
    // Skills are display data; a server that has not snapshotted any returns [].
    skills: reqArray(o.skills, 'skills', 'run detail response').map((s) => {
      const so = asObject(s, 'skill');
      return { ...(so as unknown as ResolvedSkill), id: reqString(so.id, 'id', 'skill') };
    }),
    ...(goal === undefined ? {} : { goal }),
  };
}

const GOAL_STATUSES = new Set(['absent', 'active', 'paused', 'budget_limited', 'error', 'complete', 'cancelled', 'unmet']);

function parseGoal(value: unknown): GoalState {
  const o = asObject(value, 'goal');
  const status = reqString(o.status, 'goal.status', 'goal');
  if (!GOAL_STATUSES.has(status)) {
    // Rejecting an unknown status is the same call made for event types: a status the client
    // cannot name must not be rendered as if it were one it can.
    throw new ProtocolError(`unknown goal status "${status}"`);
  }
  return {
    runId: reqString(o.runId, 'goal.runId', 'goal'),
    status: status as GoalStatus,
    objective: reqString(o.objective, 'goal.objective', 'goal'),
    updatedAt: reqString(o.updatedAt, 'goal.updatedAt', 'goal'),
    ...(parseGoalContract(o.contract) ? { contract: parseGoalContract(o.contract)! } : {}),
    ...(parseGoalGates(o.gates).length > 0 ? { gates: parseGoalGates(o.gates) } : {}),
    ...(typeof o.tokenBudget === 'number' ? { tokenBudget: o.tokenBudget } : {}),
    ...(typeof o.tokensUsed === 'number' ? { tokensUsed: o.tokensUsed } : {}),
    ...(typeof o.timeUsedSeconds === 'number' ? { timeUsedSeconds: o.timeUsedSeconds } : {}),
    ...(typeof o.turnsUsed === 'number' ? { turnsUsed: o.turnsUsed } : {}),
    ...(typeof o.lastReason === 'string' ? { lastReason: o.lastReason } : {}),
    ...(typeof o.lastError === 'string' ? { lastError: o.lastError } : {}),
    ...(typeof o.pausedReason === 'string' ? { pausedReason: o.pausedReason } : {}),
    // A non-boolean is dropped rather than coerced: absent means "no answer", and coercing a
    // malformed value to false would claim the Run never started.
    ...(typeof o.attempted === 'boolean' ? { attempted: o.attempted } : {}),
    ...(o.source === 'harness' || o.source === 'operator' ? { source: o.source } : {}),
  };
}

/**
 * Gate specs are caller-supplied text that comes back around, so they are parsed rather than
 * passed through: a `command` that is not a string would otherwise reach a terminal or an
 * innerHTML sink unchecked. A malformed gate is rejected outright instead of skipped, because a
 * silently shortened gate list would understate what the harness was asked to enforce.
 */
/** The contract fields Mercury knows. Unknown keys are ignored, not rejected: the contract is
 *  free-form prose and a newer server may add a field this client predates. */
const GOAL_CONTRACT_FIELDS = ['outcome', 'verification', 'constraints', 'boundaries', 'stopWhen'] as const;

function parseGoalContract(value: unknown): GoalContract | undefined {
  if (value === undefined || value === null) return undefined;
  const o = asObject(value, 'goal.contract');
  const out: GoalContract = {};
  for (const field of GOAL_CONTRACT_FIELDS) {
    const v = o[field];
    if (v === undefined || v === null) continue;
    // A non-string is skew or corruption, not something to coerce: rendering `[object Object]`
    // as the success condition an operator is being judged against would be worse than failing.
    if (typeof v !== 'string') throw new ProtocolError(`goal.contract.${field} must be a string`);
    const trimmed = v.trim();
    if (trimmed.length > 0) out[field] = trimmed;
  }
  // Absent, not empty: a contract with no fields says nothing, and rendering an empty block
  // would read as "a contract exists" next to one that genuinely does not.
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseGoalGates(value: unknown): GoalGate[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ProtocolError('goal.gates must be an array');
  return value.map((g, i) => {
    const at = `goal.gates[${i}]`;
    const o = asObject(g, at);
    const command = reqString(o.command, `${at}.command`, at);
    if (typeof o.timeoutMs !== 'number' || !Number.isFinite(o.timeoutMs)) {
      throw new ProtocolError(`${at}.timeoutMs must be a finite number`);
    }
    if (typeof o.maxRetries !== 'number' || !Number.isFinite(o.maxRetries)) {
      throw new ProtocolError(`${at}.maxRetries must be a finite number`);
    }
    return { command, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries };
  });
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

/**
 * Validate a create request the operator supplied, before it is sent.
 *
 * This exists because the server accepts almost anything here. `POST /api/runs` requires only a
 * non-empty `task` and then stores `repository` verbatim, so the two realistic operator mistakes --
 * passing a URL string instead of an object, and misspelling a field name -- both produce a 201 and a
 * Run that cannot be worked on. A rejected request is a much better outcome than a silently useless
 * Run, and rejecting it here means the message can name the field.
 *
 * Unknown TOP-LEVEL keys are rejected (they would be ignored by the server), but keys INSIDE
 * `constraints` and `repository` pass through, since those are forward-compatible extension points
 * where an older client legitimately does not know the newer names.
 */
export function validateCreateRunRequest(value: unknown): CreateRunRequest {
  const o = asObject(value, 'create request');
  const task = reqString(o.task, 'task', 'create request');
  if (task.trim() === '') throw new UsageError('create request: task must not be blank');

  const known = new Set(['task', 'repository', 'repositories', 'agent', 'skills', 'constraints']);
  const unknown = Object.keys(o).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new UsageError(
      `create request has unrecognised field(s): ${unknown.join(', ')}. ` +
        `Accepted: ${[...known].join(', ')}. A misspelled field would be ignored by the server and ` +
        'the Run would be created without it.',
    );
  }

  const request: CreateRunRequest = { task };
  if (o.repository !== undefined) request.repository = validateRepository(o.repository, 'repository');
  if (o.repositories !== undefined) {
    request.repositories = reqArray(o.repositories, 'repositories', 'create request')
      .map((r, i) => validateRepository(r, `repositories[${i}]`));
  }
  if (o.agent !== undefined) request.agent = reqString(o.agent, 'agent', 'create request');
  if (o.skills !== undefined) {
    request.skills = reqArray(o.skills, 'skills', 'create request')
      .map((s, i) => reqString(s, `skills[${i}]`, 'create request'));
  }
  if (o.constraints !== undefined) request.constraints = validateConstraints(o.constraints);
  return request;
}

function validateRepository(value: unknown, where: string): RepositoryContext {
  if (typeof value === 'string') {
    throw new UsageError(
      `${where} must be an object, not the string ${JSON.stringify(value.slice(0, 60))}. ` +
        'Use {"url": "..."} -- the server stores this field verbatim, so a string is accepted and then ' +
        'produces a Run with no repository to check out.',
    );
  }
  const o = asObject(value, where);
  const repo: RepositoryContext = {};
  for (const key of ['url', 'localPath', 'baseBranch', 'baseCommit'] as const) {
    const v = o[key];
    if (v !== undefined) repo[key] = reqString(v, `${where}.${key}`, where);
  }
  if (repo.url === undefined && repo.localPath === undefined) {
    throw new UsageError(`${where} needs at least one of "url" or "localPath"`);
  }
  return { ...repo, ...(o as Record<string, unknown>) } as RepositoryContext;
}

function validateConstraints(value: unknown): Partial<RunConstraints> {
  const o = asObject(value, 'constraints');
  const out: Record<string, unknown> = { ...o };
  for (const key of ['maxDurationMs', 'maxRetries', 'budgetTokens', 'budgetCost'] as const) {
    const v = o[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new UsageError(`constraints.${key} must be a non-negative number, got ${JSON.stringify(v)}`);
    }
    out[key] = v;
  }
  return out as Partial<RunConstraints>;
}

/**
 * SSE frame names the server sends that are NOT Mercury events.
 *
 * `hello` is the stream's opening frame: it echoes the run id and the `after` cursor the server
 * honoured, which is what lets a client confirm it resumed where it meant to. Its payload has no
 * `sequence`, so feeding it to parseEvent raises a protocol error and a watch dies on contact with a
 * healthy server. Names are matched exactly and the set is small on purpose: an unknown frame name is
 * still a protocol error, because silently skipping an unrecognised frame is how a new server-side
 * event type becomes invisible.
 */
export const NON_EVENT_FRAME_TYPES: ReadonlySet<string> = new Set(['hello']);

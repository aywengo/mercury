// The create-Run request validator (A0-5, issue #989).
//
// ONE validator, not two: `POST /api/runs` (its boundary half, `validateCreateRequestKeys`,
// on the raw body), the A2A exposed-skill catalog (docs/a2a-design.md section 6.2) and the
// bot task templates (`host bot validate`, dispatcher-bot-design.md section 12) all pass
// their create-request bodies through `validateCreateRequest`, so the same invalid body is
// refused identically by every surface. That is the general form of the #785 fix: night 1 of
// #742 dispatched 20 Runs that all failed at workspace setup because a template had no
// `repository` and nothing checked templates against the create model.
//
// Pure on purpose: no database, no registries, no capability probes. The checks that need
// server state (the agent is registered, a named preset/workflow resolves, capability
// matrices, the selection record's agreement with the resolved agent/model) stay in
// `RunService.create` -- and the A1 server-load path runs them through the same code.
//
// Lives in src/domain/ like the other checks it reuses (modelShape, goalSpec): its users span
// the bot boundary, whose coupling guard (dispatcher-bot-design.md section 15 item 4) admits
// domain modules, and the server (src/api, src/a2a, src/runs).
//
// `validateConstraints` moved here from runService.ts with its messages intact; it was
// module-private there, which is exactly why neither an offline validator nor
// `host bot validate` could call it (the #989 mechanism statement).

import { ValidationError } from './errors.ts';
import { validateModelShape } from './modelShape.ts';
import { GoalValidationError, resolveGoalSpec } from './goalSpec.ts';
import { KnowledgeRequestError, parseKnowledgeRequest } from '../knowledge/request.ts';
import { parseByteLimit, parseCpuLimit } from '../sandbox/resourceLimits.ts';
import type { RepositoryContext } from './types.ts';
import { suggestionFor } from './suggestKey.ts';

// -- Constraints (moved from runService.ts, issue #28) --

const NUMERIC_CONSTRAINT_KEYS = ['maxDurationMs', 'maxRetries', 'budgetTokens', 'budgetCost'] as const;
const CONSTRAINT_KEYS = new Set(['maxDurationMs', 'maxRetries', 'budgetTokens', 'budgetCost', 'resourceLimits', 'allowedNetworks', 'notAfter', 'botTask']);

// Renamed by issue #63 because max* implied enforcement that does not exist. Rejecting them with a
// migration message (rather than the generic "Unknown constraint") is deliberate: a stale client
// would otherwise get an error that names neither the new spelling nor the reason.
const RENAMED_CONSTRAINTS: Record<string, string> = Object.assign(Object.create(null), {
  maxTokens: 'budgetTokens',
  maxCost: 'budgetCost',
});

/** Validate a client-supplied constraints object (issue #28). */
export function validateConstraints(c: Record<string, unknown>): void {
  for (const key of Object.keys(c)) {
    // Object.hasOwn, not a bare index: a plain object literal inherits from Object.prototype, so
    // `RENAMED_CONSTRAINTS['toString']` returns the toString FUNCTION, which is truthy. A client
    // sending `{ toString: 1 }` would then get "constraint toString was renamed to function
    // toString() { [native code] }..." instead of the correct "Unknown constraint: toString".
    // Verified against node: toString, constructor, valueOf, hasOwnProperty and __proto__ all
    // resolve to something truthy through the prototype chain.
    const renamed = Object.hasOwn(RENAMED_CONSTRAINTS, key) ? RENAMED_CONSTRAINTS[key] : undefined;
    if (renamed) {
      throw new ValidationError(
        `constraint ${key} was renamed to ${renamed}: it is recorded but not enforced, so the ` +
        `max* name implied a guarantee that does not exist`,
      );
    }
    if (!CONSTRAINT_KEYS.has(key)) {
      throw new ValidationError(`Unknown constraint: ${key}`);
    }
  }
  for (const key of NUMERIC_CONSTRAINT_KEYS) {
    const v = c[key];
    if (v === undefined) continue;
    // budgetCost is a money amount, so fractional values are the normal case: `budgetCost: 2.5`
    // means two dollars and fifty cents. Requiring an integer here made the field unable to
    // express any non-whole budget, rejecting exactly the values it exists to accept. The other
    // three are genuine counts/durations and stay integer-only.
    const integral = key !== 'budgetCost';
    if (typeof v !== 'number' || !Number.isFinite(v) || (integral && !Number.isInteger(v))) {
      throw new ValidationError(`constraint ${key} must be a finite ${integral ? 'integer' : 'number'}`);
    }
    if (v < 0) {
      throw new ValidationError(`constraint ${key} must be >= 0`);
    }
    if (v > Number.MAX_SAFE_INTEGER) {
      throw new ValidationError(`constraint ${key} must be <= ${Number.MAX_SAFE_INTEGER}`);
    }
  }
  const rl = c.resourceLimits;
  if (rl !== undefined) {
    if (typeof rl !== 'object' || rl === null || Array.isArray(rl)) {
      throw new ValidationError('constraint resourceLimits must be an object');
    }
    for (const [k, v] of Object.entries(rl)) {
      if (!['cpu', 'memory', 'disk'].includes(k)) {
        throw new ValidationError(`Unknown resourceLimits key: ${k}`);
      }
      if (typeof v !== 'string') {
        throw new ValidationError(`resourceLimits.${k} must be a string`);
      }
      // Section 3.3: malformed values are rejected BEFORE the Run is inserted, not at container
      // start where they first fail. The parsers mirror what the sandbox manager passes to
      // docker/podman (#725).
      if (k === 'cpu' && parseCpuLimit(v) === null) {
        throw new ValidationError(`resourceLimits.cpu ${JSON.stringify(v)} is not a positive decimal (e.g. "1.5")`);
      }
      if (k !== 'cpu' && parseByteLimit(v) === null) {
        throw new ValidationError(`resourceLimits.${k} ${JSON.stringify(v)} is not a positive integer with an optional b/k/m/g suffix (e.g. "512m")`);
      }
    }
  }
  const an = c.allowedNetworks;
  if (an !== undefined) {
    if (!Array.isArray(an) || an.some((x) => typeof x !== 'string')) {
      throw new ValidationError('constraint allowedNetworks must be an array of strings');
    }
  }
  const bt = c.botTask;
  if (bt !== undefined) {
    // A recorded-only hint (section 4.3), but the bot's singleFlight groups Runs by it, so constrain
    // it to the same task-name vocabulary the bot config enforces (keys.ts dispatchKey). Anything
    // else would let two different tasks collide under one hint.
    if (typeof bt !== 'string' || !/^[a-z0-9-]+$/.test(bt)) {
      throw new ValidationError('constraint botTask must be a string matching ^[a-z0-9-]+$');
    }
  }
  const na = c.notAfter;
  if (na !== undefined) {
    // An ABSOLUTE deadline must name its offset: a timezone-less '2026-01-01T00:00:00' parses via
    // Date.parse as server-local time, so the same config string means different instants on
    // different hosts. Require an explicit Z or +hh:mm offset and parse once.
    if (
      typeof na !== 'string'
      || !/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:Z|[+-]\d{2}:\d{2})$/.test(na)
      || Number.isNaN(Date.parse(na))
    ) {
      throw new ValidationError('constraint notAfter must be an ISO-8601 timestamp with an explicit UTC offset (Z or +hh:mm)');
    }
    // Must be in the future AT CREATION: a deadline already passed would make the Run
    // unstartable by construction, which is a caller mistake, not a queue state (#731).
    if (Date.parse(na) <= Date.now()) {
      throw new ValidationError('constraint notAfter must be in the future');
    }
  }
}

// -- The create-request shape (A0-5, issue #989) --

/**
 * The fields of a caller-facing create-Run request: exactly the fields `POST /api/runs`
 * forwards (src/api/routes.ts). Internal-only fields (`ownerId`, `retryLink`, `origin`, the
 * snapshots, `modelSource`, `idempotencyKey`) are NOT create-request fields: no body may carry
 * them, and no validator sees them -- `RunService.create` runs this check on the named fields
 * only, so in-process callers keep passing their internal parameters.
 */
export const CREATE_REQUEST_FIELDS = [
  'task',
  'repository',
  'repositories',
  'agent',
  'skills',
  'constraints',
  'goal',
  'knowledge',
  'preset',
  'workflow',
  'model',
  'selection',
] as const;

export type CreateRequestField = (typeof CREATE_REQUEST_FIELDS)[number];

/** The message for a body that carries a key the create request does not know. */
export function unknownCreateRequestKeyMessage(key: string): string {
  const s = suggestionFor(key, CREATE_REQUEST_FIELDS);
  // A misspelled field used to be IGNORED by the server (the route forwards named fields only):
  // the Run was created without it -- #785's failure mode at the body level. Refused, with the
  // same did-you-mean discipline the bot configs and the preset/workflow blocks use.
  return `create request has unknown key ${JSON.stringify(key)}${s ? ` (did you mean '${s}'?)` : ''}; allowed keys: ${CREATE_REQUEST_FIELDS.join(', ')}`;
}

const REPOSITORY_KEYS = ['url', 'localPath', 'baseBranch', 'baseCommit'] as const;

/**
 * Shape of one repository object (the `repository` field and each `repositories[]` entry).
 *
 * The server stored these VERBATIM before: a string round-tripped into a Run with nothing to
 * check out (the client's copy of this check, client/api/protocol.ts, exists for exactly that
 * reason), and a misspelled key failed later at workspace setup with an error naming no field.
 * A string or non-object is now refused with a fixable message; the KNOWN keys must be
 * non-empty strings when present. Unknown keys stay legal -- the field is still stored
 * verbatim (the client deliberately forwards them, so a newer client must not 400 on this
 * server), and `requireTemplateRepository` checks what a template actually needs.
 *
 * An EMPTY object stays legal on the create surface -- it is the documented "no repository"
 * form (the UI sends it). Templates add the url/localPath requirement on top
 * (`requireTemplateRepository`), which is the #785 rule.
 */
export function validateRepositoryShape(value: unknown, where: string): void {
  if (typeof value === 'string') {
    throw new ValidationError(
      `${where} must be an object, not the string ${JSON.stringify(value.slice(0, 60))}. ` +
        'Use {"url": "..."} -- a string is stored where the workspace expects a repository, so the Run has nothing to check out.',
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${where} must be a JSON object`);
  }
  const o = value as Record<string, unknown>;
  for (const key of REPOSITORY_KEYS) {
    const v = o[key];
    if (v !== undefined && (typeof v !== 'string' || v.length === 0)) {
      throw new ValidationError(`${where}.${key} must be a non-empty string when present`);
    }
  }
}

/** The closed `preset` block shape (#859): the pure half of create()'s preset validation. */
export function validatePresetShape(preset: unknown): void {
  if (preset === null || typeof preset !== 'object' || Array.isArray(preset)) {
    throw new ValidationError('preset must be an object with an id');
  }
  // An unknown key is refused, never ignored. A typo such as `versoin` would otherwise
  // drop the version pin silently and resolve the current preset -- the exact downgrade
  // the pin exists to catch (the same closed-shape rule as the workflow block, #842 r4).
  for (const key of Object.keys(preset as object)) {
    if (key !== 'id' && key !== 'version') {
      const hint = /^v/i.test(key) ? " (did you mean 'version'?)" : /^i/i.test(key) ? " (did you mean 'id'?)" : '';
      throw new ValidationError(`preset has unknown key ${JSON.stringify(key)}${hint}; allowed keys: id, version`);
    }
  }
  const block = preset as { id?: unknown; version?: unknown };
  if (typeof block.id !== 'string' || block.id.length === 0) {
    throw new ValidationError('preset.id must be a non-empty string');
  }
  if (block.version !== undefined && (typeof block.version !== 'string' || block.version.length === 0)) {
    throw new ValidationError('preset.version must be a non-empty string when given');
  }
}

/** The closed `workflow` block shape (#842 r4): the pure half of create()'s workflow validation. */
export function validateWorkflowShape(workflow: unknown): void {
  if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new ValidationError('workflow must be an object with an id');
  }
  // Closed shape (#842 review r4): an unknown key is refused, never ignored. A typo such as
  // `versoin` would otherwise drop the version pin silently and run the current template --
  // the exact downgrade the pin exists to catch.
  for (const key of Object.keys(workflow as object)) {
    if (key !== 'id' && key !== 'version') {
      const hint = /^v/i.test(key) ? " (did you mean 'version'?)" : /^i/i.test(key) ? " (did you mean 'id'?)" : '';
      throw new ValidationError(`workflow has unknown key ${JSON.stringify(key)}${hint}; allowed keys: id, version`);
    }
  }
  const wf = workflow as { id?: unknown; version?: unknown };
  if (typeof wf.id !== 'string' || wf.id.length === 0) {
    throw new ValidationError('workflow.id must be a non-empty string');
  }
  if (wf.version !== undefined && (typeof wf.version !== 'string' || wf.version.length === 0)) {
    throw new ValidationError('workflow.version must be a non-empty string when given');
  }
}

export interface CreateRequestValidationOptions {
  /**
   * Require the primary repository to name a `url` or `localPath` (the #785 rule,
   * docs/a2a-design.md section 6.2). Templates -- A2A skill templates and bot task templates --
   * must pin a repository: a Run without one fails at workspace setup, so for a template that
   * is a load-time finding, not a failed night.
   *
   * Direct create calls keep accepting repository-less requests (behavior unchanged; the worker
   * still fails them at workspace setup, exactly as before).
   */
  requireRepository?: boolean;
}

/**
 * Validate a create-request body's shape -- the ONE validator for every surface (A0-5, #989).
 *
 * `RunService.create` runs it on the named caller-facing fields it receives, `POST /api/runs`
 * runs its boundary half (`validateCreateRequestKeys`) on the raw body -- the block checks
 * stay with the service so they run AFTER the idempotency-replay lookup -- and the template
 * validators on the resolved template, so an invalid body is refused identically by the API
 * and by `host a2a validate` (acceptance 2: one validator, not two).
 *
 * Throws a ValidationError naming the offending field on the first problem, in the order
 * `RunService.create` always checked them: the closed shape, then task, constraints, model,
 * preset, workflow, goal, knowledge, and the shapes create() never had (repository,
 * repositories, agent, skills) last.
 *
 * `selection` is a KNOWN field (the route forwards it) but is not shape-checked here: its
 * `chosen` check runs against the RESOLVED agent/model, which only create() knows -- a preset
 * or workflow can change both. It is validated, unchanged, in `RunService.create`.
 *
 * Deliberately NOT here otherwise: the server-stamped refusal (a body-level rule the HTTP
 * boundary and the template loaders run), and every check that needs server state (agent
 * registered, preset/workflow resolvable, capabilities) -- those run in `RunService.create`,
 * unchanged.
 */
/**
 * The boundary half of the create-request check: the body is a JSON object and every key in it
 * is a known create-request field.
 *
 * This is all `POST /api/runs` and the workflow route run on the RAW body -- and it is
 * deliberate. The block checks of `validateCreateRequest` (goal, knowledge, preset, workflow,
 * the repository shapes, ...) run in `RunService.create`'s admission, which runs them AFTER the
 * idempotency-replay lookup: a replayed key returns the original Run and its original record,
 * and the new body's blocks are ignored -- the rule selection/goal/knowledge/preset/workflow
 * always followed. Running the full check at the route would 400 a replay before the service
 * could answer it (Copilot review of this PR). The unknown-key refusal stays at the boundary,
 * because a misspelled field is exactly what the service never sees (the route forwards named
 * fields only) -- #785's failure mode at the body level.
 */
export function validateCreateRequestKeys(request: unknown): void {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new ValidationError('create request must be a JSON object');
  }
  const r = request as Record<string, unknown>;
  // Closed shape: a misspelled caller field is refused, never ignored. Runs FIRST because the
  // misspelling is the root cause of what follows (a `constrains` typo plus missing
  // constraints reads as "constraints required" without the suggestion).
  for (const key of Object.keys(r)) {
    if (!(CREATE_REQUEST_FIELDS as readonly string[]).includes(key)) {
      throw new ValidationError(unknownCreateRequestKeyMessage(key));
    }
  }
}

export function validateCreateRequest(
  request: unknown,
  opts: CreateRequestValidationOptions = {},
): void {
  validateCreateRequestKeys(request);
  const r = request as Record<string, unknown>;
  // `task` is the one required field. The check is widened to non-strings, which used to
  // TypeError (and 500) at the HTTP boundary: `123` has no `.trim()`.
  const task = r.task;
  if (typeof task !== 'string' || task.trim().length === 0) {
    throw new ValidationError('task is required');
  }
  if (r.constraints) validateConstraints(r.constraints as Record<string, unknown>);
  if (r.model !== undefined) {
    validateModelShape(r.model as string, 'model');
  }
  if (r.preset !== undefined) validatePresetShape(r.preset);
  if (r.workflow !== undefined) {
    validateWorkflowShape(r.workflow);
    if (r.preset !== undefined) {
      throw new ValidationError(
        'preset and workflow are mutually exclusive: an advisory workflow renders per-stage'
        + ' preset guidance for its own steps, so a Run-wide preset has no place in it',
      );
    }
  }
  // Goal admission shape (docs/goals.md): resolved against the task here; the capability checks
  // that need server state stay in create().
  if (r.goal !== undefined && r.goal !== null) {
    try {
      resolveGoalSpec(r.goal, task);
    } catch (err) {
      throw new ValidationError(err instanceof GoalValidationError ? err.message : `invalid goal: ${String(err)}`);
    }
  }
  // Knowledge admission shape (docs/knowledge-base.md 9.1): the block's shape is request-level;
  // whether the knowledge surface is configured stays in create().
  if (r.knowledge !== undefined && r.knowledge !== null) {
    try {
      parseKnowledgeRequest(r.knowledge);
    } catch (err) {
      throw new ValidationError(err instanceof KnowledgeRequestError ? err.message : String(err));
    }
  }
  // `null` is treated as OMITTED for repository, repositories, agent and skills -- exactly the
  // `??`/`=== null` semantics create() always had (issue #459 pins `skills: null` to "omitted",
  // not "none"). The blocks that refuse an explicit null (preset, workflow, model) keep doing so:
  // a documented object field may not smuggle a null past its closed-shape check (#859 r2).
  if (r.repository !== undefined && r.repository !== null) validateRepositoryShape(r.repository, 'repository');
  if (r.repositories !== undefined && r.repositories !== null) {
    if (!Array.isArray(r.repositories)) {
      throw new ValidationError('repositories must be an array of repository objects');
    }
    r.repositories.forEach((x, i) => validateRepositoryShape(x, `repositories[${i}]`));
  }
  if (r.agent !== undefined && r.agent !== null
    && (typeof r.agent !== 'string' || r.agent.trim().length === 0)) {
    throw new ValidationError('agent must be a non-empty string');
  }
  if (r.skills !== undefined && r.skills !== null) {
    if (!Array.isArray(r.skills) || r.skills.some((s) => typeof s !== 'string' || s.trim().length === 0)) {
      throw new ValidationError('skills must be an array of non-empty strings');
    }
  }
  // The template requirement (#785, docs/a2a-design.md section 6.2): a template pins EVERYTHING
  // except the caller's text, and a Run without a repository fails at workspace setup.
  if (opts.requireRepository) {
    requireTemplateRepository(r, 'template');
  }
}

/**
 * The template-level rule the create surface does not have (A0-5, #785): a template must name
 * a primary repository with a `url` or `localPath`. The primary is `repository` itself (the
 * workspace checks out `run.repository`; `repositories[]` are extras attached under it), so a
 * template that only fills the list still has nothing to check out.
 */
export function requireTemplateRepository(request: Record<string, unknown>, where: string): void {
  const repo = request.repository;
  if (repo === undefined || repo === null) {
    throw new ValidationError(`${where} must name a repository (url or localPath); a Run without one fails at workspace setup (#785)`);
  }
  if (typeof repo !== 'object' || Array.isArray(repo)) {
    throw new ValidationError(`${where} must name a repository with a url or localPath`);
  }
  const o = repo as Partial<RepositoryContext>;
  const hasUrl = typeof o.url === 'string' && o.url.length > 0;
  const hasLocalPath = typeof o.localPath === 'string' && o.localPath.length > 0;
  if (!hasUrl && !hasLocalPath) {
    throw new ValidationError(`${where} must name a repository with a url or localPath`);
  }
}

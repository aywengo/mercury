// Run creation, input, cancellation, retry (Mercury.md sections 7, 19-21).

import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tx } from '../db/database.ts';
import { validateModelShape } from '../domain/modelShape.ts';
export { validateModelShape };
import { isTerminal } from '../domain/stateMachine.ts';
import { TERMINAL_GOAL_STATUSES } from '../domain/goalEvents.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.ts';
import type { Redactor } from '../domain/redact.ts';
import type { AgentCapabilitySummary, GoalState, GoalStatus, GoalSummary, RepositoryContext, ResolvedSkill, Run, RunConstraints, RunStatus } from '../domain/types.ts';
import { goalCapabilityMessage, goalFieldCapabilityMessage } from '../domain/goalSupport.ts';
import { GoalValidationError, resolveGoalSpec } from '../domain/goalSpec.ts';
import type { GoalStore } from './goalStore.ts';
import { EventStore } from '../events/eventStore.ts';
import type { SkillRegistry } from '../skills/skillRegistry.ts';
import type { SkillSelector } from '../skills/skillSelector.ts';
import { parseByteLimit, parseCpuLimit } from '../sandbox/resourceLimits.ts';
import { RunStore, newRunId } from './runStore.ts';
import { PresetStore, type RunPresetRow } from './presetStore.ts';
import type { PresetRegistry } from '../presets/presetRegistry.ts';
import type { ResolvedRolePreset } from '../presets/types.ts';
import { resolvePreset, type PresetCallerInput } from '../presets/resolvePreset.ts';
import type { ReplicaStore } from '../knowledge/replica.ts';
import { selectPack, type PackSelection } from '../knowledge/pack.ts';
import { KnowledgeRequestError, knowledgeCapabilityMessage, parseKnowledgeRequest } from '../knowledge/request.ts';
import type { KnowledgeRequest } from '../knowledge/types.ts';
import { resolveProfile, type CredentialProfiles } from '../host/credentials-profiles.ts';

export interface KnowledgeSelectionDeps {
  /** The Atlas project this host contributes to and reads (section 5). */
  projectId: string;
  replica: ReplicaStore;
  /** Host ceiling on pack size. A per-Run `maxBytes` is clamped to it, never allowed past it. */
  packMaxBytes: number;
  /** MERCURY_KNOWLEDGE_INJECT. When false, Runs get no pack unless they ask for one. */
  injectByDefault: boolean;
  /**
   * Which agents can receive a pack, from the same capability snapshot goals use (section 7.4).
   *
   * Supplied as a function because the underlying probes are detached and the answer changes when they
   * land. An agent absent from the map is UNKNOWN, which fails open: no pack, no error, because an
   * unverified harness must not brick a Run. `require: true` is what turns unknown into a refusal.
   */
  capabilities?: () => Record<string, AgentCapabilitySummary>;
}

export interface CreateRunInput {
  ownerId: string;
  task: string;
  repository?: RepositoryContext;
  /** Additional repositories (roadmap #6); `repositories` or `repository` both work. */
  repositories?: RepositoryContext[];
  agent?: string;
  skills?: string[];
  /**
   * Skill snapshots to store verbatim instead of resolving `skills` against the live registry.
   *
   * Only retry uses this (#506). A Run's skill rows are a snapshot for a reason: they pin the
   * exact bytes, version and hash the Run was created with. Re-resolving by id at execution time
   * silently substitutes whatever the registry holds now, so editing a skill changes what an
   * already-queued Run does, and deleting one makes `resolveOne` throw and the Run fail to start.
   */
  skillSnapshots?: ResolvedSkill[];
  constraints?: Partial<RunConstraints>;
  /**
   * INTERNAL — retry only, never accepted from HTTP (the route forwards named fields only).
   * The parent Run's stored credential profile: the retry's OWN resolution inside create() must
   * equal it, checked against the SAME file read that decides the retry's stored value. That
   * closes the two-reads window (Copilot review round 1 on #841): a guard that read the file in
   * retry() and again in create() could pass on read 1 and persist a changed profile from
   * read 2, letting the parent's work resume under a different identity.
   */
  retryCredentialProfile?: string | null;
  /**
   * Optional objective for the Run (docs/goals.md). `undefined` means no goal and the Run
   * behaves exactly as before. Validated and resolved against `task` in create(); an
   * omitted objective defaults to the task text.
   */
  goal?: unknown;
  /**
   * Per-Run control over the knowledge pack (docs/knowledge-base.md 9.1). `undefined` means "use the
   * host default", which never fails; a malformed block is refused. Validated in create() so HTTP and
   * in-process callers hit identical rules, exactly as `goal` does.
   */
  knowledge?: unknown;
  /**
   * Role Preset selection (docs/crew/role-presets.md section 5). `undefined` means no preset
   * and the Run behaves exactly as before. Resolved in create() against the builtin registry;
   * a caller-supplied `version` is an optimistic guard against resolving an unexpected
   * current definition.
   */
  preset?: { id: string; version?: string };
  /**
   * A preset snapshot to store verbatim instead of resolving `preset` against the registry.
   * Only retry uses this, exactly like `skillSnapshots`: a retried Run must execute the SAME
   * bytes its parent executed, not a re-resolution of whatever the registry holds now.
   */
  presetSnapshot?: ResolvedRolePreset;
  /**
   * Per-Run model override (docs/laya-integration-design.md §13 P-1, issue #823). `undefined`
   * means "no caller model" and the Run behaves exactly as before. Resolution, one rule for both
   * paths: caller.model → preset model → none. Refused fail-closed when the effective agent's
   * static capabilities lack `perRunModel: true`, with the same unknown/undeclared/false wording
   * the preset path uses.
   */
  model?: string;
  /**
   * Where `model` came from, when the caller already knows (retry, #832 r1). Retry copies the
   * parent's model; recording it as 'caller' would rewrite the explainability record's origin.
   * Only retry passes this; the HTTP surface does not expose it.
   */
  modelSource?: 'caller' | 'preset';
  /**
   * Optional Laya selection record (issue #854, laya-integration-design §6.5, §13 L1-1).
   * Attribution only: it is stored as the `run.selection_recorded` event in the same
   * transaction as `run.created` and never influences execution. Validated fail-closed in
   * create() (strict v1 schema, at most 8 KiB serialized, `chosen` must match the effective
   * agent/model) AFTER the idempotency-replay check, so a replayed key returns the original
   * Run and its original record; the new body's `selection` is ignored, exactly like `model`.
   */
  selection?: unknown;
  idempotencyKey?: string;
}

export interface RunServiceDeps {
  db: DatabaseSync;
  runs: RunStore;
  events: EventStore;
  skills: SkillRegistry;
  selector: SkillSelector;
  knownAgents: string[];
  /**
   * Builtin preset registry. Absent means presets are off: a `preset` block on a Run is
   * rejected rather than ignored (section 8.4 vocabulary, same shape as knowledge/goals).
   */
  presets?: PresetRegistry;
  /**
   * Per-agent capability snapshot, resolved from what each adapter declares plus the
   * harness version detected at startup. Optional: absent means nothing is known, which
   * resolves to "no agent supports goals" rather than "all do".
   *
   * Supplied as a function rather than a value because the underlying probes are
   * detached -- the answer changes once they land, and a snapshot taken at construction
   * would freeze every agent as version-unknown for the process lifetime.
   */
  agentCapabilities?: () => Record<string, AgentCapabilitySummary>;
  /** Goal persistence. Absent means goals are not wired and any `goal` input is rejected. */
  goals?: GoalStore;
  /**
   * Knowledge selection. Absent means the feature is off: no pack is selected, and a `knowledge` block
   * on the request is rejected rather than ignored (section 8.4).
   *
   * Reads the local replica only. Nothing here may reach the network -- that is the decision which
   * makes an Atlas outage cost freshness instead of costing Run creation (section 8.3).
   */
  knowledge?: KnowledgeSelectionDeps;
  /** Agent id used when create input omits `agent` (MERCURY_DEFAULT_AGENT; default `fake`). */
  defaultAgent: string;
  defaultMaxDurationMs: number;
  defaultMaxRetries: number;
  /** Optional secret redactor; input values are redacted at write time (issue #36). */
  redactor?: Redactor;
  /**
   * Credential profiles (CP-3, issue #807). Optional: absent means credential profiles are not
   * wired (test fakes and callers that predate the feature) and every Run resolves to no profile
   * without touching the filesystem — the composition root always wires the real loader.
   *
   * A function, not a value, because design §5.4/§9 make the FILE the authority at every
   * decision: the file is re-read at creation, claim and retry so an operator edit takes effect
   * without a restart. Caching a snapshot here would freeze the host's identity decisions at
   * boot, which is exactly the staleness the parity check exists to catch.
   */
  credentialProfiles?: () => CredentialProfiles;
}


// -- Laya selection record (#854, laya-integration-design §6.5, §13 L1-1) --
// Strict schema v1. Every field is attribution; none may change execution, so unknown keys are
// refused rather than stored: a record that silently carries extra fields is a schema the
// server does not promise, and GET consumers would read it as one.
const SELECTION_MAX_BYTES = 8 * 1024;
const SELECTION_REASONS = [
  'shadow',
  'below_threshold',
  'sidecar_unavailable',
  'invalid_response',
  'single_candidate',
  'selected',
] as const;
/**
 * Reasons that carry NO Laya pick (#866 review): the sidecar was not asked (single candidate)
 * or gave no usable answer (unavailable, invalid). For these the record must not contain
 * `laya`, `answerConfidence` or `distribution` -- inventing a pick would misreport, and
 * requiring one made every failure dispatch unrecordable. Every other reason means Laya
 * answered, so `laya` is required.
 */
const SELECTION_NO_PICK_REASONS = new Set(['sidecar_unavailable', 'invalid_response', 'single_candidate']);
const SELECTION_KEYS = new Set([
  'via',
  'mode',
  'chosen',
  'laya',
  'answerConfidence',
  'distribution',
  'candidatesOffered',
  'candidatesFiltered',
  'checkpoint',
  'latencyMs',
  'reason',
]);

/** One `{agent, model?}` endpoint inside a selection record. */
function validateSelectionActor(value: unknown, label: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`selection.${label} must be an object`);
  }
  const a = value as Record<string, unknown>;
  for (const k of Object.keys(a)) {
    if (k !== 'agent' && k !== 'model') {
      throw new ValidationError(`selection.${label} has an unknown key: ${k}`);
    }
  }
  if (typeof a.agent !== 'string' || a.agent.length === 0) {
    throw new ValidationError(`selection.${label}.agent must be a non-empty string`);
  }
  if (a.model !== undefined && (typeof a.model !== 'string' || a.model.length === 0)) {
    throw new ValidationError(`selection.${label}.model must be a non-empty string when present`);
  }
}

function validateSelectionProbability(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValidationError(`selection.${label} must be a finite probability in [0, 1]`);
  }
}

/**
 * Validate a `selection` request field (#854) against the effective agent/model and return it.
 * Fail-closed: strict allowlisted keys, bounded size, finite probabilities, and `chosen` must
 * equal what actually ran -- a record that disagrees with the Run it rides on can never be
 * stored, so the record cannot misreport.
 */
export function validateSelection(
  raw: unknown,
  agent: string,
  model: string | undefined,
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('selection must be an object');
  }
  const s = raw as Record<string, unknown>;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(s), 'utf8');
  } catch {
    throw new ValidationError('selection must be JSON-serializable');
  }
  if (bytes > SELECTION_MAX_BYTES) {
    throw new ValidationError(`selection must serialize to at most ${SELECTION_MAX_BYTES} bytes; got ${bytes}`);
  }
  for (const k of Object.keys(s)) {
    if (!SELECTION_KEYS.has(k)) {
      throw new ValidationError(`selection has an unknown key: ${k}`);
    }
  }
  if (s.via !== 'laya') {
    throw new ValidationError('selection.via must be "laya"');
  }
  if (s.mode !== 'shadow' && s.mode !== 'enforce') {
    throw new ValidationError('selection.mode must be "shadow" or "enforce"');
  }
  if (s.reason === undefined || !SELECTION_REASONS.includes(s.reason as (typeof SELECTION_REASONS)[number])) {
    throw new ValidationError(`selection.reason must be one of: ${SELECTION_REASONS.join(', ')}`);
  }
  validateSelectionActor(s.chosen, 'chosen');
  if (SELECTION_NO_PICK_REASONS.has(s.reason as string)) {
    for (const k of ['laya', 'answerConfidence', 'distribution'] as const) {
      if (s[k] !== undefined) {
        throw new ValidationError(`selection.${k} must be absent when reason is "${String(s.reason)}" (no Laya pick)`);
      }
    }
  } else {
    validateSelectionActor(s.laya, 'laya');
  }
  // `chosen` must match the request's effective agent and model (#854): a record that
  // disagrees with what actually ran is refused, so the record can never misreport.
  const chosen = s.chosen as { agent: string; model?: string };
  if (chosen.agent !== agent) {
    throw new ValidationError(
      `selection.chosen.agent ${JSON.stringify(chosen.agent)} does not match the run's agent ${JSON.stringify(agent)}`,
    );
  }
  if (chosen.model !== undefined && model === undefined) {
    throw new ValidationError('selection.chosen.model was given, but the run has no model');
  }
  if (chosen.model === undefined && model !== undefined) {
    throw new ValidationError('selection.chosen.model is missing, but the run has a model');
  }
  if (chosen.model !== undefined && chosen.model !== model) {
    throw new ValidationError(
      `selection.chosen.model ${JSON.stringify(chosen.model)} does not match the run's model ${JSON.stringify(model)}`,
    );
  }
  if (s.answerConfidence !== undefined) validateSelectionProbability(s.answerConfidence, 'answerConfidence');
  if (s.distribution !== undefined) {
    if (typeof s.distribution !== 'object' || s.distribution === null || Array.isArray(s.distribution)) {
      throw new ValidationError('selection.distribution must be an object');
    }
    const dist = s.distribution as Record<string, unknown>;
    const keys = Object.keys(dist);
    if (keys.length > 12) {
      throw new ValidationError(`selection.distribution must have at most 12 entries; got ${keys.length}`);
    }
    for (const k of keys) {
      if (k.length === 0) throw new ValidationError('selection.distribution keys must be non-empty');
      validateSelectionProbability(dist[k], `distribution["${k}"]`);
    }
  }
  for (const k of ['candidatesOffered', 'candidatesFiltered'] as const) {
    if (s[k] !== undefined && (typeof s[k] !== 'number' || !Number.isInteger(s[k]) || (s[k] as number) < 0)) {
      throw new ValidationError(`selection.${k} must be a non-negative integer`);
    }
  }
  if (s.checkpoint !== undefined && (typeof s.checkpoint !== 'string' || s.checkpoint.length > 256)) {
    throw new ValidationError('selection.checkpoint must be a string of at most 256 characters');
  }
  if (s.latencyMs !== undefined
    && (typeof s.latencyMs !== 'number' || !Number.isFinite(s.latencyMs) || (s.latencyMs as number) < 0)) {
    throw new ValidationError('selection.latencyMs must be a non-negative finite number');
  }
  return s;
}

export class RunService {
  private deps: RunServiceDeps;

  constructor(deps: RunServiceDeps) {
    // Fail at construction, not on the first POST: an unknown default is an operator
    // misconfiguration and must not wait for a Run to surface it.
    if (!deps.knownAgents.includes(deps.defaultAgent)) {
      throw new Error(
        `MERCURY_DEFAULT_AGENT=${deps.defaultAgent} is not a registered agent (known: ${deps.knownAgents.join(', ')})`,
      );
    }
    this.deps = deps;
  }

  /** Per-Run preset snapshots (section 6). Lazy: absent when presets are not wired. */
  private presetStore(): PresetStore | null {
    if (!this.deps.presets) return null;
    return new PresetStore(this.deps.db);
  }

  /** Registered agent ids (the adapters wired at startup). */
  listAgents(): string[] {
    return [...this.deps.knownAgents];
  }

  /**
   * Owner-transfer for a removed bot's Runs (§17.7, #760): rewrites owner_id for every Run of
   * `fromOwner` inside one transaction and appends a `run.owner_reassigned` event per Run, so
   * the audit trail survives the ownership change.
   *
   * Validation is shape-only for `toOwner` on purpose: the common case is transferring to a
   * NEW owner (the operator inheriting a dead bot's Runs) who may own no Runs yet - there is no
   * server-side owner registry to check against, and the admin caller names the target.
   *
   * Redaction is unaffected: events pass the redactor at append time and were already redacted
   * at write time; the transfer changes WHO can read them (owner-scoped listing), not WHAT is
   * stored. No secret material rides on the event payload.
   */
  reassignRuns(opts: { fromOwner: string; toOwner: string }): { transferred: number; runIds: string[] } {
    const OWNER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
    const from = opts.fromOwner.trim();
    const to = opts.toOwner.trim();
    if (!OWNER_RE.test(from)) throw new ValidationError(`fromOwner must match ${OWNER_RE.source}; got '${opts.fromOwner}'`);
    if (!OWNER_RE.test(to)) throw new ValidationError(`toOwner must match ${OWNER_RE.source}; got '${opts.toOwner}'`);
    if (from === to) throw new ValidationError('fromOwner and toOwner must differ');
    const runIds = this.deps.runs.reassignOwner(from, to);
    for (const runId of runIds) {
      this.deps.events.append(runId, 'run.owner_reassigned', { fromOwner: from, toOwner: to });
    }
    return { transferred: runIds.length, runIds };
  }
  /** Capability snapshot for every registered agent (docs/goals.md 13.6). */
  listAgentCapabilities(): Record<string, AgentCapabilitySummary> {
    return this.deps.agentCapabilities?.() ?? {};
  }


  /** Agent id used when create input omits `agent`. */
  defaultAgent(): string {
    return this.deps.defaultAgent;
  }

  /**
   * The credential profile a Run with this owner and repositories would use, resolved against
   * the CURRENT file (CP-3, issue #807): one fresh read per call (§5.4 — the file is the
   * authority at every decision), never a cached snapshot.
   *
   * Absent deps (test fakes, callers that predate the feature) resolve to no profile without
   * touching the filesystem. A loaded-but-broken file THROWS (§9): the caller turns that into
   * the right refusal per surface (creation 500, claim-time Run failure) instead of treating
   * it as "no profile".
   */
  resolveCredentialProfile(repositories: ReadonlyArray<RepositoryContext>, ownerId: string): ReturnType<typeof resolveProfile> {
    if (!this.deps.credentialProfiles) return { outcome: 'none' };
    const { profiles } = this.deps.credentialProfiles();
    return resolveProfile(profiles, ownerId, repositories);
  }

  /** Read the stored selection record, if any (#854). Sibling of `run`, like goal/preset. */
  getSelection(runId: string): Record<string, unknown> | null {
    const ev = this.deps.events.list(runId).find((e) => e.type === 'run.selection_recorded');
    return ev ? (ev.payload as Record<string, unknown>) : null;
  }

  create(input: CreateRunInput): Run {
    if (!input.task || input.task.trim().length === 0) {
      throw new ValidationError('task is required');
    }
    if (input.constraints) validateConstraints(input.constraints);
    // Per-Run model shape validation (#823). It reaches argv/config in the adapters (P1-2/P1-3),
    // so it must be a single shell-safe token: no whitespace or control characters, bounded
    // length. An empty string is 'no model' vs an invalid value — refused rather than silently
    // dropped, because a dropped override silently executes with the wrong model.
    if (input.model !== undefined) {
      validateModelShape(input.model, 'model');
    }
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.ownerId, input.idempotencyKey);
      if (existing) return existing;
    }

    // Preset resolution (section 5): BEFORE agent/skills/constraints so the preset acts as
    // defaults the caller can override (and required fields the caller cannot). A retry that
    // carries presetSnapshot skips resolution entirely -- same bytes as the parent, exactly
    // like skillSnapshots.
    let presetSnapshot: ResolvedRolePreset | null = input.presetSnapshot ?? null;
    if (input.preset && !presetSnapshot) {
      if (!this.deps.presets) {
        throw new ValidationError('presets are not enabled on this server; remove the preset block');
      }
      const loaded = this.deps.presets.get(input.preset.id);
      if (input.preset.version && loaded.version !== input.preset.version) {
        throw new ValidationError(
          `preset ${JSON.stringify(input.preset.id)} is version ${loaded.version}, not the requested ${input.preset.version}`,
        );
      }
      if (!loaded.enabled) {
        throw new ValidationError(`preset ${JSON.stringify(loaded.id)} is disabled`);
      }
      const stat = this.deps.agentCapabilities?.();
      const selection = resolvePreset(
        loaded.manifest,
        {
          agent: input.agent,
          // Caller surface exists now (#823): the caller's model wins unless the preset requires
          // its own (modelRequired conflict stays enforced inside resolvePreset).
          model: input.model,
          skills: input.skills,
          constraints: input.constraints,
        } satisfies PresetCallerInput,
        {
          defaultAgent: this.deps.defaultAgent,
          defaultMaxDurationMs: this.deps.defaultMaxDurationMs,
          defaultMaxRetries: this.deps.defaultMaxRetries,
        },
        {
          knownAgents: this.deps.knownAgents,
          staticCapabilities: (agentId) => stat?.[agentId]?.static,
        },
      );

      // Skills: auto-selection (section 3.2 step 2) needs the task text and the available
      // list, so the selector runs here, not inside resolvePreset -- which flags the case
      // (empty start list, autoSelect not disabled). A nativeNames backend with
      // preset skills is a guaranteed fatal exit (issue #507's lesson), so preset skills fail
      // closed for one instead of being silently recorded.
      let skillIds = selection.effectiveSkillIds;
      if (selection.autoSelect) {
        const skillDelivery = this.deps.agentCapabilities?.()[selection.effectiveAgent.id]?.static?.skills;
        if (skillDelivery !== 'nativeNames') {
          // Section 3.2 as amended by #724: the selector runs whenever the start list is empty,
          // and the preset's required skills are appended AFTER its picks (steps 3-4). The
          // selector's budget shrinks by the DISTINCT required count so the merged, deduplicated
          // list still fits the effective maximum without dropping a required skill -- required
          // skills are "always present" by definition.
          // Validation caps DISTINCT ids, so dedupe before the budget math: duplicates in the
          // required list would otherwise shrink the selector's budget more than the final
          // deduped list needs.
          const required: string[] = [];
          const seenRequired = new Set<string>();
          for (const id of selection.effectiveSkillIds) {
            if (seenRequired.has(id)) continue;
            seenRequired.add(id);
            required.push(id);
          }
          const cap = selection.skillCap;
          const picks = this.deps.selector.select(
            input.task,
            this.deps.skills.list(),
            Math.max(0, cap - required.length),
          );
          const seen = new Set<string>();
          skillIds = [];
          for (const id of [...picks, ...required]) {
            if (seen.has(id)) continue;
            seen.add(id);
            skillIds.push(id);
          }
          // Step 5, enforced on the final merged list rather than assumed from the budget: a
          // selector that ignores its budget or an over-cap required set fails the Run at
          // creation with the same message resolveSkillIds uses for the named path.
          if (skillIds.length > cap) {
            throw new ValidationError(
              `preset resolves to ${skillIds.length} skills; the effective maximum is ${cap}`,
            );
          }
        }
      }
      if (skillIds.length > 0
        && this.deps.agentCapabilities?.()[selection.effectiveAgent.id]?.static?.skills === 'nativeNames') {
        throw new ValidationError(
          `preset ${JSON.stringify(loaded.id)} names skills, but agent ${JSON.stringify(selection.effectiveAgent.id)}`
          + ' resolves skill names in its own store; a missing one is a fatal exit. Run this preset'
          + ' on an agent that reads workspace skills.',
        );
      }
      const resolvedSkills = this.deps.skills.resolve(skillIds);
      presetSnapshot = {
        schemaVersion: 1,
        id: loaded.id,
        version: loaded.version,
        role: loaded.role,
        description: loaded.description,
        trust: loaded.trust,
        instruction: loaded.instruction,
        effectiveAgent: selection.effectiveAgent,
        effectiveSkills: resolvedSkills,
        effectiveConstraints: selection.effectiveConstraints,
        source: { kind: loaded.source.kind, relativePath: loaded.source.relativePath },
        files: loaded.files,
        contentHash: loaded.contentHash,
      };
    }

    const presetAgent = presetSnapshot?.effectiveAgent.id;
    const agent = input.agent ?? presetAgent ?? this.deps.defaultAgent;
    if (!this.deps.knownAgents.includes(agent)) {
      throw new ValidationError(`Unknown agent: ${agent} (known: ${this.deps.knownAgents.join(', ')})`);
    }

    // Per-Run model resolution (#823), ONE rule for both paths: caller.model → preset model →
    // none. On the preset path resolvePreset already applied the same precedence (and enforced
    // the modelRequired conflict); the snapshot's effectiveAgent.model IS the resolved preset
    // model. On the no-preset path the caller's value is the only source.
    //
    // Fail closed on BOTH paths: an effective model on an agent whose static capabilities lack
    // `perRunModel: true` is refused at creation, with the same three-way wording (unknown /
    // undeclared / false) resolvePreset uses for the preset path. Today that refuses every real
    // agent, which is correct until the adapters declare the capability (P1-2..P1-4).
    const presetModel = presetSnapshot?.effectiveAgent.model;
    const model = input.model ?? presetModel;
    if (model !== undefined) {
      // The RESOLVED model is validated too (#832 r1): a preset carrying `agent.model: "two
      // words"` passes preset validation today, and only this check keeps the persisted value
      // inside the same contract the caller surface has.
      validateModelShape(model, 'model');
      const stat = this.deps.agentCapabilities?.()[agent]?.static;
      if (stat?.perRunModel !== true) {
        const declared = stat === undefined
          ? 'unknown -- the agent has no declared static capabilities'
          : stat.perRunModel === undefined
            ? "undeclared -- the agent's static block omits perRunModel"
            : "false -- the agent's static block declares perRunModel: false";
        const source = input.model !== undefined ? 'per-Run model' : 'preset model';
        throw new ValidationError(
          `the ${source} ${JSON.stringify(model)} was requested, but agent ${JSON.stringify(agent)}`
          + ` cannot take a per-Run model (perRunModel: ${declared});`
          + ' pick an agent that accepts a per-Run model, or drop the model',
        );
      }
    }

    // Laya selection record (#854). Validated AFTER the idempotency-replay check (so a replayed
    // key returns the original Run and its original record; the new body's `selection` is
    // ignored, exactly like `model`) and after agent/model resolution, because `chosen` is
    // checked against what actually resolved. Fail-closed: a record that cannot be trusted to
    // describe what ran is refused, never partially stored. It is attribution only -- nothing
    // here changes execution -- so the accepted set is a strict v1 schema, not a grab-bag.
    // Only `undefined` counts as omitted: an explicit `null` fails the object check (Copilot
    // review of #865) -- a documented object field may not smuggle a null past validation.
    const selection = input.selection !== undefined
      ? validateSelection(input.selection, agent, model)
      : undefined;

    // Goal admission. Everything about this block is fail-closed, because the failure mode
    // this feature was designed against is accepting a goal and silently not honouring it
    // (issue #459). A goal that cannot be tracked is refused here with the reason, before any
    // state is written -- not accepted, stored, and then never updated.
    let goalState: GoalState | null = null;
    if (input.goal !== undefined && input.goal !== null) {
      let spec;
      try {
        spec = resolveGoalSpec(input.goal, input.task);
      } catch (err) {
        throw new ValidationError(err instanceof GoalValidationError ? err.message : `invalid goal: ${String(err)}`);
      }
      if (!this.deps.goals) {
        throw new ValidationError('goals are not enabled on this server');
      }
      const cap = this.deps.agentCapabilities?.()[agent]?.goals;
      if (!cap?.supported) {
        throw new ValidationError(
          goalCapabilityMessage(agent, cap ?? { supported: false, reason: 'unsupported' }),
        );
      }
      // `set` being supported says nothing about the rest of the spec. Each supplied field is
      // checked against its own matrix entry, because accepting a field the backend cannot act
      // on is the exact failure this feature was written to prevent (issue #459) -- and it is
      // worse than dropping it, since the field is persisted and rendered, so the operator sees
      // gates or a contract that nothing will ever evaluate while the Run sails to COMPLETED.
      //
      // Checked on the RESOLVED spec rather than the raw input: `contract: {}` normalises away
      // to nothing, and refusing that would reject a request that carries no contract at all.
      for (const field of ['tokenBudget', 'contract', 'gates', 'maxTurns'] as const) {
        if (spec[field] === undefined) continue;
        const fieldCap = cap.fields?.[field] ?? { supported: false, reason: 'unsupported' as const };
        if (!fieldCap.supported) {
          throw new ValidationError(goalFieldCapabilityMessage(agent, field, fieldCap));
        }
      }
      // Redact before persisting. `runs.task` is redacted at write time because tasks
      // carry credentials (issue #43); resolving the objective from the RAW task and storing
      // it unredacted in a new table would route around that protection entirely, so this is
      // a leak rather than an audit note.
      //
      // Applied to the resolved value, not just the default: an explicit objective is free
      // text supplied by the same caller that supplies the task, and is no less likely to
      // carry a key. Contract fields and gate commands are the same kind of text.
      const redact = this.deps.redactor;
      const safeObjective = redact ? redact.redact(spec.objective) : spec.objective;
      const safeContract = spec.contract && redact
        ? Object.fromEntries(
            Object.entries(spec.contract).map(([k, v]) => [k, redact.redact(v)]),
          ) as GoalState['contract']
        : spec.contract;
      const safeGates = spec.gates && redact
        ? spec.gates.map((g) => ({ ...g, command: redact.redact(g.command) }))
        : spec.gates;

      goalState = {
        runId: '',
        status: 'active',
        objective: safeObjective,
        contract: safeContract,
        gates: safeGates,
        tokenBudget: spec.tokenBudget,
        // The caller set this; a harness reports back under 'harness'.
        source: 'operator',
        updatedAt: new Date().toISOString(),
      };
    }
    const available = this.deps.skills.list();
    // An omitted `skills` means "choose for me"; an explicitly empty array means
    // "no skills". Collapsing the two (issue #459) made every Run carry at least one
    // skill, because select() falls back rather than returning nothing -- and a Run
    // that always carries skill ids cannot be handed to a backend that resolves them
    // in its own namespace. HermesAgentAdapter passes `-s <id>`, Hermes looks that up
    // in its installed-skill store, and an unknown name is a fatal exit, so Hermes
    // could not execute any Run at all. `null` stays "omitted" so a JSON caller that
    // sends null keeps today's behaviour.
    // A snapshot, when the caller supplies one, replaces resolution rather than supplementing it:
    // resolving the parent's ids here would read the live registry anyway, and would throw for a
    // skill deleted since the parent ran (#506).
    // Which namespace the target backend resolves skills in, read from the capability descriptor
    // rather than a hardcoded per-agent map (#507, using the vocabulary #508 added). A hardcoded map
    // is a second source of truth that drifts from the adapter: the adapter is what actually decides
    // what reaches the child process, so asking it is the only answer that cannot go stale.
    const skillDelivery = this.deps.agentCapabilities?.()[agent]?.static?.skills;
    // ONLY `nativeNames` is disqualifying, and the reason is the failure MODE, not the delivery mode.
    //
    //   workspacePaths -- Mercury ids become workspace paths the worker materialised. Usable.
    //   nativeNames    -- the backend resolves the name in its OWN store and EXITS NON-ZERO on an
    //                     unknown one. Every selected id is a guaranteed Run failure.
    //   none           -- the adapter ignores skills entirely. Harmless: the ids are recorded and
    //                     materialised, nothing forwards them, nothing dies.
    //
    // Treating `none` as incompatible was my first attempt and it broke 8 tests, because the `fake`
    // adapter declares `none` (#508) and every test Run uses it. `none` describes what the adapter
    // forwards, not whether Mercury may hold skill records -- so it must not change selection.
    const canUseMercurySkills = skillDelivery !== 'nativeNames';
    // A preset owns skill selection when it is present: the snapshot's effectiveSkills ARE the
    // resolved list (autoSelect already applied above). A snapshot (retry) carries the parent's
    // exact skill rows. Only a Run without a preset follows the original path.
    const resolved = presetSnapshot
      ? presetSnapshot.effectiveSkills
      : input.skillSnapshots ?? this.deps.skills.resolve(
          input.skills === undefined || input.skills === null
            // An omitted `skills` for a nativeNames backend resolves to NOTHING. Not "fallback
            // suppressed" -- even a well-matched Mercury id is a fatal exit there, so selection is skipped
            // rather than merely denied its fallback.
            ? canUseMercurySkills
              ? this.deps.selector.select(input.task, available, 4)
              : []
            : input.skills,
        );

    // Knowledge admission, validated before anything is written -- the same shape goal admission uses,
    // for the same reason: a block that is accepted and then quietly ignored leaves the caller believing
    // a constraint is in force.
    //
    // The feature being off is a refusal rather than a no-op. A caller who set `scopes` against a host
    // with no Atlas configured would otherwise get a normal-looking Run that knew nothing.
    let knowledgeRequest: KnowledgeRequest | null = null;
    if (input.knowledge !== undefined && input.knowledge !== null) {
      if (!this.deps.knowledge) {
        throw new ValidationError(
          'knowledge is not configured on this server (set MERCURY_ATLAS_URL); remove the knowledge block',
        );
      }
      try {
        knowledgeRequest = parseKnowledgeRequest(input.knowledge);
      } catch (err) {
        throw new ValidationError(err instanceof KnowledgeRequestError ? err.message : String(err));
      }
    }

    // With a preset, the snapshot's effectiveConstraints ARE the Run's constraints: resolution
    // already merged the caller input with preset ceilings/defaults and system policy, and the
    // executed Run must match what the snapshot records (otherwise the snapshot documents
    // limits the worker never applies). The legacy path below is the no-preset behavior.
    const constraints: RunConstraints = presetSnapshot
      ? presetSnapshot.effectiveConstraints
      : {
        maxDurationMs: input.constraints?.maxDurationMs ?? this.deps.defaultMaxDurationMs,
        maxRetries: input.constraints?.maxRetries ?? this.deps.defaultMaxRetries,
        // Absolute deadline that counts queue time (#731); inherited verbatim by retries.
        notAfter: input.constraints?.notAfter,
        // Bot attribution hint (dispatcher-bot-design §4.3); recorded verbatim, never enforced.
        botTask: input.constraints?.botTask,
        budgetTokens: input.constraints?.budgetTokens,
        budgetCost: input.constraints?.budgetCost,
        resourceLimits: input.constraints?.resourceLimits,
        allowedNetworks: input.constraints?.allowedNetworks,
      };

    // `repository` is the primary (the workspace checks it out); `repositories`
    // holds additional repos cloned under workspace/repos/. When only the list
    // form is given, its first entry is the primary.
    const repositories = input.repositories && input.repositories.length > 0
      ? input.repositories
      : undefined;
    const repository = input.repository ?? (repositories?.[0] ?? {});

    // Credential profile resolution (CP-3, issue #807, design §5.4). AFTER `repository` is
    // settled (the primary is the first list entry when only the list form is given), BEFORE
    // anything is written: a refusal must leave no Run row, no event, no skill snapshot.
    //
    // Resolved against the REDACTED repository objects that are about to be stored, computed
    // HERE so resolution and persistence read the same bytes: the claim-time re-check
    // (worker.ts) re-resolves the stored objects, so resolving the raw URLs at creation and
    // redacted ones at claim could make an unchanged file look like a parity violation
    // (Copilot review round 1 on #841). A redaction that mangles a URL into an unnormalizable
    // shape yields no id on BOTH sides (resolveProfile skips it), so the Run consistently
    // resolves to no profile rather than flapping. Refusals carry the profile NAME and the
    // reason (§5.4) — never the file's contents, env names or file paths: a caller who may not
    // use a profile learns nothing about it.
    const safeTask = this.deps.redactor ? this.deps.redactor.redact(input.task) : input.task;
    const safeRepository = this.deps.redactor ? this.deps.redactor.redactJson(repository) as RepositoryContext : repository;
    const safeRepositories = this.deps.redactor && repositories ? this.deps.redactor.redactJson(repositories) as RepositoryContext[] : repositories;
    let credentialProfile: string | null = null;
    if (this.deps.credentialProfiles) {
      const resolution = this.resolveCredentialProfile(
        [safeRepository, ...(safeRepositories ?? [])],
        input.ownerId,
      );
      if (resolution.outcome === 'refused') {
        throw new ForbiddenError(resolution.message);
      }
      if (resolution.outcome === 'profile') {
        credentialProfile = resolution.name;
      }
      // Resume parity against the SAME read that produced `credentialProfile` (retry only):
      // the retry must never persist a profile other than what the parent was created under.
      if (input.retryCredentialProfile !== undefined && credentialProfile !== input.retryCredentialProfile) {
        throw new ConflictError(
          'credential profile changed since creation'
          + ` (created under ${input.retryCredentialProfile ? `'${input.retryCredentialProfile}'` : 'no profile'},`
          + ` now ${credentialProfile ? `'${credentialProfile}'` : 'no profile'});`
          + ' create a new Run instead of retrying under a changed identity',
        );
      }
    }

    // Whether this Run gets a pack, and whether asking for one is even possible on this agent.
    //
    // The asymmetry is deliberate and comes from section 7.4. Ingest fails OPEN: an agent whose ability
    // to receive a pack is unverified simply gets no pack, because an unknown harness version must not
    // brick a Run. `require: true` fails CLOSED: a caller who asked for the pack and did not get it was
    // given something other than what they asked for, and silence is the wrong way to report that.
    const knowledgeDeps = this.deps.knowledge;
    const wantsPack = knowledgeDeps !== undefined
      && (knowledgeRequest?.enabled ?? knowledgeDeps.injectByDefault);
    const knowledgeCap = knowledgeDeps ? knowledgeDeps.capabilities?.()[agent]?.static?.knowledge : undefined;
    if (knowledgeRequest?.require && !wantsPack) {
      throw new ValidationError(
        knowledgeCapabilityMessage(agent, knowledgeDeps
          ? 'injection is disabled for this host and knowledge.enabled was false'
          : 'knowledge is not configured on this server'),
      );
    }
    if (knowledgeRequest?.require && knowledgeCap === false) {
      throw new ValidationError(knowledgeCapabilityMessage(agent, 'the adapter does not declare knowledge support'));
    }
    // Computed inside the transaction below, because it reads the replica and the snapshot must be
    // consistent with the Run row that references it. Declared here so the event append can see it.
    let knowledgeSelection: PackSelection | null = null;

    const now = new Date().toISOString();
    // safeTask/safeRepository/safeRepositories were computed above, before credential-profile
    // resolution (CP-3): resolution must read the same redacted bytes that are stored here.
    const run: Run = {
      id: newRunId(),
      ownerId: input.ownerId,
      task: safeTask,
      repository: safeRepository,
      repositories: safeRepositories,
      workspaceBranch: null,
      workspacePath: null,
      agent,
      status: 'QUEUED',
      attempt: 1,
      retryOf: null,
      error: null,
      errorKind: null,
      constraints,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      cancellationRequestedAt: null,
      finalCommits: [],
      prUrl: null,
      model: model ?? null,
      credentialProfile,
    };

    try {
      tx(this.deps.db, () => {
        this.deps.runs.insert(run);
        for (const skill of resolved) {
          this.deps.db
            .prepare('INSERT INTO run_skills (run_id, skill_id, skill_version, skill_hash, snapshot_json) VALUES (?, ?, ?, ?, ?)')
            .run(run.id, skill.id, skill.version, skill.hash, JSON.stringify(skill));
        }
        if (input.idempotencyKey) {
          this.deps.db
            .prepare('INSERT INTO idempotency_keys (owner, key, run_id, created_at) VALUES (?, ?, ?, ?)')
            .run(input.ownerId, input.idempotencyKey, run.id, now);
        }
        this.deps.events.append(run.id, 'run.created', { runId: run.id, agent, status: 'QUEUED' });
        this.deps.events.append(run.id, 'run.queued', { runId: run.id });
        if (credentialProfile !== null) {
          // The resolved identity, as an event (design §5.4: "credentialProfile appears in Run
          // detail and events"). Deliberately NOT emitted for the no-profile case: a host
          // without a profile file produces byte-identical Runs to pre-CP-3 (issue #807
          // acceptance 3), and the name is stored on the row either way.
          this.deps.events.append(run.id, 'run.credential_profile_resolved', { profile: credentialProfile });
        }
        if (model !== undefined) {
          // The explainability record L1 builds on (#823): which model, and where it came from.
          // Not emitted for model-less Runs, so a Run created without `model` behaves
          // byte-identically to base. Retry passes the parent's recorded source (#832 r1): the
          // copied model was not chosen by a caller, and the record must not change origin.
          const source = input.modelSource ?? (input.model !== undefined ? 'caller' : 'preset');
          this.deps.events.append(run.id, 'run.model_resolved', { model, source });
        }
        if (selection) {
          // §6.5: the pick and its distribution recorded ON the Run, same transaction as the
          // Run row (#854) -- a committed Run always carries its selection record.
          this.deps.events.append(run.id, 'run.selection_recorded', selection);
        }
        if (goalState) {
          // runId is only known here, so the row is built after the run id exists.
          this.deps.goals!.insert({ ...goalState, runId: run.id });
          this.deps.events.append(run.id, 'goal.created', {
            objective: goalState.objective,
            contract: goalState.contract,
            gates: goalState.gates,
            tokenBudget: goalState.tokenBudget,
          });
        }
        for (const skill of resolved) {
          this.deps.events.append(run.id, 'skill.selected', { skill: skill.id, version: skill.version, hash: skill.hash });
        }
        // The preset snapshot lands in the SAME transaction as the Run row (section 5): a
        // failure before commit leaves no partial Run or preset row, and a committed Run
        // always carries the exact bytes it was created with.
        if (presetSnapshot) {
          const row: RunPresetRow = {
            runId: run.id,
            presetId: presetSnapshot.id,
            presetVersion: presetSnapshot.version,
            role: presetSnapshot.role,
            trust: presetSnapshot.trust,
            contentHash: presetSnapshot.contentHash,
            sourceKind: presetSnapshot.source.kind,
            sourceCommit: presetSnapshot.source.commit ?? null,
            sourcePath: presetSnapshot.source.relativePath,
            snapshot: presetSnapshot,
          };
          this.presetStore()!.insert(row);
          this.deps.events.append(run.id, 'preset.selected', {
            presetId: presetSnapshot.id,
            version: presetSnapshot.version,
            role: presetSnapshot.role,
            trust: presetSnapshot.trust,
            hash: presetSnapshot.contentHash,
            sourceKind: presetSnapshot.source.kind,
          });
        }

        if (wantsPack && knowledgeDeps) {
          knowledgeSelection = selectPack(knowledgeDeps.replica, {
            projectId: knowledgeDeps.projectId,
            // The REDACTED task, deliberately. Selection is the one place a task string influences what
            // the agent is told, and an unretracted path from a secret-bearing task line could otherwise
            // pull a note into a pack and echo it back through NOTES.md.
            task: safeTask,
            agent,
            repositories: [repository, ...(repositories ?? [])]
              .map((r) => r.url ?? r.localPath ?? '')
              .filter((v) => v.length > 0),
            ...(knowledgeRequest?.scopes ? { scopes: knowledgeRequest.scopes } : {}),
            // A caller may ask for a smaller pack; the host ceiling still applies, or one Run could ask
            // for a pack large enough to crowd out the harness's own context.
            maxBytes: Math.min(knowledgeRequest?.maxBytes ?? knowledgeDeps.packMaxBytes, knowledgeDeps.packMaxBytes),
          });
        }
        if (knowledgeSelection) {
          // Written here rather than by the worker, so a Run always has a snapshot by the time anything
          // can observe it. The worker materializes files; this row is the record of what was chosen,
          // and it must survive the workspace being garbage-collected.
          this.deps.db.prepare(`
            INSERT INTO run_knowledge (run_id, pack_hash, notes_json, note_count, byte_size, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(run.id, knowledgeSelection.packHash, JSON.stringify(knowledgeSelection.notes),
            knowledgeSelection.notes.length, knowledgeSelection.byteSize, now);
          this.deps.events.append(run.id, 'knowledge.selected', {
            packHash: knowledgeSelection.packHash,
            count: knowledgeSelection.notes.length,
            bytes: knowledgeSelection.byteSize,
            // The notes that did not fit. Without this a caller comparing two Runs sees a short pack and
            // cannot tell "nothing else matched" from "the budget cut it off".
            omitted: knowledgeSelection.omitted,
            scopes: knowledgeSelection.scopes,
          });
        }
      });
      return run;
    } catch (err) {
      // Check-then-insert race (issue #24): a concurrent POST with the same
      // (owner, key) may have won between our dedup SELECT and this INSERT.
      // The tx rolled back (no partial run); return the winner's run instead
      // of surfacing a raw UNIQUE-constraint 400.
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const existing = this.findByIdempotencyKey(input.ownerId, input.idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }
  }

  get(runId: string, ownerId: string, isAdmin: boolean): Run | null {
    const run = this.deps.runs.get(runId);
    if (!run) return null;
    if (!isAdmin && run.ownerId !== ownerId) return null;
    return run;
  }

  list(opts: { ownerId: string; isAdmin: boolean; status?: RunStatus; limit: number; cursor?: string }) {
    return this.deps.runs.list({
      ownerId: opts.isAdmin ? undefined : opts.ownerId,
      status: opts.status,
      limit: opts.limit,
      cursor: opts.cursor,
    });
  }

  /**
   * The goal attached to a Run, or null.
   *
   * Exposed as a SEPARATE field from the Run rather than folded into it, for two reasons. The
   * Run type mirrors the `runs` table and is persisted and replayed as that shape; and a
   * consumer that reads `run.status` must not be able to mistake a goal status for it -- the
   * two are orthogonal axes and the whole feature is about keeping them apart.
   */
  getGoal(runId: string): GoalState | null {
    return this.deps.goals?.get(runId) ?? null;
  }

  /**
   * The knowledge pack a Run was created with, or null when it was given none.
   *
   * Read from `run_knowledge`, never re-derived from the replica. That distinction is the point of the
   * table: notes get revised and retired, and a read that joined the current replica would silently
   * rewrite what a past Run was told. Answering "what did this Run know?" from today's data is exactly
   * how an incident review goes wrong.
   */
  getKnowledge(runId: string): { packHash: string; noteCount: number; byteSize: number; selectedAt: string; notes: unknown[] } | null {
    const row = this.deps.db.prepare(
      'SELECT pack_hash, notes_json, note_count, byte_size, created_at FROM run_knowledge WHERE run_id = ?',
    ).get(runId) as { pack_hash: string; notes_json: string; note_count: number; byte_size: number; created_at: string } | undefined;
    if (!row) return null;
    let notes: unknown[] = [];
    try {
      const parsed = JSON.parse(row.notes_json) as unknown;
      if (Array.isArray(parsed)) notes = parsed;
    } catch {
      // A snapshot that will not parse is reported as unreadable rather than as empty. An empty pack
      // would say "this Run was told nothing", which is a different and much more misleading claim.
      notes = [{ unreadable: true }];
    }
    return {
      packHash: row.pack_hash, noteCount: Number(row.note_count), byteSize: Number(row.byte_size),
      selectedAt: row.created_at, notes,
    };
  }

  /**
   * Drop a goal on operator instruction (docs/goals.md 8: `POST /api/runs/:id/goal/cancel`).
   *
   * This is the ONLY writer of `cancelled`, and it existed as a documented capability with no
   * implementation for three phases: `cancelled` sits in MERCURY_ONLY_GOAL_STATUSES, so a harness
   * is refused if it reports it, and nothing else set it. The status, the `goal.cancelled` event
   * type, the dashboard badge and the CLI colour were all live while no code path could produce
   * them -- surface built as if a feature existed.
   *
   * Cancel is a mutation the design allows. Section 12 forbids an operator REPLACING the
   * objective and FORBIDS an operator-authored `complete`, because both would put a
   * Mercury-originated judgement where only the harness may speak. Dropping a goal is neither:
   * it asserts nothing about whether the work was done, and `unmet` -- the status a terminal Run
   * would otherwise produce -- makes a claim about the harness falling short that an operator who
   * deliberately stopped tracking should be able to prevent.
   *
   * Owner-scoped through get(), so another owner's Run is a 404 rather than a 403, matching the
   * repo's standing rule that a Run must not be confirmable at all.
   */
  cancelGoal(runId: string, ownerId: string, isAdmin: boolean): GoalState {
    const run = this.get(runId, ownerId, isAdmin);
    if (!run) throw new NotFoundError('run not found');
    const goals = this.deps.goals;
    if (!goals) throw new ValidationError('goals are not enabled on this server');
    const goal = goals.get(runId);
    if (!goal) throw new NotFoundError('run has no goal');
    if (TERMINAL_GOAL_STATUSES.has(goal.status)) {
      // Refusing rather than no-op'ing matters: `complete` and `unmet` are verdicts, and an
      // operator cancelling a goal that already completed would erase the thing the feature
      // exists to record.
      throw new ConflictError(`goal is already ${goal.status}`);
    }
    const now = new Date().toISOString();
    let updated: GoalState | null = null;
    // Row and event in one transaction, like every other goal write: a `cancelled` row with no
    // event leaves the timeline claiming the goal was still active, and the reverse makes the
    // timeline the only true record of a state the row denies.
    tx(this.deps.db, () => {
      updated = goals.update(runId, { status: 'cancelled', source: 'operator' }, now);
      // Checked rather than asserted. Inside this transaction the row cannot vanish, so null
      // means the invariant is already broken -- but a non-null assertion would return
      // undefined to the caller as if the cancel had succeeded, and the event below would then
      // announce a state change that the row denies. Failing here keeps the transaction the
      // authority.
      if (!updated) throw new ConflictError('goal disappeared while being cancelled');
      this.deps.events.append(runId, 'goal.cancelled', { source: 'operator', runStatus: run.status });
    });
    return updated!;
  }

  /**
   * Goal status per Run for a page of Runs, as a map keyed by run id.
   *
   * Deliberately narrow: status plus `attempted`, not the whole row. The list view needs a word
   * per row, and carrying objectives here would put up to 4000 chars times the page limit into
   * every dashboard poll; the detail endpoint already returns the full row for the one Run a person
   * is looking at.
   *
   * `attempted` is the one field that earns its place beside the status. Status alone renders the
   * two kinds of `unmet` identically, and the list is where an operator actually looks, so the
   * distinction the gauge gained in #489 was invisible exactly where it was most needed (issue
   * #492). Nothing else did.
   *
   * A map rather than a field on each Run for the same reason `/api/agents` gained a parallel
   * `capabilities` field: `runs` stays an array of Run, and existing clients keep working.
   */
  goalStatuses(runIds: string[]): Record<string, GoalSummary> {
    const goals = this.deps.goals;
    if (!goals || runIds.length === 0) return {};
    return goals.statusesFor(runIds);
  }

  getSkills(runId: string): ResolvedSkill[] {
    const rows = this.deps.db
      .prepare('SELECT snapshot_json FROM run_skills WHERE run_id = ? ORDER BY skill_id')
      .all(runId) as { snapshot_json: string }[];
    return rows.map((r) => JSON.parse(r.snapshot_json) as ResolvedSkill);
  }

  /**
   * The preset snapshot a Run was created with, or null.
   *
   * Read from `run_presets`, never re-derived from the registry -- the same rule as
   * getSkills and the knowledge pack: notes get revised and definitions change, and a
   * read that re-resolved would silently rewrite what a past Run was told to be.
   */
  getPreset(runId: string): ResolvedRolePreset | null {
    return this.presetStore()?.get(runId) ?? null;
  }

  /**
   * The builtin preset registry, or null when presets are off. The API read surface
   * (browse/inspect) goes through this accessor so the composition root stays the only place
   * that knows how the registry is built -- exactly like listAgents for the agent ids.
   */
  presetRegistry(): PresetRegistry | null {
    return this.deps.presets ?? null;
  }

  submitInput(runId: string, ownerId: string, isAdmin: boolean, value: unknown): void {
    const run = this.get(runId, ownerId, isAdmin);
    if (!run) throw new NotFoundError('run not found');
    if (run.status !== 'NEEDS_INPUT') {
      throw new ConflictError(`Run is not waiting for input (status: ${run.status})`);
    }
    const safeValue = this.deps.redactor ? this.deps.redactor.redactJson(value) : value;
    this.deps.db
      .prepare('INSERT INTO run_inputs (id, run_id, input_json, created_at) VALUES (?, ?, ?, ?)')
      .run('inp_' + randomUUID().replace(/-/g, '').slice(0, 16), runId, JSON.stringify(safeValue), new Date().toISOString());
  }

  cancel(runId: string, ownerId: string, isAdmin: boolean): Run {
    const run = this.get(runId, ownerId, isAdmin);
    if (!run) throw new NotFoundError('run not found');
    if (isTerminal(run.status)) throw new ConflictError(`Run already terminal (${run.status})`);
    if (run.status === 'QUEUED') {
      const updated = this.deps.runs.transition(runId, 'CANCELLED', { completedAt: new Date().toISOString() });
      this.deps.events.append(runId, 'run.cancelling', { runId });
      this.deps.events.append(runId, 'run.cancelled', { runId });
      return updated;
    }
    // STARTING / RUNNING / NEEDS_INPUT: cooperative cancellation; worker honors it.
    this.deps.runs.requestCancellation(runId);
    this.deps.events.append(runId, 'run.cancelling', { runId });
    return this.deps.runs.get(runId)!;
  }

  retry(runId: string, ownerId: string, isAdmin: boolean, opts: { auto?: boolean } = {}): Run {
    const original = this.get(runId, ownerId, isAdmin);
    if (!original) throw new NotFoundError('run not found');
    if (!isTerminal(original.status)) throw new ConflictError(`Run not terminal (${original.status})`);
    if (original.status === 'COMPLETED') throw new ConflictError('Cannot retry a completed Run');
    if (original.attempt >= original.constraints.maxRetries + 1) {
      throw new ConflictError(`Max retries reached (${original.constraints.maxRetries})`);
    }
    // The parent's stored snapshots, not its ids (#506). Passing ids would re-resolve against the
    // live registry, so a retried Run would execute skill bytes its parent never saw -- and if a
    // skill had been deleted, create() would throw and the retry could not be attempted at all.
    const skillSnapshots = this.getSkills(runId);
    // original.repository carries the pinned base commit (set when the original
    // workspace was created); a fresh resolve happens only when the original
    // never got a base commit (setup failed before workspace creation).
    // A goal is inherited like the task, repository, agent, skills and constraints are.
    // Retry re-attempts the SAME work, and the objective is part of what that work is --
    // inheriting everything about the work except its success condition is incoherent, and
    // the retry endpoint takes no body, so without this a retried Run could never carry a
    // goal at all.
    //
    // Only the SPEC is copied, never the status: the new Run starts its own attempt, so the
    // objective is open again. If the goal can no longer be honoured -- harness downgraded,
    // version now undetectable -- create() rejects the retry with the reason rather than
    // producing an untracked retry that looks like the original.
    const originalGoal = this.deps.goals?.get(runId);
    // Resume parity (CP-3, issue #807, design §5.4 / issue #807 acceptance 5): the retry
    // re-resolves against the CURRENT file inside create(), and that result must equal what the
    // parent was created under. A profile removed, an owner dropped or a repository re-bound
    // between the parent and this retry would otherwise resume the parent's work under "no
    // credentials" (or under a different identity) — the Crew resume-parity rule (#722) forbids
    // exactly that. The caller creates a FRESH Run instead: a new identity decision belongs to a
    // new Run, not to a resumed one.
    // CP-3 resume parity (issue #807, design §5.4, acceptance 5): the parent's stored profile is
    // passed into create() as `retryCredentialProfile`, which re-resolves against the CURRENT
    // file and compares the result with what it will PERSIST — one file read, no window between
    // a guard here and the write inside create() (Copilot review round 1 on #841). A profile
    // removed, an owner dropped or a repository re-bound between the parent and this retry
    // refuses the retry: the parent's work is never resumed under "no credentials" or under a
    // different identity (the Crew resume-parity rule, #722).
    const retryCredentialProfile = original.credentialProfile ?? null;
    // The parent's recorded model origin (#832 r1): a preset-sourced parent must not become
    // 'caller' on the retry, or the explainability record changes meaning across retries.
    const parentModelSource = original.model
      ? this.deps.events.list(runId).find((e) => e.type === 'run.model_resolved')
        ?.payload as { source?: 'caller' | 'preset' } | undefined
      : undefined;

    const created = this.create({
      ownerId: original.ownerId,
      task: original.task,
      repository: { ...original.repository },
      repositories: original.repositories,
      agent: original.agent,
      // CP-3 resume parity, checked inside create() against the same read it persists from.
      retryCredentialProfile: retryCredentialProfile,
      // Retry re-attempts the SAME work (#823): the model the parent carried is part of that
      // work, exactly like the skill/preset snapshots. A parent WITHOUT a model stays without.
      model: original.model ?? undefined,
      ...(original.model && parentModelSource?.source ? { modelSource: parentModelSource.source } : {}),
      skillSnapshots,
      constraints: { ...original.constraints },
      // The parent's preset snapshot, verbatim (section 6): a retry is the SAME task
      // configuration, so it must not re-resolve "latest" -- a preset edited between the
      // original and the retry must not change what the retry executes.
      presetSnapshot: this.getPreset(runId) ?? undefined,
      goal: originalGoal
        ? {
            objective: originalGoal.objective,
            contract: originalGoal.contract,
            gates: originalGoal.gates,
            tokenBudget: originalGoal.tokenBudget,
          }
        : undefined,
    });
    // link the retry to its original (retryOf) and bump the attempt counter
    this.deps.db
      .prepare('UPDATE runs SET retry_of = ?, attempt = ? WHERE id = ?')
      .run(original.id, original.attempt + 1, created.id);
    return this.deps.runs.get(created.id)!;
  }

  private findByIdempotencyKey(ownerId: string, key: string): Run | null {
    const row = this.deps.db
      .prepare('SELECT run_id FROM idempotency_keys WHERE owner = ? AND key = ?')
      .get(ownerId, key) as { run_id: string } | undefined;
    return row ? this.deps.runs.get(row.run_id) : null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

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
function validateConstraints(c: Record<string, unknown>): void {
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
    // A recorded-only hint (§4.3), but the bot's singleFlight groups Runs by it, so constrain it
    // to the same task-name vocabulary the bot config enforces (keys.ts dispatchKey). Anything
    // else would let two different tasks collide under one hint.
    if (typeof bt !== 'string' || !/^[a-z0-9-]+$/.test(bt)) {
      throw new ValidationError('constraint botTask must be a string matching ^[a-z0-9-]+$');
    }
  }
  const na = c.notAfter;
  if (na !== undefined) {
    // An ABSOLUTE deadline must name its offset: a timezone-less '2026-01-01T00:00:00' parses via
    // Date.parse as server-local time, so the same config string means different instants on
    // different hosts. Require an explicit Z or ±hh:mm offset and parse once.
    if (
      typeof na !== 'string'
      || !/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:Z|[+-]\d{2}:\d{2})$/.test(na)
      || Number.isNaN(Date.parse(na))
    ) {
      throw new ValidationError('constraint notAfter must be an ISO-8601 timestamp with an explicit UTC offset (Z or ±hh:mm)');
    }
    // Must be in the future AT CREATION: a deadline already passed would make the Run
    // unstartable by construction, which is a caller mistake, not a queue state (#731).
    if (Date.parse(na) <= Date.now()) {
      throw new ValidationError('constraint notAfter must be in the future');
    }
  }
}

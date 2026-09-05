# Role Presets

Role Presets are the first Crew deliverable. One preset configures one ordinary
Mercury Run. It does not create subagents, child Runs or a workflow.

Status: **design only.**

Related: [`README.md`](README.md), [`roadmap.md`](roadmap.md),
[`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## 1. Goals

A Role Preset must:

- give a role a stable instruction and a small skill set;
- choose safe defaults without hiding caller intent;
- resolve during Run creation;
- persist exact executable bytes on the Run;
- remain inspectable after its source changes;
- use structured adapter capabilities;
- preserve existing behavior when no preset is selected.

The MVP supports builtin presets shipped with Mercury. Git synchronization,
owner drafts, MCP and workflows are separate designs.

## 2. Manifest

One directory contains one preset:

```text
presets/
  reviewer/
    preset.json
    INSTRUCTION.md
  system-architect/
    preset.json
    INSTRUCTION.md
  linux/
    preset.json
    INSTRUCTION.md
  kafka/
    preset.json
    INSTRUCTION.md
```

The MVP manifest is intentionally small:

```ts
interface RolePresetManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  description: string;
  role: string;
  tags?: string[];
  enabled?: boolean;

  instruction: {
    file: string;               // default: INSTRUCTION.md
  };

  agent?: {
    id?: string;                // default only unless required=true
    required?: boolean;
    model?: string;             // structured per-run override
    modelRequired?: boolean;
  };

  skills?: {
    defaults?: string[];
    required?: string[];
    autoSelect?: boolean;
    max?: number;               // default 4, system-capped
  };

  constraints?: {
    defaults?: Partial<RunConstraints>;
    ceilings?: {
      maxDurationMs?: number;
      maxRetries?: number;
      resourceLimits?: {
        cpu?: string;
        memory?: string;
        disk?: string;
      };
      networkMode?: 'none' | 'bridge';
    };
  };

  requires?: {
    sandbox?: boolean;
  };
}
```

`trust` is absent. Trust is assigned by the registry from provenance and stored
on the resolved snapshot. A manifest cannot declare itself trusted.

`agent.args`, MCP servers, vendored skills and graphs are absent. They belong to
later milestones or are deliberately unsupported.

### 2.1 Validation

Validation returns structured findings with stable rule identifiers. These are
hard errors:

- `schemaVersion` is not exactly `1`;
- `id` is not a safe lowercase path segment or differs from its directory;
- `version` is not valid semantic version text;
- the instruction path is absolute, contains `..`, crosses a symlink or resolves
  outside the preset directory;
- the instruction is missing, not UTF-8 or larger than 32 KiB;
- a referenced skill does not exist;
- required and default skills exceed the system cap after deduplication;
- a required agent does not exist;
- a numeric constraint is negative, non-finite or outside the corresponding
  system limit;
- `requires.sandbox` is true but the effective constraints would not request
  sandboxing.

One invalid preset does not hide valid presets. Registry list responses include
invalid entries only when an authorized diagnostic caller explicitly requests
them.

## 3. Resolution semantics

Resolution is deterministic. Given the same manifest, source bytes, caller
input and system policy, it produces the same snapshot and content hash.

### 3.1 Agent

The selected agent follows these rules:

1. If the preset has `agent.required: true`, its `agent.id` is mandatory.
2. A caller naming a different agent receives a validation error; Mercury does
   not silently override either side.
3. Otherwise an explicit caller agent wins.
4. Otherwise the preset agent is used.
5. Otherwise Mercury uses its existing `primeagent` default.

An unknown selected agent is rejected through the same known-agent check used
for runs without presets.

`agent.model` is a structured default, not an argv fragment. A caller model wins
unless `modelRequired` is true. When a model is required, a conflicting caller
model is rejected. If the selected adapter cannot express a required model,
resolution fails closed.

### 3.2 Skills

Preset skills have two meanings:

- `required` skills are always present;
- `defaults` are used when the caller does not provide an explicit skill list.

Resolution is:

1. start with caller skills when non-empty, otherwise preset defaults;
2. if still empty and `autoSelect` is not false, run the existing deterministic
   selector;
3. append required skills;
4. deduplicate by id while preserving the first occurrence;
5. enforce the effective maximum;
6. resolve and snapshot every skill.

The caller cannot remove a required skill. Presets should use `required`
sparingly; most skills belong in `defaults`.

### 3.3 Constraints

System policy is authoritative. Preset ceilings can only narrow it. Caller
values may override defaults but cannot widen a ceiling.

For scalar limits:

```text
effective =
  min(
    systemCeiling,
    presetCeiling or Infinity,
    callerValue or presetDefault or systemDefault
  )
```

Resource ceilings are evaluated per field. Invalid CPU, memory and disk values
are rejected before the Run is inserted.

The current `allowedNetworks: string[]` does not enforce destinations: an empty
array maps to container network `none`, while any non-empty array maps to
`bridge`. Role Presets therefore use the honest `networkMode` vocabulary in
their policy. Named egress destinations are deferred to
[`mcp-security.md`](mcp-security.md).

`budgetTokens` and `budgetCost` may be supplied as recorded defaults, but they
are not ceilings and must remain labelled “not enforced” until adapters report
usage.

## 4. Snapshot contract

The snapshot is the source of truth after Run creation.

```ts
interface ResolvedRolePreset {
  schemaVersion: 1;
  id: string;
  version: string;
  role: string;
  description: string;
  trust: 'builtin' | 'trusted' | 'untrusted';
  instruction: string;
  effectiveAgent: {
    id: string;
    model?: string;
  };
  effectiveSkills: ResolvedSkill[];
  effectiveConstraints: RunConstraints;
  source: {
    kind: 'builtin' | 'mirror' | 'draft';
    commit?: string;
    relativePath: string;
  };
  files: Record<string, string>;
  contentHash: string;
}
```

The hash is SHA-256 over a canonical, code-unit-sorted sequence of relative file
paths and UTF-8 content. It includes the resolved manifest and instruction.
Runtime-only values such as absolute filesystem paths and secrets are excluded.

### 4.1 Existing skill gap

`run_skills.snapshot_json` already stores complete skill snapshots. However, the
worker currently calls `SkillRegistry.resolve()` again using only the stored
ids before `writeSkills()`. This permits source changes between creation and
execution to change the bytes used by a queued Run.

Before Role Presets ship:

- `RunService.getSkills(runId)` must remain the source of the stored snapshots;
- the worker must pass those snapshots directly to `writeSkills()`;
- retrying unchanged configuration must copy the parent snapshots;
- a regression test must mutate a skill after Run creation and assert that the
  workspace receives the original bytes.

Role Presets must not reproduce this defect. `writePreset()` receives a
`ResolvedRolePreset` loaded from `run_presets.snapshot_json`, never a live
registry result.

## 5. Run creation

The integration point is `RunService.create()`:

```text
validate task and caller constraints
  -> idempotency lookup
  -> resolve preset when requested
  -> select agent, model and skills
  -> clamp constraints
  -> resolve skill snapshots
  -> transaction {
       insert run
       insert run skills
       insert run preset
       insert idempotency key
       append run and selection events
     }
```

`preset.selected` is appended in the same transaction as `run.created`. A
failure before commit leaves no partial Run or preset row.

Idempotency remains owner-scoped. Reusing an idempotency key returns the Run and
snapshot created by the winning request.

## 6. Persistence

The first Crew migration follows the current five migrations:

```sql
CREATE TABLE IF NOT EXISTS run_presets (
  run_id          TEXT PRIMARY KEY,
  preset_id       TEXT NOT NULL,
  preset_version  TEXT NOT NULL,
  role             TEXT NOT NULL,
  trust            TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  source_kind      TEXT NOT NULL,
  source_commit    TEXT,
  source_path      TEXT NOT NULL,
  snapshot_json    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_presets_identity
  ON run_presets(preset_id, preset_version);
```

Preset definitions remain files. The database stores only immutable per-Run
snapshots.

Retry creates a new Run and copies the parent preset and skill snapshots when
the retry means “same task configuration.” It does not resolve “latest” again.
A future explicit “retry with latest preset” operation must be a separate API
choice.

## 7. Workspace materialization

The worker writes:

```text
workspace/
  .mercury-context.json
  .mercury/
    preset/
      preset.json
      INSTRUCTION.md
      PROVENANCE.json
  .agents/
    skills/
      <resolved skill snapshots>
```

Materialization reuses the existing containment rules:

- safe single-segment ids;
- no absolute paths or `..`;
- lexical and realpath containment;
- no symlink components at or below the destination root.

The root `.mercury-context.json` gains a `preset` block containing id, version,
role, trust, content hash and workspace-relative instruction path. Existing
adapters that use this file continue to see one context object.

## 8. Adapter contract

`RunContext` gains optional structured data:

```ts
interface RunContext {
  // existing fields
  preset?: {
    id: string;
    role: string;
    instructionPath: string;
    instruction: string;
    model?: string;
  };
}

interface AgentCapabilities {
  roleInstruction: 'system' | 'prompt-reference' | 'none';
  perRunModel: boolean;
  sandbox: boolean;
  mcp: 'none' | 'per-run';
}
```

Each adapter translates the instruction through its supported mechanism:

- `system` sends a true backend system instruction;
- `prompt-reference` tells the agent to read the materialized instruction;
- `none` rejects a preset that requires role instruction behavior.

Adapters must apply the same preset behavior to both `start()` and `resume()`.
The current PrimeAgent resume path does not repeat skill arguments; preset work
must not extend that asymmetry.

No Role Preset can supply raw argv. Adapter flags remain adapter configuration,
owned by operators and reviewed with Mercury.

## 9. API and UI

MVP endpoints:

```text
GET  /api/presets
GET  /api/presets/:presetId
POST /api/runs
GET  /api/runs/:runId
```

Create Run accepts:

```json
{
  "task": "Review the authorization change",
  "repository": { "url": "https://github.com/acme/app" },
  "preset": {
    "id": "reviewer",
    "version": "1.0.0"
  }
}
```

`version` is an optional optimistic guard against resolving an unexpected
current definition. The builtin MVP keeps one definition per id; it does not
pretend to be a historical version catalog. The snapshot hash is the durable
identity.

Run details return the resolved preset snapshot metadata and instruction, but
never runtime secrets. Existing clients continue to work because `preset` is
optional.

The dashboard adds a **Roles** page and a Role field to Run creation:

- list id, role, version, tags and short description;
- show instruction, default/required skills, agent preference and constraints;
- offer “Run task as this role”;
- show resolved role and content hash on Run details.

The MVP has no edit, upload, delete or publish controls.

## 10. Events and observability

Run-scoped events:

- `preset.selected` — id, version, role, trust, hash and source kind;
- `preset.materialized` — file count, byte count and instruction hash.

Registry load failures are startup or reload logs and metrics because no Run
exists yet. They are not inserted into the Run event store with a synthetic id.

Logs for an executing Run add `presetId`, `presetVersion` and `presetTrust`.
Metrics count presets by validity and Runs by role. Labels must avoid source
paths, repository URLs or other unbounded values.

## 11. MVP seed catalog

The initial presets prove instruction and skill reuse without MCP:

- `reviewer` — code-review, testing and security-review defaults;
- `system-architect` — planning, repository-analysis and documentation;
- `linux` — implementation, debugging and testing, with sandbox required;
- `kafka` — repository-analysis and debugging guidance without live cluster
  tools.

Kubernetes, cloud and production Kafka presets that require external tools wait
for the MCP security milestone.

## 12. Acceptance criteria

Role Presets are complete when:

1. selecting a builtin preset creates an ordinary queued Run;
2. the Run stores exact preset and skill snapshots atomically;
3. source mutation after creation cannot change workspace bytes;
4. retry copies the parent snapshots;
5. caller/default/required precedence has focused tests;
6. constraint ceilings only narrow system policy;
7. unsupported required adapter capabilities fail closed;
8. start and resume apply equivalent preset context;
9. users can browse roles and create a Run from the dashboard;
10. a Run without `preset` is byte-for-byte compatible at the API and worker
    boundaries.

# Crew — Agent Preset Store

Design and implementation roadmap for **Crew**: a versioned store of agent role
presets (skills, MCP servers, instructions, loops/graphs) that users upload from
the dashboard and keep in a Git repository.

Status: **design only.** No source changes are in scope for this document.

Related: [ARCHITECTURE.md](../ARCHITECTURE.md) (§8 adapters, §10–13 skills, §14 events,
§24 security), [docs/agent-adapters.md](agent-adapters.md).

---

## 1. Summary

A **Crew preset** (a "crew member") is one role: `reviewer`, `system-architect`,
`kubernetes`, `linux`, `kafka`, `gcp-sre`, `aws-sre`, and so on. Each preset bundles
everything Mercury needs to run a task as that role:

| Bundle part | What it is |
| --- | --- |
| `instruction` | Role system prompt (`INSTRUCTION.md`), injected into the run context |
| `skills` | Skill ids from the existing registry, plus optional crew-vendored skills |
| `mcps` | MCP servers the role may use (stdio/http), with secret references, never literals |
| `agent` | Preferred adapter id (`primeagent`, `pi`, `omp`, `hermes`, ...) + args + model |
| `constraints` | Defaults and ceilings for duration, retries, tokens, cost, network, resources |
| `graph` | Optional bounded instruction graph: stages, loops, gates |

A **Crew** is a named collection of presets plus an optional stage graph that wires
those roles together (for example `implement -> review -> security-review`).

The store lives in a Git repository on GitHub. Mercury syncs a read-only mirror,
serves presets over the API, materialises them into an isolated run workspace, and
snapshots the resolved content onto the run so past runs stay reproducible.

The design deliberately reuses three patterns the repo already has:

1. **Declarative directory registries** — `RpcAgentRegistry`, `LocalAgentRegistry`,
   `RemoteAgentRegistry` load one JSON file per agent from a directory
   (`src/adapters/rpcAgentRegistry.ts:26`). `CrewRegistry` is the same shape.
2. **Filesystem skill registry with content snapshots** — `SkillRegistry.resolve()`
   returns files plus a sha256 content hash, and `run_skills` stores the snapshot
   (`src/skills/skillRegistry.ts:56`, `src/db/database.ts:35`). Crew resolution
   mirrors this exactly.
3. **Fail-closed capability enforcement** — `SandboxManager` refuses to start a run
   that requests isolation with no runtime available (`src/worker/worker.ts:169`).
   Crew capabilities that an adapter cannot express fail closed the same way.

---

## 2. Goals and non-goals

### Goals

- G1 — Define a declarative preset format for an agent role: instruction, skills, MCP
  servers, agent binding, constraints, and an optional bounded instruction graph.
- G2 — Resolve a preset at run creation and **snapshot** the resolved content onto the
  run, so a run replayed in a year uses the same instruction bytes (same guarantee
  ARCHITECTURE.md §10 already requires for skills).
- G3 — Keep presets in a Git repository. Sync from GitHub, pin to a commit, and make
  the provenance of every run visible (`repo + commit + path`).
- G4 — Upload and validate presets from the dashboard, including a dry-run validation
  that reports errors before anything is stored.
- G5 — Make MCP a first-class Mercury concept. Today MCP exists only as prose in
  adapter docs (`docs/agent-adapters.md:151`, `:239`); no source file mentions it.
- G6 — Enforce a trust model. A crew bundle is third-party executable guidance plus
  network-facing tool servers, so it gets the same treatment ARCHITECTURE.md §24
  already mandates for third-party skills.
- G7 — Stay backward compatible. A run with no `crew` field behaves exactly as today.

### Non-goals

- NG1 — Not a general workflow engine. Graphs are bounded and either advisory or a
  fixed stage sequence; there is no arbitrary DAG scheduler, timer, or human-task
  inbox in v1.
- NG2 — Not a skill store. Skills stay in `.agents/skills/` with their own registry.
  Crews reference skills by id and may vendor a small set alongside the role.
- NG3 — Not a model gateway. A preset names a preferred model string; Mercury does not
  negotiate, route, or meter models.
- NG4 — No multi-agent shared context or agent-to-agent messaging. Staged crews hand
  off through run records and workspace artifacts only.
- NG5 — No changes to the run state machine (see §9 for why staged crews need none).

---

## 3. Terminology

| Term | Meaning |
| --- | --- |
| Crew preset / member | One role bundle, e.g. `kubernetes-sre` |
| Crew | A named set of presets plus an optional stage graph |
| Preset manifest | The `crew.json` file describing a preset |
| Source of truth | The upstream Git repository holding preset files |
| Mirror | Mercury's local read-only checkout of that repository |
| Overlay | Local presets created from the dashboard, not yet upstream |
| Resolution | Merging a manifest with caller input and system ceilings into an effective preset |
| Snapshot | The immutable resolved content + hash stored on the run |
| Trust tier | `builtin` / `trusted` / `untrusted`, drives what a preset may request |

---

## 4. Why this fits the existing design

Mercury's invariant is: *Mercury owns orchestration and durable state, agents own
execution, skills are reusable guidance, workers own process lifetime.* A crew is
orchestration input — it decides **what** capability set and **which** role runs,
never **how** the agent works. So it slots in beside the skill layer without touching
adapters' internals.

The concrete reuse points:

| Need | Existing precedent | Crew equivalent |
| --- | --- | --- |
| Load declarative config from a directory | `RpcAgentRegistry.load()` (`rpcAgentRegistry.ts:26`) | `CrewRegistry.load()` |
| Validate a config object | `validateRpcAgentConfig(cfg)` (`rpcAgentRegistry.ts:52`) | `validateCrewPreset(cfg)` |
| Resolve + hash content | `SkillRegistry.resolveOne()` (`skillRegistry.ts:56`) | `CrewResolver.resolve()` |
| Persist snapshot per run | `run_skills` (`database.ts:35`) | `run_crews` |
| Materialise into workspace | `writeSkills()` (`worker.ts:659`) | `writeCrew()` |
| Pass to agent via argv flags | `--skill <dir>` loop (`primeAgentAdapter.ts:146`) | `--mcp-config`, instruction path |
| Fail closed on missing capability | `worker.ts:169` sandbox guard | MCP capability guard |
| Expose ids to the UI dropdown | `GET /api/agents` (`routes.ts:24`) | `GET /api/crews` |

---

## 5. Data model

### 5.1 Preset manifest (`crew.json`)

One directory per preset, mirroring the `.agents/skills/<id>/SKILL.md` convention.

```ts
export interface CrewPreset {
  schemaVersion: 1;
  id: string;                    // ^[a-z0-9][a-z0-9-]{1,63}$  (also the directory name)
  version: string;               // semver, required (unlike skills, which default to 0.0.0)
  description: string;
  role: string;                  // 'reviewer' | 'system-architect' | 'kubernetes' | free-form
  tags: string[];
  enabled: boolean;              // default true; false = hidden from the picker, still resolvable

  /** Preferred execution backend. Advisory unless `required: true`. */
  agent: {
    id?: string;                 // must exist in the adapter registry when set
    args?: string[];             // appended to adapter argv; validated (see §10.4)
    model?: string;              // opaque model string passed through to the agent
    required?: boolean;          // default false: caller's explicit agent wins
  };

  /** Role instruction. Exactly one of `file` (default 'INSTRUCTION.md') or inline `text`. */
  instruction: {
    file?: string;
    text?: string;
    maxBytes?: number;           // default 32768; larger = validation error
  };

  skills: {
    include?: string[];          // ids from SkillRegistry
    exclude?: string[];
    autoSelect?: boolean;        // default true when include is empty
    max?: number;                // default 4, matching runService.ts:66
    localDir?: string;           // default 'skills' — crew-vendored skills (see §10.3)
  };

  mcps: {
    file?: string;               // default 'mcps.json'; merged with inline `servers`
    servers?: McpServer[];
  };

  /** Defaults and ceilings merged into RunConstraints (see §7.2). */
  constraints?: {
    defaults?: Partial<RunConstraints>;
    ceilings?: {                 // hard limits this role must never exceed
      maxDurationMs?: number;
      budgetTokens?: number;   // recorded only, not enforced (issue #63)
      budgetCost?: number;     // recorded only, not enforced (issue #63)
      allowedNetworks?: string[];
    };
  };

  graph?: { file?: string; inline?: CrewGraph };   // see §8

  trust: 'builtin' | 'trusted' | 'untrusted';      // assigned by the store, see §10
  requires?: {
    sandbox?: boolean;           // preset refuses to run unsandboxed
    mcp?: boolean;               // preset is useless without MCP support
  };
}

export interface McpServer {
  name: string;                  // ^[a-z0-9][a-z0-9-]{1,63}$, unique within the preset
  transport: 'stdio' | 'http';
  command?: string;              // stdio only
  args?: string[];
  url?: string;                  // http only; https required unless allowlisted
  env?: Record<string, string>;  // ONLY '${env:VAR}' references — literals are rejected
  allowedTools?: string[];       // tool allowlist; empty = deny all (fail closed)
  trust?: 'builtin' | 'trusted' | 'untrusted';
}
```

Validation rules that are **hard errors** (not warnings):

- `id` must equal its directory name; `schemaVersion` must be exactly `1`.
- Any `env` value that is not a full `${env:VARNAME}` reference is rejected. This is the
  rule that keeps credentials out of the Git repository, matching the ARCHITECTURE.md §24 rule that
  skills must not contain credentials.
- `allowedTools` absent or empty on a server means **deny all**, not allow all.
- Every path field (`instruction.file`, `mcps.file`, `graph.file`, `skills.localDir`)
  must resolve inside the preset directory after normalisation. See §10.3 — this is not
  a theoretical concern today.
- `agent.id`, when set, must be present in the adapter registry at load time.
### 5.2 Store layout

A dedicated Git repository (default `MERCURY_CREWS_REPO`), so a team can extend the
crew without forking Mercury:

```text
crew-store/
  crews.json                      # optional catalog: id -> path, default order
  crews/
    reviewer/
      crew.json
      INSTRUCTION.md
    system-architect/
      crew.json
      INSTRUCTION.md
      graph.json                  # optional
    kubernetes-sre/
      crew.json
      INSTRUCTION.md
      mcps.json
      skills/                     # crew-vendored skills (optional)
        k8s-incident-triage/
          SKILL.md
    gcp-sre/
      crew.json
      INSTRUCTION.md
      mcps.json
    aws-sre/
      crew.json
      INSTRUCTION.md
      mcps.json
    kafka/
      crew.json
      INSTRUCTION.md
```

`crews.json` is optional. When absent, the registry discovers presets by scanning
`crews/*/crew.json`, exactly as `SkillRegistry.list()` scans for `SKILL.md`
(`skillRegistry.ts:26`).

### 5.3 Example — `kubernetes-sre`

```json
{
  "schemaVersion": 1,
  "id": "kubernetes-sre",
  "version": "1.2.0",
  "description": "Debug and harden Kubernetes workloads; triage incidents.",
  "role": "kubernetes",
  "tags": ["infra", "k8s", "sre"],
  "enabled": true,
  "agent": { "id": "primeagent" },
  "instruction": { "file": "INSTRUCTION.md" },
  "skills": {
    "include": ["repository-analysis", "debugging", "testing", "security-review"],
    "autoSelect": false,
    "localDir": "skills"
  },
  "mcps": { "file": "mcps.json" },
  "constraints": {
    "defaults": { "maxDurationMs": 1800000 },
    "ceilings": { "maxDurationMs": 3600000, "allowedNetworks": ["cluster-api"] }
  },
  "requires": { "sandbox": true, "mcp": true },
  "trust": "trusted"
}
```

`mcps.json` for the same preset — note every credential is a reference:

```json
{
  "servers": [
    {
      "name": "kubectl",
      "transport": "stdio",
      "command": "mcp-server-kubernetes",
      "args": ["--kubeconfig", "/etc/mercury/kube/config"],
      "env": { "KUBE_TOKEN": "${env:MERCURY_K8S_TOKEN}" },
      "allowedTools": ["kubectl_get", "kubectl_describe", "kubectl_logs"],
      "trust": "trusted"
    }
  ]
}
```

`INSTRUCTION.md` is plain markdown with optional frontmatter, parsed by the same
frontmatter reader the skill registry already uses (`skillRegistry.ts:88`):

```markdown
---
role: kubernetes
version: 1.2.0
---

You are an SRE working on Kubernetes manifests and the services that deploy to them.

Before changing anything:
1. Read the current cluster state with the kubectl MCP tools (read-only verbs only).
2. Never run `kubectl apply`, `delete`, or `patch` — propose the diff instead.
...
```

### 5.4 Instruction graphs (loops and graphs)

Graphs express "reviewer then architect then implement, loop until tests pass".
Two execution modes, and the distinction matters because ARCHITECTURE.md §13 says
skills are guidance, not enforced phases:

```ts
export interface CrewGraph {
  schemaVersion: 1;
  mode: 'advisory' | 'staged';       // default 'advisory'
  entry: string;
  nodes: Record<string, GraphNode>;
  maxSteps: number;                  // required, default 24, hard cap 64
}

export type GraphNode =
  | { kind: 'instruction'; id: string; text?: string; file?: string; skills?: string[] }
  | { kind: 'role';        id: string; crew: string; task?: string }
  | { kind: 'gate';        id: string; check: GateCheck; onPass?: string; onFail?: string }
  | { kind: 'loop';        id: string; body: string[]; until: GateCheck;
                           maxIterations: number; onNext?: string }
  | { kind: 'terminal';    id: string; outcome: 'completed' | 'failed' };

export type GateCheck = 'tests-pass' | 'no-findings' | 'review-approved' | 'agent-declared';
```

**Advisory mode (default, v1).** The graph is rendered into the instruction as an
ordered plan and handed to one agent in one run. The agent follows it as guidance and
reports progress through the existing `step.started` / `step.completed` events, which
the timeline already renders. Nothing new is enforced, so this respects ARCHITECTURE.md §13 and needs
no state machine change. Loops are bounded by `maxIterations`, and the bound is
rendered into the prompt so the agent can see its own budget.

**Staged mode (v2, opt-in).** Mercury enforces the sequence by creating one child run
per `role` node, in order. Each stage is an ordinary run with its own workspace,
lease, and lifecycle. A coordinator creates stage N+1 when stage N completes.

Design decision worth stating: staged crews add **no new run states**. The rejected
alternative was a parent run in a "waiting on children" state, which would need new
state machine edges in `src/domain/stateMachine.ts` and new terminal-reachability
reasoning. Instead a staged crew is a **crew group**: a `crewGroupId` shared by
independent runs plus a coordinator timer, reusing the same shape as the existing
stuck-run timer. If stage N fails, the group stops; retry is a new run, exactly as
ARCHITECTURE.md §21 already prescribes.

---

## 6. Storage, sync, and precedence

### 6.1 Three sources, one precedence order

| Layer | Source | Trust | Writable by |
| --- | --- | --- | --- |
| builtin | `crews/` shipped inside the Mercury repo | `builtin` | repo maintainers, via PR |
| mirror | read-only checkout of `MERCURY_CREWS_REPO` | `trusted` | GitHub, via PR to the crew repo |
| overlay | `MERCURY_CREWS_OVERLAY_DIR` | `untrusted` | dashboard upload, per owner |

Resolution order for an id is **overlay > mirror > builtin**, so a local draft wins for
iteration. Shadowing is not silent: resolution emits a warning event and the UI shows
the provenance of the winning layer. Overlay presets are always `untrusted`, so they
cannot silently gain the mirror's privileges.

### 6.2 Sync from GitHub

`CrewSync` keeps the mirror current. It reuses the git-invocation style already in
`WorkspaceManager` rather than adding a dependency:

```text
first run : git clone --depth 1 --branch <ref> <repo> <mirror>
later     : git fetch --depth 1 origin <ref> && git reset --hard FETCH_HEAD
state     : <mirror>/.mercury-sync.json  { repo, ref, commit, syncedAt, presetCount }
```

Properties that matter operationally:

- **Pin, then resolve.** Sync records the commit SHA, and each run snapshot records that
  SHA. Two runs that resolve the same preset version can therefore still be told apart
  when the underlying bytes changed.
- **Sync failure is non-fatal.** On any git error the mirror keeps the last good
  checkout, the worker keeps serving presets from it, and the failure is logged plus
  counted. A force-push or a deleted branch must never take down run creation.
- **Sync is single-writer.** Only the worker syncs (the API process only reads), which
  avoids two processes racing on one checkout. The API learns the current SHA by
  reading `.mercury-sync.json`.
- **Read-only credentials.** `MERCURY_CREWS_TOKEN` is a fine-grained read-only token
  supplied through the environment or a git credential helper. It is never embedded in
  the remote URL, never stored in the database, and never written into a workspace —
  the same rule ARCHITECTURE.md §24 applies to platform credentials.

New configuration, following the existing `loadConfig` style (`src/config.ts:76`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MERCURY_CREWS_REPO` | none (builtin only) | Upstream crew repository URL |
| `MERCURY_CREWS_REF` | `main` | Branch, tag, or SHA to pin |
| `MERCURY_CREWS_DIR` | `./crews` | Builtin presets in this repo |
| `MERCURY_CREWS_MIRROR` | `./crews-mirror` | Read-only sync target |
| `MERCURY_CREWS_OVERLAY_DIR` | `./crews-overlay` | Dashboard uploads |
| `MERCURY_CREWS_SYNC_INTERVAL_MS` | `300000` | Periodic sync (worker only) |
| `MERCURY_CREWS_TOKEN` | none | Read-only token for the crew repo |
| `MERCURY_CREWS_PUBLISH_TOKEN` | none | Scoped token for dashboard publish (§12.3) |

### 6.3 Registry

`CrewRegistry` follows `RpcAgentRegistry` closely: construct with directories, `load()`
returns a map, a malformed file throws with the offending path in the message
(`rpcAgentRegistry.ts:37-45`). One deliberate difference: a bad preset must **not** take
down the whole process. Crew presets are third-party content, so `load()` collects
errors, keeps the good presets, and reports the bad ones through
`crew.rejected` events and `GET /api/crews?includeInvalid=true`. A typo in one team's
`aws-sre/crew.json` should not stop `kafka` runs.

---

## 7. Resolution and run integration

### 7.1 Where it hooks in

Crew resolution belongs in `RunService.create()`, right where skills already resolve
(`src/runs/runService.ts:60-69`). The order is deliberate:

```text
create(input)
  1  validate task + constraints                     (existing)
  2  idempotency lookup                               (existing)
  3  resolve crew preset  -> EffectiveCrew            (new)
  4  pick agent: caller > preset(required) > preset > 'primeagent'
  5  pick skills: caller > preset.include > autoSelect (existing selector as fallback)
  6  merge constraints with ceilings                  (new, §7.2)
  7  resolve skills + crew-local skills, hash          (existing + new)
  8  tx { insert run; insert run_skills; insert run_crews; append events }
```

Steps 3-6 must happen **before** the skill decision, because a preset supplies skills.
The existing `knownAgents` check (`runService.ts:62`) already rejects unknown agents;
the preset's `agent.id` goes through the same check so a preset cannot smuggle in an
unregistered agent.

### 7.2 Constraint merge

Caller values win, except where the preset declares a ceiling, and the system config
always wins over both. Ceilings exist so a shared preset can say "this role never runs
longer than an hour" without trusting every caller.

```text
maxDurationMs = min( systemCeiling,
                     presetCeilings.maxDurationMs ?? Infinity,
                     caller.maxDurationMs ?? preset.defaults.maxDurationMs ?? systemDefault )
```

Ceilings only ever *reduce* what a caller can ask for. A preset may not raise a limit
above the system default, and `allowedNetworks` is intersected with the preset ceiling
rather than unioned — an empty preset ceiling means no network, matching the sandbox
rule that an empty `allowedNetworks` means `--network none` (`sandboxManager.ts:15`).

**Constraint naming resolved (issue #63).** `budgetTokens` and `budgetCost` are stored
and validated but **not enforced** anywhere in the worker: no adapter reports token or cost
usage, so there is nothing to compare a budget against mid-run. They used to be called
`maxTokens`/`maxCost`, sitting beside two genuinely enforced `max*` fields, which made a
silently ignored field look like a ceiling. They are now named `budget*`, documented as
recorded-only, and the dashboard labels them "(not enforced)". Phase 4 still owns pairing
crew budgets with real enforcement; what changed is that the field no longer claims to work
before it does.

### 7.3 Workspace materialisation

The worker already writes resolved skills into the workspace (`worker.ts:659`). Crew
adds sibling files under a dedicated `.mercury/crew/` namespace so nothing can collide
with the user's repository content:

```text
<workspace>/
  .mercury/
    context.json                 # extended with a `crew` block (see below)
    crew/
      INSTRUCTION.md             # resolved role instruction
      crew.json                  # resolved manifest (post-merge, with provenance)
      mcps.json                  # MCP config, env references UNRESOLVED (§10.5)
      graph.json                 # advisory plan, when the preset has one
      PROVENANCE.json            # repo, commit, path, contentHash, trust tier
  .agents/skills/<id>/...        # existing mechanism, now including crew-vendored skills
```

`primeAgentAdapter` already writes a context file the prompt points the agent at
(`primeAgentAdapter.ts:130-138`, prompt text at `:345`). Crew extends that object with:

```json
{
  "crew": {
    "id": "kubernetes-sre", "version": "1.2.0", "role": "kubernetes",
    "trust": "trusted", "instruction": ".mercury/crew/INSTRUCTION.md",
    "graph": ".mercury/crew/graph.json", "mcps": [ "kubectl" ],
    "source": { "repo": "...", "commit": "abc123", "path": "crews/kubernetes-sre" }
  }
}
```

and the prompt gains one line: *"You are acting as the `kubernetes-sre` role. Read
`.mercury/crew/INSTRUCTION.md` and follow it."* Skills keep their existing
`--skill <dir>` argv loop (`primeAgentAdapter.ts:146`).

### 7.4 MCP is an adapter capability

MCP support differs per backend — Claude takes `--mcp-config <json>`
(`docs/agent-adapters.md:151`), Gemini takes `--mcp <config>` (`:239`), PrimeAgent RPC
has its own config. So MCP becomes a declared capability on the declarative configs,
exactly like the existing `sandbox.policyFlag` mapping (`docs/agent-adapters.md` §4.1):

```ts
// added to LocalAgentConfig / RpcAgentConfig
mcp?: {
  flag?: string;                 // e.g. '--mcp-config'
  format: 'json-file' | 'json-inline' | 'none';
  path?: string;                 // workspace-relative path the agent expects
};
```

Resolution rule, fail closed like the sandbox: if a preset sets `requires.mcp: true`
and the selected adapter declares `format: 'none'` (or omits `mcp`), run creation fails
with an explicit message naming the preset, the agent, and the missing capability.
Silently dropping MCP servers would hand the user a run that looks like an SRE run but
has no cluster access — worse than refusing to start. This mirrors the existing guard at
`worker.ts:169`.

---

## 8. Staged crews (v2 runtime)

A staged crew group runs roles in order, each as its own run.

```text
POST /api/crews/:id/run  { task, repository }        # or POST /api/runs { crew, staged: true }
   -> creates crewGroup gc_01... and stage-1 run, returns both ids

CrewCoordinator (worker-side timer, same pattern as the stuck-run check)
   on stage N terminal:
     COMPLETED  -> create stage N+1 (same group, same base commit, carry-forward summary)
     FAILED     -> mark group failed, stop
     CANCELLED  -> mark group cancelled, stop
     TIMED_OUT  -> mark group timed_out, stop
   on group cancel: cancel the active stage run
```

Handoff is explicit and small: stage N+1 receives the task, the pinned base commit, and
a `carryForward` block containing stage N's final summary, commits, and findings — read
from stage N's run record and events, not from a shared mutable workspace. Each stage
gets its own workspace branch derived from its own `runId`, which keeps the ARCHITECTURE.md §21 rule
that branches derive from the run id and prevents two stages editing one tree.

Guarantees that follow from reusing runs:

- Duplicate delivery is already tolerated, so a coordinator restart cannot double-create
  a stage: stage creation is keyed by `(crewGroupId, stageIndex)` with a unique index.
- Retry stays "new run with `retryOf`" (ARCHITECTURE.md §21). Retrying a stage does not re-run earlier
  stages unless the user asks.
- Cancellation, timeouts, leases, and SSE all work per stage with no changes.

---

## 9. Lifecycle and state machine impact

**None for v1 or v2.** `src/domain/stateMachine.ts` keeps its eight states and existing
edges. Crews add *inputs* to a run and *events* about a run, never new run states.

The one place a crew can affect lifecycle is a preset ceiling that shortens
`maxDurationMs`, which uses the existing `TIMED_OUT` path (`worker.ts:260`, `:525`).

---

## 10. Security and trust model

A crew bundle is the highest-risk artifact Mercury accepts: it is third-party
instructions plus a list of executables and network endpoints, uploaded by a user and
synced from a remote repository. ARCHITECTURE.md §24 already states the governing rule —
*"Never execute downloaded third-party skill scripts merely because they exist"* — and
crews make that rule load-bearing rather than theoretical.

### 10.1 Threat model

| Threat | Vector | Control |
| --- | --- | --- |
| Credential theft | secret literal in `crew.json` / `mcps.json` / `INSTRUCTION.md` | `${env:}`-only rule; redactor scan at validation; secrets never in DB or workspace |
| Arbitrary code execution | `command` in an MCP server | allowlist + trust tier; untrusted presets cannot define stdio servers |
| Workspace escape | `../` in a bundled file path | containment check on every path (§10.3) |
| Argument injection | `agent.args` with `--`-prefixed flags | argv allowlist + no shell (§10.4) |
| Prompt injection | instruction text overriding safety rules | trust tier gates privileged roles; instruction is data, not config |
| Egress exfiltration | MCP http server to attacker host | `allowedNetworks` intersection + sandbox `--network none` default |
| Resource abuse | huge bundles, deep recursion, unbounded loops | size/count limits (§10.6), bounded `maxIterations` |
| Privilege shadowing | overlay preset impersonating a trusted one | overlay is always `untrusted`; shadowing is loud in UI + events |

### 10.2 Trust tiers

| Tier | Who can publish | May define stdio MCP servers | May set `agent.args` | May request no sandbox |
| --- | --- | --- | --- | --- |
| `builtin` | Mercury repo maintainers | yes | yes | yes |
| `trusted` | PR to the crew repo, reviewed | yes, from an allowlist | yes, allowlisted | no |
| `untrusted` | any dashboard uploader | **no** | **no** | no |

Tier is a property of the **store layer**, not of the manifest. A manifest that claims
`"trust": "trusted"` inside the overlay directory is downgraded to `untrusted` at load
time and the mismatch is reported. This is the single most important rule in the design:
privilege comes from where a file came from, never from what the file says.

### 10.3 Path containment (blocking prerequisite)

`writeSkills()` writes snapshot files with no containment check:

```ts
// src/worker/worker.ts:659-668
const dest = join(workspacePath, '.agents', 'skills', skill.id, rel);
mkdirSync(join(dest, '..'), { recursive: true });
writeFileSync(dest, content);
```

`rel` comes from `collectFiles()` (`skillRegistry.ts:104`), which today only ever yields
relative paths of files that already exist under the skill directory — so it is safe
*today*. Crews change that: the overlay accepts an **uploaded file tree**, so `rel`
becomes attacker-influenced. A member named `../../../../.git/hooks/pre-commit` would
write outside the workspace and gain code execution on the next git operation in that
repository.

Requirement: a single shared helper, used by both skill and crew materialisation, that
rejects absolute paths, `..` segments, symlinks, and any resolved path that is not
inside the destination root; plus the same check at validation time so uploads fail
early. Phase 0 of the roadmap lands this helper and its tests **before** any upload
path exists, because the upload feature is what makes it exploitable.

### 10.4 Argument handling

`agent.args` and MCP `args` are passed as argv arrays to `spawn` with no shell, matching
the existing adapter behaviour. Additional rules: reject args containing NUL or newline;
reject args that begin with `-` unless the flag is on the adapter's declared allowlist;
cap `args.length` at 32. Registry-driven adapters already accept arbitrary commands from
JSON on disk (`rpc-agents/*.json`), so this does not add a new trust boundary for
`builtin` — it prevents the *upload* path from becoming one.

### 10.5 Secrets and MCP env

`mcps.json` keeps `${env:VARNAME}` placeholders all the way to the workspace file. The
substitution happens at spawn time in the worker process, which is the only place that
holds the values, and the resolved config is written to a per-run temp directory with
`0600` permissions outside the workspace — or, when a sandbox is active, mounted into
the container only. Rationale: ARCHITECTURE.md §24 says the workspace must not contain platform-wide
credentials, and the workspace is retained for inspection for `workspaceRetentionMs`
(default 7 days, `config.ts:99`) and is readable by anyone with filesystem access.

Consequences to design for explicitly:

- The retained workspace shows placeholders, which is the desired audit view.
- `GET /api/runs/:id` and SSE never include resolved MCP env values.
- The redactor (`src/domain/redact.ts`) gets the substituted values added to its secret
  set for the duration of the run, so a chatty agent cannot echo a token into an event.

### 10.6 Limits

Enforced at validation and again at load: manifest <= 256 KB; instruction <= 32 KB;
<= 16 MCP servers; <= 32 bundled skill files; <= 1 MB total bundle; <= 64 graph nodes;
`maxIterations` <= 8; preset count <= 512. Overlays are additionally capped per owner.

---

## 11. API surface

All routes sit behind the existing `requireAuth` middleware (`routes.ts:22`) and follow
the repo's owner-scoping rule: a caller sees their own overlays plus shared presets, and
a missing-or-foreign resource is always `404`, never `403` (AGENTS.md "Common mistakes").

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/crews` | any | List visible presets (`role`, `tag`, `trust`, `limit`, `cursor`) |
| `GET` | `/api/crews/:id` | any | Manifest, instruction, graph, provenance, validation state |
| `POST` | `/api/crews/validate` | any | Dry-run: validate a manifest + bundle, no write |
| `POST` | `/api/crews` | owner | Create/update an **overlay** preset |
| `DELETE` | `/api/crews/:id` | owner | Delete an overlay preset (404 for builtin/mirror) |
| `POST` | `/api/crews/:id/publish` | admin | Push an overlay to the crew repo as a commit/PR |
| `POST` | `/api/crews/sync` | admin | Force a mirror sync now |
| `GET` | `/api/crews/sync` | any | Last sync state (`.mercury-sync.json`) |
| `POST` | `/api/runs` | owner | Extended: accepts `crew`, `crewVersion` |
| `GET` | `/api/runs/:id` | owner | Extended: returns the `crew` snapshot |

`POST /api/runs` gains two optional fields and nothing else changes:

```json
{ "task": "...", "repository": { "url": "..." }, "crew": "kubernetes-sre", "crewVersion": "1.2.0" }
```

`crewVersion` absent means "current resolved version", and the snapshot records which
version that was. An explicit version that is no longer present fails creation with a
clear error rather than silently resolving a different preset.

`POST /api/crews/validate` is the endpoint the dashboard leans on. It returns structured
findings rather than a single message, so the UI can point at the offending field:

```json
{
  "valid": false,
  "findings": [
    { "level": "error", "path": "mcps.servers[0].env.KUBE_TOKEN",
      "rule": "env-must-be-reference",
      "message": "Use '${env:VARNAME}'. Literal credential values are rejected." },
    { "level": "warning", "path": "skills.include[3]",
      "rule": "unknown-skill", "message": "'k8s-triage' is not in the skill registry; it will resolve from the crew bundle instead." }
  ]
}
```

Rate limiting: `POST /api/crews` and `/validate` reuse the existing limiter
(`src/api/rateLimit.ts`) with a conservative per-owner budget, since validation parses
uploaded trees.

---

## 12. Dashboard

### 12.1 Crews page

A third tab beside the run list, using the existing static-SPA conventions (no build
step, no framework — see the `frontend` skill).

- **Table**: id, role, version, trust badge, skill count, MCP count, source
  (`builtin`/`mirror`/`overlay`), short commit, updated.
- **Detail drawer**: rendered instruction, skill chips, MCP server list with tool
  allowlists, graph rendered as an indented stage list with loop bounds, provenance, and
  a **"Run task as this role"** button that prefills the create-run form.
- **Filter** by role and tag; a `role` facet is what makes a 40-preset crew usable.

### 12.2 Upload flow

```text
Crews -> New preset
  1. Author: form fields + instruction editor, or paste crew.json, or drop a folder/zip
  2. Validate: POST /api/crews/validate -> findings, blocking on any error
  3. Save: POST /api/crews -> overlay preset, trust=untrusted, clearly badged
  4. Try it: "Run task as this role" -> a real run against a real repo
  5. Publish (admin): POST /api/crews/:id/publish -> commit or PR to the crew repo
```

The order matters: a preset is only useful once it has been exercised against a real
run, so "try it" comes before "publish", and publishing is the only admin-gated step.

### 12.3 Publish mechanics

Publish writes to the crew repository through the GitHub Contents API with a scoped
token (`MERCURY_CREWS_PUBLISH_TOKEN`) that is allowed to write `crews/**` only. It
creates a commit on a branch (`crew/<id>-<version>`) and opens a pull request, so the
reviewed-PR path to `trusted` is the normal path rather than an extra chore. Publish is
off by default and requires the token to be present; without it the button is hidden, not
disabled-with-an-error.

### 12.4 Trust in the UI

Trust is shown everywhere a preset appears, including the run detail page and the run
list row for a crew run. An `untrusted` preset renders a visible warning and states what
that means in one line: no MCP tool servers, no custom agent arguments, sandbox required.
The point is that a user choosing a role can see how much the system trusts it.

---

## 13. Events and observability

New event types, added to the `EVENT_TYPES` set (`src/domain/types.ts:141`) so they
persist and stream like the rest:

| Event | When | Payload |
| --- | --- | --- |
| `crew.selected` | run creation | id, version, role, trust, contentHash, source |
| `crew.rejected` | load/validation failure | id, path, findings |
| `crew.synced` | mirror sync | repo, ref, commit, added/changed/removed counts |
| `crew.materialized` | worker wrote crew files | file count, bytes, instruction hash |
| `crew.mcp.configured` | MCP config written | server names, tool counts, unresolved-ref count |
| `crew.stage.started` | staged stage begins | groupId, stageIndex, crewId, runId |
| `crew.stage.completed` | staged stage ends | groupId, stageIndex, status, durationMs |

`crew.selected` is emitted inside the same transaction as `run.created`
(`runService.ts:130`), so a run always has its crew provenance.

Logs gain `crewId`, `crewVersion`, `crewTrust` on the existing child logger
(`worker.ts:650`), matching the ARCHITECTURE.md §25 field list. Metrics worth having: sync age, sync
failures, preset count by trust tier, runs by role, validation failures by rule, and
stage-group completion rate.

---

## 14. Database changes

One new migration (the store is at v3 today, `database.ts:80`), additive only:

```sql
CREATE TABLE IF NOT EXISTS run_crews (
  run_id        TEXT PRIMARY KEY,
  crew_id       TEXT NOT NULL,
  crew_version  TEXT NOT NULL,
  role          TEXT NOT NULL,
  trust         TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  source_repo   TEXT,
  source_commit TEXT,
  source_path   TEXT,
  snapshot_json TEXT NOT NULL      -- resolved manifest + instruction + graph
);
CREATE INDEX IF NOT EXISTS idx_run_crews_crew ON run_crews(crew_id, crew_version);

CREATE TABLE IF NOT EXISTS crew_groups (          -- staged crews, phase 5 only
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  crew_id       TEXT NOT NULL,
  task          TEXT NOT NULL,
  stage_index   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crew_group_stages (
  group_id      TEXT NOT NULL,
  stage_index   INTEGER NOT NULL,
  crew_id       TEXT NOT NULL,
  run_id        TEXT,
  status        TEXT NOT NULL,
  UNIQUE (group_id, stage_index)   -- duplicate-delivery guard for the coordinator
);
```

`run_crews` mirrors `run_skills` (`database.ts:35`) including the snapshot column, so
the reproducibility argument is the same one already accepted for skills. Presets
themselves stay on the filesystem — no `crews` table — exactly as skills have no
`skills` table. That keeps Git as the only write path for shared presets and avoids a
second source of truth.

Note on writes: `run_crews` inserts belong inside the existing creation transaction
(`runService.ts:122-131`), not appended after it.

---

## 15. Backward compatibility

- A run created without `crew` is unchanged: no `run_crews` row, no `.mercury/crew/`
  directory, no new prompt lines.
- `RunService.create()` keeps its current signature; `crew` is an optional field on
  `CreateRunInput`.
- `RunContext` gains an optional `crew?: ResolvedCrew`. Adapters that ignore it behave
  as today, so all six adapters stay valid without edits.
- Existing skills-only runs keep working; `skills` and `crew` can both be supplied, and
  explicit `skills` win over preset skills (caller intent beats a default).
- The migration is additive, so `npm run migrate` is safe on an existing database and
  rollback is "ignore the new tables".
- `GET /api/runs/:id` adds a `crew` key; existing UI code ignores unknown keys.

---

## 16. Roadmap

Effort is in engineer-days for one person familiar with the codebase. Each phase is
independently shippable and ends with `npm run typecheck` and `npm test` green.

### Phase 0 — Prerequisites (1-2 d) — **blocking**

Land these before any upload path exists.

1. Path containment helper `src/workspace/containment.ts`:
   `assertInside(root, rel)` rejecting absolute paths, `..`, and symlinks. Wire it into
   `writeSkills()` (`worker.ts:659`) and add a regression test with a `../` member name.
2. ~~Constraint enforcement gap~~ — **done (issue #63)**: renamed to
   `budgetTokens`/`budgetCost` and documented as recorded-only. Crew presets still depend
   on ceilings being real, so Phase 4 must add usage reporting before budgets can gate.
3. Decide the transaction posture for concurrent event appends (see note below), since
   `crew.selected` adds another writer to the same path.

*Acceptance:* a crafted skill/crew bundle cannot write outside its destination root;
tests cover absolute path, `..`, and symlink cases.

> **Note on 3.** `EventStore.append()` assigns `sequence` with a read-then-insert inside
> a **deferred** transaction (`eventStore.ts:36-58`, `database.ts:141`). Measured
> behaviour against `node:sqlite` with a competing writer holding the lock for 1.2 s and
> `busy_timeout = 5000`: `BEGIN` fails in ~300 ms with `database is locked`, while
> `BEGIN IMMEDIATE` waits ~1.26 s and succeeds. `busy_timeout` does not cover a
> deferred-to-write upgrade in WAL mode. The `UNIQUE (run_id, sequence)` constraint
> (`database.ts:51`) prevents duplicate sequences, so ordering stays correct, but a
> concurrent append surfaces as a thrown error and nothing retries it. One-line fix:
> `BEGIN IMMEDIATE` in `tx()`.

### Phase 1 — Preset format and registry (3-4 d)

- `src/crew/types.ts` — `CrewPreset`, `McpServer`, `CrewGraph`, `ResolvedCrew`.
- `src/crew/validateCrew.ts` — schema + rule validation returning structured findings;
  every rule from §5.1 and §10.6.
- `src/crew/crewRegistry.ts` — multi-directory load with precedence, per-preset error
  isolation (§6.3), `list()` / `resolveOne()` with content hashing.
- Seed `crews/` in this repo with `reviewer`, `system-architect`, `linux`, `kafka`.
- Tests: `test/crewRegistry.test.ts`, `test/crewValidate.test.ts` — happy path, each
  rejection rule, precedence and shadowing, malformed-file isolation.

*Acceptance:* registry loads builtin + overlay, rejects a credential literal, and one bad
manifest does not hide the good presets.

### Phase 2 — Resolution, snapshot, run integration (3-4 d)

- `src/crew/resolveCrew.ts` — merge preset + caller + system ceilings into
  `ResolvedCrew`; agent and skill selection per §7.1.
- `runService.create()` — steps 3-6; `run_crews` insert inside the existing transaction.
- Migration for `run_crews`; `RunService.getCrew(runId)`; `GET /api/runs/:id` returns it.
- `RunContext.crew`; `writeCrew()` in the worker using the containment helper;
  `context.json` `crew` block; one prompt line in `primeAgentAdapter`.
- Tests: resolution precedence, ceiling clamping, snapshot immutability (mutating the
  source after creation does not change the stored snapshot), retry inherits the parent's
  crew, `crew.selected` ordering relative to `run.created`.

*Acceptance:* `POST /api/runs {crew}` runs end to end with `FakeAgentAdapter`, and the
run detail response shows the resolved crew with its hash and commit.

### Phase 3 — API and dashboard read path (3-4 d)

- `src/api/crewRoutes.ts` — list, get, sync state, validate; owner-scoped visibility.
- Dashboard Crews tab: table, detail drawer, role/tag facets, trust badges,
  "Run task as this role".
- Tests: `test/crewApi.test.ts` (auth, 404-not-403 for foreign overlays, validation
  findings shape), `test/ui.test.ts` extension for crew rendering.

*Acceptance:* a user can browse every visible preset, see its instruction and MCP servers,
and start a run as that role from the browser.

### Phase 4 — MCP as a first-class capability (4-6 d)

- `mcp` capability block on `LocalAgentConfig` / `RpcAgentConfig`; `mcpFlag` support in
  `primeAgentAdapter`, `localAgentAdapter`, `rpcAgentAdapter`.
- Fail-closed capability guard next to the existing sandbox guard (`worker.ts:169`).
- Per-run `0600` MCP config outside the workspace (or container-mounted) with `${env:}`
  substitution at spawn; substituted values registered with the redactor for the run.
- Tests: capability mismatch refuses to start with an actionable message; placeholders
  reach the workspace and resolved values do not; a token echoed by a mock agent is
  redacted in stored events; `allowedNetworks` intersection.

*Acceptance:* an SRE preset gets working MCP config on a capable agent and a clear
refusal on one that lacks the capability, with no secret ever landing in the database,
an event, or a retained workspace.

### Phase 5 — Upload, sync, publish (4-6 d)

- `CrewSync` (clone/fetch/reset, `.mercury-sync.json`, non-fatal failures, worker-only).
- `POST /api/crews` overlay write with validation-before-write and per-owner quotas.
- `POST /api/crews/:id/publish` via the GitHub Contents API behind
  `MERCURY_CREWS_PUBLISH_TOKEN`.
- Dashboard upload flow §12.2 including folder/zip drop.
- Tests: sync failure keeps the last good mirror; overlay cannot escalate trust; publish
  requires admin; zip with a traversal member is rejected at validate **and** at write.

*Acceptance:* a preset authored in the browser survives validate -> save -> run ->
publish, and the crew repo gains a reviewable PR.

### Phase 6 — Graphs: advisory, then staged (5-8 d)

- Advisory: graph -> plan rendering into the instruction; `step.*` mapping so the
  existing timeline shows stage progress; `maxIterations` bound surfaced in the prompt.
- Staged: `crew_groups` / `crew_group_stages`, `CrewCoordinator` timer in the worker,
  carry-forward handoff, group cancel, `crew.stage.*` events.
- Tests: advisory rendering is deterministic; staged group creates exactly one run per
  stage under duplicate delivery; stage failure stops the group; group cancel cancels the
  active stage; retry of a stage does not re-run earlier stages.

*Acceptance:* `review -> architect -> implement(loop until tests pass, max 3) -> review`
runs as a group, and the dashboard shows per-stage status.

### Phase 7 — Hardening and operations (2-3 d)

- Preset linting in CI for the crew repo (schema, `${env:}` rule, containment, size).
- Metrics and alerts from §13; `GET /healthz/crews` exposing sync age and rejected count.
- Ops docs: `deploy/README.md` section for crew sync credentials and failure modes.

### Suggested order and rationale

Phase 0 first — it is the only phase that closes an exposure the others open. Phases 1-2
give the durable-value core (presets on real runs) with no network surface. Phase 3 makes
it visible. Phase 4 is the deepest technical risk and is worth doing after the core is
proven. Phase 5 opens the write path, which is why 0 must be long done. Phase 6 is the
most speculative and can slip without weakening anything above it.

---

## 17. Open questions

1. **Preset ownership.** Are overlays per-owner (as designed) or shared within a team
   once published to a staging area? Per-owner is safer; a team namespace is a likely
   follow-up.
2. **Version pinning default.** Resolve "latest" or require an explicit version on every
   run? Latest is friendlier; explicit is more reproducible. Current design: latest, with
   the resolved version recorded.
3. **Crew-local skills vs the global registry.** Vendoring skills inside a preset makes a
   role self-contained but duplicates content that belongs in `.agents/skills/`. The
   `localDir` field supports both; the default policy for the seed crew should be
   "reference globally, vendor only role-specific knowledge".
4. **Staged handoff size.** `carryForward` needs a byte cap and a summarisation strategy
   for long runs; passing full event history between stages would be quadratic.
5. **Model pinning.** Whether `agent.model` should be a ceiling as well as a default, so a
   shared role cannot be run with an unexpectedly expensive model.
6. ~~Enforcement of `maxTokens`/`maxCost`~~ — **renamed (issue #63)** to
   `budgetTokens`/`budgetCost`, recorded-only. Still open: enforcement, which needs per-run
   usage reporting from adapters. A crew preset can record a budget today but cannot stop a
   run that exceeds it.

---

## Appendix A — Seed crew catalog

| Preset | Role | Skills (global) | MCP | Notes |
| --- | --- | --- | --- | --- |
| `reviewer` | reviewer | code-review, security-review, testing | none | read-only intent; never commits |
| `system-architect` | system-architect | planning, repository-analysis, documentation | none | advisory graph |
| `linux` | linux | implementation, debugging, testing | shell (trusted) | sandbox required |
| `kubernetes` | kubernetes | repository-analysis, debugging, testing | kubectl (read verbs) | `allowedNetworks: [cluster-api]` |
| `kafka` | kafka | repository-analysis, debugging, testing | kafka (read) | consumer-lag triage |
| `gcp-sre` | gcp-sre | debugging, testing, security-review | gcloud (read) | `${env:GOOGLE_APPLICATION_CREDENTIALS}` |
| `aws-sre` | aws-sre | debugging, testing, security-review | aws (read) | `${env:AWS_PROFILE}` |

The read-only bias in every SRE preset is deliberate: a preset that can mutate
production is a different trust conversation from one that can diagnose it.

## Appendix B — File map

New files:

```text
src/crew/types.ts              src/crew/validateCrew.ts
src/crew/crewRegistry.ts       src/crew/resolveCrew.ts
src/crew/crewSync.ts           src/crew/crewCoordinator.ts   (phase 6)
src/api/crewRoutes.ts          src/workspace/containment.ts  (phase 0)
crews/<id>/{crew.json,INSTRUCTION.md,mcps.json,graph.json}
test/crewRegistry.test.ts      test/crewValidate.test.ts
test/crewResolve.test.ts       test/crewApi.test.ts
test/crewSync.test.ts          test/crewContainment.test.ts
```

Files to change (small, surgical edits):

| File | Change |
| --- | --- |
| `src/domain/types.ts` | `RunContext.crew?`; new `EVENT_TYPES` entries |
| `src/runs/runService.ts` | crew resolution in `create()`; `getCrew()` |
| `src/db/database.ts` | one additive migration |
| `src/worker/worker.ts` | `writeCrew()`; MCP capability guard; coordinator timer |
| `src/adapters/primeAgentAdapter.ts` | `crew` block in `context.json`; prompt line |
| `src/adapters/{local,rpc}Agent*` | `mcp` capability block |
| `src/api/server.ts` | mount `crewRoutes` |
| `src/config.ts` | `MERCURY_CREWS_*` options |
| `src/cli.ts` | construct registry/sync, pass to worker and server |
| `ui/index.html`, `ui/index.js` | Crews tab |
| `ARCHITECTURE.md` | roadmap entry pointing here |

## Appendix C — What this design deliberately does not do

- It does not put presets in the database. Git is the write path; the database holds only
  per-run snapshots.
- It does not let a manifest grant itself privileges. Trust comes from the store layer.
- It does not enforce a skill pipeline. Advisory graphs keep ARCHITECTURE.md §13 true.
- It does not add run states, and so does not touch the state machine.
- It does not resolve credentials into retained workspaces.

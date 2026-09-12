# Mercury — Phase 0 issue set (shared prerequisites for Crew and Atlas)

Drafted 2026-09-12 against `main` at the state read from the working tree. Each issue is
written to the `issue-fix-loop` contract: mechanism, choke point, proven regression test,
one PR. Numbers are placeholders (`P0-n`); replace with GitHub numbers once filed and
convert the `Blocked by` lines into real cross-references.

Every claim about current code names the file and line-level mechanism, not the symptom.
Where a Crew document says something the code no longer agrees with, the code wins and the
doc gets a fix (P0-6, P0-7).

## Dependency order

```
P0-1 skill snapshot bytes ─────┐
P0-2 skill namespace per agent ─┼──► P0-3 general capability descriptor ──► P0-5 healthz version
P0-4 bounded git (independent) │
P0-6 / P0-7 doc drift (independent, can go first)
```

Work order: **P0-6, P0-7** (cheap, stop others implementing from stale docs) → **P0-1** →
**P0-2** → **P0-3** → **P0-5** → **P0-4** whenever a slot opens. P0-4 depends on nothing and
blocks nothing in Atlas Phases 0–2; it is listed because the Crew roadmap names it and the
Atlas harvester (§7.3) will run `git diff` at finalize.

Unblocks after this set: Atlas Phases 0–3 (P0-1, P0-3), Atlas Phases 4–5 (P0-2, P0-3),
Crew Milestone A (all), Teams Phase -1/0/1 (P0-2, P0-3, P0-5).

---

## P0-1 — Worker executes stored skill snapshot bytes, not the live registry

**Labels:** `bug`, `priority: high`
**Blocked by:** —
**Blocks:** P0-3 (descriptor test asserts snapshot execution), Atlas Phase 2 (`run_knowledge`
is modelled on `run_skills`; building it before this lands copies a known defect into a
second table), Crew Phase 2.

### Mechanism

`RunService.create()` snapshots each resolved skill into `run_skills.snapshot_json` with a
content hash and emits `skill.selected { hash }`. That is the audit record. The worker then
discards it:

```ts
// src/worker/worker.ts, execute()
const skills = this.deps.skills.resolve(this.deps.runService.getSkills(run.id).map((s) => s.id));
await writeSkills(workspace.path, skills);
```

`getSkills()` returns the full `ResolvedSkill` from `snapshot_json`, the worker keeps only
`.id`, and `skills.resolve()` re-reads the filesystem registry. Three consequences:

1. Editing a skill while a Run is `QUEUED` changes the bytes it executes; the recorded hash
   no longer describes what ran.
2. Deleting or renaming a skill while a Run is queued makes `resolve()` throw at claim time
   → `FAILED(infrastructure)` → `maybeAutoRetry` → same failure, up to `maxRetries`. A
   content change becomes a retry loop.
3. `RunService.retry()` passes `this.getSkills(runId).map((s) => s.id)` into `create()`,
   so the retry re-resolves too. ARCHITECTURE §21 says retry must reuse the original base
   commit; the same reasoning applies to skills and is not honoured.

`docs/status.md` already lists this as "Recommended priority 1" and `docs/overview.md`
documents it as a known limitation. `crew/roadmap.md` §2 lists it as not complete.

### Fix at the choke point

- `worker.ts execute()`: use `runService.getSkills(run.id)` directly as the
  `ResolvedSkill[]` passed to `writeSkills()` and into `RunContext.skills`. Remove the
  `resolve()` round-trip. `writeSkills()` already takes `ResolvedSkill[]` with `files`, so
  no signature change.
- `RunService.retry()`: copy the parent's `run_skills` rows verbatim into the new Run's
  rows (same `skill_version`, `skill_hash`, `snapshot_json`) instead of passing ids
  through `create()`. `create()` needs a private path that accepts pre-resolved snapshots,
  or `retry()` inserts the rows itself inside its own `tx()` after `create()` returns with
  an empty skill list. Prefer the former so `skill.selected` events still carry the copied
  hash.
- `skill.started` / `skill.completed` payloads already read `skill.version` from the
  object; they become correct for free.

### Acceptance

1. Create a Run with skill `X`; modify `X/SKILL.md` on disk; claim and execute with the
   fake adapter. The bytes under `<workspace>/.agents/skills/X/` equal the snapshot, not
   the modified file. The `run_skills.skill_hash` matches a hash computed over the
   materialized files.
2. Same setup, but delete `X` from the registry after creation. The Run completes; no
   `FAILED(infrastructure)`, no retry.
3. Retry a failed Run whose skill was modified after the original was created. The retry's
   `run_skills` rows have the parent's hash, and the materialized bytes match the parent's
   snapshot.
4. `npm run typecheck` clean; full suite passes; no test that previously passed changes
   its assertion (the fake adapter must not have been reading the live registry).

### Regression test (prove it fails on base)

Model on `test/worker.test.ts` (existing `makeEnv` + fake adapter). Write the skill file,
create the Run, overwrite the skill file with a sentinel string, execute, read the
workspace copy, assert the sentinel is absent. On base this asserts false.

### Likely files

`src/worker/worker.ts`, `src/runs/runService.ts`, `test/worker.test.ts`,
`test/skills.test.ts`; `docs/status.md` and `docs/overview.md` lose their "known
limitation" paragraphs in the same PR (source wins over stale docs).

---

## P0-2 — Skill selection respects the target agent's skill namespace (Hermes cannot execute any Run)

**Labels:** `bug`, `priority: high`
**Blocked by:** — (P0-1 recommended first so the test fixture is stable)
**Blocks:** P0-3 (descriptor needs a `skills` block that this issue defines), Atlas Phases
4–5, Teams Phase -1 (this *is* Teams Phase -1), Crew Phase 0 acceptance item 5.

### Mechanism — narrower than the Crew docs state

`crew/teams.md` §3 and `crew/roadmap.md` §4 say a Run cannot carry zero skills. That is
half-fixed already. `src/runs/runService.ts create()`:

```ts
const skillIds = input.skills === undefined || input.skills === null
  ? this.deps.selector.select(input.task, available, 4)
  : input.skills;
```

An explicit `skills: []` is honoured (comment cites #459). Two gaps remain, and they
are the ones that keep Hermes broken for every caller who does not know to send `[]`:

1. **The selector still cannot return nothing.** `src/skills/skillSelector.ts`:
   ```ts
   return picked.length > 0 ? picked : FALLBACK.filter((id) => available.some((a) => a.id === id));
   ```
   `FALLBACK = ['planning', 'implementation', 'testing', 'git-pr']`. Omitted `skills`
   always yields ≥1 Mercury skill id. `teams.md` §3's verification ("Say hello." →
   those four) still reproduces.

2. **`HermesAgentAdapter` forwards Mercury-namespace ids into Hermes's namespace.**
   `src/adapters/hermesAgentAdapter.ts buildArgv()`:
   ```ts
   for (const skill of context.skills) argv.push('-s', skill.id);
   ```
   Hermes resolves `-s <n>` in its own installed store (81 skills, none named
   `planning` etc.), rejects unknown names, exits non-zero in under a second. The adapter
   is the K2 violation `docs/knowledge-base.md` §4 describes: Mercury naming things inside
   a sub-harness's namespace.

Compare `PrimeAgentAdapter`, which passes `--skill <workspace path>` — a path Mercury
materialized, so it exists. The two adapters read different namespaces and the selector
does not know which one the target reads.

### Fix at the choke point

The choke point is the selector's contract plus one adapter, not every caller.

- `skillSelector.select()` gains a way to return `[]`: drop `FALLBACK` for callers that
  pass a target-namespace hint, or make the fallback conditional on an
  `allowFallback` flag defaulting to today's behaviour. **Do not** silently change the
  default for existing PrimeAgent callers in this PR — that is Crew Phase 2 territory
  (selection moving into the sub-team resolver). The scoped change: `RunService.create()`
  passes the agent's skill namespace (from P0-3's descriptor once it exists; until then a
  hardcoded map `{ hermes: 'nativeNames' }` in one place) and the selector returns `[]`
  when the namespace is not `workspacePaths`.
- `HermesAgentAdapter.buildArgv()` stops emitting `-s` for Mercury skills entirely. If a
  future caller wants Hermes-native skills, that is a capability (`skills.nativeNames`)
  with its own field on the create request, not a reinterpretation of Mercury ids.
- `RunService.retry()` already passes the parent's (possibly empty) list through, so
  retry of a zero-skill Run stays zero-skill once P0-1 lands.

### Acceptance

1. `POST /api/runs` with `agent: "hermes"` and no `skills` field creates a Run with zero
   `run_skills` rows and zero `skill.selected` events.
2. The same with `agent: "primeagent"` and no `skills` field behaves exactly as today
   (fallback still applies).
3. `HermesAgentAdapter.buildArgv()` never emits `-s` regardless of `context.skills`.
4. A Hermes Run completes end to end against a real workspace on a machine with `hermes`
   installed (manual verification; record the Run id and Hermes version in the PR body per
   `goals.md` §2 style — a real binary, not a mock). Until this is observed, Crew
   roadmap §4 acceptance 5 stays open and no Teams/Templates work is scheduled.
5. API route layer (`src/api/routes.ts`) passes `skills: []` through unchanged — verify,
   since the RunService fix is only reachable if the route does not coerce `[]` to
   `undefined`.

### Regression test

Model on the existing selector tests in `test/skills.test.ts`: `select("Say hello.",
available, 4, { namespace: 'nativeNames' })` returns `[]`. Plus a Hermes adapter argv
test asserting no `-s` in `buildArgv` output for a context with two skills. Both fail on
base.

### Likely files

`src/skills/skillSelector.ts`, `src/runs/runService.ts`,
`src/adapters/hermesAgentAdapter.ts`, `src/api/routes.ts` (verify only),
`test/skills.test.ts`, adapter test for Hermes argv.

---

## P0-3 — Generalize `AgentCapabilities` beyond goals; advertise on `/api/agents`

**Labels:** `enhancement`, `priority: high`
**Blocked by:** P0-2 (defines the `skills` namespace values this descriptor carries)
**Blocks:** P0-5, Atlas §7.4 capability gating and §9.3 per-harness rendering, Crew
Phase 0 acceptance 6, `harness-capabilities.md` §3, Fleet placement.

### Current state — partly done, goals-only

`src/adapters/capabilities.ts` (`AgentCapabilityRegistry`) exists: detached version
probing, per-adapter parse, fail-closed resolution, `snapshot()` served as a parallel
`capabilities` field on `/api/agents`. Migration v7 records the harness version on each
Run. `goalSupport.ts` resolves six goal fields against a version threshold.

But `AgentCapabilities` is `{ goals?: AgentGoalSupport }` and nothing else.
`HermesAgentAdapter.capabilities = {}`. `harness-capabilities.md` §2 still says
`/api/agents` returns bare names; that is stale — it returns names *plus* a
goals-only `capabilities` map. The gap is the vocabulary, not the plumbing.

Three consumers need the same descriptor and are each blocked on it:

| Consumer | Needs | Doc |
| --- | --- | --- |
| Skill selection (P0-2) | `skills: 'workspacePaths' \| 'nativeNames' \| 'none'` | `harness-capabilities.md` §3 |
| Atlas ingest/injection | `knowledge.notesFile`, `knowledge.workspaceFile`, `knowledge.contextFile` | `knowledge-base.md` §7.4, §9.3 |
| Crew templates / Teams | `persona.append`, `persona.workspaceFile`, `humanInput`, `resume` | `harness-capabilities.md` §3 |

### Fix

- Extend `AgentCapabilities` (in `src/domain/types.ts`) with a closed vocabulary. Keep
  `goals` as-is. Add, all optional:
  - `skills?: 'workspacePaths' | 'nativeNames' | 'none'`
  - `persona?: { append?: boolean; workspaceFile?: string[] }`
  - `humanInput?: boolean` (derive from `input.enabled` where the registry already has it)
  - `resume?: boolean` (derive from `resume.enabled`)
  - `knowledge?: { notesFile?: boolean; workspaceFile?: string[]; contextFile?: boolean }`
- Version-gated fields (like goals) keep the `minVersion` shape; plain booleans are
  static declarations. Do not invent an affinity/quality field (K3, `harness-capabilities`
  §3): this issue is capability only.
- Declarative adapters (`local`, `rpc`, `remote`) read the block from their registry JSON,
  same pattern `goals` uses today (`goals.md` §13.4).
- `AgentCapabilityRegistry.snapshot()` includes the new fields; `/api/agents` gains them
  in the existing parallel `capabilities` map. `agents: string[]` stays untouched — the
  dashboard's `loadAgents()` bails on a non-array (`goals.md` §13.6).
- Declare values for every shipped adapter. Honest values, verified where possible:
  PrimeAgent `skills: 'workspacePaths'`, Hermes `skills: 'nativeNames'`, Claude/Fake as
  measured. `persona.append` for `pi`/`omp` is **unverified** (`harness-capabilities.md`
  §7 Q3) — leave it absent, not `true`.

### Acceptance

1. `GET /api/agents` returns the new fields for every registered adapter; a guard test
   asserts every adapter has a `skills` value (mirrors the "every adapter has a matrix
   entry" rule in `goals.md` §13.7).
2. P0-2's hardcoded namespace map is replaced by a read of this descriptor; the P0-2 test
   still passes.
3. `mercuryctl agents list` renders the new columns (client already renders a goal column).
4. A declarative RPC agent JSON with a `capabilities` block surfaces it on `/api/agents`.
5. Existing goal behaviour unchanged — the goal test files pass without modification.

### Regression test

Snapshot test on `/api/agents` shape with all built-in adapters registered; fails on base
because the fields are absent. Plus the guard test.

### Likely files

`src/domain/types.ts`, `src/adapters/capabilities.ts`, every `src/adapters/*Adapter.ts`
(one-line declaration each), `src/adapters/{local,rpc,remote}AgentRegistry.ts`,
`src/api/routes.ts`, `client/` (agents list), `test/agentCapabilities.test.ts` (new),
`docs/agents.md`, `docs/crew/harness-capabilities.md` §2 (update the "bare names" claim).

---

## P0-4 — Bound and de-interactivize Git commands in `WorkspaceManager`

**Labels:** `bug`, `priority: medium`
**Blocked by:** —
**Blocks:** nothing in Atlas 0–2; Crew Phase 0 acceptance 3–4; Atlas §7.3 harvester
(runs `git diff` at finalize; has its own timeout but inherits any credential-prompt hang).

### Mechanism

`crew/roadmap.md` §2 lists "workspace Git commands are not consistently bounded" as not
complete; `docs/status.md` "Recommended priority 2". `AGENTS.md` states the project rule:
"Bound every command. A hung command is indistinguishable from a slow one." The worker's
`drive()` bounds the agent with `maxDurationMs`, but workspace creation happens
*before* `drive()` and before the `STARTING → RUNNING` transition, so a clone or fetch
that stalls — remote credential prompt, DNS blackhole, a fork that hangs on
`git worktree add` — leaves the Run in `STARTING` until the lease expires, at which point
the reaper records `FAILED(infrastructure)` and auto-retries into the same stall.

(Read `src/workspace/workspaceManager.ts` to confirm which of clone / fetch / worktree /
rev-parse / `recordCommits` are unbounded before writing the fix; this draft did not open
the file.)

### Fix at the choke point

One `runGit(args, { cwd, timeoutMs })` helper in `workspaceManager.ts` that every git
invocation goes through:

- `spawn` with an argv array, never a shell string (`AGENTS.md`: command-injection
  surface).
- `AbortSignal.timeout(timeoutMs)` → on expiry kill and throw with the command and cwd in
  the message.
- Environment: `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/bin/true` (or `echo`),
  `GIT_SSH_COMMAND='ssh -oBatchMode=yes'`. A credential prompt becomes an immediate
  failure, not a hang.
- Timeout from config: `MERCURY_GIT_TIMEOUT_MS` (default something like 120 000; document
  in `configuration.md`).
- The harvester in Atlas Phase 3 reuses this helper rather than adding its own.

### Acceptance

1. A fixture remote that never responds (e.g. `git daemon` replaced by a listener that
   accepts and sleeps) fails workspace creation within `MERCURY_GIT_TIMEOUT_MS` + margin,
   with the Run going `STARTING → FAILED` carrying the git command in the error.
2. A fixture requiring credentials fails immediately (`GIT_TERMINAL_PROMPT=0` exit), never
   blocks on stdin.
3. Existing workspace tests pass with no timing change on the happy path.

### Regression test

Model on `test/workspace.test.ts`. Deliberately hanging fixture; assert failure within the
bound. On base the test itself hangs — bound the *test* with `--test-timeout` so a hang
reads as a failure, not a stall (per `AGENTS.md`).

### Likely files

`src/workspace/workspaceManager.ts`, `src/config.ts`, `docs/configuration.md`,
`test/workspace.test.ts`.

---

## P0-5 — Version/capability field on `/healthz` so Fleet can reject an old host at registration

**Labels:** `enhancement`, `priority: medium`
**Blocked by:** P0-3
**Blocks:** Fleet routing on capabilities (`harness-capabilities.md` §6), Atlas §11.1
(Atlas's own `/healthz` copies this shape).

### Mechanism

`harness-capabilities.md` §6: "There is no version negotiation or capability handshake
between Fleet and a host today. Fleet identifies a host only by whether `/healthz`
answers." Once P0-3 changes the `/api/agents` shape, an old host paired with a new Fleet
fails at first use instead of at registration.

### Fix

- `/healthz` response gains `{ version: <package version>, api: <integer schema
  version> }`. `src/version.ts` already exists; use it. `api` is an integer bumped on any
  response-shape change to a route inside Fleet's `fleet/src/child.js` allowlist.
- Fleet's `hosts add` and its probe read `api`, refuse a host whose `api` is below what
  this Fleet build was written against, and record the host's `version` in the registry so
  `hosts list --live` shows it.
- Coupling rule holds: Fleet reads JSON, imports nothing.

### Acceptance

1. `GET /healthz` returns `version` and `api`; the shape is asserted in
   `test/fleetContract.test.ts` alongside the existing routes.
2. `fleet hosts add` against a mocked `/healthz` with `api: 0` fails with a message naming
   both numbers.
3. `fleet hosts list --live` shows the host version.

### Likely files

`src/api/routes.ts` (or `server.ts`), `src/version.ts`, `fleet/src/child.js`,
`fleet/src/cli.ts`, `test/fleetContract.test.ts`, `fleet/test/*`, `docs/fleet-design.md`.

---

## P0-6 — docs: `crew/README.md` §6 says five migrations; there are seven

**Labels:** `documentation`, `priority: low`, `good first issue`
**Blocked by:** —

`docs/crew/README.md` §6: "The schema currently has five migrations; Crew changes start
after v5." `src/db/database.ts` `MIGRATIONS` has seven entries: v6 `run_goals`
(`goals.md` §5), v7 `agent_version*` (`goals.md` §13.1). `docs/knowledge-base.md` §8.6
correctly says the next is v8. `crew/roadmap.md` §6 says "Add migration v6 for
`run_presets`" — v6 is taken.

Fix: README §6 → "seven migrations (v1–v7); Crew changes start after v7, or after whatever
Atlas Phase 1 claims first." Roadmap §6 → "next free migration". Do not hardcode a number
twice.

Acceptance: `grep -n "five migrations\|migration v6" docs/crew/` returns nothing.

---

## P0-7 — docs: Crew capability/teams docs stamped "nothing implemented" while goals.md Phase 0a shipped the version probe and goal-capability half

**Labels:** `documentation`, `priority: medium`
**Blocked by:** —
**Blocks:** anyone implementing from `docs/crew/` alone (they would re-implement
`capabilities.ts`).

`docs/crew/harness-capabilities.md` and `docs/crew/teams.md` open with "design only,
nothing here is implemented." Both are partly stale:

- `harness-capabilities.md` §2: "`/api/agents` returns bare names, verified against a
  live 0.1.0 host." `src/api/routes.ts` now returns a parallel `capabilities` map
  (goals + detected version) — `goals.md` §13.6, shipped.
- `teams.md` §9 Phase 0 ("per-Run capabilities … on at least PrimeAgent and Hermes") and
  Phase 1 ("capability advertisement on `/api/agents`, plus a version or capability field
  on `/healthz`"): the version probe + goal capability advertisement half is done
  (`src/adapters/capabilities.ts`, `versionProbe.ts`, migration v7); the `/healthz` half is
  P0-5; the persona/skills-namespace half is P0-3.
- `teams.md` §3 and `roadmap.md` §4: "a Run must be able to carry zero skills. Today it
  cannot." `RunService.create()` honours explicit `[]` (comment cites #459). What remains
  is the selector fallback and the Hermes adapter — P0-2.

Fix: replace the blanket "nothing implemented" stamp in both files with a short
"What exists today" table in the style of `goals.md`'s opening table, listing
`capabilities.ts`, the `/api/agents` `capabilities` field, migration v7, and the explicit
`skills: []` path, each with the file that implements it. Point remaining items at P0-2,
P0-3, P0-5 by number once filed. `crew/README.md` §6's "Current implementation facts" list
gets the same treatment.

Acceptance: no sentence in `docs/crew/` describes `/api/agents` as bare names or a Run as
unable to carry zero skills. A reviewer reading only `docs/crew/` can find
`capabilities.ts` from it.

---

## Not in this set, and why

- **Crew Role Preset registry, resolution, API, UI** (Crew Phases 1–3). Not a prerequisite
  for Atlas; sequenced after this set. Note the touchpoint collision with Atlas Phase 2
  (`RunService.create()` transaction, worker materialization, `.mercury-context.json`) —
  pick one to go first through those files.
- **Selection moving into a per-harness sub-team resolver** (`teams.md` §3 consequence 1).
  A larger refactor that P0-2 deliberately does not attempt; P0-2 makes the namespace
  explicit, which is the input that refactor needs.
- **Destination-aware `allowedNetworks`** (`status.md`, Crew Phase 5). Real proxy/network
  policy work, gates HTTP MCP, unrelated to Atlas 0–3.
- **Daemon adapter repair.** `status.md` says reverify only if resident sessions prove
  value over RPC. Nothing here depends on it.

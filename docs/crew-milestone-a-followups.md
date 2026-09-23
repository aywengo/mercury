# Crew Milestone A — follow-up issue set

Drafted 2026-09-23 against `main` at `bfe1420`, after a review of #714 (`07b0755`), #716 (`a6b4d79`),
#718 (`cd4bf04`) and #719 (`bfe1420`) against [`crew/role-presets.md`](crew/role-presets.md). The format follows
the `issue-fix-loop` contract used by [`atlas-phase-5-6-issues.md`](atlas-phase-5-6-issues.md):
each issue gives the mechanism with file evidence, the choke point, acceptance criteria, a regression
test that fails on base, and one PR. Filed 2026-09-23 as #720 (C-0), #721 (C-1), #722 (C-2), #723 (C-3),
#724 (C-4) and #725 (C-5); each heading below carries its number.

## Summary

The core of Milestone A holds:
- the transactional snapshot;
- materialization from `run_presets`, never from the live registry;
- verbatim retry;
- the preset-less byte-identity guarantees;
- containment and symlink refusal;
- registry-assigned trust;
- escaped dashboard rendering.

The preset, UI and metrics tests pass (105/105 at `bfe1420`).

Two of the design's own acceptance criteria are not met, and #719 marks the milestone complete anyway:
- **AC 7:** unsupported required adapter capabilities fail closed. See C-1.
- **AC 8:** start and resume apply equivalent preset context. See C-2.

C-3 is a bug in the constraint ceilings. C-4 is a spec/code disagreement that needs a decision, not a
fix. C-5 is a pre-existing validation gap that §3.3 makes a preset requirement.

## Dependency order

```
C-0 docs: un-stamp "complete" (goes first, independent)

C-1 fail-closed capability checks at creation ──┐
C-2 resume parity ──────────────────────────────┤
C-3 ceiling fixes + validator cross-checks ─────┼──► re-stamp Milestone A complete (last PR of the set)
C-4 skill-semantics decision ───────────────────┘
C-5 resource-limit format validation (independent, low)
```

---

## C-0 (#720) — docs: roadmap and status claim Milestone A complete while AC 7 and AC 8 are open

**Labels:** `documentation`, `priority: medium`
**Blocked by:** —

### Mechanism

#719 added "Status: **Milestone A (Role Presets, Phases 0-3) is complete.**" to `docs/crew/roadmap.md`,
along with "Status: complete" for each of Phases 1–3. It also made the matching flip in `docs/status.md`
and `docs/crew/README.md`. Acceptance criteria 7 and 8 of `role-presets.md` §12 do not hold on the
merged tree (C-1, C-2). This is the same overclaim pattern that #579 and #512 fixed.

### Fix

- Replace the milestone line with "implemented; AC 7 and AC 8 open (C-1, C-2)". Phase 2 is where the
  gaps live, so it gets the same caveat.
- In `status.md`, move Role Presets under *Implemented*, with an explicit "not yet" list that names
  C-1 to C-4.
- Leave the Phase 1 and Phase 3 stamps alone. Their acceptance lists do hold.

### Acceptance

1. No document says Milestone A is complete while any of C-1 to C-3 is open.
2. `test/crewDocsStatus.test.ts` gains an assertion that the roadmap's milestone status line and
   `status.md` agree. The stamp moved twice in one week, which is the threshold A-0 used for adding a
   guard.

### Likely files

`docs/crew/roadmap.md`, `docs/status.md`, `docs/crew/README.md`, `test/crewDocsStatus.test.ts`.

---

## C-1 (#721) — Enforce the §8 capability vocabulary at Run creation (AC 7)

**Labels:** `bug`, `priority: high`
**Blocked by:** —

### Mechanism

`AgentStaticCapabilities` gained `roleInstruction`, `perRunModel`, `sandbox` and `mcp`
(`src/domain/types.ts`). Resolution reads exactly one of them: `perRunModel`, in `resolveAgent()`
(`src/presets/resolvePreset.ts`). A search of `src/` for `roleInstruction` and `static?.sandbox`
outside the adapters' own declarations finds nothing. As a result:

- **Hermes** declares no `roleInstruction`, which means `none` under §8. Its adapter also has no preset
  rendering: the #716 diff to `hermesAgentAdapter.ts` adds only capability fields. A preset Run on
  `hermes` is created, materializes `.mercury/preset/`, emits `preset.materialized`, and the agent is
  never told a role exists. §8 says `none` "rejects a preset that requires role instruction behavior".
  The comment in the Hermes adapter says the same, but nothing implements it.
- **Daemon** declares `roleInstruction` unmeasured (`none`) and `sandbox: false`. A skill-less preset
  on `daemon` drops the role silently. A `requires.sandbox` preset is admitted at creation, and fails
  only when `start()` refuses a sandboxed Run.
- **RPC (`pi`, `omp`)** renders the preset line in `buildPrompt()`, but declares no `roleInstruction`.
  Its declaration therefore says `none` while its behavior is `prompt-reference`. Once the check
  exists, it would reject the one backend that actually carries the role.
- **The model check fails open.** `resolveAgent()` tests `stat && stat.perRunModel !== true`, so a
  model passes when capabilities are unknown. That is harmless today, because no caller surface sets
  a model and no seed preset declares one. It is still the only fail-open path in resolution.

### Fix at the choke point

Put the check in `resolvePreset()`, next to the existing `perRunModel` check, using the
`staticCapabilities` lookup that `RunService.create` already passes in:

- If the effective agent's `roleInstruction` is absent or `none`, and the preset has a non-empty
  instruction, raise a `ValidationError` that names the agent and the preset. An instruction-less
  preset (skills and constraints only) stays admissible, because nothing is dropped.
- If `requires.sandbox` is set and the agent declares `sandbox: false`, raise a `ValidationError` at
  creation. Do not let the Run fail at `start()`.
- If capabilities are unknown (`stat === undefined`) and the preset asks for a model or an
  instruction, fail closed. Unknown is not supported, which is the rule `status.md` states for goal
  fields.
- Fix the declarations in the same PR:
  - `RpcAgentAdapter`: `roleInstruction: 'prompt-reference'`.
  - Hermes: an explicit `roleInstruction: 'none'`. The value doesn't change, but it becomes readable.
  - Daemon: an explicit `roleInstruction: 'none'`.
  - Local and remote adapters: pass the field through if their registries declare it; otherwise it is
    absent, which means `none`.

### Acceptance

1. A preset with an instruction on `hermes`, and on `daemon`, is rejected at `POST /api/runs` with a
   400 naming the agent. No Run row and no `run_presets` row is written.
2. The same preset on `primeagent`, `claude`, `pi`/`omp` (mock) and `fake` is admitted.
3. A `requires.sandbox` preset on `daemon` is rejected at creation.
4. A preset with a model and unknown capabilities is rejected.
5. A Run without a preset on `hermes` is unaffected (AC 10).

### Regression test

Extend `test/presetResolution.test.ts` with a capability table covering each backend's declared
static block. Extend `test/presetRunIntegration.test.ts` with acceptance 1 and 5 end to end. On base,
acceptance 1 creates a Run.

### Likely files

`src/presets/resolvePreset.ts`, `src/adapters/rpcAgentAdapter.ts`, `src/adapters/hermesAgentAdapter.ts`,
`src/adapters/daemonAgentAdapter.ts`, `test/presetResolution.test.ts`, `test/presetRunIntegration.test.ts`.

---

## C-2 (#722) — Resume must carry the preset like start does (AC 8)

**Labels:** `bug`, `priority: high`
**Blocked by:** —

### Mechanism

§8 says: "Adapters must apply the same preset behavior to both `start()` and `resume()`… preset work
must not extend that asymmetry." On the merged tree:

- **RPC.** `buildResumePrompt()` (`src/adapters/rpcAgentAdapter.ts`) appends only `knowledgeLine()`.
  `sessionContext()` rebuilds a `RunContext` carrying `knowledge` and nothing else, and the `Session`
  interface stores `knowledge` but no preset. The knowledge pointer was deliberately repeated on
  resume. The preset line, which is the same kind of pointer, was not.
- **PrimeAgent.** `resume()` spawns `--resume <sessionFile>` with no new prompt. The original prompt,
  preset line included, lives in the session history. That is probably equivalent, but it is not
  asserted.
- **Claude Code.** `taskText()` includes the preset line. Whether the `-r` resume path writes task text
  again is not covered by any preset test.
- A search of `test/preset*.test.ts` for `resume` finds nothing.

Mitigation: `.mercury-context.json` still names the preset, and the RPC resume prompt tells the agent
to read that file "for the original task and constraints". The role therefore stays reachable. It is
just no longer named in the resume prompt.

### Fix

- **RPC.** Store `preset` (id, role, instructionPath) on `Session` beside `knowledge`, carry it through
  `sessionContext()`, and append `presetLine()` in `buildResumePrompt()`. Mirror the knowledge line
  exactly.
- **PrimeAgent and Claude.** Add tests. If a path does not repeat the reference and relies on session
  history, record that in a code comment as the deliberate equivalence argument, the way `goalArgs()`
  documents why goal flags are not repeated.
- In the same PR, make the context-file comments match what is actually written. They say "id,
  version, role, trust, hash and the instruction path"; the code writes `id`, `role` and
  `instructionPath`. Either write the missing fields or fix the comment. Writing them is cheap, and it
  lets the agent see the hash it runs under.

### Acceptance

1. The RPC resume prompt with a preset contains the preset line exactly once. Without a preset it is
   unchanged from base, byte for byte.
2. For each adapter that declares `roleInstruction` other than `none`, a test asserts the resume path
   either repeats the reference or relies on documented session history.
3. The context file's `preset` block and its comment agree.

### Regression test

Add resume cases to `test/rpcAgentAdapter.test.ts` and `test/primeAgentAdapter.test.ts`, plus a Claude
resume case where one exists. On base, the RPC assertion fails.

### Likely files

`src/adapters/rpcAgentAdapter.ts`, `src/adapters/primeAgentAdapter.ts`, `src/adapters/claudeCodeAdapter.ts`,
their tests.

---

## C-3 (#723) — Network and resource ceilings: one rejects narrowing, one lets defaults widen

**Labels:** `bug`, `priority: medium`
**Blocked by:** —

### Mechanism

All three problems are in `resolveConstraints()` (`src/presets/resolvePreset.ts`) and
`validatePreset()` (`src/presets/validatePreset.ts`):

1. **`networkMode: 'bridge'` rejects `allowedNetworks: []`.** A ceiling is an upper bound (§3.3:
   "Preset ceilings can only narrow"). No network is narrower than bridge, so a caller choosing it must
   be admitted.
2. **`networkMode: 'none'` copies `defaults.allowedNetworks` through unchecked.** The ceiling branch
   checks only the caller: `effective.allowedNetworks = defaults.allowedNetworks ?? []`. A manifest
   with a `none` ceiling and non-empty defaults yields bridge networking, which is wider than its own
   ceiling. `validatePreset` checks defaults and ceilings separately and never against each other.
3. **A `resourceLimits` default that differs from its ceiling makes the preset unrunnable.** The
   merged `rl` includes defaults, and any value that differs from the ceiling throws. A preset whose
   default is `memory: "1g"` under a `"2g"` ceiling therefore fails every Run at creation, instead of
   being flagged when the registry loads it. The design (§3.3) evaluates resource ceilings per field.
   Exact-match is a defensible MVP reading, because "narrower" is not comparable for free-form
   strings until C-5 parses them. But the preset author should learn that at load time.

### Fix

- **Bridge ceiling:** admit `[]`. Only values wider than the ceiling are rejected.
- **None ceiling:** force `effective.allowedNetworks = []` regardless of defaults. Separately,
  `validatePreset` rejects a manifest whose `constraints.defaults` violate its own
  `constraints.ceilings`, with a new code `PRESET_DEFAULT_EXCEEDS_CEILING`. Apply that to the numeric
  ceilings, to `networkMode` versus `allowedNetworks`, and to `resourceLimits` under the exact-match
  rule while it stands.
- A scalar default above its ceiling is currently clamped silently at resolution. It becomes the same
  load-time finding, so the author sees it.

### Acceptance

1. Bridge ceiling with caller `[]` gives effective `[]`, admitted.
2. None ceiling with a non-empty default is refused at registry load with
   `PRESET_DEFAULT_EXCEEDS_CEILING`. If resolution is reached directly, it still yields `[]`.
3. A `resourceLimits` default that differs from its ceiling is refused at load, not at Run creation.
4. The four seed presets still load and resolve unchanged.

### Regression test

Extend `test/presetResolution.test.ts` (acceptance 1 and 2) and `test/presetValidation.test.ts`
(acceptance 2 and 3). On base, acceptance 1 throws and acceptance 2 yields bridge.

### Likely files

`src/presets/resolvePreset.ts`, `src/presets/validatePreset.ts`, the two tests.

---

## C-4 (#724) — Skill resolution: code and §3.2 disagree; decide which one moves

**Labels:** `design-decision`, `priority: medium`
**Blocked by:** —

### The two divergences

`role-presets.md` §3.2 specifies:
1. start with the caller's skills when non-empty, otherwise the preset defaults;
2. if still empty and `autoSelect` is not false, run the selector;
3. append required skills;
4. dedupe;
5. cap.

`resolveSkillIds()` (`src/presets/resolvePreset.ts`) differs in two places:

1. **An explicit `skills: []`** from the caller means "no skills". It suppresses both the defaults and
   auto-selection. The spec treats empty the same as absent, which falls back to the defaults.
2. **Auto-select** runs only when the defaults *and* `required` are both empty. The spec runs the
   selector whenever the start list is empty, and appends required skills afterwards. A preset with
   only `required` skills therefore gets exactly those skills in code, but the selector's picks plus
   those skills in the spec.

Both code choices are argued in comments. Divergence 1 is the more useful semantics: an API caller
otherwise has no way to say "none". Divergence 2 is a real behavior difference for any preset that
uses only `required`. None of the seed presets does today.

### Work

Pick one outcome for each divergence, and change either the spec or the code in one PR:

- **Recommended for 1:** keep the code, and amend §3.2 step 1 to "when the caller provides a list;
  an explicit empty list means none".
- **Recommended for 2:** follow the spec. A `required`-only preset should not silently lose
  auto-selection. If the code is kept instead, amend §3.2 and add a note in the preset authoring
  documentation.

### Acceptance

§3.2 and `resolveSkillIds()` describe the same algorithm. `test/presetResolution.test.ts` has one case
for each step, including a `required`-only preset.

### Likely files

`docs/crew/role-presets.md`, `src/presets/resolvePreset.ts`, `test/presetResolution.test.ts`.

---

## C-5 (#725) — Reject invalid CPU, memory and disk values before insert (§3.3)

**Labels:** `enhancement`, `priority: low`
**Blocked by:** —

### Mechanism

§3.3: "Invalid CPU, memory and disk values are rejected before the Run is inserted." Both the caller
path (`validateConstraints` in `src/runs/runService.ts`) and the manifest path
(`validateConstraintObject` in `src/presets/validatePreset.ts`) check only that each value is a
string. A malformed value reaches the container runtime, which is where it first fails. This is
pre-existing and was not introduced by Milestone A, but the preset design makes it a stated
requirement.

### Fix

Add one parser shared by both paths:
- CPU is a positive decimal.
- Memory and disk are an integer with an optional `b/k/m/g` suffix, matching what the sandbox manager
  passes to `docker`/`podman`.

Once values are comparable, C-3's exact-match rule for `resourceLimits` ceilings can become a true
"not wider than" comparison. That is a follow-up, not part of this issue.

### Acceptance

A malformed value is a 400 at creation, and a registry finding at load. Valid values already in use
(tests, examples, seed presets) are unaffected.

### Likely files

`src/runs/runService.ts`, `src/presets/validatePreset.ts`, `src/sandbox/*` (reuse or align),
`test/presetValidation.test.ts`, the run-creation constraint tests.

---

## Not in this set

- **Per-Run model on a caller surface.** `RunService.create` passes `model: undefined` on purpose, and
  no API field exists. This is new scope, not a gap.
- **`preset.selected`/`preset.materialized` payload shape.** It matches §10. No change.
- **Roles page behavior for disabled presets.** Listing them with `includeDisabled` and rendering them
  as visible but unrunnable is a reasonable reading of §9. No change.

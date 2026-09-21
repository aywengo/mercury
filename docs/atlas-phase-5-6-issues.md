# Atlas — Phase 5 and 6 issue set

Drafted 2026-09-21 against `main` at `c4f3e8d`. It follows the `issue-fix-loop` contract, the same way
[`phase-0-issues.md`](phase-0-issues.md) does: each issue gives the mechanism, the choke point, a regression
test proven to fail on base, and one PR.

**Filed 2026-09-21.** The placeholders map to GitHub issues: A-0 = #681, A5-1 = #683, A5-2 = #684,
A5-3 = #685, A5-4 = #686, A5-5 = #687, A5-6 = #688, A6-1 = #689, A6-2 = #690, A6-3 = #691,
A6-4 = #692. The `Blocked by` lines below name those numbers; the issues carry matching
cross-references.

Design lives in [`knowledge-base.md`](knowledge-base.md): §6 (decision records), §7.3 (tier 3), §9.3 and
§10 (per-harness rendering), §11.6 (e2e), §14 (Fleet) and §15 (packaging). That document's §16 names
Phases 5 and 6 in one paragraph each. This file breaks those paragraphs down into work. It adds no design.
Where the draft found a gap in §6 or §7.3, the gap is written up as a decision inside the issue that hits
it, not settled here.

Each claim about current code names the file it was read from. Where a design section and the tree
disagree, the tree wins, and A-0 carries the correction.

## What the tree already has

This section was checked against the tree rather than taken from §16. Two items that §16 lists as future
work have already shipped:

| Design item | State | Where |
| --- | --- | --- |
| Fleet reader (§14 item 1) | **built** — `GET /fleet/knowledge` and `fleet knowledge`, reader token only, counts only, always 200 | `fleet/atlas.ts`, `fleet/server.ts`, #615 |
| Fleet soft placement signal (§14 item 2) | **built**, off by default (`FLEET_KNOWLEDGE_STALE_MS=0`) | `fleet/config.ts`, `fleet/routing.ts` |
| Claude Code rendering (§9.3) | **built, not observed** — generated `CLAUDE.md`, stdin pointer fallback | `src/adapters/claudeCodeAdapter.ts` |
| Atlas package metadata | `@aywengo/mercury-atlas` 0.1.0, `bin: atlas → dist/cli.js`, `build:atlas`, `test:atlas` in root `npm test` | `atlas/package.json`, `package.json` |
| Bounded git helper the harvester must reuse | `runGit()` with `MERCURY_GIT_TIMEOUT_MS` (default 30 000) | `src/workspace/workspaceManager.ts` |
| `repo-record` lands promoted at Atlas | built | `atlas/notes.ts` (the `tier` assignment in `contributeOne`) |

What is **not** in the tree:
- a decision-record parser;
- a `git diff` in the finalize path;
- a `knowledge index` subcommand (`src/cli.ts` has `status`, `identity` and `flush`);
- harness-native delta import;
- a knowledge line in the RPC prompt (`buildPrompt()` in `src/adapters/rpcAgentAdapter.ts` names
  `.mercury-context.json` and `.agents/skills/`, and nothing else);
- an `atlas-v*` tag in `.github/workflows/release.yml`;
- `docs/releases/atlas/`;
- an Atlas unit under `deploy/`;
- an Atlas scenario in `e2e/`.

## Dependency order

```
A-0 doc drift (independent, goes first)

A5-1 decision-record parser ──┬──► A5-2 finalize delta harvest
                              └──► A5-3 `knowledge index` CLI
A5-2 ──────────────────────────► A5-4 harness-native deltas (reuses A5-2's diff)
A5-5 RPC prompt line (independent)
A5-6 Claude Code observation (independent, no code)

A6-1 release plumbing ──┬──► A6-4 first release (atlas-v0.1.0)
A6-2 deploy unit ───────┤
A6-3 two-host e2e ──────┘
```

Suggested work order:
1. **A-0**.
2. **A5-6**, because it is cheap and closes a matrix row.
3. **A5-1**, **A5-2**, **A5-3**.
4. **A5-5**.
5. **A5-4**.
6. **A6-1**, **A6-2**, **A6-3**, and then **A6-4**.

Phase 5 and Phase 6 are independent, so A6 can run in parallel if a slot opens.

---

## A-0 — docs: knowledge-base.md and status.md disagree with the tree and with each other

**Labels:** `documentation`, `priority: medium`
**Blocked by:** —
**Blocks:** anyone planning from §16 alone. They would rebuild the Fleet reader that #615 already shipped.

### Drift, each item with its evidence

1. **`knowledge-base.md` status header** says "phases 0 to 3 implemented". §16 records Phase 4 as
   observed, with auto-promotion across `obs-host`/`obs-host-b` (`run_4acabb39e38c4c7d` and others).
2. **`knowledge-base.md` §8.4** ends with "none of it exists now". The header and `status.md` both say
   the `MERCURY_*` configuration is live and read by `src/config.ts`.
3. **`knowledge-base.md` §16 Phase 1** says "Migration v8". §8.6 already explains that v8 went to
   `run_goals.attempted` and says not to pre-reserve a number.
4. **`knowledge-base.md` §16 Phase 6** lists `FLEET_ATLAS_URL`, the dashboard and the soft placement
   signal as future work. All three are built (see the table above).
5. **`knowledge-base.md` §18 Q6** says "180 days is a guess". §12 and `status.md` say retired-note
   tombstoning is off by default with no age set.
6. **`knowledge-base.md` §7.4** specifies `knowledge: { notesFile, workspaceFile, contextFile }`. The
   shipped capability is one boolean: `knowledge?: boolean` in `src/domain/types.ts`, with the matching
   leaf in `src/adapters/configSchema.ts`. Record the boolean as what exists. Record the object as the
   shape to add when a consumer needs one of its fields. A5-4 deliberately does not need one.
7. **`status.md`** says the write path "has not been seen from a real agent" and cites
   `run_e8fe5f095b38438b`. That is stale. `knowledge-base.md` §16 3b records Hermes writing a note
   that was accepted (`run_0826c0e5e4ee4f6c`), and Phase 4 shows that tier-1 candidates from real
   agents were promoted.
8. **`status.md`** says the RPC adapters get "a prompt line". `buildPrompt()` in
   `src/adapters/rpcAgentAdapter.ts` has no knowledge line; it has only the context-file and skills
   lines. Either fix the claim here or let A5-5 make it true. The claim must not stay ahead of the code
   in the meantime.
9. **`status.md`** does not mention the Fleet reader (`/fleet/knowledge`, `fleet knowledge`) under
   the Atlas section.

### Fix

Correct every item in place, keeping the history in the style that document already uses ("was X;
now Y, because Z"). Do not rewrite sections.

### Acceptance

1. Every numbered item above is resolved, or it is explicitly marked as pending with the issue that
   will resolve it.
2. `test/knowledgeDocsClaims.test.ts` gains one relationship assertion for each claim that has
   drifted twice. At minimum: the status header's highest phase agrees with the highest phase §16
   marks observed, and §16 does not describe `FLEET_ATLAS_URL` as unbuilt while `fleet/config.ts`
   reads it.

### Likely files

`docs/knowledge-base.md`, `docs/status.md`, `test/knowledgeDocsClaims.test.ts`.

---

## A5-1 — Decision-record parser (§6.1, §6.2)

**Labels:** `enhancement`, `priority: high`
**Blocked by:** —
**Blocks:** A5-2, A5-3.

### Mechanism

No code reads `docs/decisions/`. A search of `src/` and `atlas/` for `docs/decisions` finds nothing.
`repo-record` exists only as a source value in `NOTE_SOURCES` (`src/knowledge/types.ts`) and in Atlas's
promotion rule. Every §6 consumer needs one pure function that turns a record file into either a note
draft or a rejection with a stated reason.

### Fix

Add `src/knowledge/decisionRecord.ts`, which exports
`parseDecisionRecord(text, { path, repoIdentity, headSha }) → { ok: true, draft } | { ok: false, reason, detail }`.

- **Frontmatter.** Use a restricted YAML subset: scalar keys, plus an `evidence` list whose entries are
  either URLs or `commit: <sha>`. Do not add a YAML dependency. A deliberate subset, with a test for each
  accepted form, is easier to review than a general parser. Anything outside the subset is a rejection,
  not a best-effort read.
- **The four §6.2 rules:**
  - Required keys are `id`, `title`, `status` and `date`.
  - The first paragraph under `## Decision` must fit within `maxClaimBytes`. That paragraph becomes the
    claim verbatim.
  - There must be at least one parseable evidence entry.
  - `status` must be `accepted`, `superseded` or `rejected`. A `proposed` record is not indexed. It is
    reported as skipped, not as rejected, because it is not wrong, only early.
- **Output.** The output has `kind: 'decision'` and `scope: repo:<hash>` from `identityHash()`. Its
  evidence is the record's own list plus one `repo-file` reference to the record at `headSha`. For
  `status: rejected`, the claim is prefixed with `Rejected:`.
- **The result passes through `validateDraft()`** (`src/knowledge/validation.ts`), so K2, the bounds and
  the secret check apply unchanged. The parser adds no second validation path.
- **New reject reasons** are added to `REJECT_REASONS`:
  - `decision-without-evidence`, which §6.2 names;
  - `decision-malformed`, for bad frontmatter, a missing required key or a missing `## Decision`, with
    the specific problem in `detail`.

### Decision this issue must record

§6.2 says a `superseded` record's note gets `supersededBy` pointing to "the note of the superseding
record". The host cannot know that `noteId`, because Atlas assigns it. There are two options:

- **(a)** Carry the record `id` (for example `0007`) in the draft. Atlas resolves `supersedes` by
  record id within the project when the superseding note arrives, and retires the old note with
  `supersededBy`.
- **(b)** Emit no `supersededBy` from the host. Leave supersession to an operator retire.

Option (a) matches the design's intent. It adds a field to the wire, which touches
`test/atlasContract.test.ts`. Pick one in the PR and amend §6.2 in the same PR.

### Acceptance

1. A fixture record for each §6.2 rule produces the expected rejection reason. A valid record produces a
   draft whose claim equals the first `## Decision` paragraph byte for byte.
2. A `proposed` record is skipped, not rejected.
3. A `rejected` record's claim starts with `Rejected:`.
4. A record whose `## Decision` paragraph contains a harness-specific flag (for example `--skill x`) is
   rejected as `k2-violation`. This proves the result goes through `validateDraft()`.
5. The evidence always includes the self-referencing `repo-file` entry at `headSha`.

### Regression test

Add `test/knowledgeDecisionRecord.test.ts` with table-driven fixtures under
`test/fixtures/decisions/`. On base the import fails, which counts as the failing run.

### Likely files

`src/knowledge/decisionRecord.ts` (new), `src/knowledge/validation.ts` (reasons),
`test/knowledgeDecisionRecord.test.ts`, `test/fixtures/decisions/*`. Also `atlas/notes.ts` and
`test/atlasContract.test.ts` if option (a) is chosen.

---

## A5-2 — Harvest decision records changed by the Run, at finalize (§6.3 per-Run delta)

**Labels:** `enhancement`, `priority: high`
**Blocked by:** A5-1.
**Blocks:** A5-4.

### Mechanism

The worker's finalize path (`src/worker/worker.ts`, around the `harvestNotes()` call) reads only
`.mercury/notes.jsonl`. A Run that writes `docs/decisions/0012-*.md` and commits it publishes the
decision to git and nothing to Atlas. That is the §6.3 coverage gap in its sharpest form: the one
Run that certainly touched the record is not asked about it.

### Fix at the choke point

Keep one harvest step. Do not add a second pass.

- In the same pre-transaction read that calls `harvestNotes()`, run
  `runGit(['diff', '--name-status', '<baseCommit>..HEAD', '--', 'docs/decisions/'], { cwd: workspacePath })`.
  `baseCommit` is already on the workspace (`src/workspace/workspaceManager.ts` returns it). Use
  `runGit` so that the timeout and the non-interactive environment come for free. Phase 0 P0-4 said the
  harvester must not add its own git invocation.
- **Copy mode** has no git: `workspaceManager` returns `baseCommit: 'copy'`. Skip the delta without
  treating it as an error, and note this in the harvest log line. That matches how §9.4 treats copy mode.
- Parse `A` and `M` entries with A5-1. Ignore `D` entries. A record deleted from git is a supersession
  that someone forgot to write, and it is not the harvester's job to guess which. Read file content at
  `HEAD` with `git show HEAD:<path>`, not from the working tree. An uncommitted edit is not a decision.
- The deadline is the existing `MERCURY_KNOWLEDGE_HARVEST_TIMEOUT_MS`, shared with tier 1 rather than
  added to it. Records count toward `MERCURY_KNOWLEDGE_MAX_NOTES_PER_RUN`.
- Survivors go into the outbox inside the existing completion transaction, with `source: 'repo-record'`
  and `provenance.runId` set. Emit `knowledge.noted` for each accepted record and `knowledge.rejected`
  for each refused one, with `source: 'repo-record'`.
- Gate the step on the same condition as tier 1 (`deps.knowledgeHarvest` present). A host with no Atlas
  runs no git.

### Acceptance

1. A fake Run that commits a valid record produces one outbox row with `source: repo-record`, the
   Run's id, and a `repo-file` evidence entry at the Run's `HEAD`. It also produces one
   `knowledge.noted`.
2. A record that is present but uncommitted produces nothing.
3. A copy-mode Run completes with no delta and no error event.
4. A git hang (use the P0-4 hanging fixture) ends the harvest at the deadline. The Run still reaches
   `COMPLETED` (K4) and the harvest failure is logged.
5. Tier-1 notes and records from the same Run land in the same transaction. A forced failure of the
   completion transaction leaves neither.

### Regression test

Extend `test/knowledgeHarvestFinalize.test.ts` with a worktree fixture that commits a record. On base,
no row appears.

### Likely files

`src/worker/worker.ts`, `src/knowledge/harvest.ts` (or a sibling `harvestRecords.ts` called from the
same site), `test/knowledgeHarvestFinalize.test.ts`.

---

## A5-3 — `knowledge index <checkout>`: operator bootstrap of existing records (§6.3)

**Labels:** `enhancement`, `priority: medium`
**Blocked by:** A5-1.
**Blocks:** —

### Mechanism

A repository that already has records before Atlas exists has no path into Atlas except one Run per
record. §6.3 specifies an operator command for this. `src/cli.ts` has `knowledge status`, `identity`
and `flush`, but no `index`.

### Fix

- `node src/cli.ts knowledge index <checkout-path>` parses every `docs/decisions/*.md` at the
  checkout's `HEAD` with A5-1. It inserts survivors into the ordinary outbox with `runId: null` and
  `source: 'repo-record'`. It prints a table of accepted, skipped and rejected records with reasons,
  and exits non-zero if any record was rejected, so the command is usable in CI.
- **Idempotency key.** `idempotencyKey()` in `src/knowledge/outbox.ts` maps `runId: null` to
  `operator:<claimHash>`. An indexed record and an operator note with the same claim would then collide
  at the host. Give indexed rows their own prefix (`index:<claimHash>`), and have the key function take
  the source rather than inferring it from a missing Run.
- **Corroboration at Atlas.** `note_sources` is unique on `(note_id, host_id, run_id)` and `run_id` is
  `NOT NULL` (`atlas/db.ts`). Verify how Atlas stores a runless contribution. Re-running `index` on the
  same host must produce `duplicate` and must not inflate corroboration. Assert this rather than assume
  it.
- The command refuses with an explanation when no Atlas is configured, the same way `flush` does. It
  never pushes synchronously; `flush` exists for that.

### Acceptance

1. Indexing a checkout with three valid records and one `proposed` record queues three rows and
   reports one skipped.
2. Indexing the same checkout twice queues nothing new at the host, and after a flush Atlas reports
   `duplicate` with corroboration unchanged.
3. An indexed record and an operator note with the same claim hash do not share an outbox key.
4. The indexed notes land `promoted` (already built in `atlas/notes.ts`; asserted here end to end).

### Regression test

Add `test/knowledgeIndexCli.test.ts`, modelled on `test/knowledgeIdentityCli.test.ts`. Extend
`test/atlasContract.test.ts` for acceptance 2.

### Likely files

`src/cli.ts`, `src/knowledge/outbox.ts`, `test/knowledgeIndexCli.test.ts`, `test/atlasContract.test.ts`,
`docs/operations.md` (operator usage).

---

## A5-4 — Harness-native file deltas as `convention` candidates (§7.3 second half)

**Labels:** `enhancement`, `priority: low`
**Blocked by:** A5-2 (reuses its committed-diff read).
**Blocks:** —

### Mechanism

Agents edit `AGENTS.md`, `CLAUDE.md`, `SOUL.md`, `.cursor/rules/*.mdc` and `.agents/skills/` as a side
effect of working. None of those edits reaches Atlas. A search of `src/` for `SOUL.md` finds nothing.

### Fix

- Use the same committed range as A5-2 (`baseCommit..HEAD`), with paths limited to the §7.3 list.
  Import only **added paragraphs**, using a line diff grouped into blank-line-separated blocks. Never
  import whole files; K1 applies here.
- The output has `kind: 'convention'`, `source: 'distilled'` (§7.3 names no source; `distilled` is the
  closest existing value, so record that choice in §7.3), scope `repo:<hash>` or
  `repo:<hash>#<dir>`, and a `repo-file` evidence entry at `HEAD`. Every item lands `candidate`.
- **Mercury's own generated files must not come back as knowledge.** The generated `CLAUDE.md`,
  `AGENTS.md` and `.agents/skills/mercury-knowledge/` are in `info/exclude` (§9.4), so they cannot
  appear in a committed diff. Assert that anyway. A pack that feeds itself back into Atlas would
  corroborate its own notes, which is the K3 failure in a loop.
- **Expect heavy K2 rejection.** Harness-native files are harness-specific by nature. Rejections are
  reported through `knowledge.rejected` like any other rejection, and their volume is the signal
  for whether this tier is worth keeping (§16 already makes that point about tier 2).
- **No capability gate.** §7.4 gates this on `knowledge.workspaceFile`, which does not exist (A-0
  item 6). The read is of git, not of the harness, so it fails open, which is the same posture §7.4
  takes for ingest in general. Amend §7.4 accordingly.

### Acceptance

1. A Run that commits a new paragraph to a tracked `AGENTS.md` produces one `convention` candidate
   whose claim is that paragraph.
2. An unchanged paragraph and a deleted paragraph produce nothing.
3. A paragraph containing a harness path such as `~/.hermes/...` is rejected as `k2-violation`.
4. A Run that received a pack via a generated `AGENTS.md` and committed other work contributes nothing
   from the generated file.

### Regression test

Extend `test/knowledgeHarvestFinalize.test.ts`.

### Likely files

`src/knowledge/harvest.ts` (or `harvestNative.ts`), `src/worker/worker.ts` (same call site as A5-2),
`docs/knowledge-base.md` §7.3 and §7.4.

---

## A5-5 — RPC adapters (pi, omp): name the pack in the prompt (§9.3)

**Labels:** `enhancement`, `priority: medium`
**Blocked by:** —
**Blocks:** the `pi`/`omp` row of §10 moving off "unverified".

### Mechanism

`buildPrompt()` in `src/adapters/rpcAgentAdapter.ts` tells the agent to read `.mercury-context.json` and
`.agents/skills/`. The context file carries the `knowledge` block (`...(context.knowledge ? { knowledge } : {})`),
but nothing tells the agent to follow that pointer. The resume prompt (`client.prompt('Continue the
task...')`) has the same gap. The §9.3 row specifies "one added line in the prompt", and it was never
written.

### Fix

- When `context.knowledge` is present, add one line to `buildPrompt()` that names the knowledge pack
  file (`NOTES_FILE` from `src/knowledge/materialize.ts`) and says what it is. Omit the line when there
  is no pack, so a Run without knowledge gets the prompt it gets today, byte for byte.
- Give the resume prompt the same conditional line.

### Acceptance

1. A prompt snapshot with a pack contains the line exactly once. A prompt snapshot without a pack is
   unchanged from base.
2. **Observation.** Following the #589 method, run one treated and one control Run on a real `pi` (or
   `omp`) binary, with one promoted operator note naming a command no document in the repository
   mentions. Record the Run ids and binary versions in the PR body and in the §10 row. If neither
   harness is available, merge the code and leave the row marked unverified. Do not write "works".

### Regression test

Add a prompt snapshot test in the existing RPC adapter test file. On base, the line is absent.

### Likely files

`src/adapters/rpcAgentAdapter.ts`, its test, `docs/knowledge-base.md` §10 (row update only when
observed).

---

## A5-6 — Observe the Claude Code knowledge channels on real Runs (§10)

**Labels:** `verification`, `priority: medium`
**Blocked by:** —
**Blocks:** the `claude` row of §10.

### Mechanism

Both Claude Code channels are built (`src/adapters/claudeCodeAdapter.ts`):
- a generated `CLAUDE.md` when the repository does not track one;
- a stdin pointer line when it does.

Neither has been observed on a real Run. §10 says so plainly. It is the only built channel without a
Run id.

### Work (no code expected)

Use the #589 method with the same operator note naming an unadvertised command:

1. Treated and control Runs on a repository that **does not** track `CLAUDE.md`. This observes the
   generated-file channel.
2. A treated Run on a repository that **does** track `CLAUDE.md`. This observes the degraded pointer
   channel, and it is the case §10 calls unmeasured.
3. Record the Run ids, the Claude Code version and the observed first command. Update the §10 row and
   the §16 Phase 5 paragraph.

If the pointer channel is not acted on, record that as the result. The row becomes "observed: not
read", which is a finding, not a failure of the issue.

### Acceptance

The §10 `claude` row cites Run ids for each channel it describes, as the `primeagent` and `hermes` rows
do. If `knowledgeDocsClaims.test.ts` gains a "measured rows cite runs" assertion under A-0, this row
passes it.

### Likely files

`docs/knowledge-base.md`.

---

## A6-1 — Release plumbing for `@aywengo/mercury-atlas` (§15)

**Labels:** `release`, `priority: medium`
**Blocked by:** —
**Blocks:** A6-4.

### Mechanism

`.github/workflows/release.yml` accepts only `host-v*` and `fleet-v*`, and refuses any other tag as
malformed. The Atlas package has metadata (`atlas/package.json`, `tsconfig.atlas.json`, `build:atlas`)
but no release path. `distribution.md` and `releasing.md` do not mention Atlas. That is correct today,
because §15 forbids documenting an install that does not exist.

### Fix

- Add `atlas-v*.*.*` to the tag filter and the refusal message. Add an Atlas branch to the release job:
  `npm run build:atlas`, `npm pack` in `atlas/`, and publish `@aywengo/mercury-atlas`.
- Add a **tarball smoke step** before publishing: install the packed tarball into a temporary
  directory and run `atlas --version` from `node_modules/.bin`. This is the failure that the comments
  in `tsconfig.fleet.json` record (a `.ts` `bin` that installs and then fails on first use), and a
  test is cheaper than a broken release.
- Create `docs/releases/atlas/` (empty until A6-4).
- Extend `test/releaseDocs.test.ts` and `test/ciWorkflow.test.ts` so that the tag glob, the
  refusal message and the docs agree on three products. Keep the existing rule that the runbooks do
  not give a product an artifact it does not have. Atlas, like Fleet, gets no bundle and no formula.

### Acceptance

1. A dry run of the workflow on an `atlas-v0.0.0-test` tag builds, packs and smoke-tests, and does not
   publish.
2. A tag of any other shape is still refused, with a message listing all three prefixes.
3. `npm test` passes with the extended doc and workflow tests.

### Likely files

`.github/workflows/release.yml`, `atlas/package.json` (the `files` field, if needed),
`test/releaseDocs.test.ts`, `test/ciWorkflow.test.ts`.

---

## A6-2 — Deploy unit and backup for Atlas (§11.3, §15)

**Labels:** `deployment`, `priority: medium`
**Blocked by:** —
**Blocks:** A6-4.

### Fix

- Add `deploy/atlas.service` and `deploy/atlas.env.example` next to `fleet.service` and
  `fleet.env.example`, with the same hardening. The example environment file covers loopback bind by
  default, TLS variables required off loopback, `ATLAS_CONTRIBUTORS_FILE` with mode `0600`, and an
  empty `ATLAS_SECRETS`.
- `deploy/backup.sh` covers `ATLAS_DB` and its WAL. §11.3 says the host's backup pattern "applies
  unchanged", so make it true rather than asserted.
- Add an Atlas section to `deploy/README.md`.

### Acceptance

1. `systemd-analyze verify deploy/atlas.service` passes. If there is an existing unit-lint test, it
   covers the new file.
2. The backup script produces a restorable `atlas.db`, checked by a restore-and-`atlas migrate` round
   trip in a test or in the deploy README's manual procedure.

### Likely files

`deploy/atlas.service`, `deploy/atlas.env.example`, `deploy/backup.sh`, `deploy/README.md`.

---

## A6-3 — Containerized two-host scenario (§11.6 third layer)

**Labels:** `testing`, `priority: medium`
**Blocked by:** —
**Blocks:** A6-4.

### Mechanism

`test/knowledgeTeachE2E.test.ts` proves the transport in process against a real Atlas process. §11.6
also asks for the containerized suite to gain one scenario: two hosts, one Atlas, one project, and a
note learned on host A materialized on host B. `e2e/` has no Atlas service.

### Fix

- Add an `atlas` service to `e2e/compose.yml` and a second host pair (API and worker).
- Add one scenario to `e2e/system.test.ts`:
  1. Host A runs a `fake` Run that writes `.mercury/notes.jsonl`.
  2. An admin promotes the note.
  3. Host B's replica converges.
  4. A Run on host B has the note in `.mercury/knowledge/NOTES.md`.
- Add a second assertion with Atlas stopped: host A still completes its Run and its outbox holds the
  note (K4 in containers, not only in process).
- Note from Phase 0: `testcontainers` is not present in every checkout. Keep the preflight honest
  rather than letting the scenario skip silently.

### Acceptance

The scenario passes in CI where the e2e suite runs. It fails when the puller is disabled on host B,
which proves the scenario is not vacuous, using the same revert-to-prove technique Phase 0 used.

### Likely files

`e2e/compose.yml`, `e2e/system.test.ts`, `e2e/helpers.ts`, `e2e/README.md`.

---

## A6-4 — Cut `atlas-v0.1.0`

**Labels:** `release`
**Blocked by:** A6-1, A6-2, A6-3, and A-0.

### Work

- Write `docs/releases/atlas/0.1.0.md` and move `atlas/CHANGELOG.md` from Unreleased to the release.
- In the same PR, update `distribution.md` and `releasing.md` so they describe Atlas as it now
  exists. `test/releaseDocs.test.ts` holds them to that.
- Update the §15 "no install command" paragraph and the §16 Phase 6 status.
- Tag the release. The install command appears in the release notes and not before (§15).

### Acceptance

`npm install @aywengo/mercury-atlas@0.1.0` into an empty directory followed by `npx atlas --version`
prints `0.1.0`. The registry check in `releaseDocs.test.ts`, which exists for Fleet, covers Atlas.

---

## Not in this set, and why

- **Tier 2 distillation (§7.2).** It is deferred by §16 4b until a Run shows a fact that only the event
  stream carries. No such Run is recorded.
- **Remote-agent `knowledge.payload` (§9.3, §18 Q10).** It is not designed, and it needs a
  remote-registry format change first.
- **`LocalAgentAdapter` context pointer (§9.3).** `local-agents/` ships no example entry, so there is no
  backend to observe it on. File this when the first entry lands.
- **Hermes `persona.append`.** It is not needed for knowledge, because `AGENTS.md` is the channel that
  exists. It belongs to Crew's harness-capabilities work.
- **A Fleet dashboard UI.** Fleet has no UI. §14 item 1 is delivered as `GET /fleet/knowledge` and
  `fleet knowledge` (#615). A visual surface is a Fleet product question, not an Atlas phase.
- **Retired-note retention policy (§18 Q6).** Deletion ships off by default. Choosing a default is a
  data question, and it waits for candidate and retirement volumes from a real project.

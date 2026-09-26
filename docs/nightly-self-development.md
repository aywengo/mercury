# Nightly self-development — Mercury working on Mercury

Status: **in progress — N0 done, N1 partly done, dispatcher B0–B1 done;
nothing runs unattended yet.** See §8.1 for the per-milestone status. This
document specifies how a Mercury host, driven by a dispatcher bot
(`dispatcher-bot-design.md`), works on the `aywengo/mercury` repository
unattended between 00:00 and 06:00 local time.

## 1. Summary

Every night the host:

1. runs the end-to-end suite and files a GitHub issue for each real defect;
2. fixes trusted open issues, highest priority first;
3. works on new issues opened by @aywengo, if time remains;
4. when no issue is workable, reads the docs and designs and proposes the next
   feature work (§6, gated by a human).

The one architectural decision:

> The night is a **priority ladder evaluated by a pull loop**, not a pipeline of
> chained phases. A scheduled task fires repeatedly with `singleFlight`; each
> Run takes the top available rung and finishes. Rung selection is
> deterministic (GitHub state), the agent only does the work.

This needs only dispatcher milestones B0–B1 (scheduler, no LLM). The dispatcher
design has no "after Run X completes, dispatch Y" trigger, and staggered cron
times waste the window; the ladder avoids both.

## 2. Goals

1. Nightly E2E results become deduplicated, actionable GitHub issues.
2. Trusted issues get PRs overnight, one issue → one PR (issue-fix-loop skill,
   independent review).
3. Nothing reaches `main` without a human merge (v1).
4. Every night ends with a single morning report.
5. Mercury can never break the installation that runs it.
6. Content from GitHub (issue bodies, comments, PR text) is data, never
   instruction; what gets worked on is decided by code from verified metadata.

## 3. Non-goals

- Auto-merge (v1). Revisit per §9.
- Working on issues from arbitrary authors. The repo is public.
- Deploying or upgrading the nightly host from its own output.
- A new orchestration mechanism: every step is an ordinary Run dispatched by a
  bot, as in `dispatcher-bot-design.md`.

## 4. The night

### 4.1 Schedule

| Task | Cron (`tz: "local"`) | Purpose |
| --- | --- | --- |
| `nightly-e2e` | `5 0 * * *` | run E2E, file/update defect issues |
| `nightly-next` | `*/20 0-4 * * *`, `singleFlight: true` | take the top ladder rung |
| `nightly-report` | `40 5 * * *` | morning digest |

`tz: "local"` so midnight is Poznań midnight. The EU DST switch happens at
02:00/03:00 local, inside the window: two nights a year are 5 h or 7 h long.
Accepted.

If the worker runs one Run at a time, E2E and the ladder serialize through the
queue. If it runs more, `nightly-next` must check that tonight's E2E Run is
terminal before taking rung 1 (bugs it may be about to file).

The bot config implementing this schedule is #742
(`deploy/nightly-bot.json.example`).

### 4.2 The ladder

Each `nightly-next` Run evaluates, in order, and takes the first rung with work:

1. **Trusted bugs** — `origin:e2e` issues and `nightly:ready` issues, by
   priority label then age.
2. **New @aywengo issues** — authored by @aywengo, not yet labeled.
3. **Docs → proposals** — §6.

Selection runs as code against the GitHub API
(`.agents/skills/nightly/select.ts`, #738). The chosen issue is labeled
`nightly:in-progress` before work starts, so a concurrent or retried Run does
not take it twice.

### 4.3 The window ends at 06:00

- The last `nightly-next` fire is 04:40.
- Every nightly Run carries `constraints.notAfter` (#731), an absolute deadline
  that also counts time spent queued: a Run past it is never started, and a
  running Run is stopped at it. Bot templates set it with `notAfterAt: "06:00"`,
  resolved on the fire's date. The bot never cancels Runs on shutdown, so this
  constraint is the only thing that enforces the window.
- A template without `constraints.maxDurationMs` gets 1 h from the bot. The
  E2E task sets its own.
- A Run stopped by its deadline leaves its issue labeled `nightly:in-progress`
  with a comment; `nightly-report` lists it, and the next night resets it.

### 4.4 Nightly Runs never ask

`singleFlight` skips on any non-terminal status, NEEDS_INPUT included. A
question at 00:40 would block the ladder for the rest of the night, with nobody
awake to answer. Rule for every nightly skill: when in doubt, stop, label the
issue `nightly:blocked`, put the question in an issue comment, finish the Run.
(N5 may later let the brain answer from an allowlist.)

## 5. Trust and safety

1. **Trusted issues only.** The ladder considers an issue only if it is authored
   by @aywengo, filed by the nightly identity from E2E — the issue's AUTHOR is
   `mercury-nightly` and the CURRENT `origin:e2e` label carries the nightly
   identity as its timeline actor — or labeled `nightly:ready` by @aywengo.
   Checked from the API's author and label-event actor fields, never by the
   agent reading issue text (#738, #764): a label alone is provenance anyone
   with triage access can apply, so the middle clause verifies who filed the
   issue, not just which label it carries.
2. **Bot identity.** The machine user `mercury-nightly`, Write collaborator on
   `aywengo/mercury` only, classic PAT with `repo` scope (fine-grained tokens do
   not work for collaborators on a personal repository). Documented in
   `docs/operations.md`.
3. **Branch protection.** `main` is protected by the `main-protection` ruleset:
   PR required, `ci` required green, force-push and deletion blocked, @aywengo
   alone on the bypass list, one approving review required (set 2026-09-26), so
   the nightly identity cannot merge its own PRs.
4. **Pinned host.** The nightly host runs a released `@aywengo/mercury`
   version, upgraded deliberately by a human. Work happens in Run workspaces,
   never in the installation.
5. **Credentials.** The GitHub token reaches Runs through the harness
   environment, never through task text, argv or events. Until credential
   profiles (`credential-profiles-design.md`) ship, this requires a host
   dedicated to the nightly identity (that design's §12), because local Runs
   inherit the worker's whole environment.
6. **Budgets.** Maximum PRs per night and token budget per night, enforced by
   the skills. The per-hour dispatch cap of `dispatcher-bot-design.md` is not
   in the B1 config; the nightly schedule is bounded by its cron and
   `singleFlight`.
7. **Fail-closed capabilities.** Crew #721 is closed (PR #743).

### 5.1 Labels

`nightly:ready`, `nightly:in-progress`, `nightly:blocked`, `nightly:proposed`,
`origin:e2e` — created (#728); meanings and the trust rule are in
`docs/issue-triage.md`.

## 6. Docs → features, gated

The rung where an autonomous loop is most likely to drift gets a human gate.
Nightly reads the docs (via Atlas, as dogfooding), finds the next
unimplemented item in a document's roadmap section, and **only drafts the issue
set**, labeled `nightly:proposed` — the same pattern as
`atlas-phase-5-6-issues.md`. Implementation starts on a later night, after
@aywengo relabels an item `nightly:ready`. One night of latency buys a human
decision on *what* gets built.

## 7. Skills

- **`nightly-e2e`** (#739) — `npm run test:e2e` (the host needs Docker). Reruns
  each failure once to separate flakes from defects. Fingerprints each real
  failure (test name + normalized assertion/error), searches issues for the
  fingerprint, comments on a match or files a new `origin:e2e` issue. Flakes
  are reported, not filed, until they recur on N nights.
- **`nightly-next`** (#740) — the ladder (§4.2), then the issue-fix-loop for
  the chosen issue; rung 3 drafts proposals only.
- **`nightly-report`** (#741) — one digest: PRs opened, issues filed or
  updated, blocked items with their questions, Runs stopped by deadline,
  budget used.

Role presets (Crew Milestone A): tester, fixer, planner.

## 8. Roadmap

The issue set for N0, N1 and dispatcher B0–B1 is
[`nightly-issues.md`](nightly-issues.md).

### 8.1 Status (2026-09-26)

| Milestone | Status | Issues |
| --- | --- | --- |
| N0 guardrails | **done** — identity `mercury-nightly`, approvals = 1 | #727, #728 |
| Dispatcher B0 | **done** | #729–#734 |
| Dispatcher B1 | **done** | #735–#737 |
| N1 skills | **in progress** — selector done | #738 done; #739, #740, #741 open |
| N2 unattended | **not started** — bot config + first nights | #742 |
| N3 docs → proposals | not started — needs nights, no new issues | (rung 3 in #740) |
| N4 reactive | **not filed** — waits for evidence (§8.2 stage 4) | — |
| N5 brain | **not filed** — waits for evidence (§8.2 stage 5) | — |

Non-blocking follow-ups from B1: #759 (`host bot status` partial data on API
failure), #760 (owner-transfer API for `--reassign-runs`).

### 8.2 Stages

The milestones below are delivered in five stages. Each stage adds autonomy
only after the previous one has produced evidence that it can be trusted.

1. **First night (N1 → N2).** Owner steps done 2026-09-26 (approvals = 1,
   identity `mercury-nightly`); the token goes into the host harness
   environment with the #742 checklist. Agent work: #739–#741, then #742. Then walk
   the #742 checklist, `host bot service install --alias nightly`, and record
   three clean nights on #742.
2. **Prove it (N2 acceptance, no new code).** Run nightly until the N2
   acceptance holds (seven consecutive nights) and the §9 metrics have a
   baseline. Defects the nights reveal become ordinary issues, and the ladder
   takes them.
3. **Docs → features (N3).** Review `nightly:proposed` issues and relabel the
   ones worth doing to `nightly:ready`; later nights implement them. Needs
   only time and review.
4. **Reactive (N4 = dispatcher B2).** File the issue set only after stage 2
   shows which failures actually occur. Requires `statusChangedAt` on the runs
   list and the trigger engine.
5. **Brain (N5 = dispatcher B3), optional.** File only if `nightly:blocked`
   is a frequent outcome in the reports. Requires the `reason` field on input
   events.

Auto-merge is a later policy decision (§9), not a stage.

### N0 — guardrails (no bot code) — done

Bot identity, branch protection, labels, trust rule written down, pinned host
version, budgets decided.

*Acceptance*: the bot identity cannot push to `main`; the trust rule has a
fixture test (issues by other authors, and labels applied by other actors, are
excluded).

### N1 — nightly skills — in progress

`nightly-e2e`, `nightly-next`, `nightly-report`, and the selector they share.
Originally they were to be run by hand before the bot existed. B1 landed first,
so they are exercised through `host bot dispatch` instead.

*Acceptance*: a seeded E2E failure is filed once and commented on the second
run, not filed twice; `nightly-next` picks the right rung on seeded GitHub
states; a Run that would need input ends with `nightly:blocked` instead.

### N2 — unattended (dispatcher B0 + B1) — not started

The nightly bot config with the §4.1 schedule and the first-night checklist
(#742). B0 prerequisites (idempotency replay, owner-id form) and the Run
deadline (§4.3) are done.

*Acceptance*: seven consecutive nights with no double fires, every Run
attributable to the bot, nothing running after 06:00, a report every morning.
#742 closes after the first three; N2 closes after seven.

### N3 — docs → proposals (§6)

*Acceptance*: proposals are drafted only from documents with a roadmap section;
nothing labeled `nightly:proposed` is implemented without the `nightly:ready`
relabel.

### N4 — reactive (dispatcher B2) — not filed

A failed nightly Run triggers a triage/escalation Run that lands in the morning
report; `maxChainDepth` stays at 2.

### N5 — optional brain (dispatcher B3) — not filed

The brain answers questions on the bot's own Runs from an allowlist (`skip`,
`abort`). Prioritization stays in the skill.

## 9. Metrics and open decisions

Tracked per night: PRs merged as-is / revised / closed, reverts, E2E flake rate,
duplicate issues filed, Runs stopped by deadline.

**Open — auto-merge.** Off in v1. Criterion for revisiting: after N nights with
a high merge-as-is rate and no reverts, allow auto-merge only for `origin:e2e`
fixes with green checks.

**Open — host lifecycle.** Whether the host processes run only in the window
(started by a system timer) or the host is always on and only the bot schedule
is windowed. Always-on is simpler; windowed relies on Run durability across
restarts.

## 10. Revision history

### 2026-09-26 — identity named

Nightly identity is `mercury-nightly` (classic PAT, see §5.2); `main-protection`
requires one approving review. N0 has no remaining owner steps.

### 2026-09-26 — status and stages

Added §8.1 (status) and §8.2 (stages). §4.3 now describes the shipped
`notAfter` (#731) instead of a prerequisite. §5.3 records the `main-protection`
ruleset and its missing approval requirement. §5.6 notes that the per-hour
dispatch cap is not in the B1 config. N1 is no longer "run by hand", since B1
landed first, and the launchd stopgap is replaced by the bot config (#742).

### 2026-09-23 — initial roadmap

First draft, derived from `dispatcher-bot-design.md` §18.

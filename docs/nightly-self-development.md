# Nightly self-development — Mercury working on Mercury

Status: **roadmap; nothing is implemented.** This document specifies how a
Mercury host, driven by a dispatcher bot (`dispatcher-bot-design.md`), works on
the `aywengo/mercury` repository unattended between 00:00 and 06:00 local time.
No skill, bot config or label described here exists yet.

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

### 4.2 The ladder

Each `nightly-next` Run evaluates, in order, and takes the first rung with work:

1. **Trusted bugs** — `origin:e2e` issues and `nightly:ready` issues, by
   priority label then age.
2. **New @aywengo issues** — authored by @aywengo, not yet labeled.
3. **Docs → proposals** — §6.

Selection runs in the skill as code against the GitHub API. The chosen issue is
labeled `nightly:in-progress` before work starts, so a concurrent or retried Run
does not take it twice.

### 4.3 The window ends at 06:00

- The last `nightly-next` fire is 04:40.
- Every nightly Run carries a deadline that ends it before 06:00. **If Runs
  have no deadline constraint today, adding one is a server prerequisite of
  N2** — the bot never cancels Runs on shutdown.
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
   by @aywengo, filed by the bot from E2E, or labeled `nightly:ready` by
   @aywengo. Checked from the API's author and label-event actor fields, never
   by the agent reading issue text.
2. **Bot identity.** A GitHub App or machine user with fine-grained permissions
   on `aywengo/mercury` only: issues, pull requests, contents on branches.
3. **Branch protection.** `main` requires review and green checks; the bot
   cannot push to it.
4. **Pinned host.** The nightly host runs a released `@aywengo/mercury`
   version, upgraded deliberately by a human. Work happens in Run workspaces,
   never in the installation.
5. **Credentials.** The GitHub token reaches Runs through the harness
   environment, never through task text, argv or events.
6. **Budgets.** Maximum PRs per night, token budget per night, and the
   dispatcher's `maxDispatchesPerHour`.
7. **Fail-closed capabilities.** Crew #721 (fail-closed capability checks) is
   closed before anything runs unattended.

### 5.1 Labels

`nightly:ready`, `nightly:in-progress`, `nightly:blocked`, `nightly:proposed`,
`origin:e2e`.

## 6. Docs → features, gated

The rung where an autonomous loop is most likely to drift gets a human gate.
Nightly reads the docs (via Atlas, as dogfooding), finds the next
unimplemented item in a document's roadmap section, and **only drafts the issue
set**, labeled `nightly:proposed` — the same pattern as
`atlas-phase-5-6-issues.md`. Implementation starts on a later night, after
@aywengo relabels an item `nightly:ready`. One night of latency buys a human
decision on *what* gets built.

## 7. Skills

- **`nightly-e2e`** — `npm run test:e2e` (the host needs Docker). Reruns each
  failure once to separate flakes from defects. Fingerprints each real failure
  (test name + normalized assertion/error), searches issues for the
  fingerprint, comments on a match or files a new `origin:e2e` issue. Flakes
  are reported, not filed, until they recur on N nights.
- **`nightly-next`** — the ladder (§4.2), then the issue-fix-loop for the
  chosen issue.
- **`nightly-report`** — one digest: PRs opened, issues filed or updated,
  blocked items with their questions, Runs stopped by deadline, budget used.

Role presets (Crew Milestone A): tester, fixer, planner.

## 8. Roadmap

The issue set for N0, N1 and dispatcher B0–B1 is [`nightly-issues.md`](nightly-issues.md).

### N0 — guardrails (no bot code)

Bot identity, branch protection, labels, trust rule written down, pinned host
version, budgets decided.

*Acceptance*: the bot identity cannot push to `main`; the trust rule has a
fixture test (issues by other authors, and labels applied by other actors, are
excluded).

### N1 — skills run by hand (parallel with dispatcher B0)

`nightly-e2e`, `nightly-next`, `nightly-report` written and run through
`mercuryctl runs create --file`, like B0's `workspace-audit`.

*Acceptance*: a seeded E2E failure is filed once and commented on the second
run, not filed twice; `nightly-next` picks the right rung on seeded GitHub
states; a Run that would need input ends with `nightly:blocked` instead.

### N2 — unattended (dispatcher B0 + B1)

Bot config with the §4.1 schedule; B0 prerequisites (idempotency replay,
owner-id form) plus the Run deadline (§4.3).

*Acceptance*: seven consecutive nights with no double fires, every Run
attributable to the bot, nothing running after 06:00, a report every morning.

### N3 — docs → proposals (§6)

*Acceptance*: proposals are drafted only from documents with a roadmap section;
nothing labeled `nightly:proposed` is implemented without the `nightly:ready`
relabel.

### N4 — reactive (dispatcher B2)

A failed nightly Run triggers a triage/escalation Run that lands in the morning
report; `maxChainDepth` stays at 2.

### N5 — optional brain (dispatcher B3)

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

### 2026-09-23 — initial roadmap

First draft, derived from `dispatcher-bot-design.md` §18.

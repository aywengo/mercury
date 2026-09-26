# Nightly self-development — issue set (N0, B0, B1, N1)

Drafted 2026-09-23 against `main` at `2d7e8e6`. It covers what has to exist before
[`nightly-self-development.md`](nightly-self-development.md) can run: the N0 guardrails, dispatcher
milestones B0 and B1 of [`dispatcher-bot-design.md`](dispatcher-bot-design.md), and the N1 nightly
skills. The format follows the `issue-fix-loop` contract used by
[`crew-milestone-a-followups.md`](crew-milestone-a-followups.md): each issue gives the mechanism with
file evidence, the fix, acceptance criteria and likely files, and ships as one PR. Filed 2026-09-23 as #727–#742; each heading below carries its number.

## Summary

Two findings from checking the tree change the dispatcher design's B0:

- **Idempotency replay already exists.** `RunService.create` returns the existing Run when the
  `(owner, key)` pair repeats (`src/runs/runService.ts:171`), and the route answers 201 with the same
  `runId` (`src/api/routes.ts:309`). `mercuryctl runs create --idempotency-key` passes it through
  (`client/cli.ts:494`). B0 only needs a contract test that pins it (B0-2), not a server feature.
- **The owner-id form `bot:<alias>` does not survive the token parser.** `parseTokens` in
  `src/config.ts` does `pair.split(':')` and destructures two elements, so `tok-x:bot:maint` becomes
  owner `bot`. Every bot on a host would silently share one owner. See B0-1.

One gap is new, not from the dispatcher design: `maxDurationMs` is measured from when the worker starts
driving the Run (`src/worker/worker.ts:603`, `startedMs`), not from creation. Time spent queued does not
count, so a Run queued at 04:40 behind another can start at 05:30 and run past 06:00. See B0-3.

Deferred on purpose, because nothing in this set needs them: `statusChangedAt` on the list endpoint
(needed by B2 triggers, N4), and the `reason` field on input events (needed by the B3 brain, N5).

External blockers, already filed: **#721** (fail-closed capability checks, Crew AC 7) and **#722**
(resume parity, Crew AC 8). Nothing runs unattended until both are closed.

## Dependency order

```
N0-1 branch protection + bot identity ─┐
N0-2 nightly labels + triage doc ──────┤
#721, #722 (Crew) ─────────────────────┼──► N1-5 launchd stopgap ──► first unattended night
N1-1 selection helper ──► N1-2, N1-3 ──┤
N1-4 report ───────────────────────────┘
B0-3 notAfter ─────────────────────────────► N1-5 (Runs must stop by 06:00)

B0-1 owner-id ─┐
B0-2 replay ───┤
B0-4 cron ─────┼──► B0-5 config + validate ──► B1-1 scheduler ──► B1-2 dispatch/status
B0-6 audit ────┘                                                └──► B1-3 service ──► retire N1-5
```

The left column gets Mercury working on itself; the right column replaces the stopgap with the bot.

---

## N0-1 (#727) — Protect `main` and give the nightly host its own GitHub identity

**Labels:** `security`, `deployment`, `priority: high`
**Blocked by:** —

### Mechanism

`GET repos/aywengo/mercury/branches/main/protection` answers 404 (branch not protected). Anything with
a write token can push to `main`, including a nightly agent.

### Fix

- Branch protection on `main`: pull request required, CI (`.github/workflows/ci.yml`) required green,
  no force-push. Keep direct doc commits possible for @aywengo only (bypass list), matching the current
  habit of committing docs to `main`.
- A GitHub App or machine user for the nightly host, fine-grained to `aywengo/mercury`: issues
  read/write, pull requests read/write, contents read/write. Not on the bypass list.
- Record in `docs/operations.md`: the identity, its scopes, where the token lives on the host (harness
  environment only, never task text), and that the host runs a released `@aywengo/mercury` version,
  upgraded by hand.

### Acceptance

1. A push to `main` with the bot token is rejected; a PR from the bot token opens.
2. `docs/operations.md` names the identity and scopes and states the pinned-version rule.

### Likely files

GitHub settings; `docs/operations.md`.

---

## N0-2 (#728) — Nightly labels and the trust rule in the triage doc

**Labels:** `documentation`, `priority: medium`
**Blocked by:** —

### Mechanism

None of `nightly:ready`, `nightly:in-progress`, `nightly:blocked`, `nightly:proposed`, `origin:e2e`
exist (`gh label list`). `docs/issue-triage.md` has no notion of which issues an unattended agent may
take.

### Fix

- Create the five labels.
- Add a "Nightly" section to `docs/issue-triage.md`: label meanings, and the trust rule from
  `nightly-self-development.md` §5 — an issue is workable only if authored by @aywengo, filed by the bot
  with `origin:e2e`, or labeled `nightly:ready` by @aywengo. The rule is enforced by N1-1, never by an
  agent reading issue text.

### Acceptance

1. Labels exist.
2. `issue-triage.md` states the rule and points to N1-1 as its enforcement.

### Likely files

`docs/issue-triage.md`.

---

## B0-1 (#729) — `parseTokens` truncates owners containing `:`; settle the bot owner-id form

**Labels:** `bug`, `security`, `priority: high`
**Blocked by:** —

### Mechanism

`src/config.ts` `parseTokens`: `const [token, owner] = pair.split(':')`. An entry with more than one
colon keeps only the second segment as owner, with no warning. `tok-a:bot:maint` and `tok-b:bot:coord`
both map to owner `bot`, so two bots, and anything else configured this way, share one owner scope:
each sees and can cancel the other's Runs. This is independent of bots, since any owner string with a
colon is affected.

### Fix

- `parseTokens` fails loudly on an entry that does not have exactly one `:`, naming the entry's
  position, never the token. Silent truncation of an authorization mapping is the defect; the fix is to
  refuse, not to split on the first colon, so that the env format stays unambiguous.
- Bot owner ids are `bot-<alias>`. Update `dispatcher-bot-design.md` §4.2 to record the decision, and
  replace `bot:<alias>` throughout that document.

### Acceptance

1. `MERCURY_API_TOKENS="t1:a:b"` makes config loading fail with an error that names entry 1 and does
   not contain `t1`.
2. Existing single-colon configs parse unchanged.
3. Regression test fails on base.

### Likely files

`src/config.ts`, `test/config.test.ts`, `docs/dispatcher-bot-design.md`, `docs/configuration.md`.

---

## B0-2 (#730) — Pin idempotency replay over HTTP

**Labels:** `testing`, `priority: medium`
**Blocked by:** —

### Mechanism

Replay exists (`runService.ts:171`, `:565` for the concurrent insert race), and `test/runService.test.ts`
covers it in-process. The HTTP route (`routes.ts:309`) is the seam the bot uses, and the #539/#680
lesson is that in-process tests cannot see route seams.

### Fix

Contract test against the real server: same owner and key twice → same `runId`, 201 both times, one Run
in the list; same key under a different owner → two Runs; the header absent → no dedupe. Record in
`dispatcher-bot-design.md` §5.2 that the prerequisite is met and which test pins it.

### Acceptance

The test fails if the route stops forwarding the header (mutation: drop `idempotencyKey` from the
route's create call).

### Likely files

`test/api*.test.ts` (follow the nearest route-contract test), `docs/dispatcher-bot-design.md`.

---

## B0-3 (#731) — `constraints.notAfter`: an absolute deadline that counts queue time

**Labels:** `enhancement`, `priority: high`
**Blocked by:** —

### Mechanism

`maxDurationMs` is enforced from `startedMs` (`src/worker/worker.ts:603`, `:642`): the clock starts when
the worker begins driving the Run. A Run's time in QUEUED is unbounded. The nightly window
(`nightly-self-development.md` §4.3) needs "must be finished by 06:00", which no existing constraint can
express.

### Fix

- Optional `constraints.notAfter` (ISO-8601 timestamp), validated in `validateConstraints` (must parse,
  must be in the future at creation).
- Claim time: a Run past `notAfter` is not driven; it goes terminal with a distinct reason
  (`deadline passed before start`).
- Drive loop: effective deadline = min(`startedMs + maxDurationMs`, `notAfter`), through the same
  timeout path as today.
- Retries inherit `notAfter` unchanged, so a retry cannot extend the window.
- `mercuryctl runs create --not-after`, and the field in `docs/api.md`.

### Acceptance

1. A Run created with `notAfter` in 2 s and held in the queue for 3 s never starts and records the
   reason.
2. A Run that starts in time is stopped at `notAfter` even when `maxDurationMs` would allow more.
3. Runs without `notAfter` behave byte-identically (existing worker tests unchanged).
4. Mutation: using `startedMs` alone for the deadline fails test 2.

### Likely files

`src/domain/types.ts`, `src/runs/runService.ts` (validation), `src/worker/worker.ts`, `client/cli.ts`,
`docs/api.md`, worker tests.

---

## B0-4 (#732) — Hand-rolled cron evaluator and derived idempotency keys

**Labels:** `enhancement`, `priority: medium`
**Blocked by:** —

### Mechanism

New code per `dispatcher-bot-design.md` §5.1–§5.2 and §16 (hand-rolled parser decided). Nothing exists
under `src/host/bots/`.

### Fix

- `src/host/bots/cron.ts`: 5-field parser; `due(cron, lastFired, now, tz)`; `tz` is `UTC` (default),
  `local`, or a fixed offset.
- `src/host/bots/keys.ts`: `bot-<alias>:<task>:<scheduled-minute-iso>` (owner form from B0-1).

### Acceptance

The design's §15.1 cron set on a fixed clock, including a 02:30 `tz: local` task firing exactly once on
spring-forward and fall-back days (DST-adjacent cases run with `TZ=Europe/Warsaw`), and keys stable across
process restarts. If DST handling passes ~150 lines, stop and revisit the §16 decision.

### Likely files

`src/host/bots/cron.ts`, `src/host/bots/keys.ts`, `test/botCron.test.ts`.

---

## B0-5 (#733) — Bot config schema, credentials file and `host bot validate`

**Labels:** `enhancement`, `cli`, `priority: medium`
**Blocked by:** B0-1, B0-4

### Fix

Per `dispatcher-bot-design.md` §4.1, §4.2, §12:

- per-alias JSON config under `${XDG_CONFIG_HOME}/mercury/bots/`, alias regex, unknown-key refusal with
  a suggestion, the `run` + `singleFlight` warning;
- `bot-credentials.json` 0600 check (same shape as `client/credentials.ts`) and the two-copy agreement
  check against `MERCURY_API_TOKENS`;
- `mercury host bot validate --alias <a>`, offline;
- coupling test for `src/host/bots/` (API surface only; redactor as the documented exception).

B1 does not use `brain` or `triggers`. The schema accepts them only as reserved keys, rejected with
"not supported before B2/B3", so a config cannot claim behaviour that does not exist.

### Acceptance

The fixture set of malformed configs is rejected, each with a named field; a group-readable credentials
file is refused; drifted token copies are reported.

### Likely files

`src/host/bots/config.ts`, `src/host/bots/credentials.ts`, `src/cli.ts`, `test/botConfig.test.ts`,
coupling test.

---

## B0-6 (#734) — `workspace-audit` skill, run by hand

**Labels:** `enhancement`, `priority: low`
**Blocked by:** —

As specified in `dispatcher-bot-design.md` §18 B0: written, and run through
`mercuryctl runs create --file`, before the scheduler exists. It validates the `template` surface on a
real task.

### Acceptance

A hand-dispatched Run completes and reports workspaces older than the retention window on a seeded host.

### Likely files

`.agents/skills/workspace-audit/SKILL.md`, a template JSON under `docs/` or `deploy/`.

---

## B1-1 (#735) — `host bot run`: the scheduler process

**Labels:** `enhancement`, `priority: high`
**Blocked by:** B0-2, B0-5

### Fix

Per `dispatcher-bot-design.md` §5 and §10: one timer per process; dispatch via loopback
`POST /api/runs` with the derived key; `constraints.botTask`; `singleFlight` as "no Run of this task in
a non-terminal status" (deny-list of terminal statuses); `onMiss` skip/collapse/run keyed to the missed
scheduled minute; state file written after dispatch; `/healthz` probe with capped backoff; SIGINT/SIGTERM
exit 0 without cancelling anything. Template fields may use `{{fire.date}}`/`{{fire.time}}` and a
`notAfterAt: "HH:MM"` helper resolved to `constraints.notAfter` on the fire's date (B0-3).

### Acceptance

Subprocess tests against the real test server on a fake clock: 100 fires produce exactly the Runs the
policy allows; a task whose Run sits in NEEDS_INPUT does not fire again; a restart mid-cycle does not
double-dispatch; mutations from §15.5 (key input, non-terminal set) are caught.

### Likely files

`src/host/bots/scheduler.ts`, `src/host/bots/process.ts`, `src/cli.ts`, `test/botScheduler.test.ts`.

---

## B1-2 (#736) — `host bot dispatch` and `host bot status`

**Labels:** `enhancement`, `cli`, `priority: medium`
**Blocked by:** B1-1

Manual fire (`--yes`, `--dry-run`) and status (next fires, last actions, dispatches in the last hour
counted from the API).

---

## B1-3 (#737) — Per-alias service install/uninstall

**Labels:** `enhancement`, `deployment`, `priority: medium`
**Blocked by:** B1-1

systemd user unit / launchd plist through the machinery `host service install` already uses. Uninstall
prints the §17.7 consequence and offers `--reassign-runs <owner>`. Landing this retires N1-5.

---

## N1-1 (#738) — Deterministic ladder selection and trust check

**Labels:** `enhancement`, `security`, `priority: high`
**Blocked by:** N0-2

### Mechanism

The ladder (`nightly-self-development.md` §4.2) and the trust rule (§5) must be decided by code from
GitHub metadata. An agent reading issue bodies to decide what to work on is the injection surface the
rule exists to close.

### Fix

A small script shipped with the skills (`.agents/skills/nightly/select.ts`, no dependencies, `gh api` or
`fetch` with the harness token) that outputs one JSON decision:
`{ rung, issue, reason }` or `{ rung: "none" }`. Status (N1-1, issue #738,
2026-09-26): shipped and merged (PR #762) — the selector decides from GitHub
metadata only (author, labels, timeline label actors), implements the
§4.2 ladder with the e2e-terminal gate (paged, fail-closed), claims the chosen
issue with `nightly:in-progress` before returning (422-already-exists = a
racer won: re-select), and is pinned by `test/nightlySelect.test.ts`
(21 tests).

- Trust: author login, and for `nightly:ready` the actor of the labeling event from the issue timeline.
- Excludes `nightly:in-progress`, `nightly:blocked` and `nightly:proposed`.
- Claims the chosen issue by adding `nightly:in-progress` before returning it; if the label is already
  there on re-read, it picks again.
- Rung 1 waits until tonight's `nightly-e2e` Run is terminal (queried from the host API with the same
  token the Run was created with).

### Acceptance

Fixture tests on recorded timeline JSON: an issue by another author is never chosen; a `nightly:ready`
label applied by another actor is ignored; the priority and age order holds; the claim is visible before
return.

### Likely files

`.agents/skills/nightly/select.ts`, `test/nightlySelect.test.ts`, fixtures.

---

## N1-2 (#739) — `nightly-e2e` skill

**Labels:** `enhancement`, `testing`, `priority: high`
**Blocked by:** N1-1

`npm run test:e2e`; rerun each failure once; fingerprint real failures (test name + normalized error,
volatile ids and paths stripped); comment on the issue carrying the fingerprint, or file a new
`origin:e2e` issue with the fingerprint in a hidden marker. Flakes are listed in the report, and filed
only when the same fingerprint flakes on three nights.

### Acceptance

A seeded failure is filed once, then commented on (not re-filed) on the second run; a failure that
passes on rerun is not filed.

---

## N1-3 (#740) — `nightly-next` skill

**Labels:** `enhancement`, `priority: high`
**Blocked by:** N1-1, #721, #722

Runs N1-1, then the `issue-fix-loop` procedure for the chosen issue: one PR, independent review. Rung 3
drafts issues labeled `nightly:proposed` and never implements (`nightly-self-development.md` §6).

**Never asks.** When in doubt it stops, labels the issue `nightly:blocked`, puts the question in an
issue comment and finishes. It removes `nightly:in-progress` on every exit path.

### Acceptance

On a seeded repo: bug → PR; a blocked case → `nightly:blocked` plus a comment, and the Run ends
without entering NEEDS_INPUT; `rung: none` → the Run ends without changes.

---

## N1-4 (#741) — `nightly-report` skill

**Labels:** `enhancement`, `priority: medium`
**Blocked by:** —

One digest per night: PRs opened, issues filed or commented, blocked items with their questions, Runs
stopped by `notAfter`, flakes. Delivered as a single GitHub issue per night (label `nightly:report`),
closed by the next night's report.

---

## N1-5 (#742) — launchd stopgap: nightly Runs before the bot exists

**Labels:** `deployment`, `priority: medium`
**Blocked by:** N0-1, N1-2, N1-3, N1-4, B0-3, #721

### Fix

`deploy/nightly/`: three Run templates and a launchd plist (plus a systemd timer equivalent) that call
`mercuryctl runs create --file <template> --idempotency-key nightly-<task>-<date>-<HHMM> --not-after
<date>T06:00` on the §4.1 schedule. This is deliberately thin, and retired by B1-3.

### Acceptance

Three consecutive nights: Runs fire on schedule, none runs past 06:00, a repeated fire in the same
minute creates no second Run, and a report issue exists each morning.

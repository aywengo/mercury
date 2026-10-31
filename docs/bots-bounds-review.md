# Dispatcher bots — the §14 security bounds review

This is the B4 deliverable named in issue #915: a walk of **every bound in
[`§12`](dispatcher-bot-design.md#12-configuration-reference-v1-surface) and
[`§14`](dispatcher-bot-design.md#14-security-model), and every mutation in
[`§15.5`](dispatcher-bot-design.md#15-testing-strategy)**, each with the named test that fails when
the bound is removed or weakened. It is a review, not a new layer: no code lives here.

A row is one of two things:

- **`test: <file> — <title>`** — a test in this repository that fails when the bound is removed.
  `test/botBoundsReview.test.ts` asserts the named test exists, so a rename cannot quietly drop the
  coverage; and for the configuration rows it also asserts the field's negative fixture is still in
  `test/botConfig.test.ts`.
- **`deferred: B<n> (#…)`** — the code this bound protects does not exist yet. The row lands with
  that milestone, and the checklist test refuses a `test:` claim for a deferred area, so the review
  cannot pretend the brain is tested before it is written.

B4 shipped the setup step, the doctor section and these docs. Event triggers and the read-only
observer scope are B2 (#907–#909); the LLM brain is B3 (#912). Rows that land with those milestones
say so explicitly.

## §12 — configuration surface

| ID | Bound | Coverage |
| --- | --- | --- |
| §12 `description` | human label; a non-string is refused | test: test/botConfig.test.ts — fixture set: each malformed config is refused with a named field |
| §12 `api.url` | http(s) URL only | test: test/botConfig.test.ts — fixture set: each malformed config is refused with a named field |
| §12 `api.timeoutMs` | positive integer | test: test/botConfig.test.ts — fixture set: each malformed config is refused with a named field |
| §12 `api.via` | `host` (default) or `fleet`; `fleet` requires a `fleet` token beside `api` in `bot-credentials.json` | test: test/botFleetClient.test.ts — config: api.via "fleet" without a Fleet token is refused at load, naming the alias (acceptance 5); test: test/botFleetClient.test.ts — config: api.via "fleet" loads with a Fleet token; unknown values and non-strings are refused |
| §12 `schedule.tasks[].name` | `[a-z0-9-]+`, unique per bot (colon would split the key) | test: test/botConfig.test.ts — fixture set: each malformed config is refused with a named field |
| §12 `schedule.tasks[].cron` | parsed at validate time, not at 03:00 | test: test/botCron.test.ts — parseCron rejects malformed expressions, naming the field; test: test/botConfig.test.ts — fixture set: each malformed config is refused with a named field |
| §12 `schedule.tasks[].tz` | UTC, local or a fixed offset; DST-adjacent fires once | test: test/botCron.test.ts — tz: local — a 02:30 daily task fires exactly once on spring-forward (TZ=Europe/Warsaw); test: test/botConfig.test.ts — fixture set: each malformed config is refused with a named field |
| §12 `schedule.tasks[].template` | a JSON object with non-empty `task` | test: test/botConfig.test.ts — fixture set: each malformed config is refused with a named field |
| §12 `schedule.tasks[].singleFlight` | boolean; default true | test: test/botConfig.test.ts — fixture set: each malformed config is refused with a named field |
| §12 `schedule.tasks[].onMiss` | skip, collapse or run | test: test/botConfig.test.ts — fixture set: each malformed config is refused with a named field |
| §12 `schedule.tasks[].maxCatchUp` | non-negative integer; 0 means no catch-up | test: test/botScheduler.test.ts — maxCatchUp: 0 means NO catch-up fires (slice(-0) guard, round-5 review) |
| §12 `triggers[].on` | declarative matchers | deferred: B2 (#907–#909) |
| §12 `triggers[].on.inStatusLongerThanMs` | matches status age, not creation age | deferred: B2 (#907–#909) |
| §12 `triggers[].pollMs` | floor 5000, coalesced per bot | deferred: B2 (#907–#909) |
| §12 `triggers[].includeBotRuns` | default false: bot Runs are not matched | deferred: B2 (#907–#909) |
| §12 `triggers[].maxChainDepth` | chain-depth refusal at the cap | deferred: B2 (#907–#909) |
| §12 `triggers[].cooldownMs` | per-match-key cooldown | deferred: B2 (#907–#909) |
| §12 `triggers[].triggerCooldownMs` | per-trigger cooldown | deferred: B2 (#907–#909) |
| §12 `triggers[].action` | dispatch only in v1 | deferred: B2 (#907–#909) |
| §12 `brain.*` | absent = deterministic bot | deferred: B3 (#912) |
| §12 `brain.shareTaskText` | default false; limits the injection surface | deferred: B3 (#912) |
| §12 `brain.tokenBudgetPerCycle` | checked before the call | deferred: B3 (#912) |
| §12 `brain.maxResponseBytes` | 64 KiB response cap | deferred: B3 (#912) |
| §12 `brain.maxDispatchesPerHour` | counted from the API, not local state | deferred: B3 (#912) |
| §12 `brain.answers` | allowlist of answers, own Runs only | deferred: B3 (#912) |
| §12 `schedule.tasks[].select.*` | shape validated, then refused until L1 (#826) | test: test/botConfig.test.ts — select: a WELL-FORMED block is refused with the reserved message (#826, fails on base) |

## §14 — security model

| ID | Bound | Coverage |
| --- | --- | --- |
| §14-1 | Redact before egress; a redaction failure aborts the cycle (§8.3 step 2) | deferred: B3 (#912) |
| §14-2 | Closed vocabulary, payload included: the LLM picks declared templates and declared answers, never invents them (§8.3 steps 4–5) | deferred: B3 (#912) |
| §14-3 | No cross-owner writes, at all; the observer scope is read-only with no exception (§9) | deferred: B2 (#907–#909) |
| §14-4 | Untrusted context: labelled wrapping, field caps, provenance (§8.5) | deferred: B3 (#912) |
| §14-5 | Least visibility: own-Runs by default; observer is a deliberate token-form change; admin is never set up by the wizard | test: test/botSetup.test.ts — wizard: the observer posture is refused with the §8.5 sentence and writes nothing; test: test/botDoctor.test.ts — seeded defect: a token registered under another owner fails, naming both owners |
| §14-6 | Bounded spend: token budget before the call, 64 KiB cap, dispatch cap from the API, probe costs stated | deferred: B3 (#912) |
| §14-7 | Credential handling: two deliberate copies, both 0600, neither in argv, logs, prompts or events | test: test/botDoctor.test.ts — a group-readable mercury.env fails the section (§4.2: it holds tokens); test: test/botSetup.test.ts — wizard: --non-interactive writes the bot config, both token copies, and never prints the token; test: test/botService.test.ts — removeBotTokenFromEnv refuses malformed entries by index without echoing the token |
| §14-8 | No persistence of LLM traffic by default (debug-level, bot log only) | deferred: B3 (#912) |
| §14-9 | Fail-closed on every boundary: unreachable API, unreachable LLM, malformed output | test: test/botScheduler.test.ts — a listOwnRuns failure refuses singleFlight dispatch but not singleFlight:false tasks; test: test/botDoctor.test.ts — an unreachable API is a fail-closed status line |

## §15.5 — mutation discipline

Each mutation is applied by hand to the shipped code and must be caught by the named test. Two
mutations are provable today; the other four protect code that lands with B2/B3.

| ID | Mutation | Coverage |
| --- | --- | --- |
| §15.5 M1 | idempotency-key derivation: change the key input (scheduled minute → discovery minute) | test: test/botScheduler.test.ts — onMiss collapse fires once keyed to the newest MISSED scheduled minute; test: test/botScheduler.test.ts — onMiss run fires once per missed interval capped at maxCatchUp (default 3) |
| §15.5 M2 | `maxDispatchesPerHour` cap: delete the check | deferred: B3 (#912) |
| §15.5 M3 | redact-before-egress call: reorder redact after serialize | deferred: B3 (#912) |
| §15.5 M4 | answer allowlist: widen it to any string | deferred: B3 (#912) |
| §15.5 M5 | own-Run check on `input` actions: drop the ownership check | deferred: B3 (#912) |
| §15.5 M6 | non-terminal `singleFlight` check: narrow the status set back to QUEUED\|RUNNING | test: test/botScheduler.test.ts — singleFlight skips NEEDS_INPUT (and every non-terminal status), dispatches on terminal (§5.3) |

### Mutation evidence (2026-10-24, tree at the B4 branch)

- **M1** — `dispatchKey(cfg.alias, taskName, fire.fireMs, …)` changed to `opts.nowMs`: four tests
  failed, including *onMiss collapse fires once keyed to the newest MISSED scheduled minute* and
  *onMiss run fires once per missed interval capped at maxCatchUp (default 3)*.
- **M6** — `runIsNonTerminal` narrowed to `QUEUED || RUNNING`: four tests failed, including
  *singleFlight skips NEEDS_INPUT (and every non-terminal status), dispatches on terminal (§5.3)*
  and *singleFlight through the real server: a Run parked in NEEDS_INPUT blocks the next fire*.

Both mutations were reverted before the branch was committed. The suite was green afterwards.

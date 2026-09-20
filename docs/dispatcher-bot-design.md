# Dispatcher bots — host-resident scheduled and coordinated agents

Status: **design; nothing is implemented.** This document specifies the feature and
its roadmap. No command, config file or code described here exists yet; §17 records
what a reader can treat as runnable today (nothing) so intent is never mistaken for
shipped behaviour.

## 1. Summary

A dispatcher bot is an optional host-resident process that creates and coordinates
Mercury Runs on the host it lives on. Every bot has:

- an **alias** — its identity on the host (`maint`, `coord`, ...);
- its **own configured connection to an LLM** — optional per bot, used for
  coordination decisions, never for executing work itself;
- its own **scheduled tasks** — cron-style dispatch of Run templates for
  maintenance (nightly GC audits, workspace sweeps, health summaries) and for
  coordination and communication among the harnesses on the host (relaying
  between a stuck PrimeAgent Run and a Hermes Run, answering pending inputs,
  escalating failures).

The one architectural decision this document makes, and everything else follows
from it:

> A bot is a **client** of its host's Mercury API — the same public HTTP API the
> dashboard and `mercuryctl` use — never a new execution path. The bot creates
> Runs, submits input and reads state over loopback with its own token. The
> worker executes; the bot only decides.

This keeps every property Mercury already guarantees intact: Runs a bot creates
are durable, queued, leased, owner-scoped and event-recorded exactly like Runs a
human creates. The bot adds **when** and **why**, not **how**.

```mermaid
flowchart LR
    subgraph host [One host]
        S[MercuryServer] --> DB[(SQLite)]
        W[MercuryWorker] --> DB
        W --> H1[primeagent]
        W --> H2[hermes]
        subgraph botp [Bot process (one per alias)]
            SCH[Scheduler] --> ACT[ActionPlanner]
            TRG[TriggerWatcher] --> ACT
            LLM[LLMConnection] --> ACT
        end
    end
    botp -->|"loopback HTTP + bearer"| S
```

## 2. Goals

1. A host operator can define a bot by alias with its own schedule, task
   templates and (optionally) LLM credentials, and the bot runs unattended.
2. Scheduled dispatch is deterministic: same config, same clock, same actions —
   the LLM is never required for a scheduled task to fire.
3. A bot can react to host activity (failures, pending inputs) with bounded,
   declarative triggers.
4. An LLM-connected bot can decide *which* declared action to take, but can
   never invent a new kind of action.
5. Every Run a bot creates is an ordinary Run: visible, owner-scoped,
   cancelable, event-recorded, attributable to the bot.
6. No credential ever reaches argv, logs, the Run event stream or an LLM prompt.
7. A broken bot degrades to silence (skipped cycles, logged reasons), never to
   wrong actions: fail-closed everywhere.

## 3. Non-goals

- **Not** a new agent backend or adapter. Bots do not execute agent work; the
  worker and its adapters do (`src/adapters/` stays the only execution path).
- **Not** Fleet. A bot sees and acts on exactly one host. Cross-host routing
  stays Fleet's job (`fleet-design.md`); a bot must not blur that boundary.
- **Not** a chat interface. Communication with operators happens through Runs,
  input answers and events — the surfaces that already exist.
- **Not** a general agent framework. The bot's LLM gets a closed action
  vocabulary (§8), not tools, not shell, not free-form file writes.
- **Not** a second event-delivery mechanism. Polling stays the correctness
  mechanism (`cross-process-event-push.md` §1); the bot polls, it does not
  invent a new stream.
- **Not** a scheduler for arbitrary shell jobs. Every task dispatches a
  Mercury Run; system-level cron remains the tool for anything else.

## 4. Identity, aliases and credentials

### 4.1 One file per bot

Bot definitions live in one JSON file per bot:

```text
${XDG_CONFIG_HOME:-~/.config}/mercury/bots/<alias>.json
```

This mirrors the remote-agent registry (`src/adapters/remoteAgentRegistry.ts`):
directory of validated JSON configs, one file per entity, load-all at start,
refuse the whole directory on an invalid file rather than silently skipping one
bot. The alias **is** the file name (minus `.json`), validated as
`^[a-z][a-z0-9-]{0,31}$` — it appears in process titles, log lines, the owner id
and unit names, so it must be filesystem- and systemd-safe.

```json
{
  "description": "nightly maintenance + harness coordination",
  "api": { "url": "http://127.0.0.1:3000", "timeoutMs": 30000 },
  "schedule": {
    "tasks": [
      {
        "name": "nightly-gc-audit",
        "cron": "17 3 * * *",
        "template": {
          "task": "Audit workspace GC retention; report anything older than the retention window",
          "agent": "hermes",
          "skills": ["workspace-audit"]
        },
        "singleFlight": true,
        "onMiss": "skip"
      }
    ]
  },
  "triggers": [
    {
      "name": "failed-hermes",
      "on": { "runStatus": "FAILED", "agent": "hermes" },
      "pollMs": 30000,
      "action": { "dispatch": "triage-failed-run" }
    }
  ],
  "brain": {
    "provider": "openai-compatible",
    "url": "https://llm.example.internal/v1",
    "model": "planner-small",
    "cycleSeconds": 300,
    "tokenBudgetPerCycle": 4000,
    "maxDispatchesPerHour": 6
  }
}
```

### 4.2 The bot's API token

Each bot gets its own API token, stored in the host's credential file — never in
`<alias>.json`, never in `mercury.env`, never in argv:

```text
${XDG_CONFIG_HOME:-~/.config}/mercury/bot-credentials.json
{
  "maint": "tok-bot-maint-..."
}
```

- The file must be 0600; a group- or world-readable file is refused where
  permissions can be checked, exactly like `client/credentials.ts` refuses them.
- The token is registered in `MERCURY_API_TOKENS` as `tok-bot-maint-...:bot:maint`,
  giving the bot `ownerId = bot:maint`. Owner-scoping then works unchanged:
  the bot sees its own Runs; everything else is invisible unless §9's observer
  scope is granted.
- The host redactor already redacts `MERCURY_*` values in events; bot tokens
  follow the same `tok-` shape the redactor and API already handle. A bot token
  must never appear in a dispatched Run's task text or input.

### 4.3 Attribution

Every Run a bot creates is attributable: `ownerId = bot:<alias>`, and the create
request tags `constraints.createdBy = "bot:<alias>"` so an operator reading
`runs show` or the dashboard sees machine origin without a schema change to
`run`. (If a `createdBy` field proves unnecessary because the owner column
already answers it, record that decision in §17 rather than adding a field.)

## 5. Scheduled tasks

### 5.1 The scheduler is its own timer

One timer per bot process, driven by the scheduler — never piggybacked on the
worker's claim loop. This is the same rule the worker's stuck-run check and
backlog sampler already follow (`AGENTS.md`, `src/worker/worker.ts`): the claim
loop is blocked for the whole duration of a Run, so anything that must run
*while* Runs execute needs its own timer.

The timer ticks once per minute and computes due tasks from a **deterministic**
cron evaluation: `due(cron, lastFired, now)`. No drift accumulation, no
"seconds" field, no timezone database — schedules are evaluated in the host's
local time, and the config may specify `tz: "UTC"` explicitly (offset-only
handling; named-zone support is a deferred decision, §16).

### 5.2 Dispatch

Firing a task means: `POST /api/runs` with the task's template (the same request
model `mercuryctl runs create --file` accepts — task, repository, agent, skills,
constraints, goal), with an **idempotency key derived deterministically**:
`bot:<alias>:<task-name>:<scheduled-fire-iso-minute>`. A crash between dispatch
and recording cannot double-dispatch: a retry after the crash reuses the key,
and the server's idempotency path returns the original Run.

### 5.3 singleFlight and missed fires

- `singleFlight: true` (default): skip firing if a Run dispatched by this task
  name is still QUEUED or RUNNING. The bot knows its own Runs by owner + the
  `createdBy` tag; no cross-owner read is needed.
- `onMiss` decides what happens when the host was down at fire time and the bot
  starts late: `skip` (default — do nothing), `collapse` (fire once now), `run`
  (fire once per missed interval, capped at `maxCatchUp: 3`).
- `lastFired` state lives in a small state file per bot
  (`${XDG_STATE_HOME:-~/.local/state}/mercury/bots/<alias>.state.json`,
  0600), written **after** a successful dispatch. The state file is an
  optimisation for `onMiss` only; correctness of non-double-dispatch comes from
  the derived idempotency key, never from the file.

### 5.4 No LLM in this layer

A scheduled task fires or does not fire based on config and clock alone. An LLM
outage cannot stop maintenance from running. This is what makes §2 goal 2
testable: the whole scheduler is testable with a fake clock and a scripted
client, no LLM at all.

## 6. Event triggers

### 6.1 Declarative matchers, poll-based

A trigger watches host activity through the bot's own API visibility and fires a
declared action:

```json
{
  "name": "stuck-input",
  "on": { "runStatus": "NEEDS_INPUT", "agent": "primeagent", "olderThanMs": 60000 },
  "pollMs": 20000,
  "action": { "dispatch": "answer-or-escalate" }
}
```

Matching rules:

- `runStatus`, `agent`, `minDurationMs`, `olderThanMs` — all optional, all
  AND-ed. Matching is over fields the list endpoint already returns.
- The bot polls `GET /api/runs?status=...` on its own cadence per trigger. There
  is deliberately **no global event stream to subscribe to**: the server
  exposes per-Run SSE only, and `cross-process-event-push.md` established that
  polling is the correctness mechanism. If the host later enables the Stage-1
  wake-up socket, the bot *may* use it to wake early and then poll — latency
  optimisation, never a correctness dependency.
- **Cursor state**: the trigger records the newest `nextCursor`/timestamp it
  acted on, so a restarted bot does not re-fire on old events. Like `lastFired`,
  the cursor is an optimisation; the idempotency-key rule (§8.3) is the
  correctness backstop.

### 6.2 Trigger storms

A trigger that dispatches a Run whose own failure re-fires the trigger is a
loop. Guards, in order:

1. per-trigger `cooldownMs` (default 5 minutes) — no re-fire within the window
   for the same match key (run id + trigger name);
2. per-bot `maxDispatchesPerHour` hard cap (default 12) — enforced locally,
   counted in the state file;
3. a dispatched Run always carries `createdBy`, so an operator can see the chain
   `failed run → triage run` and cancel the bot if the chain is wrong.

## 7. The bot's activity is ordinary Runs

The bot does not get a side channel for its own "thoughts". When a bot decides
something worth recording that is not a Run dispatch (e.g. "answered input on
run-x because it asked Y"), it creates a small **note Run** on itself —
`task: "[bot:maint] answered input on run-x: <reason>"`, agent = the cheapest
configured harness, or no-op if notes are disabled for the bot. This keeps the
event stream the single audit trail. (A cheaper `bot.note` event type was
considered and rejected for v1: it adds an event vocabulary every consumer must
learn; a Run is already visible everywhere. Revisit if note-Runs prove noisy.)

## 8. The LLM connection

### 8.1 Optional per bot

`brain` is optional. A bot without one can schedule and trigger but not
"decide" — every action is the literal one in its config. This is the default
and the recommended posture; §2 goal 4 bounds what an LLM-connected bot can do.

### 8.2 Transport

One HTTP client, zero dependencies (the CLI's transport already proved
node:http is enough): `POST {url}/chat/completions` with a bearer header from
`bot-credentials.json` (`"llm": "<alias>-llm"` key, same 0600 file), a total
per-request deadline, a bounded response body (16 MiB, same bound as the client)
and no automatic retry (a planner call is not idempotent; a skipped cycle is
always safe).

### 8.3 The closed action vocabulary

Every coordination cycle:

1. **Gather** bounded context: the bot's own recent Runs, the Runs matching its
   triggers, pending inputs on watched Runs — each with hard size caps (N Runs,
   M events, K chars), each field already owned by the API.
2. **Redact**: the assembled context passes through the host redactor
   (`src/domain/redact.ts`) **before** it leaves the process. This is the
   property that makes an external LLM acceptable at all: the same redaction
   that guards the event stream guards the prompt. Redaction failures abort the
   cycle.
3. **Prompt** with the action schema: the LLM must answer with JSON
   `{"actions": [...]}` where each action is one of:
   - `{ "kind": "dispatch", "template": "<declared name>" }` — a template that
     exists in this bot's config;
   - `{ "kind": "input", "runId": "...", "value": "..." }` — answer a pending
     input on a Run the bot can see (see §9);
   - `{ "kind": "none", "reason": "..." }`.
4. **Validate fail-closed**: unknown kind, unknown template, malformed JSON,
   missing reason → the action is dropped and the cycle logs why. The LLM can
   choose among declared actions; it cannot create a new kind, cannot set
   arbitrary flags, cannot address a Run the bot cannot see.
5. **Enforce budgets**: per-cycle token budget (refuse to call if the last cycle
   exceeded it), `maxDispatchesPerHour` cap, per-action idempotency key
   `bot:<alias>:cycle:<cycle-id>:<action-index>`.

### 8.4 What the LLM never sees

- Credentials of any kind (the redactor's job, plus the prompt builder's
  allowlist of fields);
- Run task text is included **only** if `brain.shareTaskText: true` (default
  false) — task text is the field most likely to carry secrets a redactor
  pattern did not anticipate;
- Anything from another owner's Runs unless the observer scope (§9) is granted,
  and then only the same fields the API returns to any authenticated caller.

## 9. Visibility and the observer scope

A coordination bot's value is seeing harness activity, but harness Runs belong
to their own owners. Three postures, in increasing capability:

1. **Own-runs (default)**: the bot sees only `bot:<alias>` Runs. Scheduling and
   self-coordination work with no new auth concept.
2. **Observer scope (new, small)**: `MERCURY_API_TOKENS` gains a third segment:
   `tok:owner:observe`. An observer token gets `GET` (list/show/events/stream)
   across owners — read-only, exactly the same 404 semantics for writes
   (writes are *not* 403'd into a disclosure; they answer 404 the way any
   non-owner write does today). This needs a small change in
   `src/api/auth.ts` + the read routes' `isAdmin` checks, gated by a test that
   an observer cannot write anything.
3. **Admin**: the existing admin token. Never recommended for a bot.

The NEEDS_INPUT question: answering another owner's Run is the one write a
coordinator genuinely needs. v1 rule: an observer bot **may** `POST input` on a
Run in `NEEDS_INPUT` status only; the route checks status before applying the
override, and the input event records `source: bot:<alias>`. Every other
cross-owner write stays impossible. (State-machine check: `NEEDS_INPUT →
RUNNING` is a legal transition, so the input path needs no new transition —
only the ownership exception.)

## 10. Process model and lifecycle

- **One process per bot**: `mercury host bot run --alias <alias>`. Crash
  isolation, per-alias unit files, per-alias logs
  (`${XDG_STATE_HOME}/mercury/bots/<alias>.log`). A multi-bot supervisor was
  considered and deferred (§16): per-bot processes make the failure story
  obvious, and hosts rarely run more than a handful.
- **Service install**: `mercury host bot service install --alias <alias>`
  writes a systemd user unit (Linux) / launchd plist (macOS) by the same
  machinery `host service install` uses — same wrapper script, same
  `EnvironmentFile` (the bot reads `mercury.env` for `MERCURY_BIND_HOST`-style
  defaults but its token comes from `bot-credentials.json`).
- **Shutdown**: SIGINT/SIGTERM stop the timers, finish an in-flight dispatch
  (idempotency keys make an interrupted dispatch safe), exit 0. A bot never
  cancels a Run on shutdown — stopping watching is not cancelling (the same
  rule `mercuryctl runs watch` follows).
- **Start ordering**: the bot starts, probes `GET /healthz`, and if the API is
  unreachable retries with capped backoff (5 attempts, 15 s cap — the same
  bounds the CLI's stream uses). It does not fire scheduled tasks it missed
  while the API was down except per `onMiss`.

## 11. Commands

```text
mercury host bot validate --alias <a>     # parse config, check token, dry-parse crons
mercury host bot run --alias <a>          # foreground (what the service runs)
mercury host bot dispatch --alias <a> --task <name> [--yes]   # fire one task now
mercury host bot status --alias <a>       # next fires, last actions, budget state
mercury host bot service install|uninstall --alias <a>
mercury host doctor                       # gains a bots section (§13)
```

`host setup` gains an optional step: "Set up a dispatcher bot?" which collects
alias + harness defaults, generates the bot token into `bot-credentials.json`,
registers it into `MERCURY_API_TOKENS` (preserving the operator's hand-set vars
per #677's preservation rule), and writes a starter `<alias>.json`. Skipping it
changes nothing.

Every command shares the wizard's guardrails: bounded probes before writes,
redacted summaries, `--yes` for anything that writes, and a `--dry-run` mode
for `run`/`dispatch` that prints the actions the cycle *would* take. A bot is
exactly the "script that will act on a live system" case, so its dry-run mode
is not optional.

## 12. Configuration reference (v1 surface)

| Field | Required | Meaning |
| --- | --- | --- |
| `description` | no | human label |
| `api.url` | no | defaults to `http://127.0.0.1:${MERCURY_PORT:-3000}` |
| `api.timeoutMs` | no | per-request deadline; default 30000 |
| `schedule.tasks[].name` | yes (if tasks) | unique per bot, `[a-z0-9-]` |
| `schedule.tasks[].cron` | yes | 5-field cron, local time unless `tz` |
| `schedule.tasks[].template` | yes | create-Run request fields |
| `schedule.tasks[].singleFlight` | no | default `true` |
| `schedule.tasks[].onMiss` | no | `skip` (default) / `collapse` / `run` |
| `triggers[].on` | yes | matcher fields (AND) |
| `triggers[].pollMs` | no | default 30000, floor 5000 |
| `triggers[].action` | yes | `{ dispatch: <template> }` (v1: dispatch only) |
| `brain.*` | no | absent = no LLM, deterministic bot |
| `brain.shareTaskText` | no | default `false` |
| `brain.tokenBudgetPerCycle` | no | default 4000 |
| `brain.maxDispatchesPerHour` | no | default 12 |

Unknown keys are rejected with a "did you mean" suggestion, the same rule the
wizard's answers file follows (#649 §2).

## 13. Doctor and observability

`mercury host doctor` gains a bots section, one line per discovered bot:

```text
bot maint: config ok, token ok, 2 tasks, next fire in 4h12m, brain: llm ok
bot coord: SKIP — token rejected (401); check bot-credentials.json
```

Checks are the doctor's usual kind: config parses and validates, credential
file permissions, a real authenticated `GET /api/agents` (bounded), cron
expressions parse, `nextFire` computable, LLM endpoint reachable with a 1-token
probe (only when a brain is configured; a probe that costs tokens is bounded
and says so). Log lines are structured (`bot=<alias> task=<name> action=dispatch
run=<id>`), and every dispatch is visible as a Run, so the dashboard needs no
new UI to show what bots did.

## 14. Security model

The bot is the first host component that sends Mercury content to an external
service, so its security section is a requirement list, not advice:

1. **Redact before egress** (§8.3 step 2). A redaction failure aborts the cycle.
2. **Closed vocabulary** (§8.3 step 4). The LLM picks among declared actions;
   it cannot invent one. The validation code is the only interpreter.
3. **Least visibility**: own-runs by default; observer scope is a deliberate,
   documented token-form change; admin is discouraged and never set up by the
   wizard.
4. **Bounded spend**: token budgets per cycle, dispatch caps per hour, probe
   costs stated in doctor output.
5. **No credential egress**: tokens live in the 0600 file; prompts are built
   from an allowlist of fields; the redactor runs before serialization.
6. **No persistence of LLM traffic by default**: prompts/responses are logged
   only at debug level and only in the bot's own log file, never into the Run
   event stream.
7. **Fail-closed on every boundary**: unreachable API → skipped cycles with
   logged reasons; unreachable LLM → deterministic behaviour only; malformed
   LLM output → dropped actions. A bot must be safe to forget about.

## 15. Testing strategy

No test talks to a real LLM. The brain gets a **scripted fake** (a local HTTP
stub returning queued responses per cycle), the same discipline as the fake
agent adapter and the mock PrimeAgent RPC fixture.

1. **Unit**: cron evaluation (DST-adjacent cases: a 02:30 daily task on a
   spring-forward day fires once, not twice and not zero times);
   `singleFlight` against a scripted client; `onMiss` policies; derived
   idempotency keys are stable across process restarts; trigger matchers;
   cooldowns and the dispatch cap; config validation and the unknown-key
   refusal; credential-file permission checks.
2. **Contract (real server, fake brain)**: dispatched Runs appear with
   `ownerId = bot:<alias>` and `createdBy`; input on another owner's
   NEEDS_INPUT Run works and on a RUNNING Run is a 409 (exit 5 semantics);
   observer tokens can read cross-owner but every write is 404; the wrapper
   shapes the bot consumes are pinned (the #680 lesson: a route that wraps in
   `{ goal }` needed a seeded-state test to catch the wrapper miss — seed
   state directly when no adapter can produce it).
3. **Subprocess**: `bot run` against the real test server + scripted brain:
   fires on schedule (fake clock), skips when `singleFlight` holds, survives a
   server restart mid-cycle, SIGINT exits 0 without cancelling anything,
   redaction: a task text containing a fake secret pattern must not appear in
   the recorded LLM request body.
4. **Coupling**: `client/test/coupling.test.ts`-style guard — bot code imports
   the API surface, never `src/` internals except the redactor, which is
   deliberately shared and pinned by its own contract tests (documented
   exception, asserted in both directions like the packaging test's exception
   list).
5. **Mutation discipline**: the idempotency-key derivation, the
   `maxDispatchesPerHour` cap and the redact-before-egress call each get a
   mutation that must be caught (delete the call / change the key input /
   reorder redact-after-serialize) — a green suite after a behaviour-free
   mutation is not evidence, the same standard M1 of the CLI design applied.

## 16. Open decisions

Deferred on purpose, with the criteria that would decide them:

- **Cron dependency**: hand-rolled 5-field parser (no tz DB, offset-only `tz`)
  vs a library. Criterion: if DST correctness forces more than ~150 tested
  lines, reconsider. The repo has resisted dependencies when a tested
  hand-rolled version stayed small (`cli-tui-design.md` §19, parser decision).
- **Named timezone support**: needs a tz database; wait for an operator to
  need it, then reconsider with the cron decision.
- **One process per bot vs a supervisor**: per-bot chosen for v1 (crash
  isolation, obvious failure story). Revisit if a host routinely runs >5 bots.
- **`bot.note` event type** vs note-Runs (§7): revisit if note-Runs are noisy
  in practice.
- **Trigger actions beyond `dispatch`**: v1 is dispatch-only; `input` as a
  trigger action needs the §9 ownership exception spelled out per case.
- **LLM providers beyond openai-compatible**: the transport is one POST; add a
  provider only when one is actually deployed.

## 17. Definition of done

The bot feature is done when an operator can:

1. define a bot by alias with a scheduled task and have it fire on schedule
   without any LLM;
2. restart the host (and the bot) without a missed fire double-dispatching;
3. see every action the bot took as ordinary Runs, owner-scoped to
   `bot:<alias>`, in the dashboard and `mercuryctl`;
4. connect an LLM to a bot and have it coordinate within the closed action
   vocabulary, with every outbound payload redacted and every budget enforced;
5. trust that a broken bot degrades to skipped cycles with logged reasons,
   never to wrong actions;
6. `mercury host doctor` says, per bot, whether it is healthy and when it will
   next act;
7. remove a bot (config + token + service unit) leaving nothing behind but its
   Runs and events — the same "uninstall leaves nothing but the opted-in data"
   standard the lifecycle commands meet.

## 18. Roadmap

Each milestone is independently shippable and leaves the host better than before.
Nothing is enabled by default: the feature exists only where a bot is configured.

### Milestone B0 — contracts and schemas (no bot runs yet)

- bot config schema + validation (unknown-key refusal, alias rules);
- `bot-credentials.json` read/permission rules (shared shape with the client's
  credential file);
- derived idempotency-key function + cron evaluator with the DST test set;
- `host bot validate` command (offline);
- coupling test extension for `src/host/bots/` with the redactor exception.

*Acceptance*: validate rejects every malformed config in the fixture set with a
named field; cron tests pass on a fixed clock; typecheck + focused tests green.

### Milestone B1 — scheduler without LLM

- bot process (`host bot run --alias`) with the scheduler timer, dispatch via
  the loopback API, `singleFlight`, `onMiss`, state file;
- `host bot dispatch` (manual fire) and `host bot status`;
- service install/uninstall per alias;
- subprocess tests against a real test server with a fake clock.

*Acceptance*: §17 items 1, 2, 3 and 7 hold for a brain-less bot; a scheduled
task fired 100 times on a fake clock produces exactly the Runs the policy
allows, each attributable.

### Milestone B2 — event triggers

- trigger matchers + per-trigger polling + cooldown + dispatch cap;
- cursor state; the NEEDS_INPUT ownership exception behind the observer scope
  (`src/api/auth.ts` third segment + read-route checks + the write-404 test).

*Acceptance*: §17 item 3 for triggered Runs; an observer bot cannot write
anything except NEEDS_INPUT input, and every such input is event-recorded with
the bot's identity.

### Milestone B3 — the LLM brain

- `LLMConnection` (bounded transport, no retry), context gatherer with field
  allowlist, redact-before-egress, action validation, budgets;
- the scripted-brain test double; doctor's LLM probe.

*Acceptance*: §17 items 4 and 5 hold with a fake brain that returns, in turn:
a valid action, malformed JSON, an unknown template, an oversized response, and
nothing at all — the bot skips or drops, logs, and stays inside its budgets.

### Milestone B4 — setup integration and hardening

- `host setup` bots step; `host doctor` bots section;
- the §14 review as a named deliverable (like the CLI's M4 bounds review):
  every bound in §12 and §14 has a test, every mutation in §15.5 is caught;
- operator docs (`docs/bots.md`) and a `status.md` entry.

*Acceptance*: a fresh-host install through the wizard can produce a working
maintenance bot without hand-editing JSON; every security claim in §14 has a
test that fails without it.

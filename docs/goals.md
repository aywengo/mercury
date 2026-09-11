# Goals: setting objectives on a Run and tracking whether they were met

**Status: partially implemented.** Phases 0a, 0, 1, 2, 3 and the implementable half of 4 are
shipped. Phase 4's second half -- rendering harness-reported gate *outcomes* -- has no emitter to
ship against and is blocked the same way Phase 5 is; Phase 5 is blocked upstream and Phase 6 is
deferred. Concretely, today:

| shipped | not shipped |
| --- | --- |
| the harness version that executed each Run, recorded at claim time (13.1) | |
| capability + version detection per agent (Phase 0a), with per-field goal capability | gate OUTCOME events -- no harness reports them, so there is no emitter (Phase 4b) |
| `GET /api/runs/:id/goal` and `POST /api/runs/:id/goal/cancel`; `cancelled` finally has a writer | |
| `run_goals` table, `GoalSpec` validation, `goal.*` event types | Hermes goals (Phase 5, blocked upstream) |
| `POST /api/runs` accepts `goal`, refused unless the agent can track it | budget enforcement (Phase 6, deferred pending real usage data) |
| `goal.unmet` when a Run ends with the objective still open, and `mercury_goals_in_status` | |
| PrimeAgent seeded with `--goal` / `--goal-token-budget`; its `goal_update` reports relayed into the row and the timeline (Phase 2) | |
| goal status beside Run status in the dashboard, `mercuryctl runs list` / `runs show`, and goal events in the SSE timeline (Phase 3) | |
| gate specs validated (bounded `timeoutMs`, sane `maxRetries`), persisted, and rendered as a spec in the dashboard and `runs show` (Phase 4a) | |

A goal is now **set, refused, tracked while the Run runs, closed when the Run ends, and
visible**. `unmet` is the only status Mercury originates; every other status is a harness
report relayed verbatim.

The rendering rule from section 4 is enforced by tests, not by care: goal status is a
**sibling** of the Run on every read path (`{ run, skills, goal }`, and a parallel `goals`
map on the list), never a field on the Run, and never written into the status column. A
surface that shows `COMPLETED` while hiding `unmet` reproduces the original problem with
extra steps, so "both values present, on separate lines" is what the tests assert.

**Scope:** the host. Fleet's role is covered in [API](#8-api) and is deliberately
thin.

**Related:** [`overview.md`](overview.md), [`agent-adapters.md`](agent-adapters.md),
[`agents.md`](agents.md), [`crew/agent-templates.md`](crew/agent-templates.md),
[`crew/harness-capabilities.md`](crew/harness-capabilities.md),
[`../ARCHITECTURE.md`](../ARCHITECTURE.md)

---

## 1. The problem this solves

A Run reports `COMPLETED` when the harness stops. That is a statement about the
process, not about the work. The two come apart constantly, and Mercury currently has
no way to express the difference:

- The agent runs out of turns, gives up, and exits 0.
- The agent answers a sub-question and stops, having never attempted the objective.
- The agent says "done" and is wrong.

Observed directly during the design of this document: a Mercury Run was marked
`COMPLETED` while the change it was asked to make had been aborted mid-flight. The
status was accurate about the process and false about the work.

Mercury already has a precedent for exactly this confusion and already resolved it.
`RunConstraints.budgetTokens` and `budgetCost` are **recorded only**, never enforced,
and [types.ts](../src/domain/types.ts) says why plainly: they used to be called
`maxTokens`/`maxCost`, which "sat next to two genuinely enforced `max*` fields and so
read as promises". The honest fix was a rename, because enforcement needs per-run
usage reporting from every adapter, which does not exist.

**A goal is the same trap waiting to be built.** A `goalAchieved: true` boolean that
Mercury invented itself would be a promise Mercury cannot keep. Everything below
follows from taking that seriously: Mercury records what the harness reports, and is
explicit about which harness can report what.

## 2. What the two harnesses actually do (verified, not assumed)

Every claim in this section was checked against the installed binaries and their
source, not against documentation. Versions: PrimeAgent 0.9.4, Hermes v0.20.5
(upstream `933c209e`).

### 2.1 PrimeAgent — settable and observable

| | |
| --- | --- |
| Set, non-interactive | `--goal <objective>`, `--goal-token-budget <n>` — "Seed a persistent goal for a new root session" |
| Set, in-session | `goal.create(objective, token_budget?)`, `goal.complete()`, `goal.get()` (async; kernel-only, via the host bridge) |
| Observe | emits `{ type: "goal_update", goal: <goalState> }` on the event stream |
| Status values | `idle`, `active`, `paused`, `budget_limited`, `complete`, `error` |
| Budget | `tokenBudget`; absent means unbounded. Exhaustion is its own status, `budget_limited` |
| Objective limit | `MAX_THREAD_GOAL_OBJECTIVE_CHARS = 4000` |

The authoritative declaration is PrimeAgent's own type file,
`dist/core/goals.d.ts` (PrimeAgent 0.9.4):

```ts
export type GoalStatus =
  | "idle" | "active" | "paused" | "budget_limited" | "complete" | "error";

export interface GoalState {
  active: boolean;          // read this alongside status; do not infer from status alone
  status: GoalStatus;
  goalId?: string;
  objective?: string;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  continuationsUsed: number;
  createdAt?: number;
  updatedAt?: number;
  lastReason?: string;
  lastError?: string;
}
```

`idle` is the no-goal state (`emptyGoalState()`), and the kernel-facing serialization
narrows it away — `SerializedGoal.status` is `Exclude<GoalStatus, "idle">` — so a
consumer never sees `idle` alongside a real objective.

`goalState` shape, read from a live session:

```json
{
  "goal": {
    "goal_id": "fb30529e-d343-47f0-870d-a442e39a5d28",
    "objective": "resolve open issues …",
    "status": "complete",
    "tokens_used": 632007,
    "time_used_seconds": 4695,
    "created_at": 1789078222975,
    "updated_at": 1789082975082
  },
  "remaining_tokens": null,
  "completion_budget_report": null
}
```

Two things matter here. First, **both directions exist**: Mercury can set a goal at
launch through argv and watch it change through events PrimeAgent already emits.
Second, `tokens_used` is **per-goal usage reported by the harness** — the first real
usage signal Mercury has ever had access to. See [Budgets](#9-budgets-the-thing-that-could-actually-be-enforced).

PrimeAgent also injects a `<goal_context>` block into the model's context each turn,
so the objective survives compaction. Mercury does not need to reproduce that and must
not try.

### 2.2 Hermes — a better model, and neither door is open to Mercury

Hermes' goal machinery (`hermes_cli/goals.py`, self-described as "the Ralph loop for
Hermes") is the stronger design of the two:

- After each turn an **auxiliary judge model** answers one question: is this objective
  satisfied by the last response? Verdict is one line of JSON,
  `{"done": bool, "reason": str}`.
- If not done, Hermes feeds a continuation prompt back into the **same session**. No
  system-prompt mutation, no toolset swap, so prompt caching survives.
- A **`GoalContract`** makes "done" decidable rather than vibes-based:
  `outcome`, `verification`, `constraints`, `boundaries`, `stop_when`. It is woven into
  both the continuation prompt and the judge prompt.
- **`GoalGate`s** are deterministic shell commands that run at the turn boundary
  **before** the judge. A failing gate short-circuits judging entirely and its bounded
  output becomes the continuation prompt, so the agent iterates against concrete
  evidence. Only when every gate passes does the judge get to decide `done`.
  `attempts` exceeding `max_retries` auto-pauses rather than spinning.
- Judge failures are **fail-open** to `continue`; a broken judge must not wedge
  progress, and the turn budget (default 20) is the backstop. Parse failures and
  transport failures are counted separately, each auto-pausing after 3 consecutive.
- Status: `active`, `paused`, `done`, `cleared`, plus `last_verdict`
  (`done`/`continue`/`skipped`) and `paused_reason`.

Mercury can use none of it today. Three verified facts:

1. **`/goal` is interactive-only.** Slash dispatch lives in the interactive input loop
   (`cli.py` `_looks_like_slash_command`, call sites at 8176 / 11566 / 20242). The
   one-shot path Mercury uses sets `cli._single_query_mode = True` and passes the text
   straight through as `user_message=effective_query`. So a task body beginning
   `/goal …` is **sent to the model as a literal user message**, not executed. It will
   not error. It will quietly do nothing useful, which is worse.
2. **The only non-interactive goal entry point is the kanban board**:
   `hermes kanban create … --goal` (a boolean — the goal text is the card title and
   body) with `--goal-max-turns N`. `hermes chat` has no goal flag.
3. **Goal status never reaches stdout.** `goals.py` emits nothing; state is persisted
   only in Hermes' SessionDB `state_meta` table, keyed `goal:<session_id>`. Quiet mode
   (`-Q`) prints the final response and the session id, and nothing else.

This is the same class of defect as issue #459, where `/api/agents` advertised `hermes`
while Hermes could not execute a single Run: **an advertised capability that the
serving path does not honour.** The design must not repeat it, which is why
[Hermes](#7-hermes-the-honest-gap) is a gap analysis rather than a feature list.

## 3. Design principles

1. **Mercury records; the harness decides.** Mercury never judges goal achievement
   itself. It has no verification surface — no per-run usage, no test results it
   trusts, no view into the agent's session. This mirrors the existing rule that
   skills are guidance and `skill.started`/`skill.completed` are agent-reported.
2. **Goal status is orthogonal to Run status.** They are different axes and must never
   be collapsed. See [section 4](#4-the-central-decision-goals-are-not-run-status).
3. **Absence is the default.** A Run with no goal behaves exactly as today. Nothing
   about this feature may change behaviour for callers that do not use it — the same
   invariant that governs `skills` and `repositories`.
4. **Never claim more than the adapter can report.** A goal on an adapter with no goal
   support is rejected at creation with a clear message, not accepted and silently
   ignored. This is the #459 lesson encoded.
5. **Persist what the harness said, not what Mercury concluded.** Snapshots keep the
   raw verdict so a replay shows what the harness actually reported.

## 4. The central decision: goals are not Run status

The tempting design is a field on `Run` — `goalAchieved: boolean` — and it is wrong in
a specific, damaging way. It invites every consumer to read `COMPLETED` as "the work is
done", which is the exact failure this feature exists to expose.

So:

- `Run.status` keeps its current meaning: what happened to the process.
- Goal state is a **separate record** with its own vocabulary, never derived from
  `Run.status` and never overriding it.
- The UI and `mercuryctl` must render them side by side, never one in place of the
  other.

The combinations are all real and all must be displayable:

| Run status | Goal status | Meaning |
| --- | --- | --- |
| `COMPLETED` | `complete` | the normal good case |
| `COMPLETED` | `active` | **the case that matters**: the process ended and the objective was never met |
| `COMPLETED` | `paused` | harness stopped judging and wants attention |
| `COMPLETED` | `budget_limited` | objective not reached because the token budget ran out |
| `FAILED` | `error` | the goal runtime broke; the Run failure and the goal failure are the same event |
| `FAILED` | `complete` | the work finished and something else broke afterwards |
| `TIMED_OUT` | `active` | wall-clock deadline hit mid-objective |
| `COMPLETED` | `absent` | today's behaviour; no judgement was made |

The second row is the reason to build this. Nothing in Mercury today can express it.

### Goal status vocabulary

Mercury needs one vocabulary that both harnesses map into. It is a superset of
PrimeAgent's and Hermes', with two additions:

| Mercury | PrimeAgent | Hermes | Meaning |
| --- | --- | --- | --- |
| `absent` | `idle` / no goal | — | no goal on this Run |
| `active` | `active` | `active` | objective open |
| `paused` | `paused` | `paused` | loop stopped, needs attention; `pausedReason` says why |
| `budget_limited` | `budget_limited` | — | token budget exhausted; the harness stopped for want of budget, not of evidence |
| `error` | `error` | — | the goal runtime itself failed; `lastError` says how |
| `complete` | `complete` | `done` | the harness judged the objective met |
| `cancelled` | — | `cleared` | a human dropped the objective |
| `unmet` | — | — | **Mercury-side, and never silent**: the Run reached a terminal status while the goal was still `active` |

Three things this table has to carry, each of which is a real asymmetry rather than
tidiness:

**PrimeAgent has no `cancelled`.** Only Hermes can have an objective dropped out from
under it (`/goal clear`), because only Hermes runs a long-lived loop a human can talk to
mid-session. PrimeAgent's goal ends by completing, erroring, or being budget-limited.
Mercury keeps `cancelled` because Hermes needs it, and it will simply never arrive from
PrimeAgent.

**`budget_limited` must not fold into `paused`.** They call for opposite responses:
`paused` means "a human should look at this", `budget_limited` means "the budget was too
small, accept the partial result or raise it". Hermes has no equivalent status — it
reports turn-budget exhaustion as `paused` with a `paused_reason` — so Mercury will see
budget exhaustion in two different shapes depending on backend, and must not pretend
those are the same input.

**`error` must not fold into `paused` either.** It reports that the goal machinery broke,
which is an infrastructure signal about the harness, not a statement about the work or a
request for help. Folding it into `paused` would hide a harness bug behind a status that
tells an operator to go reason about the objective.

`unmet` is the only state Mercury originates, and it is deliberately not a judgement
about the work. It means: the harness stopped reporting before it ever said `complete`.
It is derived at finalisation from the absence of a terminal goal state, which is a
fact Mercury is entitled to know. It must be rendered distinctly from `paused`, which
is the harness asking for help.

## 5. Data model

Goals hang off the Run, because Runs are the unit of work in this architecture —
everything else (state, events, workspace, skills) already does.

```ts
/** Optional completion contract, modelled on Hermes' GoalContract because it is the
 *  better of the two designs and is already proven in production. Every field is
 *  free-form prose; an all-empty contract is equivalent to no contract. */
export interface GoalContract {
  outcome?: string;       // what must be true at the end
  verification?: string;  // how that gets checked (command, test, artifact)
  constraints?: string;   // what the agent must not do
  boundaries?: string;    // what is out of scope
  stopWhen?: string;      // when to stop even if the outcome is partial
}

/** A deterministic check that must pass before the objective can be declared met.
 *  Execution belongs to the harness (it runs at turn boundaries mid-run); Mercury
 *  records the outcome. `timeoutMs` is mandatory: an unbounded gate is
 *  indistinguishable from a hung one. */
export interface GoalGate {
  command: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface GoalSpec {
  /** Omitted or empty means "the Run's `task` is the objective" -- see section 14.
   *  Resolved at creation, so `GoalState.objective` is always non-empty and the
   *  4000-char cap applies to the resolved value (it matches PrimeAgent's
   *  MAX_THREAD_GOAL_OBJECTIVE_CHARS). A task longer than the cap with no explicit
   *  objective is a 400, not a silent truncation: a truncated objective is a
   *  different objective. */
  objective?: string;
  contract?: GoalContract;
  gates?: GoalGate[];
  tokenBudget?: number;           // positive integer; absent = unbounded. PrimeAgent
                                  // enforces this itself and reports `budget_limited`
  maxTurns?: number;              // maps to Hermes --goal-max-turns; ignored by PrimeAgent
}

export type GoalStatus =
  | 'absent' | 'active' | 'paused' | 'budget_limited' | 'error'
  | 'complete' | 'cancelled' | 'unmet';

export interface GoalState {
  status: GoalStatus;
  objective: string;
  contract?: GoalContract;
  gates?: GoalGate[];
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  remainingTokens?: number | null;
  lastVerdict?: 'done' | 'continue' | 'skipped';  // Hermes only
  lastReason?: string;            // harness-supplied, bounded, redacted
  lastError?: string;             // PrimeAgent `error` status; bounded, redacted
  pausedReason?: string;
  /** Turn/continuation count. PrimeAgent reports `continuationsUsed`, Hermes counts
   *  turns against `--goal-max-turns`. Same idea, different denominators: never
   *  compare the two across backends or render them in one column. */
  turnsUsed?: number;
  source: 'harness' | 'operator'; // who last changed it
  updatedAt: string;
}
```

Persistence: one `run_goals` table, one row per Run, updated in place, plus the
existing append-only event stream for history.

```sql
CREATE TABLE run_goals (
  run_id         TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  objective      TEXT NOT NULL,
  contract_json  TEXT,
  gates_json     TEXT,
  status         TEXT NOT NULL,          -- GoalStatus
  tokens_used    INTEGER,
  time_used_seconds INTEGER,
  turns_used     INTEGER,
  last_verdict   TEXT,
  last_reason    TEXT,
  paused_reason  TEXT,
  source         TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
```

The migration in [src/db/database.ts](../src/db/database.ts) is the authoritative schema;
this sketch is illustrative. Two places it already differs, both deliberate: the duration
column is `time_used_seconds` because harnesses report seconds and a column named `_ms`
holding seconds is a unit bug waiting to surface, and gate events are absent from
`EVENT_TYPES` until Phase 4 has an emitter for them.

One row per Run, not a history table: the event stream is already the history, and a
second append-only copy of the same facts is how two sources of truth start arguing.

### Gates are recorded, not executed, by Mercury

Tempting to run gates in Mercury, and wrong. A gate's value is that it fails **during**
the run so the agent iterates against it. Mercury cannot inject a failing gate into a
live agent turn — only the harness can. Running gates in Mercury afterwards turns the
mechanism into a post-hoc test report, which `test.*` events already cover.

Mercury's job: validate the gate spec at creation (bounded `timeoutMs`, sane
`maxRetries`), persist it, and record each reported attempt.

## 6. Events

New types, added to `EVENT_TYPES` in [types.ts](../src/domain/types.ts). That set is
enforced at `EventStore.append`, the single write choke point, and a test already fails
if any append uses a type absent from the set (issue #60) — so the set must be updated
in the same change as the first emitter, or the emitter throws.

| Type | Payload | Emitted when |
| --- | --- | --- |
| `goal.created` | `{ objective, contract?, gates?, tokenBudget? }` | Run created with a goal |
| `goal.updated` | `{ status, objective?, tokensUsed?, turnsUsed?, lastVerdict?, lastReason? }` | a `goal_update` arrives from a harness; `objective` is present only when the harness replaced it |
| `goal.paused` | `{ pausedReason, turnsUsed? }` | harness paused the loop |
| `goal.budgetLimited` | `{ tokenBudget, tokensUsed }` | harness stopped for want of budget |
| `goal.error` | `{ lastError }` | the goal runtime itself failed |
| `goal.completed` | `{ tokensUsed?, timeUsedSeconds?, completionBudgetReport? }` | harness declared the objective met |
| `goal.cancelled` | `{ source }` | operator or harness dropped it |
| `goal.unmet` | `{ runStatus, lastVerdict?, turnsUsed? }` | Run finalised while goal was `active` |
| `goal.gate.failed` | `{ command, exitCode?, truncated, attempt }` | harness reported a gate failure |
| `goal.gate.passed` | `{ command, attempt }` | harness reported a gate pass |

Rules that must hold, each of which is a known failure mode elsewhere in this repo:

- **`lastReason` and gate output are agent-controlled text.** They pass through the
  redactor like every other payload, and are length-bounded before persistence.
  Unbounded harness text in an SSE frame is how #50 happened.
- **`goal.unmet` is appended by the worker on the finalisation path**, not by an
  adapter, so it fires on every exit route including `TIMED_OUT` and lease loss.
- **No goal event may change `Run.status`.** State transitions go through
  `RunStore.transition` and nothing else.

## 7. Hermes: the honest gap

Per principle 4, Mercury must not accept a goal for Hermes and silently do nothing.
Until one of the options below lands, **`POST /api/runs` with a goal and
`agent: "hermes"` returns `400`** naming the reason and the workaround.

Options, with the reasons each is or is not acceptable:

**(a) Ask Hermes upstream for `--goal` on `chat` and goal state in quiet output.**
The clean fix, and small: Hermes already has `GoalManager`, `GoalContract`, gates and
persistence. It needs the one-shot path to seed a goal and to print a final goal
verdict alongside the session id. Mercury then mirrors the PrimeAgent design exactly.
**Recommended.** Track as an upstream request; Mercury's adapter should be written so
this is a flag-and-parse change, not a redesign.

**(b) Interim: route goal-bearing Hermes work through `hermes kanban create --goal`.**
Works today and exercises Hermes' real goal loop. Costs a lot: it moves execution from
`hermes chat` onto Hermes' board, which changes session handling, workspace handling
and cancellation, and it makes Mercury's Hermes adapter two execution models in one
file. The existing Crew guidance is that Mercury must not rebuild Hermes kanban,
though a Hermes host may execute one stage as a kanban swarm — this is the sanctioned
shape of that exception, and it should be scoped to that: opt-in, per-Run, off by
default. **Acceptable as an experiment, not as the design.**

**(c) Read Hermes' SessionDB `state_meta` directly.** Rejected. It reaches into another
product's private storage, keyed by a session id Mercury would have to scrape from
stderr, with no compatibility promise. It would work in a demo and break on a Hermes
upgrade — and it breaks silently, reporting a stale goal rather than a missing one.

**(d) Implement Mercury's own judge loop for Hermes.** Rejected. It duplicates a judge,
gates and a continuation loop that Hermes already runs better, and it puts Mercury in
the business of deciding whether work is done — which principle 1 exists to forbid.

**What Mercury does today, with no Hermes change at all:** record the objective, and
report `unmet` when the Run ends without a completion signal. That is weaker than a
judge and still strictly better than silence, because the operator learns the
objective was never confirmed rather than inferring it from `COMPLETED`.

## 8. API

```
POST /api/runs
  { task, repository, agent, skills?,
    goal?: { objective, contract?, gates?, tokenBudget?, maxTurns? } }
  -> 201 { runId, status }
  400 when: resolved objective (explicit, else the task) exceeds 4000 chars;
      gate timeoutMs missing or non-positive; goal supplied for an agent with no
      goal support (see section 7)

GET  /api/runs/:id/goal      -> { goal: GoalState }        (404 when absent)
POST /api/runs/:id/goal/cancel -> { goal: GoalState }      (operator override)
```

`GET /api/runs/:id` also returns the goal, as a **sibling** of `run`, and `GET /api/runs`
returns a parallel `goals` map keyed by run id. Those are the endpoints a renderer should use:
the dedicated `/:id/goal` returns the goal on its own and therefore cannot show a Run status next
to a goal status, which is the pairing section 4 exists to make visible. It is kept for callers
that need only the goal.

Cancel is the only goal mutation, and the only writer of `cancelled`. That status sits in
`MERCURY_ONLY_GOAL_STATUSES`, so a harness reporting it is refused -- which meant that until this
route existed nothing whatsoever could set it, while the status, the `goal.cancelled` event, the
dashboard badge and the CLI colour were all live. A goal already carrying a verdict (`complete`,
`unmet`, `cancelled`) is a 409 rather than a silent no-op, because those are the records the
feature exists to keep.

Deliberately **no** `POST /api/runs/:id/goal/complete`. Only the harness may declare an
objective met; an operator override would put a Mercury-originated `complete` in the
same field as a harness judgement, and the two would become unreadable apart. An
operator who disagrees cancels the goal and says so in a comment; the record then shows
a human decision rather than impersonating a machine one.

Mercury sets a goal only at creation — pushing a new objective into a live session needs
an input channel neither backend offers Mercury today. But **the objective is not
immutable in Mercury's hands**, and pretending otherwise would be another advertised-
capability error: PrimeAgent replaces a live objective when a new one is set while one is
active, emitting a goal context of kind `objective_updated` (see `goalContextPrompt` in
`dist/core/goals.js`). So Mercury must accept an objective changing mid-run and record
each change through `goal.updated`, rather than treating a second objective as a
protocol violation.

What stays closed is *operator-initiated* mutation: there is no endpoint to change a
goal, because Mercury has no way to deliver one and an endpoint that silently no-ops is
exactly the #459 mistake.

`goal` and `task` are both required to be non-empty and mean different things: `task`
is the instruction the agent starts on, `objective` is the condition for stopping. For
most Runs they will be near-identical, and that is fine — the contract fields are where
the difference earns its keep.

**Fleet** proxies goal endpoints to the host rather than owning a second store, for the
same reason Crew templates do: otherwise the host that executed the Run stops being the
authority on what it executed.

`paused` surfaces in Fleet as an **alert requiring human interaction**, not as another
cell in a status column. It is the one goal status that means a named human has
something to do, and a status that only changes the colour of a row nobody is reading is
a queue that silently stops making progress. The alert carries the Run id, the objective,
and `pausedReason`, because "why" is the first thing the responder asks and making them
open the Run to get it costs a round trip per incident.

## 9. Budgets: the thing that could actually be enforced

`budgetTokens` is recorded-only today because nothing reports usage. PrimeAgent's
`goalState` reports `tokens_used` and `time_used_seconds` per goal, and emits them
incrementally via `goal_update`.

That is the missing input for issue #63. Once Mercury stores per-goal usage it can
enforce `budgetTokens` in the drive loop next to the `maxDurationMs` deadline — exactly
where [types.ts](../src/domain/types.ts) says enforcement belongs.

Better still, **PrimeAgent already enforces it.** `budget_limited` is a status the
harness reaches on its own when `tokensUsed` passes `tokenBudget`, with a dedicated
budget-limit prompt and `continuationsUsed` counting the turns it spent. So for
PrimeAgent the work is not to build enforcement but to pass the budget down and record
the outcome — which is a much smaller and more trustworthy change than Mercury polling
usage and killing a Run itself. Mercury-side enforcement is then only needed for backends
that lack it, and should be framed that way rather than as the general mechanism.

Two cautions, because this is where a plausible design goes wrong:

- Goal usage is **not** Run usage. A goal covers the turns the harness attributes to
  it; a Run may do work outside the goal. Enforcing a Run budget from goal usage would
  be a silent mismatch. Either enforce against goal usage and rename the field to say
  so, or keep them separate. Do not quietly substitute one for the other.
- Hermes reports no usage at all, so any enforcement is PrimeAgent-only until the
  adapter gap in section 7 closes.

## 10. Plan

Ordered; each phase ships something usable on its own.

**Phase 0a — capability and version detection.**
Prerequisite, not optional polish: Phase 0's rejection rule cannot be written until
Mercury knows which harness it is talking to. Adapters learn and cache the harness version,
parse it per adapter, and record it on the Run. `GET /api/agents` gains a parallel
`capabilities` field — parallel, because the dashboard's `loadAgents()` bails out on a
non-array `agents` and would silently revert to two hardcoded options. Ships on its own
merit: the harness version on a Run is the datum whose absence made #465 hard to close,
where the fix was on `main` and the installed artifact was still broken.

**Phase 0 — contract, no behaviour.**
Add `GoalSpec`/`GoalState`/`GoalContract`/`GoalGate` types, the `run_goals` migration,
and the new `EVENT_TYPES` entries. `POST /api/runs` accepts `goal`, persists it, emits
`goal.created`, and rejects it for every agent that lacks support — which is all of
them, so nothing changes for existing callers. Regression tests: a Run without a goal is
byte-identical to today; a goal for an unsupported agent is a `400` naming the reason.

**Phase 1 — the `unmet` signal.**
Worker finalisation appends `goal.unmet` when a Run reaches a terminal status with the
goal still `active`. This is the highest value per line in the whole design: it needs
no harness cooperation, works for every adapter, and it is the row that today cannot be
expressed. Ship it and measure before building more. The measurement is part of the phase, not an
afterthought: expose goal status counts through the existing
[`/metrics`](operations.md#metrics) projections so the answer is one query rather than a manual
sweep. Compute them as SQL aggregates over `run_goals`, matching the standing design decision
in [src/metrics/collect.ts](../src/metrics/collect.ts) to read from the database rather than
keep counters — a Prometheus counter incremented at the emit site would drift from the table it
describes and disagree with it after any restart. If `unmet` is rare the display work is still worth it; if it never fires, the
feature is decoration and Phase 3 should not be funded.

**Phase 2 — PrimeAgent end to end.**
`PrimeAgentAdapter` passes `--goal` / `--goal-token-budget`; translates `goal_update`
into `goal.updated` / `goal.paused` / `goal.completed`; persists state. PrimeAgent is the
only backend that can do this today, so it is where the design gets proven.

**Phase 3 — surface it.**
Dashboard shows goal status beside Run status with the two never substituted;
`mercuryctl runs get` prints both; SSE timeline renders goal events. The rendering rule
is a requirement, not a polish item: a UI that shows `COMPLETED` and hides `unmet`
reproduces the original problem with extra steps.

**Phase 4 — gates.**
Validate and persist gate specs; render harness-reported gate outcomes. No Mercury-side
execution.

Shipped as 4a; 4b is blocked, and the split is a finding rather than a scoping choice. 4a
validates the spec, refuses it when the backend cannot act on it, persists it, and renders it as
a spec. 4b -- rendering reported outcomes -- needs `goal.gate.passed` / `goal.gate.failed`, and
per section 6 those types must land in the same change as their first emitter. There is no
emitter: the section 13.2 matrix gives `gates` a dash for every shipped adapter, PrimeAgent has
no gate concept at all, and the one harness with gates is Hermes, whose goals are blocked by
Phase 5. Adding the types now would mean either inventing a wire shape no harness sends, or
landing event types that can never fire -- and a type that can never fire is how a surface comes
to advertise something nobody implemented.

What 4a does enforce is the part that was actually broken. Admission used to ask only whether an
agent could `set` a goal, so `goal.gates` was accepted, persisted, and rendered on a Run whose
harness will never evaluate it. That is issue #459 -- advertise a capability nobody honours --
reproduced inside the feature built to prevent it, and it is worse than silently dropping the
field, because the operator sees gates that nothing will run while the Run sails to COMPLETED.
Every goal field is now resolved against its own matrix entry.

**Phase 4c — operator cancel.**
Not in the original phase plan; it came out of auditing the implementation against this document.
`POST /api/runs/:id/goal/cancel` was in section 8 from the start, and `cancelled` was in
`GoalStatus`, in the event table, in the dashboard and in the CLI -- but nothing wrote it, and
`MERCURY_ONLY_GOAL_STATUSES` forbids a harness from writing it either. The feature was documented
and rendered and unreachable.

Cancel is the one mutation section 12 permits an operator. It forbids replacing an objective and
forbids an operator-authored `complete`, because both would put a Mercury-originated judgement
where only the harness may speak. Dropping a goal asserts nothing about whether the work was
done. It does prevent `unmet`, which is a claim the harness fell short -- and an operator who
stopped tracking deliberately has not earned that record. So a cancelled goal survives its Run
finishing, which is asserted directly rather than assumed.

**Phase 5 — Hermes.**
Blocked on section 7. Option (a) preferred; option (b) as an opt-in experiment if the
need is real. Until then the `400` stays, because a silently ignored goal is the #459
failure again.

**Phase 6 — budget enforcement.**
Only after Phase 2 has real usage data, and only with the naming question in section 9
settled.

## 11. Roadmap

| Phase | Depends on | Ships | Blocked by |
| --- | --- | --- | --- |
| 0a | — | harness version detection, capability surface | — |
| 0 | 0a | types, migration, validation, honest rejection | — |
| 1 | 0 | `goal.unmet` — works for every adapter | — |
| 2 | 0, 1 | PrimeAgent goals set + tracked | — |
| 3 | 1, 2 | dashboard, `mercuryctl`, SSE | — |
| 4a | 0 | gate specs validated, refused per-field, persisted, rendered as a spec | — |
| 4b | 4a, 2 | gate outcome events | no harness reports gate outcomes (13.2 matrix); Hermes goals (Phase 5) |
| 4c | 0, 1 | operator goal cancel -- the only writer of `cancelled` | — |
| 5 | 2 | Hermes goals | upstream `--goal` on `chat`, or a scoped kanban route |
| 6 | 2 | `budgetTokens` enforcement (issue #63) | real per-run usage data |

Phases 0a–3 are the whole useful product. Phase 1 alone may justify the feature, and it
is a small change to the finalisation path.

## 12. Non-goals

- **Mercury does not judge completion.** Principle 1.
- **No goal hierarchy, no sub-goals, no goal graphs.** One objective per Run. Team
  level objectives belong to [`crew/teams.md`](crew/teams.md) if they belong anywhere.
- **No cross-Run goals.** A goal lives and dies with its Run; retry gets its own.
- **No goal-based scheduling or placement.** That is Crew's job.
- **No goals on Crew templates.** A template carries persona -- who the agent is, how it
  behaves. An objective is the work a specific Run was asked to do. Putting a goal on a
  template would mean every Run from it inherits the same objective, which is almost
  never what a reusable persona means, and it would make the objective invisible to the
  person starting the Run. Goals are per-Run only.
- **No operator-initiated goal mutation.** The harness may replace the objective itself
  (PrimeAgent's `objective_updated`); Mercury records that but never originates it.
- **No operator-authored `complete`.**
- **No Mercury-side gate execution.**
- **No reuse of `NEEDS_INPUT` for `paused`.** `paused` is the harness telling us it
  stopped judging; `NEEDS_INPUT` is the agent asking the operator a question. Folding
  them together would make both unreadable.

## 13. Compatibility matrix

Goals are not a property of a harness. They are a property of a harness **at a version**,
and Mercury currently knows neither half of that.

### 13.1 What was measured

Versions installed on the machine this design was written on, and the version each feature
actually landed in, taken from each project's own history rather than its docs:

| Harness | Installed | Feature | Introduced | Mercury can use it |
| --- | --- | --- | --- | --- |
| PrimeAgent | 0.9.4 | `/goal` (interactive) | 0.0.1 — 2026-05-18 | no — interactive only |
| PrimeAgent | 0.9.4 | `--goal`, `--goal-token-budget` | **0.3.3 — 2026-07-23** (PR #514) | **yes** |
| Hermes | v0.20.5 (2026.8.19), upstream `933c209e` | `/goal`, `GoalContract`, gates | not determinable locally | **no** |
| Claude Code | 1.0.3 at `/opt/homebrew/bin/claude` | none — no goal surface in `--help` | — | no |
| Claude Code (same machine, second install) | 2.1.260 at `/Users/roman/.local/bin/claude` | none | — | no |

Three things fall out of this table, and they are three different problems.

**The same harness has several goal features with different thresholds.** PrimeAgent has had
`/goal` since its first release, but the headless flags Mercury needs arrived 14 minor
versions later. A matrix that recorded "PrimeAgent: goals yes" would be true and useless —
it would green-light a `--goal` invocation against a 0.2.x install that would reject the
flag at parse time.

**Hermes' introduction version cannot be determined from this install.** The checkout is a
shallow clone: one commit, no tags, no changelog. That is not a gap to fill in later, it is
a fact about how the harness ships, and the design has to survive it.

**A version number means nothing without the path it came from.** This machine has two
Claude Code installs, and neither the harness name nor `PATH` says which one Mercury runs.
That is the third problem, and [13.3](#133-mercury-does-not-know-harness-versions-at-all)
deals with it. It is also the reason both Claude rows are kept: the row that matters is the
one at the configured path, and recording only that one would hide the trap.

### 13.2 The rule the table forces

**The matrix describes what Mercury can do with a harness at a version, not what the harness
can do.** Hermes has goals. Mercury cannot reach them. A matrix keyed on harness capability
would record `hermes: goals yes`, and Mercury would send a goal, get no status back, and
report a Run as goal-tracked when nothing was tracked. That is issue #459 — an advertised
capability the serving path does not honour — rebuilt inside the compatibility table.

So every row is keyed on a **Mercury-usable feature**, and "the harness supports it" is not
sufficient evidence for a row. The Hermes row is `no` *because of section 7*, and it stays
`no` until one of section 7's options lands, regardless of how capable `goals.py` is.

### 13.3 Mercury does not know harness versions at all

There is no version detection anywhere: no adapter invokes `--version`, and neither `Run`
nor the agent registry carries a harness version. The only `version` fields in the domain are
`ResolvedSkill.version` and `RunSkill.skillVersion`, which are about skills.

So the matrix has a prerequisite before it can be consulted: **the adapter has to learn
which harness it is talking to.**

- **Probe once, cache, and record it on the Run.** `<cmd> --version` at adapter
  construction, not per Run. Store the resolved version on the Run so a later diagnosis
  knows what actually executed it — the absence of that datum is what made issue #465 hard
  to close, where the fix was on `main` and the installed artifact was still broken.
  **Implemented** (migration v7: `agent_version`, `agent_version_raw`, `agent_version_recorded`).
  The worker reads the registry CACHE at claim time, so this costs a map lookup and not a
  subprocess per Run. Written at most once: the value describes the binary that ran, so a later
  probe must not rewrite it, and a Run that recorded nothing stays unknown rather than being
  filled in from a probe taken after the Run may have seen an upgrade. `agent_version_recorded`
  exists because "never written" and "probed, no answer" are both NULL and must behave
  differently -- a test written to prove "record once" against a bare NULL check found that.
- **Probe the configured command path, never the bare name.** This is not hypothetical:
  the machine this design was written on has two Claude Code installs, 1.0.3 at
  `/opt/homebrew/bin/claude` (an npm global) and 2.1.260 at
  `/Users/roman/.local/bin/claude` (a native installer under `~/.local/share/claude/`).
  A shell's `claude --version` answers with whichever its `PATH` happens to resolve first,
  which is a different answer in two terminals on one machine. Mercury is configured with
  `MERCURY_CLAUDE_CMD=/opt/homebrew/bin/claude`, so 1.0.3 is the version that matters and
  2.1.260 is a fact about a binary Mercury never executes. Probing `claude` instead of the
  configured path would report a version for the wrong program and then gate features
  against it. The same applies to every adapter: probe `cmd`, record what it resolved to.
- **Parse per adapter, not universally.** The three version strings in the table above are
  `0.9.4`, `v0.20.5 (2026.8.19) · upstream 933c209e`, and `1.0.3`. One shared semver parser
  would fail on Hermes' date component and its trailing upstream sha. Each adapter owns the
  parse for its own harness and yields a comparable value plus the raw string.
- **Keep the raw string.** The parsed value drives comparison; the raw string is what goes in
  the event and the UI, because when a parse is wrong the raw string is the only evidence of
  why.

### 13.4 The matrix

Declarative, per adapter, keyed on Mercury-usable features with a minimum version each:

```ts
/** Feature names are Mercury's, and mean "Mercury can exercise this against this
 *  harness" -- NOT "this harness has this feature". See 13.2. */
export interface AgentGoalSupport {
  /** Mercury can set an objective at launch. */
  set?: string;             // minimum harness version, or absent = never
  /** Mercury can observe objective status. */
  track?: string;
  /** Mercury can pass a token budget through. */
  tokenBudget?: string;
  /** Objective carries a verification contract. */
  contract?: string;
  /** Deterministic gates are reported back to Mercury. */
  gates?: string;
  /** A per-goal turn cap can be passed through. */
  maxTurns?: string;
}
```

| Agent | `set` | `track` | `tokenBudget` | `contract` | `gates` | `maxTurns` |
| --- | --- | --- | --- | --- | --- | --- |
| `primeagent` (rpc) | `0.3.3` | `0.3.3` | `0.3.3` | — | — | — |
| `primeagent` (daemon) | — | — | — | — | — | — |
| `hermes` | — | — | — | — | — | — |
| `claude` | — | — | — | — | — | — |
| `fake` | — | — | — | — | — | — |
| declarative local/rpc/remote | from config | from config | from config | from config | from config | from config |

A dash means *never*, not *unknown* — the difference matters, because `never` is a
statement Mercury can render as a reason and `unknown` is not.

`contract` and `gates` are `—` for PrimeAgent deliberately: it has no equivalent concept, so
Mercury must reject those fields rather than accept and drop them. **This is enforced, not
advisory** -- admission resolves every goal field against its own column, because asking only
"can this agent carry a goal" let `goal.gates` through for an agent that has no gates.

`maxTurns` is `—` for every shipped adapter, which is a correction rather than a new
restriction. Section 5 says it "maps to Hermes `--goal-max-turns`", but the only Hermes turn cap
that works today is the global `MERCURY_HERMES_MAX_TURNS`, applied to every Run whether or not
it carries a goal; there is no `max_turns` column and no adapter receives a per-goal value. So
`goal.maxTurns` was validated and then dropped -- accepted and silently not honoured. It is
refused until an adapter declares the column. Hermes has both concepts
and still gets `—`, per 13.2.

**The declarative adapters must take this from config.** `LocalAgentAdapter`,
`RpcAgentAdapter` and `RemoteAgentAdapter` exist to add agents without per-agent code, so a
hardcoded per-class table would leave them permanently unable to declare support — which
would quietly make every third-party agent second-class. Mercury cannot know a third-party
CLI's feature history; the operator configures it, and Mercury's job is to verify the claim
against the detected version rather than to trust it blindly.

### 13.5 Unknown version fails closed, and never blocks the Run

This is the part most likely to be implemented wrong, so both halves are load-bearing.

**Fail closed on capability.** If the probe fails, the output does not parse, or the version
is older than the threshold, the feature is unavailable. Unknown must not mean assume-yes —
that is #459 — and it must not mean assume-newest either, since the newest version is the
one an attacker or a stale mirror could claim.

**But capability failure must degrade the feature, never the Run.** An unparseable or
unexpectedly-new PrimeAgent must not stop Mercury running it. The Run proceeds, the goal is
rejected at creation with a reason, and the operator sees why. Refusing to execute an agent
because its version string changed would brick every harness upgrade until Mercury's parser
caught up, which is a far worse failure than a goal nobody can set.

The error names the fix, because "unsupported" without a threshold is not actionable:

```
400 goal requires primeagent >= 0.3.3; detected 0.2.7 (/Users/x/.local/bin/prime-agent).
    Upgrade the harness or omit `goal`.
```

And the two failure modes stay distinguishable in the UI, because they want different
responses: *too old* means upgrade, *cannot tell* means fix the probe.

### 13.6 Surfacing it

`GET /api/agents` returns bare strings today, so neither the UI nor `mercuryctl` can know
what a server accepts. Add a parallel field rather than reshaping `agents: string[]`: the
dashboard's `loadAgents()` does `if (!Array.isArray(agents)) return;` and would silently fall
back to two hardcoded options.

```json
{
  "agents": ["fake", "primeagent"],
  "defaultAgent": "fake",
  "capabilities": {
    "primeagent": {
      "version": "0.9.4",
      "versionRaw": "0.9.4",
      "goals": { "set": "0.3.3", "track": "0.3.3", "tokenBudget": "0.3.3" },
      "goalSupported": true
    },
    "hermes": { "version": null, "goals": {}, "goalSupported": false,
                "goalReason": "no non-interactive goal interface" }
  }
}
```

`mercuryctl agents list` gains a goal column — that command exists precisely so an operator
can discover what a server accepts before writing a create request. The UI disables the goal
fields with the reason attached rather than hiding them, and refuses to switch to an
unsupported agent while a goal is filled in rather than silently discarding the input.

The client may warn from cached capability data, but **the server's `400` stays the
authority.** A client-side check alone means a stale cache silently drops a goal, which is
the same defect one layer up.

### 13.7 Keeping it honest

A matrix is a table that goes stale, and a stale table is worse than none because it looks
authoritative.

- **A guard test asserts every registered adapter has a matrix entry**, so adding an adapter
  without declaring goal support fails CI instead of defaulting to a guess.
- **Thresholds are verified against a real binary, not asserted.** The `0.3.3` row came from
  PrimeAgent's own changelog; the next one should come from the same kind of evidence, and
  the doc that records it should cite it.
- **Undetermined is a legal value, and it must render.** Hermes' introduction version is
  unknown and the matrix still works, because the Hermes row is `never` for reasons that do
  not depend on it. Do not invent a version to fill a cell.

## 14. Decisions and remaining questions

### Decided

**`objective` defaults to the Run's `task`.** Supplying `goal: {}` means "track whether
the task was achieved", which is the common case and should not require restating the
task. The risk weighed against this was implying a judgement had been made when only an
instruction was given; it does not apply, because the caller still opts in by sending
`goal`, and the judgement remains the harness's. The resolved value is stored, so
`GoalState.objective` is never empty and a reader can always see what was actually
judged.

**`paused` is a Fleet alert requiring human interaction**, not a status cell. Reasoning in
[section 8](#8-api).

**No goals on Crew templates.** Templates carry persona; objectives are per-Run work.
Reasoning in [section 12](#12-non-goals).

### Still open

**Does `unmet` fire often enough to matter?** Needs investigation, and Phase 1 now ships
the counter that answers it rather than leaving the question to anecdote.

Two further questions surfaced while checking the capability surface, and unlike these
they block implementation rather than funding:

1. **Where does goal capability come from?** Largely answered by
   [section 13](#13-compatibility-matrix): declarative per-adapter thresholds keyed on
   Mercury-usable features, config-supplied for the declarative adapters, surfaced as a
   parallel `capabilities` field, failing closed. What remains is the shape of the
   config key for `LocalAgentAdapter`/`RpcAgentAdapter`/`RemoteAgentAdapter`, and whether
   the version probe runs at adapter construction or lazily on first use.
2. **When must `unmet` NOT fire?** A Run cancelled or timed out before the worker claimed
   it never started its goal. Emitting `unmet` there is noise, and noise on the single
   signal Phase 1 exists to produce would discredit the feature before the counter in
   section 10 could be trusted.

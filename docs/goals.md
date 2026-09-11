# Goals: setting objectives on a Run and tracking whether they were met

**Status: design only. Nothing here is implemented.** No `goal` column, no `goal.*`
event type, no `--goal` plumbing exists in Mercury today.

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
| Status values | `idle`, `active`, `paused`, `complete`, `cancelled` |
| Budget | token budget; `null` means unbounded |

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
| `COMPLETED` | `paused` | harness gave up judging (budget, broken judge); needs a human |
| `FAILED` | `complete` | the work finished and something else broke afterwards |
| `TIMED_OUT` | `active` | wall-clock deadline hit mid-objective |
| `COMPLETED` | `absent` | today's behaviour; no judgement was made |

The second row is the reason to build this. Nothing in Mercury today can express it.

### Goal status vocabulary

Mercury needs one vocabulary that both harnesses map into. It is a superset of
PrimeAgent's and Hermes', with two additions:

| Mercury | PrimeAgent | Hermes | Meaning |
| --- | --- | --- | --- |
| `absent` | — | — | no goal on this Run |
| `active` | `active` | `active` | objective open |
| `paused` | `paused` | `paused` | loop stopped, needs attention; `pausedReason` says why |
| `complete` | `complete` | `done` | the harness judged the objective met |
| `cancelled` | `cancelled` | `cleared` | a human or the harness dropped it |
| `unmet` | — | — | **Mercury-side, and never silent**: the Run reached a terminal status while the goal was still `active` |

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
  objective: string;              // required, non-empty, 1..4000 chars
  contract?: GoalContract;
  gates?: GoalGate[];
  tokenBudget?: number;           // positive integer; absent = unbounded
  maxTurns?: number;              // maps to Hermes --goal-max-turns; ignored by PrimeAgent
}

export type GoalStatus = 'absent' | 'active' | 'paused' | 'complete' | 'cancelled' | 'unmet';

export interface GoalState {
  status: GoalStatus;
  objective: string;
  contract?: GoalContract;
  gates?: GoalGate[];
  tokensUsed?: number;
  timeUsedSeconds?: number;
  remainingTokens?: number | null;
  lastVerdict?: 'done' | 'continue' | 'skipped';
  lastReason?: string;            // harness-supplied, bounded, redacted
  pausedReason?: string;
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
  time_used_ms   INTEGER,
  turns_used     INTEGER,
  last_verdict   TEXT,
  last_reason    TEXT,
  paused_reason  TEXT,
  source         TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
```

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
| `goal.updated` | `{ status, tokensUsed?, turnsUsed?, lastVerdict?, lastReason? }` | a `goal_update` arrives from a harness |
| `goal.paused` | `{ pausedReason, turnsUsed? }` | harness paused the loop |
| `goal.complete` | `{ tokensUsed?, timeUsedSeconds?, completionBudgetReport? }` | harness declared the objective met |
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
  400 when: objective empty/oversized; gate timeoutMs missing or non-positive;
      goal supplied for an agent with no goal support (see section 7)

GET  /api/runs/:id/goal      -> { goal: GoalState }        (404 when absent)
POST /api/runs/:id/goal/cancel -> { goal: GoalState }      (operator override)
```

Deliberately **no** `POST /api/runs/:id/goal/complete`. Only the harness may declare an
objective met; an operator override would put a Mercury-originated `complete` in the
same field as a harness judgement, and the two would become unreadable apart. An
operator who disagrees cancels the goal and says so in a comment; the record then shows
a human decision rather than impersonating a machine one.

Goals are settable only at creation. Setting one mid-run would require an input channel
into the harness session that does not exist for either backend.

`goal` and `task` are both required to be non-empty and mean different things: `task`
is the instruction the agent starts on, `objective` is the condition for stopping. For
most Runs they will be near-identical, and that is fine — the contract fields are where
the difference earns its keep.

**Fleet** proxies goal endpoints to the host rather than owning a second store, for the
same reason Crew templates do: otherwise the host that executed the Run stops being the
authority on what it executed.

## 9. Budgets: the thing that could actually be enforced

`budgetTokens` is recorded-only today because nothing reports usage. PrimeAgent's
`goalState` reports `tokens_used` and `time_used_seconds` per goal, and emits them
incrementally via `goal_update`.

That is the missing input for issue #63. Once Mercury stores per-goal usage it can
enforce `budgetTokens` in the drive loop next to the `maxDurationMs` deadline — exactly
where [types.ts](../src/domain/types.ts) says enforcement belongs.

Two cautions, because this is where a plausible design goes wrong:

- Goal usage is **not** Run usage. A goal covers the turns the harness attributes to
  it; a Run may do work outside the goal. Enforcing a Run budget from goal usage would
  be a silent mismatch. Either enforce against goal usage and rename the field to say
  so, or keep them separate. Do not quietly substitute one for the other.
- Hermes reports no usage at all, so any enforcement is PrimeAgent-only until the
  adapter gap in section 7 closes.

## 10. Plan

Ordered; each phase ships something usable on its own.

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
expressed. Ship it and look at real Runs before building more — if almost nothing ever
goes `unmet`, the feature is answering a question nobody asked.

**Phase 2 — PrimeAgent end to end.**
`PrimeAgentAdapter` passes `--goal` / `--goal-token-budget`; translates `goal_update`
into `goal.updated` / `goal.paused` / `goal.complete`; persists state. PrimeAgent is the
only backend that can do this today, so it is where the design gets proven.

**Phase 3 — surface it.**
Dashboard shows goal status beside Run status with the two never substituted;
`mercuryctl runs get` prints both; SSE timeline renders goal events. The rendering rule
is a requirement, not a polish item: a UI that shows `COMPLETED` and hides `unmet`
reproduces the original problem with extra steps.

**Phase 4 — gates.**
Validate and persist gate specs; render harness-reported gate outcomes. No Mercury-side
execution.

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
| 0 | — | types, migration, validation, honest rejection | — |
| 1 | 0 | `goal.unmet` — works for every adapter | — |
| 2 | 0, 1 | PrimeAgent goals set + tracked | — |
| 3 | 1, 2 | dashboard, `mercuryctl`, SSE | — |
| 4 | 0 | gate specs recorded and rendered | — |
| 5 | 2 | Hermes goals | upstream `--goal` on `chat`, or a scoped kanban route |
| 6 | 2 | `budgetTokens` enforcement (issue #63) | real per-run usage data |

Phases 0–3 are the whole useful product. Phase 1 alone may justify the feature, and it
is a small change to the finalisation path.

## 12. Non-goals

- **Mercury does not judge completion.** Principle 1.
- **No goal hierarchy, no sub-goals, no goal graphs.** One objective per Run. Team
  level objectives belong to [`crew/teams.md`](crew/teams.md) if they belong anywhere.
- **No cross-Run goals.** A goal lives and dies with its Run; retry gets its own.
- **No goal-based scheduling or placement.** That is Crew's job.
- **No mid-run goal mutation.**
- **No operator-authored `complete`.**
- **No Mercury-side gate execution.**
- **No reuse of `NEEDS_INPUT` for `paused`.** `paused` is the harness telling us it
  stopped judging; `NEEDS_INPUT` is the agent asking the operator a question. Folding
  them together would make both unreadable.

## 13. Open questions

1. **Does `unmet` fire often enough to matter?** Measure after Phase 1 before funding
   Phase 3. If it is rare, the display work is still worth it; if it never fires, the
   feature is decoration.
2. **Should `objective` default to `task`?** Convenience against the risk of implying a
   judgement was made when only an instruction was given.
3. **How should `paused` surface in Fleet's aggregate views** — as a Run state, a goal
   state, or an alert? It is the one status that implies a human should act.
4. **Does a goal belong on a Crew template?** Templates carry persona; an objective is
   per-Run work. Probably no, but the boundary should be stated rather than assumed.

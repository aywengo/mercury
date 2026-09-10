# Agent Teams — mixed-harness orchestration

Status: **design only.** Nothing here is implemented. Refines
[`workflows.md`](workflows.md) under one added requirement: a team is
**heterogeneous on purpose**.

## 1. The requirement

A Crew is not one harness running several personas. It is different harnesses
collaborating, each doing what it is best at, because each is genuinely better at
something:

| Stage | Good fit | Why |
| --- | --- | --- |
| Ops triage, long unattended run | Hermes | persistent persona, `kanban` scheduling, gateways, cron |
| Deep multi-file code change | PrimeAgent | strong tool-calling, RPC events, resume, skills |
| Independent review | Claude or a second PrimeAgent session | fresh context, no author bias |
| Small mechanical fix | Pi / Oh my Pi | cheap and fast, if capability checks pass |

Concretely: a Hermes persona notices a failing service, opens a task; PrimeAgent
makes the fix in an isolated workspace; a third agent reviews; the Hermes persona
reports back. Three harnesses, one durable record.

That is the value. It is also the reason placement needs the capability and
affinity model in [`harness-capabilities.md`](harness-capabilities.md) — without
it, "pick the best harness" is a comment in a config file.

## 2. What a Team is

A **Team** is a bounded, ordered set of ordinary Runs, each bound to an Agent
Template, placed on a host and harness by Fleet, with explicit handoff and gate
rules.

- The Run stays the durable unit of work. A Team is a parent record that
  references child Runs. No state-machine change (invariant: transitions go
  through `RunStore.transition`).
- Bounded and explicit, per `README.md` non-goals: no arbitrary DAG scheduler, no
  timers, no human-task inbox in v1.
- Handoff is through Run records and workspace artifacts only. No shared mutable
  workspace, no Mercury-level agent-to-agent channel (NG4 stands).

## 3. Every harness is a sub-team

A harness is not a backend that receives Mercury's configuration. It is a
**sub-team** with its own namespace, its own registry and its own idea of what a
skill is. The team level must not name things inside a sub-team's namespace.

This is not a stylistic preference. It is forced by a reproduced failure.

Mercury auto-selects skills from **its own** registry and hands the resulting ids
to whichever harness the Run targets. `skillSelector` ends with
`return picked.length > 0 ? picked : FALLBACK.filter(...)`, so a Run **always**
carries at least one skill — a task that matches nothing still gets the fallback
set. Verified: `"Say hello."` selects `planning, implementation, testing, git-pr`.

Those ids then mean different things per harness:

| Harness | How skills arrive | Namespace |
| --- | --- | --- |
| PrimeAgent | `--skill <workspace path>` | files Mercury materialized into the workspace |
| Hermes | `-s <name>` | Hermes' own installed skill store |

Hermes has 81 installed skills. None of them is named `planning`,
`implementation`, `testing` or `git-pr`. Hermes rejects an unknown name and exits
non-zero, so the Run fails in under a second:

```
agent.message  {"text": "Error: Unknown skill(s): git-pr, implementation"}
run.failed     {"error": "Agent exited with code 1 (signal none)", "durationMs": 766}
```

Because the fallback guarantees at least one skill, and the API offers no way to
request zero skills, **Hermes cannot execute any Run through Mercury as it stands.**
PrimeAgent works only because Mercury materializes skills into the workspace and
passes paths, which happens to be the namespace PrimeAgent reads.

So the boundary is:

- **Team level** speaks capabilities and intents only — `persona.append`,
  `code-edit`, `needs-review`. Never a skill name, never a model id, never a flag.
- **Sub-team level** (one per harness) owns resolution inside its own namespace:
  which of *its* skills satisfy an intent, where its persona goes, what its model
  is called there.
- **Handoff** between sub-teams is artifacts and Run records, as before.

Two consequences for the roadmap:

1. Skill selection moves out of `RunService` and into the sub-team resolver. A
   Run records the *intent*, and each sub-team records what it resolved that
   intent to. This also makes the snapshot honest: today the snapshot stores
   Mercury skill ids that a foreign harness cannot dereference.
2. A Run must be able to carry zero skills. Today it cannot, which turns a
   namespace mismatch from a degraded run into a guaranteed failure.

## 4. Do not rebuild Hermes kanban

Hermes already ships intra-host team scheduling, verified from its CLI:

> `hermes kanban` — "Durable SQLite-backed task board shared across Hermes
> profiles. Tasks are claimed atomically, can depend on other tasks, and are
> executed by a named profile in an isolated workspace."

with `swarm`, `dispatch`, `daemon`, `claim`, `decompose`, `specify`,
`request-review`, `request-changes`, `link`/`unlink` dependencies.

Reimplementing atomic claim and dependency scheduling inside Mercury would
duplicate it and do it worse, since Mercury has no profile system. So split by
scope:

- **Mercury Team** owns the durable, cross-host, multi-harness record: which
  stages exist, where each ran, what handoff produced, what gate decided. This is
  the part kanban cannot do — it is single-host SQLite and Hermes-only.
- **A Hermes host may execute one Team stage as a kanban swarm.** Mercury sees one
  Run whose events contain the sub-structure. Adapter-translated, exactly like
  every other backend difference.

The rule: Mercury owns the record of coordination; a backend may own the
mechanics of coordination inside one stage.

## 5. The auditability problem this creates

Hermes has native cross-machine agent messaging:

> `hermes peer dm <peer>[/<agent>]` — "delivers into the remote agent's canonical
> Bot Chat over the peer's API server and prints the reply."

If a Hermes stage uses `peer dm`, agents are talking to each other outside
Mercury's view. That is compatible with NG4 only if it stays invisible to the
contract, which it cannot: work performed by another host's agent, invisible in
events, breaks the guarantee that a Run's events explain what happened.

Decision needed before building. Options:

1. **Forbid** `peer dm` inside a managed stage (enforce how? `--ignore-rules` does
   not remove tools).
2. **Allow and require surfacing** — the adapter records peer deliveries as
   Run events. Honest, but it makes Mercury a party to a vendor protocol.
3. **Restrict Teams to Mercury-mediated handoff** and treat peer/kanban-swarm as
   operator choice outside a managed Team, accepting a weaker audit trail.

Recommend 3 for v1: it keeps the guarantee cheap, and states plainly that a
self-organizing Hermes swarm is not a Crew Team.

## 6. Placement across a mixed team

Each stage declares required capabilities and an affinity domain, not a harness
id. Fleet resolves stage → harness → host:

1. Hard-filter hosts whose advertised harness has the required capabilities.
2. Rank by affinity, then capacity (`/healthz/workers`), then labels and locality.
3. Record the decision and its reason on the stage.

A stage that requires `persona.append` must never land on a harness that silently
ignores persona. Silent degradation produces a Run that completed and did the
wrong thing, which is the worst failure mode available here.

## 7. Phase order

1. **Phase 0 — per-Run capabilities** (`appendSystemPrompt`, `workspaceFiles`,
   `model`) on at least PrimeAgent and Hermes, proven by a real Run whose output
   depends on the persona. Everything else is inert without this.
2. **Phase 1 — capability advertisement** on `/api/agents`, plus a version or
   capability field on `/healthz`.
3. **Phase 2 — Agent Templates** stored and snapshotted
   ([`agent-templates.md`](agent-templates.md)).
4. **Phase 3 — Teams**: bounded stages, mixed harnesses, artifact handoff.
5. **Phase 4 — kanban delegation** for Hermes stages, after the §4 decision.

Phase 0 and 1 are small, independently useful, and they are the ones that make
the heterogeneous idea real rather than aspirational.

## 8. Not designed here

Cost and token metering (`budgetTokens`/`budgetCost` are recorded-only until
adapters report usage); network egress allowlists (`allowedNetworks` is `none` or
`bridge`, not a hostname list); template-level RBAC beyond owner scoping; and any
UI for authoring personas.

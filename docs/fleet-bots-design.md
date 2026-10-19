# Fleet and dispatcher bots — one master for many hosts

Status: **design accepted 2026-10-16; nothing here is implemented.** Option A is the direction,
and the four open decisions are settled (§9). It covers how bots relate to Fleet, and how Fleet
learns which hosts can actually run a Crew Run. Issue set: [`fleet-bots-issues.md`](fleet-bots-issues.md), filed as #970–#974. §2 describes the tree as verified on `main` at `89014c7`
(2026-10-16); everything after it is intended behaviour.

## 1. The goal

Run Crew (presets, workflows), host bots and the dispatcher bot on every Mercury host, with Fleet
as the single place that decides where work runs. Today each half exists separately:

- **Fleet** (phases 0–6 shipped) dispatches, reconciles, streams, routes, relays input/cancel/retry
  and rolls up metrics across hosts. It is a *client* of each host (`fleet-design.md` §2).
- **Dispatcher bots** (B0–B1 shipped) are host-resident schedulers that are *clients of their own
  host* (`dispatcher-bot-design.md` §3). One nightly bot runs today, on one host.

The two never meet. This document decides how they meet, and closes the routing gap that
appears as soon as several hosts carry different Crew registries.

## 2. What the tree does today (verified)

| Fact | Where | Consequence |
| --- | --- | --- |
| A bot sees and acts on exactly one host; cross-host routing is Fleet's job | `dispatcher-bot-design.md:79` | Bots cannot use Fleet |
| A bot talks to its host through `SchedulerClient`, which has two calls: `listOwnRuns` (paged, owner-scoped) and `createRun` (POST `/api/runs` with an `Idempotency-Key`) | `src/host/bots/scheduler.ts:64-73` | The seam a Fleet client would implement is small |
| The bot's API base is `cfg.api.url`, defaulting to the local host | `src/host/bots/process.ts:59` | A bot can already be pointed at another URL, but Fleet's API is `/fleet/runs`, not `/api/runs` |
| Fleet forwards the request body to the chosen host unchanged, apart from `host`, `idempotency` and a rewritten `repository` | `fleet/server.ts:318-322` | `preset`, `workflow`, `model` and `selection` already pass through |
| Fleet routes on explicit host, agent, label selector, repository locality and capacity | `fleet/routing.ts:19-26` | It does **not** know which presets, workflows or skills a host has |
| The prober reads `/healthz`, `/healthz/workers` and `/api/agents` per host | `fleet/probe.ts` | Registries are never probed |
| Fleet authenticates its callers and scopes them to hosts (`hostAllowed`) | `fleet/server.ts` | A bot calling Fleet needs a Fleet caller identity |
| `GET /fleet/runs` returns every binding on the caller's visible hosts in one unpaged response; it is scoped by **host**, not by owner | `fleet/server.ts:349-353` | A bot's single-flight check would see other callers' Runs. FB2 needs an owner filter and paging |
| `GET /api/workflows` does not exist on `main`; it arrives with W-3 | PR #934 | Workflow availability can only be probed once W-3 is merged |

So a Run that names `preset: {id: "reviewer"}` is routed by agent and capacity alone. If the
chosen host lacks `reviewer`, or has a different version, the Run is refused **on that host**
after placement. Fleet then reports a host error for a request another host could have served.

## 3. Goals and non-goals

**Goals**

1. A bot can dispatch through Fleet instead of its own host, with the same idempotency, owner
   scoping and single-flight guarantees it has today.
2. Fleet places a Crew Run only on a host that has the named preset or workflow at the
   requested version, and says so when no host qualifies.
3. Nothing changes for a bot or a Run that does not opt in.

**Non-goals**

- **Fleet as a scheduler.** Cron, triggers and the LLM brain stay in the bot (`fleet-design.md`
  §10: Fleet is not a workflow engine). See option B in §4.
- **Shared storage or a multi-host control plane.** Hosts keep their own databases; #925's
  storage question does not apply to this design.
- **Registry sync.** Fleet does not push presets, workflows or skills to hosts. Hosts are
  provisioned by the host installer; Fleet only *observes* what each host has.
- **Multi-tenant Fleet.** Covered by `fleet-tenancy-design.md` (T0–T2). This design assumes one
  operator and works unchanged once tenancy lands.

## 4. Options for bots and Fleet

### Option A — bots stay on the host and may dispatch through Fleet (decided)

The bot keeps its schedule, triggers, brain and state where they are. Only the *dispatch target*
changes. A bot config gains:

```json
"api": { "url": "http://127.0.0.1:3000", "via": "host" }   // today's behaviour, the default
"api": { "url": "https://fleet.lan:4100", "via": "fleet" }   // dispatch through Fleet
```

With `via: "fleet"`, the bot uses a `FleetSchedulerClient` that implements the same two calls:

| `SchedulerClient` | Through Fleet |
| --- | --- |
| `createRun(req)` | `POST /fleet/runs` with the same body plus optional `labels` / `host`; the derived key goes in `Idempotency-Key`. A `201` or a replayed `200` both map to `{ runId: fleetRunId, replayed }`. |
| `listOwnRuns(limit, cursor)` | `GET /fleet/runs?owner=self&limit=&cursor=`. This needs a Fleet change (FB2): today the list is unpaged and scoped by host, so a bot would count other callers' Runs against its own single-flight |

Status mapping: Fleet's `UNKNOWN` (host unreachable, binding not confirmed) counts as
**non-terminal** for single-flight. A Run Fleet cannot see must still block the next fire, for the
same reason a parked `NEEDS_INPUT` does (`scheduler.ts:66-69`).

**Why this option**

- The change is confined to one interface with two calls; the scheduler, triggers and brain don't
  change.
- It keeps both documented boundaries: Fleet stays a client and not a scheduler, and a bot still
  acts through one API.
- It degrades cleanly: if Fleet is down, the bot's fire fails, is logged and is retried next tick,
  the same as a host outage today.

**Costs**

- One more credential per bot: a Fleet caller token, stored in `bot-credentials.json`. It needs no
  host tokens.
- Idempotency now spans two layers. The bot's key becomes Fleet's client token, and Fleet derives
  the host key from it (already the case for every Fleet caller).

### Option B — Fleet owns bot configs and runs the schedules

Fleet stores bot configs, evaluates cron and triggers centrally, and dispatches. Rejected for now:

- **Fleet becomes a scheduler.** That contradicts `fleet-design.md` §10.
- **Stateful duplication:** the brain's state, single-flight and trigger cursors would all move into
  Fleet's database.
- **Fleet becomes a single point of failure** for all scheduled work, including the nightly loop
  that maintains Mercury itself.

Revisit only if host-resident bots turn out to need cross-host coordination that Fleet's routing
cannot express.

### Option C — Fleet pushes bot configs to hosts; bots stay local

Fleet is the source of truth for bot configs and syncs them to each host's `bots/` directory.
It solves configuration drift, not dispatch. That's also the host installer's job (B4, #915), and
it would give Fleet write access to every host's config tree. It's out of scope here; reconsider
after B4 ships, if keeping configs aligned by hand proves painful.

## 5. Availability-aware routing

### 5.1 What Fleet learns

The prober adds two reads per host, on its existing timer and with the same credential:

- `GET /api/presets`, which returns `id`, `version`, `enabled`, `contentHash` for every preset;
- `GET /api/workflows`, which returns the same fields for every template.

Fleet stores the result per host as an **availability snapshot** with a probe timestamp. A failed
read keeps the previous snapshot marked stale. It is never treated as empty, because "host has
nothing" and "Fleet could not see" must not look the same (`fleet-design.md` §7).

### 5.2 How routing uses it

`RouteRequest` gains the request's Crew references, derived from the body (never trusted from a
separate field): `preset: {id, version?}` or `workflow: {id, version?}`. The router adds one hard
filter:

- **No snapshot** for the host → excluded, reason `availability unknown`.
- **Reference missing, disabled, or at another pinned version** → excluded, reason
  `preset reviewer@1.2.0 not available (host has 1.1.0)`.
- **Unpinned reference** (`preset: {id}`) → matches any **enabled** version the host has (§9.2).
- **Stale snapshot** (older than `FLEET_AVAILABILITY_STALE_MS`, default 3× the probe interval, §9.3) → kept, with a finite soft-rank
  penalty smaller than `KNOWLEDGE_STALE_PENALTY`, and named in `softRankNote` when it decides the
  outcome. Stale data can still be right, so it should rank lower rather than be refused.

Explicit placement (`host`) still wins, without filtering. That's the escape hatch `fleet-design.md`
§6 keeps for every filter.

When every host is excluded, the `RoutingError` lists each host with its reason, as it already
does for agent and label filters. The caller sees "no host has workflow plan@2.0.0", not a host's
400.

### 5.3 Relation to harness affinity and Laya L2

Affinity (#953, #864) answers "which agent is *good at* this", and Laya L2 (#904) classifies the
task. Both are **soft** signals. Availability is a **hard** fact: a host without the preset cannot
run the Run at all. The filter order is fixed:

1. hard filters: agent, labels, locality, availability;
2. soft rank: capacity, knowledge freshness, availability staleness, later affinity and L2.

A soft signal never resurrects a host a hard filter removed.

## 6. Identity and credentials

- **The bot's Fleet token** lives in `bot-credentials.json` under the bot's alias, in the same
  0600 file and through the same reader. Fleet scopes the caller to the hosts it may use.
- **Host credentials never reach the bot.** Fleet holds them, as it does for every caller
  (`fleet-design.md` §9).
- **The strict no-profile default (#954) applies on the host that runs the Run,** not at Fleet. A
  bot dispatching through Fleet does not choose credentials. The host resolves the profile from
  the Run's repository, as it does for a local dispatch.

## 7. Failure semantics

| Situation | Bot sees | Single-flight | Next fire |
| --- | --- | --- | --- |
| Fleet unreachable | `createRun` throws | unchanged | retried at the next tick |
| Fleet routes, host refuses | 4xx with the host's reason | no Run recorded | the same request fails again; the bot logs it once per process (the same rule as an L1-4 record refusal) |
| Host unreachable after binding | Run `UNKNOWN` | **blocks** | waits until the sweep resolves it |
| No host qualifies | 4xx with every exclusion | no Run | logged with the exclusion list |

## 8. Milestones

Each milestone is one issue and one PR (`issue-fix-loop`), with tests that fail on base.

**FB0 — availability snapshot (Fleet).** The prober reads `/api/presets` and `/api/workflows`;
snapshots are stored per host with a timestamp; a failed read keeps the last snapshot as stale.
*Acceptance:* a probe of a host with two presets stores both with hashes; a failed read leaves
the previous snapshot marked stale, never empty. Workflows are probed once W-3 (#934) has
shipped `GET /api/workflows`; until then the workflow half of the snapshot is absent and the
filter treats workflow references as `availability unknown`, which only explicit placement bypasses.

**FB1 — availability routing filter (Fleet).** The §5.2 rules, as a pure function in
`fleet/routing.ts`, with exclusion reasons. *Acceptance:* the hard filter excludes a host
without the preset and names the reason; the stale penalty is finite and explained in
`softRankNote`; an explicit `host` bypasses the filter; "no host qualifies" lists every
exclusion.

**FB2 — `FleetSchedulerClient` (bots), plus owner-scoped paging on `GET /fleet/runs`.**
`api.via: "fleet"` in the bot config schema, plus the client implementing `createRun` and
`listOwnRuns` against Fleet, with the `UNKNOWN` mapping. On the Fleet side, `GET /fleet/runs`
gains `owner=self`, which filters bindings to the caller's `ownerId`, and keyset paging. Both are
additive, so existing callers see the same response.
*Acceptance:*

- a bot fire through a fake Fleet creates exactly one Fleet Run, and a crash-retry with the same
  key replays it;
- another caller's non-terminal Run on the same host does **not** block the bot's next fire
  (owner scoping);
- an `UNKNOWN` Run blocks the next fire;
- `via: "host"` (the default) is byte-identical to today.

**FB3 — end to end on two hosts.** An E2E tier with two real hosts behind one Fleet: a bot on
host A dispatches a workflow Run that only host B can run, and it lands on B. Gated on the
installer's fresh-VM verification (#929), because it needs two clean hosts.

**Dependencies:**

- W-3 (#934) for workflow Runs through the API;
- CP-4 (#897), so a host running several bots keeps identities apart;
- B4 (#915), so bots are installed on every host. FB2 doesn't need B4, but "every host" does.

## 9. Decisions (2026-10-16)

1. **Direction: option A.** Bots stay host-resident and may dispatch through Fleet
   (`api.via: "fleet"`). Options B and C are recorded as rejected for now (§4).
2. **Unpinned references match any enabled version.** `preset: {id}` or `workflow: {id}`
   without a version qualifies a host that has that id enabled at any version. A pinned version
   must match exactly. "Newest seen anywhere" was rejected: it would make placement depend on
   other hosts' contents.
3. **Stale threshold: 3× the probe interval.** This is the default for
   `FLEET_AVAILABILITY_STALE_MS`, the same shape as `FLEET_KNOWLEDGE_STALE_MS`.
4. **Read-only availability view per host.** `GET /fleet/hosts/:id/availability` returns the
   latest snapshot, its probe time and whether it is stale. It is scoped to the caller's visible
   hosts like every Fleet read, and ships with FB0.

## 10. References

- [`fleet-design.md`](fleet-design.md): §2 (client rule), §6 (routing), §7 (failure semantics), §9 (security), §10 (not a workflow engine)
- [`dispatcher-bot-design.md`](dispatcher-bot-design.md): §3 and line 79 (one host), B4
- [`crew/workflows.md`](crew/workflows.md), [`crew/role-presets.md`](crew/role-presets.md): what a reference names
- [`credential-profiles-design.md`](credential-profiles-design.md): strict default (#954)
- [`laya-integration-design.md`](laya-integration-design.md): §7, L2 as a soft signal

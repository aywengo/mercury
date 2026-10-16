# Fleet and dispatcher bots — issue set (FB0–FB3)

**Draft — not filed.** Written 2026-10-16 for [`fleet-bots-design.md`](fleet-bots-design.md),
after its §9 decisions. Each issue follows `issue-fix-loop`: one issue, one PR, with a
regression test that fails on base. `FB-n` labels are placeholders until filed.

## Dependency graph

```
FB0  availability snapshot + read view (Fleet)          ── needs W-3 (#934) for workflows only
 └─ FB1  availability routing filter (Fleet)
FB2a owner-scoped, paged GET /fleet/runs (Fleet)
 └─ FB2b FleetSchedulerClient + api.via (bots)
FB3  two-host end-to-end                                ── needs FB1, FB2b, #929 (fresh VM)
```

FB0 and FB2a are independent and can run in parallel. "Every host" also needs B4 (#915) and
CP-4 (#897), which are tracked separately.

---

## FB0 — Fleet: per-host availability snapshot and a read-only view

**Mechanism.** The prober reads `/healthz`, `/healthz/workers` and `/api/agents` only
(`fleet/probe.ts`). Fleet never learns which presets or workflows a host has.

**Fix.**
- The prober also reads `GET /api/presets` and, when the host serves it, `GET /api/workflows`,
  on the same timer and with the same credential and timeouts. The workflow endpoint arrives
  with W-3; a 404 there means "not served", which is not a failure.
- Fleet stores one snapshot per host: `{ presets: [{id, version, enabled, contentHash}],
  workflows: [...] | null, probedAt }`.
- A failed or partial read keeps the previous snapshot and marks it stale. A snapshot is never
  replaced with an empty list on error.
- `FLEET_AVAILABILITY_STALE_MS` defaults to 3× the probe interval (design §9.3).
- `GET /fleet/hosts/:id/availability` returns the snapshot plus `stale: boolean`, scoped to the
  caller's visible hosts (design §9.4).

**Acceptance.**
1. A probe of a host with two presets stores both, with versions and hashes.
2. A failed presets read leaves the previous snapshot in place, marked stale, never empty.
3. A host answering 404 on `/api/workflows` has `workflows: null`, and its probe still counts
   as healthy.
4. The view returns 404 for a host the caller cannot see.

**Regression test.** Acceptance 2 against a fake child. On base, no snapshot exists.

**Likely files.** `fleet/probe.ts`, `fleet/prober.ts`, `fleet/db.ts` (migration), `fleet/registry.ts`,
`fleet/server.ts`, `fleet/config.ts`, tests, `fleet/README.md`.

---

## FB1 — Fleet: availability-aware routing filter

**Mechanism.** `RouteRequest` (`fleet/routing.ts:19-26`) carries host, agent, labels and
repository. Fleet places a Crew Run without knowing whether the host can run it, and the host
then refuses it after placement.

**Fix.**
- `RouteRequest` gains `crew?: { kind: 'preset' | 'workflow', id, version? }`. The server
  derives it from the request body (`preset` / `workflow` blocks), never from a separate field.
- A hard filter, as a pure function, applies the design's rules:
  - no snapshot → exclude with `availability unknown`;
  - missing, disabled, or the wrong pinned version → exclude, naming what the host has;
  - an unpinned reference matches any enabled version (design §9.2).
- A stale snapshot gets a finite soft-rank penalty, smaller than `KNOWLEDGE_STALE_PENALTY`. It is
  named in `softRankNote` only when it decides the outcome.
- An explicit `host` bypasses the filter.
- When no host qualifies, the `RoutingError` lists every host with its reason.

**Acceptance.**
1. Two hosts, only one with `reviewer`: the Run goes to that host, and the other's exclusion is
   recorded.
2. A pinned `reviewer@1.2.0` excludes a host with `1.1.0`; an unpinned `reviewer` accepts it.
3. A disabled preset excludes the host.
4. With all hosts stale, the freshest one wins, and the note names staleness.
5. `host: X` places on X even without the preset.
6. With no host qualifying, the 4xx lists every exclusion.

**Regression test.** Acceptance 1 as a pure `route()` test. On base, placement ignores
availability.

**Blocked by** FB0. **Likely files.** `fleet/routing.ts`, `fleet/server.ts`, `test/fleetRouting*.test.ts`,
`docs/fleet-design.md` §6.

---

## FB2a — Fleet: owner-scoped, paged `GET /fleet/runs`

**Mechanism.** `GET /fleet/runs` returns every binding on the caller's visible hosts, unpaged
(`fleet/server.ts:349-353`). A bot using it for single-flight would count other callers' Runs.

**Fix.**
- Add `owner=self`, which filters bindings to the caller's `ownerId`. It is never a free-form
  owner value: a caller cannot list someone else's Runs.
- Add keyset paging with `limit` and `cursor`, ordered `created_at DESC, fleet_run_id DESC`.
  It returns `nextCursor`, in the same shape as the host's `GET /api/runs`.
- Without the new parameters, the response is byte-identical to today.

**Acceptance.**
1. Two callers' Runs on one host: `owner=self` returns only the caller's.
2. Paging walks every Run exactly once, across pages, with a new Run inserted mid-walk.
3. `owner=<someone-else>` is refused with 400.
4. With no parameters, the response is unchanged.

**Regression test.** Acceptance 1. On base, the parameter is ignored and both callers' Runs come
back.

**Likely files.** `fleet/server.ts`, `fleet/bindings.ts`, tests, `fleet/README.md`.

---

## FB2b — Bots: `FleetSchedulerClient` and `api.via: "fleet"`

**Mechanism.** `makeBotClient` (`src/host/bots/process.ts:56`) builds a client for the host API
only. `SchedulerClient` (`scheduler.ts:64-73`) has two calls, and nothing implements them
against Fleet.

**Fix.**
- The bot config schema gains `api.via: "host" | "fleet"`, default `"host"`.
- `FleetSchedulerClient`:
  - `createRun` sends `POST /fleet/runs` with the bot's derived key as `Idempotency-Key`; both
    201 and a replayed 200 map to `{ runId: fleetRunId, replayed }`;
  - `listOwnRuns` uses `GET /fleet/runs?owner=self&limit=&cursor=` (FB2a).
- Fleet's `UNKNOWN` maps to a non-terminal status, so single-flight blocks on it.
- The Fleet caller token is read from `bot-credentials.json` under the bot's alias, through the
  existing validated reader.
- `docs/dispatcher-bot-design.md`: replace "a bot must not blur that boundary" with the option A
  wording, and link `fleet-bots-design.md`.

**Acceptance.**
1. A fire through a fake Fleet creates exactly one Fleet Run; a crash-retry with the same key
   replays it.
2. An `UNKNOWN` Run blocks the next fire.
3. Another caller's non-terminal Run on the same host does not block the bot.
4. `via: "host"`, and configs without `via`, are byte-identical to today: existing bot tests pass
   unmodified.
5. `via: "fleet"` without a Fleet token in `bot-credentials.json` fails at config load, naming
   the alias.

**Regression test.** Acceptance 1 against a fake Fleet server. On base, the `via` key is
refused or ignored.

**Blocked by** FB2a. **Likely files.** `src/host/bots/config.ts`, `src/host/bots/process.ts`,
`src/host/bots/fleetClient.ts` (new), `test/botFleetClient.test.ts`, `docs/dispatcher-bot-design.md`.

---

## FB3 — End to end: a bot on host A dispatches through Fleet to host B

**Fix.** An E2E tier with two real hosts behind one Fleet:
- host B alone carries a workflow template;
- a bot on host A with `api.via: "fleet"` fires a task naming that workflow;
- the Run lands on B, completes, and the bot's single-flight sees it through Fleet.

**Acceptance.** The tier runs in CI or locally behind a flag, recorded in the PR. Placement
explanations and exclusions appear in the Fleet log.

**Blocked by** FB1, FB2b, and #929 (fresh-VM installer verification, for two clean hosts).

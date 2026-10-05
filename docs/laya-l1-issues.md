# Mercury — Laya L1 issue set (dispatcher `select`, shadow only)

**Draft — not filed.** Written 2026-10-05 against `main` at `98c553d`, for
[`laya-integration-design.md`](laya-integration-design.md) §6 and §13 milestone **L1**.
P-1 and L0 are merged (see the design's §13 table), so nothing upstream blocks L1.

Each issue follows the `issue-fix-loop` contract: mechanism, choke point, a
regression test that fails on base, one PR. `L1-n` labels are placeholders until filed.

## Scope

L1 makes a dispatcher bot ask Laya which `{agent, model}` pair a dispatch should use and
**record** the answer. It never uses the answer: `mode: enforce` stays refused until L3.
The success criterion is that a bot with `select` creates Runs whose `agent` and `model`
are identical to a build without L1, and that every such Run carries a selection record.

## What the tree already gives L1 (verified at `98c553d`)

- **`select` is parsed and shape-checked, then refused** (`src/host/bots/config.ts:195-220`):
  1–12 candidates of `{agent, model?, describe}`, `mode`, `minConfidence`. L1 lifts the refusal
  for `shadow` only.
- **The idempotency key does not depend on agent or model.** It is derived before the
  request body is final (`src/host/bots/scheduler.ts:280`, `keys.ts` `dispatchKey(alias, task,
  fireMs, tz)`). A crash-retry that selects differently still replays the original Run (§6.1).
- **Two dispatch paths build a Run body:** the scheduler (`scheduler.ts:266-283`) and manual
  fire (`dispatch.ts` `buildManualFire`). Selection must sit at one point both use.
- **Capabilities are already on the wire.** `GET /api/agents` returns a parallel
  `capabilities` field (`routes.ts:122-134`); the hard filter needs nothing new from the server.
- **The client contract exists:** `src/laya/client.ts`. It provides the 500 ms total deadline,
  the 64 KiB cap, redaction before send, and a fail-closed `{ok:false, reason}` union. The
  scripted fake is in `test/support/fakeLaya.ts`.
- **The key** is in `laya-credentials.json` via `readLayaCredentials` (`src/host/layaCredentials.ts`).
- **No server-side place exists for a selection record.** `constraints.botTask` is the only
  bot attribution today (`runService.ts:539`, recorded verbatim). §6.5's record needs a home:
  that is L1-1.

## Dependency graph

```
L1-0 (label rule, doc only)          — blocks L3, not L1 code; lands first on purpose
#852 (real-host sidecar verification) — gates L1-4 only
L1-1 (server: selection record) ──┐
L1-2 (hard filter, pure) ─────────┼── L1-4 (wire into both dispatch paths, lift shadow refusal)
L1-3 (question + decision, pure) ─┘
```

L1-1, L1-2 and L1-3 are independent and can be done in parallel.

---

## L1-0 — Decide the "good selection" label rule before any shadow data exists

**Mechanism.** Design §9 step 2 joins each selection record with the Run's outcome to label
it. §12.1 leaves the rule open. If the rule is chosen after the shadow data has been seen,
the L3 comparison ("does the fine-tuned pick beat the template default?") can be tuned to
whatever the data shows, and stops meaning anything.

**Fix.** A design-doc change only: a new §9.1 "Label rule" that fixes, before L1-4 merges:

1. **Outcome signal.** Terminal state, retry count, duration, and whether a nightly PR was
   approved or merged. Say which of these count and with what precedence. Cost is out until
   it is measured per harness.
2. **Counterfactual handling.** In shadow mode only the template default actually ran, so a
   label can only say "the default was good or bad", never "Laya's pick would have been
   better". The section states exactly which comparisons shadow data can support, and which
   need a randomized or interleaved enforce trial in L3.
3. **The held-out split** and the L3 acceptance threshold (coverage at `minConfidence`).
4. **What is excluded:** manual fires, Runs cancelled by an operator, infrastructure
   failures (`run.failed` with a harness-unavailable cause).

**Acceptance.** §9.1 merged, with its date in the revision history, **before** L1-4's
merge. L1-4's PR links it.

**Regression test.** None (doc). Its order relative to L1-4 is the check.

---

## L1-1 — Server: optional `selection` record on `POST /api/runs`

**Mechanism.** §6.5 records Laya's pick and its distribution "on the Run". The server has no
field for it. Putting the record under `constraints` would mix attribution into execution
semantics. A bot-local log would split the record from the Run outcomes L3 needs to join
against.

**Fix.**
- **Request field.** `POST /api/runs` accepts an optional `selection` object. It is validated
  fail-closed: a strict schema, at most 8 KiB serialized, and no field that changes
  execution.
- **Storage and exposure.** Stored as the event `run.selection_recorded` with the object as
  payload, written in the same transaction as `run.created`. `GET /api/runs/:id` exposes it
  next to `model` and `modelSource`.
- **Schema (v1):**
  - `via: "laya"` and `mode: "shadow" | "enforce"`;
  - `chosen` and `laya`: each `{agent, model?}`;
  - `answerConfidence`, `distribution` (option key → probability, at most 12 entries);
  - `candidatesOffered`, `candidatesFiltered`, `checkpoint`, `latencyMs`;
  - `reason`, a closed enum: `shadow`, `below_threshold`, `sidecar_unavailable`,
    `invalid_response`, `single_candidate`, `selected`.
- **`chosen` must match the request.** The server checks that `chosen` equals the request's
  effective `agent` and `model`. A record that disagrees with what actually ran is refused,
  so the record can never misreport.
- **Idempotency replay.** Same rule as P1-1 for `model`: replay is checked before any validation
  (`runService.ts:240`), so a replayed key returns the original Run and its original record; the new body's `selection` is ignored.
- **Docs:** `docs/api.md`, the request field and the event, next to `run.model_resolved`.

**Open decision.** Should `selection` be accepted from any token, or only from bot tokens
(`bot-<alias>` owners)? Recommended: any token. It is attribution, it is never enforced,
and the `chosen` check already prevents a misleading record.

**Acceptance.**
1. Over real HTTP, a Run created with a valid `selection` returns it from `GET`, and the
   event appears once.
2. Malformed records are refused with 400 and no Run row: an unknown key, oversize, a
   non-finite probability, or `chosen` ≠ the request's agent/model.
3. Without `selection`, the Run is byte-identical to base.

**Regression test.** The over-HTTP round trip (acceptance 1). On base the field is dropped
at the route.

**Likely files.** `src/api/routes.ts`, `src/runs/runService.ts`, `src/domain/types.ts`,
`docs/api.md`, `test/api.test.ts`, `test/runService.test.ts`.

---

## L1-2 — Bot: candidate hard filter (pure)

**Mechanism.** §6.2: Laya only ranks inside the admissible set. Today nothing computes that
set.

**Fix.** `filterCandidates(candidates, agentsResponse)` in `src/host/bots/select.ts`, a pure
function:
- **Drop agents the server can't use:** any agent absent from `GET /api/agents`.
- **Drop models the agent can't take:** a candidate with `model` whose agent's capabilities
  lack `perRunModel: true`.
- **Drop invalid model names:** a model that fails `validateModelShape`. Import it, never
  copy it, so the bot and the server cannot drift.
- **Keep the original order** so option keys `A…` are stable for a given config.
- **Return** `{admitted, dropped: [{index, reason}]}`.

Preset constraints (`required`/`modelRequired`) are **not** checked here. The template's
preset is applied server-side, and the server refuses a conflict with 400. Duplicating
`resolvePreset` in the bot would drift. Instead, L1-4 treats a 400 on a *selected* pair as a
fallback (see there).

**Acceptance.** Table-driven tests: unknown agent, model on a non-`perRunModel` agent,
invalid model shape, all kept, all dropped. Order is preserved.

**Regression test.** The `perRunModel` drop case. There is no filter on base.

**Likely files.** `src/host/bots/select.ts`, `test/botSelect.test.ts`.

---

## L1-3 — Bot: the Laya question and the decision rule (pure)

**Mechanism.** §6.3 (question shape) and §6.4 (decision rule) have no code.

**Fix.** Two functions in `src/host/bots/select.ts`, both pure. The client is injected.

- **`buildSelectQuestion(admitted, ctx)`:**
  - **Question:** one `choice` question over **pairs**, with opaque keys `A`, `B`, …
    (never the agent or model names) and the operator's `describe` as option text.
  - **State:** the task text, template name, repository basename and declared skills.
    Nothing else: no other Runs, no events.
  - **Redaction:** handled by the client. This function never redacts and never sends.
- **`decide(admitted, laya, cfg, templateDefault)`** implements §6.4 exactly:
  - **No call:** with 0 admitted candidates, the dispatch fails as a literal template
    would. With 1, that candidate is chosen with `reason: single_candidate`.
  - **Fallbacks:** a client failure gives `sidecar_unavailable` or `invalid_response`; an
    `answerConfidence` below `minConfidence` gives `below_threshold`.
  - **Shadow:** `mode: shadow` gives `chosen` = template default and `reason: shadow`, with
    Laya's pick recorded under `laya`.
  - **Gate:** compares the calibrated `answerConfidence`, not upstream's entropy-based
    `confidence`.
  - **Returns** `{chosen, record}`, where `record` is the L1-1 schema.

**Acceptance.**
1. With the scripted fake, every §11 scenario maps to its `reason`.
2. Shadow mode never returns a `chosen` other than the template default, whatever the fake
   answers (property test over random distributions).
3. The question sent to the fake carries opaque keys only. A planted secret in the task text
   is absent from the fake's received body (end-to-end through the real client).

**Regression test.** The shadow property test. There is no decision code on base.

**Blocked by** nothing (uses the L0-1 client and fake). **Likely files.**
`src/host/bots/select.ts`, `test/botSelect.test.ts`.

---

## L1-4 — Wire selection into both dispatch paths; lift the refusal for `shadow`

**Mechanism.** `config.ts:220` refuses every `select`. The scheduler and manual fire build
Run bodies without consulting it.

**Fix.**
- **Config.** `config.ts` accepts `select` with `mode: shadow`. `mode: enforce` is still
  refused, with the message `enforce requires L3 (docs/laya-integration-design.md §9.1)`.
  `mode` defaults to `shadow`, per design §10.
- **One choke point.** A `selectForDispatch(task, body, deps)` called from **both** the
  scheduler (after `resolveTemplate`, before `createRun`) and `buildManualFire`. It returns
  `{body, selection}`. The idempotency key is computed **before** this call; that ordering
  is asserted.
- **Sidecar wiring.** `MERCURY_LAYA_URL` comes from the bot's env (the host env file), and the
  key from `readLayaCredentials`.
- **No sidecar configured.** If `MERCURY_LAYA_URL` is unset or the credentials are
  unreadable, the dispatch proceeds and the record says `sidecar_unavailable`. A bot never
  stops dispatching because Laya is missing. The bot logs this once per process, not per
  tick.
- **Body and record.** The body's `agent`/`model` are left untouched in shadow mode;
  `selection` (L1-1) is attached.
- **A 400 caused by `selection` itself.** If the server refuses the request because of the
  record (an older server without L1-1, or a schema drift), the bot retries **once without**
  `selection`, with the same idempotency key. It logs this once per process. A Run must
  never be lost to bookkeeping.

**Acceptance.**
1. A bot with `select` (shadow) creates Runs whose `agent` and `model` equal the template's,
   byte for byte. Every such Run carries `run.selection_recorded`.
2. A crash-retry that gets a different pick from the fake replays the original Run (same
   key, original record).
3. With no sidecar configured, Runs are still created, each with
   `reason: sidecar_unavailable`.
4. Manual fire (`mercury host bot run --task`) goes through the same function.
5. A config with `mode: enforce` is refused with the L3 message.
6. The PR links the merged L1-0 §9.1.

**Regression test.** Acceptance 1 against the fake server. It fails on base, because the
config is refused.

**Blocked by** L1-1, L1-2, L1-3, and #852 (first real-host sidecar run), with L1-0 merged first. **Likely files.**
`src/host/bots/config.ts`, `src/host/bots/scheduler.ts`, `src/host/bots/dispatch.ts`,
`src/host/bots/process.ts`, `src/host/bots/select.ts`, `docs/dispatcher-bot-design.md` §12,
tests.

## Deliberately not in L1

- **Using the pick** (`enforce`). That is L3, after §9.1's comparison.
- **Any Fleet change.** That is L2, blocked on harness affinity.
- **An operator report of shadow agreement.** Useful, but it reads data L1 produces. It is
  worth an issue once a few weeks of records exist, so its shape follows the real data.
- **Escalating to the B3 brain on low confidence.** Design §12.4, still open.

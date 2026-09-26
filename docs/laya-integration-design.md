# Laya integration — System-1 selection on Host and Fleet

Status: **design; nothing is implemented.** No config key, command or code described
here exists yet. §4 records what the tree provides today (verified against `main`
at `415f8cd`, 2026-09-26) so intent is never mistaken for shipped behaviour.

## 1. Summary

[Laya](https://github.com/NandhaKishorM/laya) is an open (Apache-2.0),
non-autoregressive "System 1" decision model: a ModernBERT-class encoder that
answers typed questions — `choice`, `score`, `noul` (calibrated yes/no) — over a
text or JSON state in one forward pass. It generates no tokens.

Mercury uses it in two places, both **advisory and bounded**:

- **Host (dispatcher bots).** Before a bot dispatches a Run, Laya picks one
  `harness:model` pair from an operator-declared, capability-filtered candidate
  list. Low confidence or an unavailable sidecar falls back to the template's
  literal `agent`/`model`.
- **Fleet (placement).** Laya classifies the task into the affinity vocabulary of
  [`crew/harness-capabilities.md`](crew/harness-capabilities.md) §3. `routing.ts`
  matches that label against operator-declared affinity as a finite soft-rank
  term. It never filters and never picks a host by itself.

The property that makes this acceptable is the same one §8.3 of
[`dispatcher-bot-design.md`](dispatcher-bot-design.md) demands of the LLM brain:
**a closed vocabulary.** Laya's output is always one of the options Mercury
supplied. A hostile task text can at worst move the pick to a different
*admissible* option. It cannot invent an action, a harness, a model or free text.

## 2. Goals

1. A dispatcher bot can choose harness and model per dispatch from a declared
   candidate list, with the decision and its full distribution recorded on the
   Run.
2. Fleet can use a task-domain classification as one explainable soft-rank signal.
3. Every Laya decision has a deterministic fallback. Removing the sidecar changes
   no behaviour beyond reverting to the fallback.
4. Laya ships in **shadow mode** first: it logs its pick next to the deterministic
   one and changes nothing until an operator switches to `enforce`.
5. Mercury's own Run history becomes the labelled dataset for a domain fine-tune.

## 3. Non-goals

- **Laya as a gate for safety, credentials, merges or money.** Those stay
  deterministic code. The upstream project itself warns against using a
  distribution as a compliance decision.
- **Laya inside a harness session** (per-turn routing, compaction). That is the
  harness's business; e.g. the upstream `hermes-laya` plugin operates there and
  can coexist with this design without interaction.
- **Mercury measuring agent quality.** Laya labels *tasks*. Harness affinity stays
  operator-declared with provenance (`crew/harness-capabilities.md` §3).
- **Replacing the B3 brain.** Laya is System 1; the brain remains System 2 (§6.6).
- **Running Python inside the Mercury process.**

## 4. What exists today (verified 2026-09-26)

| Fact | Where | Consequence |
| --- | --- | --- |
| Only `fakeAgentAdapter` declares `perRunModel: true` | `grep -rln perRunModel src` → `configSchema.ts`, `fakeAgentAdapter.ts`, `resolvePreset.ts`, `domain/types.ts` | No real harness can take a per-Run model |
| Claude model is operator config (`MERCURY_CLAUDE_MODEL`); `--model` "not declared until measured" | `src/adapters/claudeCodeAdapter.ts` static capabilities comment; `src/cli.ts:780` | Same |
| PrimeAgent `--provider/--model` exist only as operator-level extra args | `src/adapters/primeAgentAdapter.ts:38,106` | Same |
| `runService` passes `model: undefined` into `resolvePreset` | `src/runs/runService.ts:200` ("arrives with a caller surface that has one") | `POST /api/runs` has no model surface |
| `resolvePreset` already fails closed on a model the adapter cannot express | `src/presets/resolvePreset.ts:166` | The gate exists; only the surface and the declarations are missing |
| Bot config refuses `brain` before B3 | `src/host/bots/config.ts:200` | New `select` key must follow the same reserved-key pattern |
| Fleet routing is a pure function with explainable soft rank (`softRankNote`, `KNOWLEDGE_STALE_PENALTY`) | `fleet/routing.ts` | A second finite soft term fits the existing shape |
| Harness affinity (§3 of harness-capabilities) is **not implemented** | no `affinity` match in `src/` or `fleet/` | Fleet-level integration depends on it (§7.1) |
| Host redactor exists | `src/domain/redact.ts` (`createRedactor`) | Laya state passes through it, like the brain context |
| Mac Studio system Python is 3.9.6; Laya requires ≥ 3.10 | `python3 --version` on the host | The installer must provide a newer interpreter (§5.3) |

**Therefore harness selection is possible on today's tree; model selection is
not.** P-1 (§13) is a hard prerequisite for the model half.

## 5. Runtime: a loopback sidecar

### 5.1 Process

Laya runs as its own process, `laya-serve` (upstream `laya[serve]` extra),
exposing the Jev-compatible `POST /v1/systemone` route. Mercury never imports
Python and never loads weights.

- Bind `127.0.0.1` only (`LAYA_HOST=127.0.0.1`). A LAN bind is out of scope.
- `LAYA_API_KEY` set; Mercury sends `Authorization: Bearer`. The key lives in the
  same 0600 credential file as the bot's LLM key (`bot-credentials.json`, key
  `laya`), and in `fleet` config for the Fleet sidecar.
- `LAYA_PRELOAD=1`, `LAYA_MODELS` limited to the checkpoints actually used, so a
  decision never pays a multi-second checkpoint build. `LAYA_THREADS` ≤ physical
  cores on CPU hosts.
- One sidecar per host (shared by all bots on it) and one beside Fleet. They are
  independent: Fleet never calls a host's sidecar.

### 5.2 Client

One zero-dependency `node:http` client, the same shape as the brain transport
(dispatcher §8.2):

- total per-request deadline, default **500 ms**;
- response body cap, default **64 KiB**;
- **no retry** — a missed decision falls back; it is never worth delaying a
  dispatch;
- request built from an allowlist of fields; state passes through the host
  redactor **before** leaving the process; redaction failure → fallback, logged.

The response is validated fail-closed: an answer key not in the request, a
`choice` not among the offered option keys, a non-finite probability, or a
malformed body → fallback with the reason recorded.

An in-process TypeScript runtime (upstream has a `laya-ts` folder whose scope is
unverified) is an open decision (§12), not the design.

### 5.3 Installation

Opt-in in the host installer (`docs/host-installer.md`), never default:

- requires Python ≥ 3.10 (uv-managed interpreter preferred; the system Python on
  macOS is too old);
- a user-scoped venv under the Mercury data dir; weights cached there;
- a user-scoped service unit (launchd/systemd user) next to Mercury's;
- `mercury doctor` gains a `laya:` line: reachable, auth ok, loaded checkpoints,
  one-question latency.

## 6. Host level: dispatcher selection

### 6.1 Where it runs

In the bot process, between "template resolved" and `POST /api/runs`
(dispatcher §5.2). The server does not know Laya exists; it receives an ordinary
Run request whose `agent` and `model` happen to have been chosen. This keeps the
server contract unchanged apart from P-1, and keeps the idempotency key argument
of §5.2 intact: the key is derived before selection, so a crash-retry that
re-selects differently still replays the original Run.

### 6.2 Candidates: hard filter first

1. Start from the task's `select.candidates` (operator-declared
   `{agent, model, describe}`).
2. Drop candidates whose agent is disabled on this host or unknown to
   `GET /api/agents`.
3. Drop candidates that fail the same checks `resolvePreset` would apply
   (required capabilities, `perRunModel` when a model is set, preset
   `required`/`modelRequired` constraints).
4. **Zero left** → the dispatch fails exactly as a literal template would.
   **One left** → no Laya call; it is the answer.

Laya only ever ranks inside the admissible set. The server re-validates on
`POST /api/runs` regardless; the bot's filter exists to avoid offering Laya an
option the server would refuse, not to replace the server's check.

### 6.3 The question

One `choice` over **pairs**, not two independent questions: harness and model are
not independent (a model exists only on some harnesses), and two separate argmaxes
can produce a pair that was never offered.

- Option keys are opaque (`A`, `B`, `C`, …) with the operator's `describe` as the
  option text. Upstream reports that current checkpoints can follow boolean-like
  or suggestive keys instead of descriptions; semantic keys also do not protect
  against negation errors.
- **At most 12 candidates.** Options share a fixed token budget; upstream reports
  trimming beyond roughly 20 short options. 12 leaves headroom for descriptions.
  Validation refuses more.
- State: the redacted task text, the template name, the repository (URL or path
  basename only), and declared skills. Nothing else — no other Runs, no events.

### 6.4 Decision rule

```
if sidecar unavailable or response invalid        -> fallback, reason recorded
elif answer_confidence(pick) < select.minConfidence -> fallback, reason recorded
elif mode == "shadow"                               -> fallback, pick recorded
else                                                -> pick
```

`fallback` is the template's literal `agent`/`model`. Gate on
`answer_confidence` (probability of the reported answer), not upstream's
`confidence` (1 − normalised entropy), because the former is the calibrated
number; see §9 for why no default threshold is trusted.

### 6.5 Recording

Every dispatch with a `select` block records on the Run (an attribution field
of the kind dispatcher §4.3 already reserves), whether or not Laya was used:

```json
"selection": {
  "via": "laya", "mode": "shadow",
  "chosen": {"agent": "claude", "model": "sonnet"},
  "lay": {"agent": "claude", "model": "opus", "answerConfidence": 0.71},
  "distribution": {"A": 0.71, "B": 0.22, "C": 0.07},
  "candidatesOffered": 3, "candidatesFiltered": 1,
  "checkpoint": "english", "latencyMs": 38,
  "reason": "shadow mode: laya pick logged, template default used"
}
```

This is both the explainability record (same principle as `softRankNote`) and
the training row for §9.

### 6.6 Relationship to the B3 brain

Independent and composable. A bot may have `select`, `brain`, both or neither.
When both are present, `select` runs on every dispatch; the brain runs on its own
coordination cycle and may dispatch templates that themselves carry `select`.
A later option (§12) is escalating a low-confidence selection to the brain
instead of the literal fallback; v1 does not do this, because it would put an
LLM call on the dispatch path.

### 6.7 Configuration

```json
"tasks": [{
  "name": "nightly-next",
  "template": { "task": "...", "agent": "claude", "model": "sonnet" },
  "select": {
    "via": "laya",
    "mode": "shadow",
    "minConfidence": 0.8,
    "candidates": [
      { "agent": "claude",     "model": "opus",   "describe": "hard multi-file changes, design-level work" },
      { "agent": "claude",     "model": "sonnet", "describe": "routine bug fixes and small features" },
      { "agent": "primeagent", "model": "<id>",   "describe": "cheap mechanical edits" }
    ]
  }
}]
```

`select` follows the reserved-key pattern already used for `brain`: accepted by
the schema and refused with a clear message until L1 ships.

## 7. Fleet level: task-affinity classification

### 7.1 Dependency

Harness affinity (`crew/harness-capabilities.md` §3) is not implemented (§4).
Until it is, there is nothing for a task label to match against, and L2 is
blocked. This design does not implement affinity; it consumes it.

### 7.2 Mechanism

On `POST` to Fleet, before `route()`:

1. Build one `choice` question whose options are the affinity domains
   (`code-edit`, `code-review`, `ops-infra`, `long-autonomous`,
   `retrieval-heavy`, `interactive`), with the descriptions fixed in Fleet code,
   not config, so the vocabulary cannot drift from §3.
2. State: redacted task text plus repository basename.
3. The result enters `route()` as data: `taskDomain: {label, answerConfidence}`
   on `RouteRequest`, keeping `route()` pure and testable without a sidecar.

### 7.3 Scoring

- Below `minConfidence`, or on any failure, `taskDomain` is absent and the rank is
  unchanged.
- Otherwise a candidate host/harness whose declared affinity does **not** include
  the label pays `TASK_AFFINITY_PENALTY`, a finite constant **below**
  `KNOWLEDGE_STALE_PENALTY` (100) and the unprobed sentinel (1 000). Classifying
  a task is a weaker claim than knowing a host's replica is stale.
- Explicit placement (`host`) still wins with no scoring.
- It is never a hard filter.
- When the term changes the outcome, `softRankNote` says so, naming
  `source: "laya"`, the label and its confidence; when it does not, the note stays
  null, preserving the existing "null in the common case" contract.
- Off by default (`FLEET_LAYA_URL` unset), like `FLEET_KNOWLEDGE_STALE_MS`.

Shadow mode applies here too: `FLEET_LAYA_MODE=shadow` computes and logs the
counterfactual host without changing placement.

## 8. Trust model

- **Input is untrusted.** Task text may come from GitHub issues (the nightly
  ladder). It is redacted and placed in the state only. Laya has no instruction
  channel: there is no system prompt to override and no text output to smuggle.
- **Output is closed.** The only effect of an adversarial state is a different
  choice inside a set the operator already accepted. Therefore every candidate
  must be one the operator would accept for *any* task on that template. A
  candidate that is only safe for some tasks does not belong in the list.
- **Laya never widens anything.** It cannot add a candidate, relax a capability,
  change constraints, sandbox, skills, repository or credentials.
- **Failure is quiet and safe.** Every failure path is the literal template or
  unchanged placement.
- **No data leaves the host** beyond loopback. Weights are downloaded once at
  install from the Hugging Face hub; `doctor` reports the checkpoint revision.

## 9. Accuracy: shadow first, then fine-tune

Upstream is explicit that the base checkpoints are near chance zero-shot on its
typed-decisions benchmark (≈0.36 vs 0.46 majority-class baseline) and that the
value comes from fine-tuning (≈0.77 on the same benchmark). An independent
agent-routing experiment (`mdad-elec/laya-v2-agent-routing`) likewise found
zero-shot Laya losing to an LLM judge and a fine-tuned one beating it. Neither
result is measured here. The plan assumes the zero-shot pick is **not** good
enough to enforce.

1. **Shadow** (L1/L2): record Laya's pick and distribution on every selecting
   dispatch; change nothing.
2. **Label**: join `selection` with the Run's outcome from the event store —
   terminal state, retries, duration, whether its PR was approved/merged (nightly).
   A pick counts as "good" by a rule written down before looking at the data
   (§12), not tuned afterwards.
3. **Fine-tune** (L3): upstream notebook, on Mercury's own rows; fit calibration
   temperatures on a held-out split; publish the checkpoint revision the host
   will pin.
4. **Enforce** per template, only when the fine-tuned pick beats the literal
   template default on held-out rows at the chosen `minConfidence` coverage.
   The comparison is recorded in this document.

The threshold is a policy chosen from measured accuracy at that coverage, not a
property of the model; there is intentionally no shipped default for `enforce`.

## 10. Configuration reference

| Key | Where | Required | Default |
| --- | --- | --- | --- |
| `select.via` | bot task | yes (if `select`) | — only `"laya"` in v1 |
| `select.mode` | bot task | no | `"shadow"` |
| `select.minConfidence` | bot task | yes if `mode: enforce` | none |
| `select.candidates[]` | bot task | yes, 1–12 | — |
| `select.candidates[].describe` | bot task | yes | — |
| `laya` credential | `bot-credentials.json` | yes (if any `select`) | — |
| `MERCURY_LAYA_URL` | host env file | yes (if any `select`) | unset |
| `MERCURY_LAYA_TIMEOUT_MS` | host env file | no | 500 |
| `FLEET_LAYA_URL` | Fleet env | no | unset = off |
| `FLEET_LAYA_MODE` | Fleet env | no | `shadow` |
| `FLEET_LAYA_MIN_CONFIDENCE` | Fleet env | yes if `enforce` | none |

## 11. Testing strategy

No test talks to real Laya or loads weights. A **scripted fake** sidecar (local
HTTP, same wire shape) returns, in turn: a valid pick; a pick below threshold; an
option key that was not offered; a non-finite probability; an over-cap body; a
401; a timeout; a malformed body. Each must produce the documented outcome and
recorded reason.

Required tests (each fails on base):

- a candidate the server would refuse is never offered to the fake (the fake
  asserts on its request);
- shadow mode never changes `agent`/`model` on the created Run;
- a crash-retry after selection replays the original Run via the idempotency key
  even when the fake returns a different pick the second time;
- the state sent to the fake contains no redactable secret planted in the task;
- Fleet: `route()` with `taskDomain` present but below threshold returns the same
  host and a null note as without it; above threshold, a rank change produces a
  non-null note naming `laya`.

One opt-in local e2e (`test/…local…`, not CI) runs real `laya-serve` to pin the
wire shape against the pinned upstream version.

## 12. Open decisions

1. **Label rule for "good selection"** (§9 step 2) — must be written before L3
   data is examined.
2. **Checkpoint**: `english` vs `typed-decisions` as the base for fine-tuning.
3. **In-process TS runtime** (`laya-ts`, ONNX) vs sidecar — revisit only if the
   sidecar's operational cost proves real.
4. **Low-confidence escalation to the brain** (§6.6) instead of the literal
   fallback.
5. **Fleet selecting harness:model too**, not just ranking hosts — only after
   affinity exists and the host-level selection has enforced successfully.
6. **Shared sidecar** between Fleet and a co-located host (the Mac Studio case):
   allowed operationally, but the two must keep separate API keys.

## 13. Milestones

### P-1 — per-Run model (prerequisite for the model half; server work)

- `model` on `POST /api/runs`, forwarded to `resolvePreset` as `caller.model`
  (replacing `model: undefined` at `runService.ts:200`), with the existing
  fail-closed rule unchanged.
- Measured `perRunModel: true` on `claudeCodeAdapter` (`--model`) and
  `primeAgentAdapter` (`--provider/--model`), each with a real-binary observation
  recorded as the Atlas prerequisites were.
- Fleet passes `model` through in the child payload.

*Acceptance*: a Run created with `model` reaches the harness argv; a model on an
adapter without `perRunModel` is refused at creation.

### L0 — sidecar and client contract

Laya client, scripted fake, `select` reserved in the bot schema, `doctor` line,
opt-in installer step. *Acceptance*: every fake scenario in §11 yields its
documented outcome; no bot behaviour changes.

### L1 — dispatcher `select`, shadow only

§6 end to end with `mode: shadow` accepted and `enforce` still refused.
*Acceptance*: nightly dispatches carry a `selection` record; Run `agent`/`model`
are byte-identical to a build without L1.

### L2 — Fleet task-domain signal, shadow only

Blocked on harness affinity (§7.1). *Acceptance*: `route()` purity tests in §11;
placement unchanged in shadow; counterfactual host logged.

### L3 — fine-tune and enforce

Label rule decided (§12.1), fine-tuned checkpoint pinned, comparison recorded
here, `enforce` enabled per template. *Acceptance*: held-out comparison beats the
literal default at the chosen threshold; `enforce` refused on any template
without a recorded comparison.

## 14. References

- Laya: https://github.com/NandhaKishorM/laya (README: serve, calibration,
  honest limits)
- Laya-v2 agent routing experiment: https://github.com/mdad-elec/laya-v2-agent-routing
- `hermes-laya` (in-harness, out of scope here): https://pypi.org/project/hermes-laya/
- [`dispatcher-bot-design.md`](dispatcher-bot-design.md) §4.3, §5.2, §8
- [`crew/harness-capabilities.md`](crew/harness-capabilities.md) §3–§4
- [`fleet-design.md`](fleet-design.md) §6, `fleet/routing.ts`
- [`host-installer.md`](host-installer.md)

## 15. Revision history

### 2026-09-26 — initial design

First draft from a design discussion. Records the per-Run model gap (§4) as a
hard prerequisite, pair-valued selection over independent questions (§6.3), and
shadow-before-enforce with no shipped enforce threshold (§9).

# Mercury — Laya integration, first wave issue set (P-1 and L0)

Drafted 2026-10-03 against `main` at `422a106`, for
[`laya-integration-design.md`](laya-integration-design.md) §13 milestones **P-1**
(per-Run model) and **L0** (sidecar and client contract). L1–L3 are not drafted:
L1 depends on what P-1 measures, L2 is blocked on harness affinity, L3 on data.

Each issue follows the `issue-fix-loop` contract: mechanism, choke point, a
regression test that fails on base, one PR. Labels `P1-n`/`L0-n` are kept below because the dependency graph is written in
terms of them; the Status table maps them to GitHub numbers.

## Status — filed 2026-10-03

| Doc | Issue | Blocked by | PR | Merge |
| --- | --- | --- | --- | --- |
| P1-1 | #823 | — | #832 | `fc8c7ae` |
| P1-2 | #827 | #823 | #834 | `f538770` |
| P1-3 | #828 | #823 | #835 | `e884e59` |
| P1-4 | #829 | #823 | #836 | `2d70d2d` |
| P1-5 | #824 | — | #833 | `3f2edbc` |
| L0-1 | #825 | — | #837 | `accc654` |
| L0-2 | #826 | — | | |
| L0-3 | #830 | #825 | | |
| L0-4 | #831 | #825, #830 | | |

## Findings that changed the design's P-1 sketch

The design (§4) said P-1 is "forward `caller.model` and declare `perRunModel`".
Reading the tree for this issue set shows it is more than that:

1. **A Run has no model field at all.** The only place a model lives is the preset
   snapshot (`ResolvedRolePreset.effectiveAgent.model`). It reaches the adapter as
   `RunContext.preset.model` (`src/worker/worker.ts:1526`,
   `src/domain/types.ts:215-227`). A Run created without a preset has nowhere to
   carry one, and the `runs` table has no column for it.
2. **No real adapter reads `preset.model`.** `grep` over `src/adapters` finds no
   consumer; Claude's `--model` comes only from operator `opts.model`
   (`claudeCodeAdapter.ts:254`).
3. **PrimeAgent daemon mode already has a per-session model slot.**
   `sessionConfigFromArgs` (`daemonAgentAdapter.ts`) turns `--model`/`--provider`
   into the `create` config. Per-Run model there is a config field, not argv.
4. **Fleet already forwards `model`.** `fleet/server.ts:318` copies the request
   body verbatim minus `host`/`idempotency`. No Fleet code change; one test pins it.

**Priority note.** The intended candidates for Mercury's own work are provider
models (GLM-5.3-Flash, DeepSeek-V4-Flash, Qwen3.8), which run through PrimeAgent
and Hermes, not Claude Code. So P1-3 (PrimeAgent) is the adapter that unlocks the
real use case; P1-2 (Claude) is the simplest proof and goes first only because it
is cheap to measure.

## Dependency graph

```
P1-1 ──┬── P1-2 (claude)
       ├── P1-3 (primeagent rpc + daemon)
       ├── P1-4 (hermes: measure, then maybe declare)
       └── P1-5 (fleet pass-through pin)
L0-1 ──┬── L0-2 (bot schema: select reserved)
       ├── L0-3 (doctor line)
       └── L0-4 (installer opt-in)
```

P-1 and L0 are independent of each other and can proceed in parallel.

---

## P1-1 — Run-level `model`: API surface, persistence, retry, adapter context

**Mechanism.** `POST /api/runs` ignores `body.model` (`src/api/routes.ts:306-331`
does not forward it). `RunService.create()` passes `model: undefined` to
`resolvePreset` (`src/runs/runService.ts:227`). Non-preset Runs have no model
storage, and the adapter context carries a model only inside `preset`.

**Fix.**
- `CreateRunInput.model?: string`, forwarded by the route (with the same
  "forwarded unresolved" comment pattern as `goal`/`knowledge`/`preset`).
- Shape validation in `create()`: non-empty, ≤ 200 chars, no whitespace or control
  characters (it reaches argv in P1-2/P1-3).
- Resolution, one rule for both paths: `caller.model` → preset model → none.
  The preset path keeps `resolvePreset`'s existing `modelRequired` conflict check
  by passing `caller.model` instead of `undefined`.
- **Fail closed** on both paths: an effective model on an agent whose static
  capabilities lack `perRunModel: true` is refused at creation, with the same
  three-way wording (`unknown` / `undeclared` / `false`) `resolvePreset` uses.
  Today that refuses every real agent, which is correct until P1-2..P1-4 declare.
- New migration: `ALTER TABLE runs ADD COLUMN model TEXT`. `Run.model` returned
  by `GET /api/runs/:id`.
- `retry()` copies `model` from the parent, like `skillSnapshots`.
- `RunContext.model?: string` at top level, set from the Run. `preset.model` stays
  for provenance but adapters read `context.model` only.
- Docs: `docs/api.md` (request field), `docs/agent-adapters.md` (context field,
  "adapters read `context.model`, never `preset.model`").

**Open decisions the PR must resolve.**
1. Does `model` participate in idempotency replay comparison (same key, different
   model)? Current replay ignores body differences entirely; the PR states
   whether that stays true.
2. Event: emit `run.model_resolved` with `{model, source: caller|preset}` or only
   persist the column. (Recommended: event, it is the explainability record L1
   builds on.)

**Acceptance.**
1. Over real HTTP, `POST /api/runs` with `model` on the fake agent creates a Run
   whose `GET` returns that `model`, and the fake adapter receives
   `context.model`.
2. The same request on an agent without `perRunModel` returns 400 naming the
   agent and the reason; no Run row is written.
3. A preset with `model` and no caller model → Run carries the preset's model;
   preset `modelRequired` + conflicting caller model → 400 (existing behaviour,
   now reachable over HTTP).
4. Retry of a Run with `model` creates a Run with the same `model`.
5. A Run created without `model` behaves byte-identically to base (no event, null
   column, context field absent).

**Regression test (fails on base).** Route-level test in `test/api.test.ts`:
POST with `model` on the fake agent, assert `GET` returns it. On base the field
is dropped at the route, so the assertion fails — the seam the `knowledge` comment
in `routes.ts` warns about.

**Likely files.** `src/api/routes.ts`, `src/runs/runService.ts`,
`src/db/database.ts`, `src/runs/runStore*.ts`, `src/domain/types.ts`,
`src/worker/worker.ts`, `src/adapters/fakeAgentAdapter.ts`, `docs/api.md`,
`docs/agent-adapters.md`, `test/api.test.ts`, `test/runService*.test.ts`.

---

## P1-2 — Claude Code: honour `context.model`, declare `perRunModel` after measurement

**Mechanism.** `claudeCodeAdapter.ts:254` emits `--model` only from operator
`opts.model`; the static capabilities comment says per-Run model "is not declared
until measured".

**Fix.** `context.model ?? opts.model` → `--model`. Per-Run wins over operator
default. Declare `perRunModel: true`.

**Acceptance.**
1. Unit: argv contains `--model <x>` from `context.model`; operator default used
   when absent; no `--model` when both absent.
2. **Real-binary observation** recorded in the PR (as P0-2 did): one Run with a
   per-Run model on the installed `claude`, the Run id, Claude Code version, and
   evidence the model was used (the harness's own reported model in its output
   or session metadata). Plus a negative control: an invalid model id fails the
   Run with the harness's error, not silently with the default.

**Regression test.** Argv test asserting `context.model` wins over `opts.model`;
on base the per-Run value is ignored.

**Blocked by** P1-1. **Likely files.** `src/adapters/claudeCodeAdapter.ts`,
`test/claudeCodeAdapter*.test.ts`, `docs/agent-adapters.md`.

---

## P1-3 — PrimeAgent: per-Run model in RPC and daemon modes

**Mechanism.** RPC mode spawns per Run with operator `opts.args`
(`primeAgentAdapter.ts:283`); daemon mode builds session config from the same
args via `sessionConfigFromArgs`. Neither reads anything per Run.

**Fix.**
- RPC: append `--model <context.model>` after `opts.args`. The PR **measures**
  whether prime-agent honours last-flag-wins; if it does not, strip an operator
  `--model` from the copied args instead of appending a duplicate.
- Daemon: set `config.model = context.model` on session `create`, overriding the
  args-derived value.
- Provider: a model id alone may be ambiguous across providers. The PR decides
  between `provider/model` syntax in `Run.model` (split by the adapter) and a
  separate field. Recommended: single string, adapter-defined syntax documented
  in `docs/agent-adapters.md`, because the candidate list in L1 is pairs of
  `{agent, model}` and a third field would make the pair a triple.
- Declare `perRunModel: true` on both adapters after measurement.

**Acceptance.**
1. Unit: RPC argv and daemon `create` config carry the per-Run model and
   override the operator default.
2. Real-binary observation in both modes with one of the intended provider
   models (e.g. GLM-5.3-Flash), Run id and prime-agent version recorded, plus the
   invalid-model negative control.

**Blocked by** P1-1. **Likely files.** `src/adapters/primeAgentAdapter.ts`,
`src/adapters/daemonAgentAdapter.ts`, `src/adapters/selectAgentAdapter.ts` (only
if capabilities differ by mode), tests, `docs/agent-adapters.md`.

---

## P1-4 — Hermes: measure per-Run model support; declare only if real

**Mechanism.** `buildArgv` (`hermesAgentAdapter.ts:163`) emits no model flag.
Whether `hermes chat` accepts a per-invocation model, and how it interacts with
`--resume` (a resumed session may pin its original model), is unmeasured.

**Fix.** Measure first. If a per-invocation flag exists and survives resume,
emit it and declare `perRunModel: true`. If it does not, record
`perRunModel: false` explicitly with the evidence, so P1-1's refusal names a
measured reason instead of "undeclared".

**Acceptance.** Either outcome is a valid close, as long as it carries the real
binary's version and the command transcript.

**Blocked by** P1-1. **Likely files.** `src/adapters/hermesAgentAdapter.ts`,
tests, `docs/agent-adapters.md`.

---

## P1-5 — Fleet: pin `model` pass-through

**Mechanism.** `fleet/server.ts:318` forwards the body verbatim, so `model`
already reaches the child. Nothing asserts it; a future allowlist would drop it
silently.

**Fix.** Test only, plus a line in `docs/fleet-design.md` listing `model` among
forwarded fields.

**Acceptance / regression test.** A Fleet test submits with `model` and asserts
the fake child received it. It passes on base by construction, so this issue's
"fails on base" proof is the mutation check: deleting `model` in the forwarding
path makes it fail. State that in the PR.

**Blocked by** nothing (can merge before P1-1; it pins forwarding, not semantics).

---

## L0-1 — Laya client and scripted fake sidecar

**Mechanism.** Nothing exists. Design §5.2 and §11.

**Fix.** `src/laya/client.ts`: zero-dependency `node:http` POST to
`/v1/systemone`; bearer auth; total deadline (default 500 ms); 64 KiB response
cap; no retry; request built from an allowlist; state passed through
`createRedactor` before send (redaction failure is a typed failure, not a throw
past the caller). Response validated fail-closed: unknown answer key, `choice`
not among offered keys, non-finite probability, malformed or over-cap body.
Returns a discriminated union `{ok: true, answers, checkpoint, latencyMs} |
{ok: false, reason}` — callers never see an exception for a Laya failure.

`test/support/fakeLaya.ts`: local HTTP server scripted per request, recording
what it received.

**Open decision.** Module location (`src/laya/` vs `src/host/laya/`): Fleet will
import it too, so it must not live under `host/`.

**Acceptance.** Each §11 scenario (valid pick, below-threshold, unoffered key,
NaN, over-cap, 401, timeout, malformed) yields its documented `{ok:false,
reason}` or `{ok:true}`. A secret planted in the state is absent from what the
fake received.

**Regression test.** The planted-secret test: it fails if redaction is skipped.

**Likely files.** `src/laya/client.ts`, `src/laya/types.ts`,
`test/support/fakeLaya.ts`, `test/layaClient.test.ts`.

---

## L0-2 — Bot schema: `select` as a reserved key

**Mechanism.** `src/host/bots/config.ts` knows a fixed key set and refuses
`brain` before B3 (`:200`). A task-level `select` would today be rejected as
unknown, or — worse, depending on where tasks are validated — ignored.

**Fix.** Accept `select` in a task's schema and refuse it with
`reserved: select is not supported before L1`, mirroring `brain`. Validate shape
already (1–12 candidates, each `{agent, model?, describe}`, `mode` in
`shadow|enforce`, `minConfidence` in (0,1)) so a config written today is
accepted by L1 unchanged once the refusal is lifted.

**Acceptance.** A config with a well-formed `select` is refused with the
reserved message; a malformed one is refused with the shape error first.

**Regression test.** Config test asserting the reserved message. On base the
error names an unknown key instead.

**Blocked by** nothing. **Likely files.** `src/host/bots/config.ts`,
`test/botConfig*.test.ts`, `docs/dispatcher-bot-design.md` §12 table.

---

## L0-3 — `mercury doctor`: Laya line

**Fix.** When `MERCURY_LAYA_URL` is set: reachable, auth ok, checkpoints loaded,
one-question latency with a fixed probe question. When unset: no line (absence
is the default, not a warning).

**Acceptance.** Against the fake: ok line; 401 → auth failure named; timeout →
unreachable named. Unset → no `laya:` line at all.

**Blocked by** L0-1. **Likely files.** `src/host/doctor.ts`, tests.

---

## L0-4 — Host installer: opt-in Laya sidecar

**Fix.** An opt-in wizard step (default **no**) per `docs/host-installer.md`
conventions (`/dev/tty` prompts, re-run preserves hand-set variables):

- locate or install Python ≥ 3.10 (uv preferred; system 3.9.6 on macOS is
  refused with the reason);
- user-scoped venv under the Mercury data dir, pinned `laya[serve]` version;
- generate `LAYA_API_KEY`, write `MERCURY_LAYA_URL` and the key;
- user-scoped launchd/systemd unit bound to `127.0.0.1`, `LAYA_PRELOAD=1`,
  `LAYA_MODELS` limited to `english`;
- finish by running the L0-3 doctor line.

**Acceptance.** Fresh macOS run with opt-in → doctor `laya: ok`; opt-out →
nothing installed, no env keys written; re-run preserves an existing key.

**Blocked by** L0-1, L0-3. **Likely files.** `install.sh`, `src/host/setup.ts`,
`src/host/install.ts`, `docs/host-installer.md`.

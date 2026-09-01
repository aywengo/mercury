# Mercury — Architecture & Design Review · Round 1 (archive)

> **This is the archived Round 1 review. It is a historical record, not the current backlog.**
>
> Reviewed at `d005fad` on 2026-08-31; all 39 findings were dispositioned and the work shipped as
> 45 PRs. The current review of `main` is
> [**Round 2 — architecture-review.md**](architecture-review.md), which supersedes this document for
> anything actionable.
>
> Three things here are **known to be wrong** and are corrected in place rather than quietly left:
> [L3 was never fixed](#l3-was-never-fixed-read-this-before-trusting-the-table), the
> [M11/L10/L4/L6/L8/L11 status subsections](#status-subsections-were-left-behind-mid-remediation)
> contradicted the table beneath them, and the source line citations describe code that has since
> moved or been deleted. See [Corrections](#corrections-found-in-round-2).

Reviewed at commit `d005fad` (`main`), 2026-08-31. Node v26.7.0.
Scope: all of `src/` (7,262 lines of TypeScript), `ui/`, `test/`, `deploy/`,
measured against [`ARCHITECTURE.md`](../ARCHITECTURE.md).

Companion: [`docs/crew-design.md`](crew-design.md) (the Crew feature design, which
depends on several findings below).

---

## Verdict

The architecture is sound and the specification is better than most. The layering
holds: `src/domain/` is pure, the state machine is small and explicit, and
PrimeAgent-specific knowledge really is confined to `src/adapters/`. The declarative
registry pattern (`rpc-agents/*.json` → `RpcAgentAdapter`) is the best idea in the
codebase — adding an agent is a JSON file, not a class.

The defects follow one remarkably uniform pattern: **the spec states a rule correctly,
and the implementation checks it non-atomically, or not at all, or checks it in a test
but not in production.** Eleven High findings reduce to four root causes, and almost
all of them are enforcement gaps rather than design errors. That is a good place to be:
the fixes are local and the target behaviour is already written down.

The single most consequential finding is **H9** — the dashboard silently loses run
history beyond 1,000 events. It is invisible, it breaks the product's core promise, and
no test covers it.

> **This verdict is the review as written, not the current state.** For what has since
> been fixed, held, or found to be wrong in this document itself, see
> [Resolution status](#resolution-status) directly below.

---

## Resolution status

_Updated after remediation. Findings are listed in this document's own numbering; each links to the_
_issue that tracked it and the PR that closed it._

**39 findings: 38 resolved, 1 reopened.** The reopened one is **L3**, which this table recorded as
"already fixed before being reached". That claim was false — see
[L3 was never fixed](#l3-was-never-fixed-read-this-before-trusting-the-table).

L11 bundled two claims and both are now closed: the logger-redaction test gap was a real defect, fixed in [#130](https://github.com/aywengo/mercury/pull/130); the missing metrics endpoint was a feature request, tracked as [#131](https://github.com/aywengo/mercury/issues/131) and shipped in [#132](https://github.com/aywengo/mercury/pull/132).

Verified as a whole rather than per-PR: at close-out `main` ran **340 tests, 0 failures, 0 cancelled** in ~28 s with `npm run typecheck` clean on node v26.7.0. That count is a snapshot of the archive, not a current claim; the live figure is in [Round 2](architecture-review.md).

| ID | Finding | Issue | PR | Status |
| --- | --- | --- | --- | --- |
| H1 | Every successful run leaks the agent process | [#46](https://github.com/aywengo/mercury/issues/46) | [#96](https://github.com/aywengo/mercury/pull/96) | ✅ resolved |
| H2 | A cancelled run can keep being executed and written to | [#47](https://github.com/aywengo/mercury/issues/47) | [#96](https://github.com/aywengo/mercury/pull/96) | ✅ resolved |
| H3 | `RunStore.transition` can lose a cancellation | [#48](https://github.com/aywengo/mercury/issues/48) | [#90](https://github.com/aywengo/mercury/pull/90) | ✅ resolved |
| H4 | `busy_timeout` does not protect event appends | [#49](https://github.com/aywengo/mercury/issues/49) | [#89](https://github.com/aywengo/mercury/pull/89) | ✅ resolved |
| H5 | SSE frame injection via unvalidated event type | [#50](https://github.com/aywengo/mercury/issues/50) | [#93](https://github.com/aywengo/mercury/pull/93) | ✅ resolved |
| H6 | Every deploy fails in-flight runs and auto-retries them | [#51](https://github.com/aywengo/mercury/issues/51) | [#99](https://github.com/aywengo/mercury/pull/99) | ✅ resolved |
| H7 | Server shutdown hangs until SIGKILL | [#52](https://github.com/aywengo/mercury/issues/52) | [#98](https://github.com/aywengo/mercury/pull/98) | ✅ resolved |
| H8 | The lease-loss recovery path is effectively dead code | [#53](https://github.com/aywengo/mercury/issues/53) | [#94](https://github.com/aywengo/mercury/pull/94) | ✅ resolved |
| H9 | Dashboard silently loses run history beyond 1,000 events | [#54](https://github.com/aywengo/mercury/issues/54) | [#100](https://github.com/aywengo/mercury/pull/100) | ✅ resolved |
| H10 | Daemon adapter `terminate()` never settles the exit promise | [#55](https://github.com/aywengo/mercury/issues/55) | [#102](https://github.com/aywengo/mercury/pull/102) | ✅ resolved |
| H11 | Sandbox does not pass environment, despite saying it does | [#56](https://github.com/aywengo/mercury/issues/56) | [#104](https://github.com/aywengo/mercury/pull/104) | ✅ resolved |
| M1 | Stored XSS via `prUrl` | [#57](https://github.com/aywengo/mercury/issues/57) | [#114](https://github.com/aywengo/mercury/pull/114) | ✅ resolved |
| M2 | Skill ids are caller-controlled and uncontained | [#58](https://github.com/aywengo/mercury/issues/58) | [#92](https://github.com/aywengo/mercury/pull/92) | ✅ resolved |
| M3 | `requeueLostLease` bypasses the state machine | [#59](https://github.com/aywengo/mercury/issues/59) | [#115](https://github.com/aywengo/mercury/pull/115) | ✅ resolved |
| M4 | The §14 event whitelist is decorative | [#60](https://github.com/aywengo/mercury/issues/60) | [#93](https://github.com/aywengo/mercury/pull/93) | ✅ resolved |
| M5 | State and events are not atomic | [#61](https://github.com/aywengo/mercury/issues/61) | [#105](https://github.com/aywengo/mercury/pull/105) | ✅ resolved |
| M6 | Unbounded `sessions` Map | [#62](https://github.com/aywengo/mercury/issues/62) | [#103](https://github.com/aywengo/mercury/pull/103) | ✅ resolved |
| M7 | `maxTokens` / `maxCost` are decorative | [#63](https://github.com/aywengo/mercury/issues/63) | [#118](https://github.com/aywengo/mercury/pull/118) | ✅ resolved |
| M8 | Session cookie has no `Secure` flag | [#64](https://github.com/aywengo/mercury/issues/64) | [#108](https://github.com/aywengo/mercury/pull/108) | ✅ resolved |
| M9 | Rate limiting collapses behind a reverse proxy | [#65](https://github.com/aywengo/mercury/issues/65) | [#109](https://github.com/aywengo/mercury/pull/109) | ✅ resolved |
| M10 | Wrong status codes and internal leakage | [#66](https://github.com/aywengo/mercury/issues/66) | [#110](https://github.com/aywengo/mercury/pull/110) | ✅ resolved |
| M11 | CI never installs dependencies, so the whole API/auth surface is unrunnable there | [#67](https://github.com/aywengo/mercury/issues/67) | [#112](https://github.com/aywengo/mercury/pull/112) | ✅ resolved — `npm ci` added; all three checks green, incl. a job asserting the *uninstalled* failure stays legible |
| M12 | `readFrame` silently drops pipelined frames | [#68](https://github.com/aywengo/mercury/issues/68) | [#111](https://github.com/aywengo/mercury/pull/111) | ✅ resolved |
| M13 | Backup fallback can silently produce a torn backup | [#69](https://github.com/aywengo/mercury/issues/69) | [#120](https://github.com/aywengo/mercury/pull/120) | ✅ resolved |
| M14 | Deploy path mismatch trap | [#70](https://github.com/aywengo/mercury/issues/70) | [#121](https://github.com/aywengo/mercury/pull/121) | ✅ resolved |
| M15 | Lease leak on the skip path | [#71](https://github.com/aywengo/mercury/issues/71) | [#107](https://github.com/aywengo/mercury/pull/107) | ✅ resolved |
| M16 | Races are simulated, not multi-process | [#72](https://github.com/aywengo/mercury/issues/72) | [#113](https://github.com/aywengo/mercury/pull/113) | ✅ resolved |
| L1 | `detectRuntime()` is dead code | [#73](https://github.com/aywengo/mercury/issues/73) | [#124](https://github.com/aywengo/mercury/pull/124) | ✅ resolved |
| L2 | Backlog alerts stall during runs | [#73](https://github.com/aywengo/mercury/issues/73) | [#124](https://github.com/aywengo/mercury/pull/124) | ✅ resolved |
| L3 | Stuck-run detection caps at 200 per status | — | — | ❌ **never fixed** — the "already fixed" entry was wrong; reopened as Round 2 [R2-1](architecture-review.md) |
| L4 | Shipped logrotate config is a no-op | [#73](https://github.com/aywengo/mercury/issues/73) | [#129](https://github.com/aywengo/mercury/pull/129) | ✅ resolved — **deleted**, not documented; the app logs to journald, which already rotates |
| L5 | Admin token compared with `===` | [#73](https://github.com/aywengo/mercury/issues/73) | [#124](https://github.com/aywengo/mercury/pull/124) | ✅ resolved |
| L6 | SSE streams stay open for terminal runs | [#73](https://github.com/aywengo/mercury/issues/73) | [#128](https://github.com/aywengo/mercury/pull/128) | ✅ resolved — close on terminal event + grace backstop for reconnects |
| L7 | Retry-of link renders as literal markup | [#73](https://github.com/aywengo/mercury/issues/73) | [#124](https://github.com/aywengo/mercury/pull/124) | ✅ resolved |
| L8 | Temp-dir leaks in tests | [#73](https://github.com/aywengo/mercury/issues/73) | [#125](https://github.com/aywengo/mercury/pull/125) | ✅ resolved — 131 per run → 0; 26,409 accumulated dirs deleted; guard added |
| L9 | Doc drift on test counts | [#73](https://github.com/aywengo/mercury/issues/73) | [#124](https://github.com/aywengo/mercury/pull/124) | ✅ resolved |
| L10 | systemd hardening blocks the docker sandbox | [#73](https://github.com/aywengo/mercury/issues/73) | [#129](https://github.com/aywengo/mercury/pull/129) | ✅ resolved — opt-in drop-in; baseline stays `ProtectSystem=strict` (fail-closed was already the right direction) |
| L11 | No metrics endpoint + logger redaction untested | [#73](https://github.com/aywengo/mercury/issues/73) | [#130](https://github.com/aywengo/mercury/pull/130) | ✅ resolved — redaction gap in [#130](https://github.com/aywengo/mercury/pull/130); metrics endpoint shipped in [#132](https://github.com/aywengo/mercury/pull/132) |
| L12 | §6 diagram has a phantom `CANCELLED --> RUNNING` edge | [#73](https://github.com/aywengo/mercury/issues/73) | [#124](https://github.com/aywengo/mercury/pull/124) | ✅ resolved |

### Corrections found in Round 2

Four subsections here described the state *during* remediation and were never revised when the work
finished, so they contradicted the table above them. They are replaced rather than left as a footnote,
because a reader who trusts the table and a reader who trusts the prose would reach opposite
conclusions about whether it is safe to enable daemon mode or trust the backlog.

#### L3 was never fixed. Read this before trusting the table.

The table used to say "already fixed before being reached", and the subsection below it explained that
"the `LIMIT 200` on stuck-run detection was gone by the time the item was picked up". It was not gone.
On `main` today, `src/worker/worker.ts` still reads:

```ts
const { runs } = this.deps.runs.list({ status, limit: 200 });
```

There is no cursor and no pagination loop, and `RunStore.list` orders `created_at DESC` — newest first.
So the cap does not merely bound the work, it biases it the wrong way. Measured on this commit with 260
runs in `RUNNING`: 200 examined, **the 60 oldest never examined at all**, and `list()` returned a
`nextCursor` that the caller ignores. The runs most likely to be stuck are precisely the oldest, so the
detection misses exactly the population it exists to find.

Reopened as Round 2 finding **R2-1**. The original reasoning for closing it — "already fixed" — was
never re-verified against the code, which is the one rule this document's own
[Method section](#method-and-confidence) says the review followed.

#### Status subsections were left behind mid-remediation

M11, L10, L4, L6, L8 and L11 were all resolved. The subsections titled "Held, not fixed: M11",
"Partial: L10" and "Still open in #73: L4, L6, L8, L11" were accurate when written and became stale.
The final state is the table above. Two details worth keeping from the superseded prose:

- **M11 was genuinely blocked, and the blocker was a tooling limitation, not a repository one.** The
  reasoning "CI never ran, `get_pull_request_status` reports zero checks" was reading a commit-status
  endpoint on a repository whose CI registers as *check runs*. Empty output from a tool is a fact about
  the tool. Once queried through `commits/<sha>/check-runs`, all three checks were present and green,
  and #112 merged.
- **L11 was two claims bundled**, and only one was a defect. The untested logger redaction was real and
  fixed in #130. The missing metrics endpoint was a feature request, tracked separately as #131 and
  shipped in #132. Bundling them is why the item looked like it could not be closed.

### Found during remediation, not in the original review

Fixing a finding repeatedly surfaced adjacent defects that were filed and fixed rather than
folded in silently:

| Issue | Found while fixing | PR |
| --- | --- | --- |
| [#95](https://github.com/aywengo/mercury/issues/95) | `--skill` path join in `PrimeAgentAdapter` unguarded (defence in depth found while fixing M2) | [#117](https://github.com/aywengo/mercury/pull/117) |
| [#106](https://github.com/aywengo/mercury/issues/106) | Failure bookkeeping still non-atomic on the worker paths, not just the reaper (found while fixing M5) | [#119](https://github.com/aywengo/mercury/pull/119) |
| [#101](https://github.com/aywengo/mercury/issues/101) | `GET /api/runs` read `limit=0` as absent (found while fixing H9) | [#116](https://github.com/aywengo/mercury/pull/116) |
| [#86](https://github.com/aywengo/mercury/issues/86) | Skill content hash was locale-dependent | [#122](https://github.com/aywengo/mercury/pull/122) |
| [#87](https://github.com/aywengo/mercury/issues/87) | Singular task text missed a plural capability | [#123](https://github.com/aywengo/mercury/pull/123) |
| [#88](https://github.com/aywengo/mercury/issues/88) | Substring scoring fired wrong skills from innocent words | [#123](https://github.com/aywengo/mercury/pull/123) |
| [#78](https://github.com/aywengo/mercury/issues/78) | 4 of 12 skills could never be auto-selected | [#84](https://github.com/aywengo/mercury/pull/84) |
| [#79](https://github.com/aywengo/mercury/issues/79) | No test that selector KEYWORDS and the registry agree | [#85](https://github.com/aywengo/mercury/pull/85) |
| [#80](https://github.com/aywengo/mercury/issues/80) | A skill could ship with broken frontmatter undetected | [#83](https://github.com/aywengo/mercury/pull/83) |
| [#81](https://github.com/aywengo/mercury/issues/81) | Skill ids sorted with two different comparators | [#82](https://github.com/aywengo/mercury/pull/82) |
| [#76](https://github.com/aywengo/mercury/issues/76) | `skills.test.ts` failed on main | [#77](https://github.com/aywengo/mercury/pull/77) |

### What the process produced, stated plainly

Two review conclusions in this document turned out to be wrong or incomplete on contact with
the code, and both changed the fix:

- **H8 / M3.** The review asked for the lease-loss path to be repaired. Reading it closely
  showed it was worse than described: it matched `lease_owner != ?`, so it fired when
  *another* worker held the lease and cleared theirs, producing two agents on one workspace.
  The correct fix was deletion, not repair — one recovery path (the reaper) instead of two
  racing ones. See §6.1 of `ARCHITECTURE.md`.
- **M7.** The review framed unenforced limits as a missing enforcement. Enforcement is not
  implementable without per-run usage reporting, which no adapter produces and no event type
  carries. The honest fix was to rename them `budget*` and document them as recorded-only, so
  the name stops implying a guarantee. Renaming left all 297 tests green: the fields had
  **zero** coverage.

Reviewer findings on the fix PRs caught defects in the fixes themselves, including a phishing
vector in the M1 fix (link text showing a trusted host while the href pointed elsewhere), a
partial backup file left behind on failure in M13, a root-owned database in the M13 restore
runbook, and a prototype-chain lookup in M7's migration error message.

Two tests were found to be passing for reasons unrelated to what they claimed. The CLI backlog
alert test (#5) created runs with no repository, so both failed instantly and the alert only
appeared because depth was transiently correct at the sampling instant; it never exercised a
real backlog. A `detectRuntime` test asserted `null || docker || podman`, which is true for
every possible outcome. Both are noted where they were fixed.


---

## Method and confidence

Five reviewers examined core persistence, the worker, the adapters, the API/UI, and
tests/operations in parallel. **Four of the five were cut off before writing a report**,
and two of those four had their output degrade partway through. Only one produced a
complete report.

Every finding below was therefore re-verified directly in source by the author of this
review. Nothing is asserted on a reviewer's authority. Claims that could not be verified
are listed separately in [Unverified](#unverified) and are not counted in the totals.

Two findings were confirmed by **empirical measurement** rather than reading alone: H4
(a runnable `node:sqlite` race test) and the test-suite state in M11.

### Known process failures, and how they were caught

Two errors were made and corrected during this review. They are recorded because they
bear on how much weight to give the findings, and because the failure mode is easy to
repeat.

1. **A completion status was mistaken for a delivered result.** All five reviewers
   reported `completed`, but four had sent no reply and had stopped mid-analysis. Trusting
   the status alone produced a false claim that their reports were in hand. The remedy was
   to read the raw rollouts, which is also how the substance behind most of this document
   was recovered.
2. **A scratch path was written into a durable artifact.** The appendix originally told
   readers to run a script that existed only in a temporary working directory, so the
   reproduction could not be followed. It was replaced with the self-contained script now
   inlined, and that script was re-run before committing.

The shared lesson: **verify against current state before asserting or persisting.** A
status field, a remembered result, or a path that resolves today is not evidence that the
thing will exist for the next reader. Both errors were caught by checking rather than
recalling, and both survived into output that had already been shared.

---

## Findings — High

### H1. Every successful run leaks the agent process

`src/adapters/primeAgentAdapter.ts:176-181` resolves the exit promise on `agent.end`.
The comment in the code admits the consequence:

```ts
// Agent finished; resolve the exit promise (the RPC process may stay alive).
session.done = true;
session.exitResolve({ code, signal: null, reason: ... });
```

`client.stop()` is reachable only from `cancel()` (`:252`) and `terminate()` (`:262`).
The worker calls `terminate()` only on timeout (`worker.ts:295`, `:332`). The success
path breaks the drive loop, awaits an already-resolved exit, and finalizes.

**Impact:** a long-lived worker accumulates one live `prime-agent --mode rpc` process per
completed run.

**Fix:** settle the exit *and* stop the client on the completion path; make termination
the worker's responsibility in a `finally`, not an error-path special case.

### H2. A cancelled run can keep being executed and written to

Interleaving: worker reads `QUEUED`; user cancels; worker writes `STARTING`; cancel
writes `CANCELLED`. The worker is now driving an agent on a run the database calls
cancelled. Its next `transition` to `RUNNING` throws; the catch at
`worker.ts:237-245` appends failure events and then calls `transition(FAILED)`, which
throws again because `CANCELLED → FAILED` is invalid. That second throw unwinds **before
any `terminate()` call**. The `finally` releases the lease; the agent survives.

**Impact:** a live agent writing into the workspace of a cancelled run that nobody is
watching. Worse than H1 — not an idle process but an active writer on stale state.

**Fix:** guard the drive loop on the run's persisted status, and terminate the handle on
every exit path including the throwing one.

### H3. `RunStore.transition` can lose a cancellation

`src/runs/runStore.ts:120-138` performs read → `assertTransition` → `UPDATE` with no
transaction, no `WHERE status = ?` guard, and no lease-owner check. Two concurrent
transitions can both read `RUNNING`, both pass validation, and last-write-wins.

**Impact:** `CANCELLED` can be silently overwritten by `COMPLETED`. The state machine is
correct in isolation and unenforced where it matters, which is the worst combination.

**Fix:** conditional update — `UPDATE runs SET status = ? WHERE id = ? AND status = ?` —
then check `changes === 1` and fail loudly otherwise.

### H4. `busy_timeout` does not protect event appends

`EventStore.append` assigns `sequence` by read-then-insert (`eventStore.ts:36-58`) inside
a **deferred** transaction (`tx()` uses `db.exec('BEGIN')`, `database.ts:141`). In WAL
mode, `busy_timeout` does not apply to a deferred→write upgrade.

Measured against real `node:sqlite`, with a competing writer holding the lock for 1.2 s
and `busy_timeout = 5000`:

```text
deferred : FAIL after  300 ms   msg=database is locked
immediate: OK  seq=1 after 1256 ms
```

The deferred form gave up in 300 ms despite a 5 s timeout. The comment at
`database.ts:101-104` describes `busy_timeout` as the fix for exactly this class of
failure (issue #38), but it does not cover this path.

**Corroboration:** the repository's own concurrency test uses the correct primitive —
`test/migrations.test.ts:89` executes `BEGIN IMMEDIATE`, while production `tx()` at
`database.ts:141` uses deferred `BEGIN`. The right primitive is known and simply not
used in production.

`UNIQUE (run_id, sequence)` (`database.ts:51`) prevents duplicate sequence numbers, so
ordering stays correct, but the append throws and nothing anywhere retries it. Two
processes genuinely contend here: the API appends `run.cancelling` / `run_inputs`
(`runService.ts:181-197`) while the worker appends agent events for the same run
(`worker.ts:394-425`).

**Fix:** `BEGIN IMMEDIATE` in `tx()`. One line. It is also a prerequisite for H3, M3 and
M5 — atomic guards are pointless if the transaction fails instantly instead of waiting.

### H5. SSE frame injection via unvalidated event type

`worker.ts:425` appends `ev.type` straight from the adapter under a comment reading
*"generic structured event passthrough (validated)"* — it is not validated.
`EventStore.append` performs no type check. `isEventType()` (`types.ts:174`) is defined
and **never called anywhere in `src/`**. `routes.ts:134` then writes the type raw:

```ts
res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
```

**Impact:** an agent, or a compromised repository driving one, that emits an event type
containing `\n\n` can inject arbitrary SSE frames into every subscriber of that run.

**Fix:** enforce the `EVENT_TYPES` whitelist at the single write choke point
(`EventStore.append`), which is already positioned to do it. See M4.

### H6. Every deploy fails in-flight runs and auto-retries them

`src/cli.ts:199-205` — the worker's SIGTERM handler is `db.close(); process.exit(0)`. It
never calls `worker.stop()` (which exists at `worker.ts:94` but is **never called from
`cli.ts`**), never terminates the running agent, and never releases leases. Neither
systemd unit sets `TimeoutStopSec`, so there is no shutdown budget either.

**Impact:** in-flight runs stay `RUNNING` until lease expiry (60 s default), are reaped as
`FAILED(infrastructure)`, and are then auto-retried. Every restart converts running work
into spurious infrastructure failures and duplicate agent spend.

### H7. Server shutdown hangs until SIGKILL

`src/cli.ts:188-195` awaits `server.close()`, which waits for open connections. SSE
streams are long-lived by design and never close server-side, and there is no
`closeAllConnections()`.

**Impact:** any dashboard with a run open stalls shutdown until systemd escalates.

### H8. The lease-loss recovery path is effectively dead code

ARCHITECTURE.md roadmap item 5 claims *"lease-loss recovery (abort + requeue)"* is done.
It is wired but unreachable in the scenario it exists for:

1. `reapExpiredLeases` marks an expired `STARTING`/`RUNNING`/`NEEDS_INPUT` run as `FAILED`
   but **does not clear `lease_owner`** (`runQueue.ts:110-113`).
2. `renewLease` matches `WHERE id = ? AND lease_owner = ?` (`runQueue.ts:46`). The owner
   never changed, so it keeps returning `true` and the worker never sets `leaseLost`.
3. `requeueLostLease` requires `lease_owner IS NOT NULL AND lease_owner != ?`
   (`runQueue.ts:75`). Nothing changes a running run's owner, so this is only reachable
   via itself — circular.

**Impact:** worker A's lease expires (GC pause, slow heartbeat, clock skew), the reaper
records `FAILED`, and worker A keeps driving the agent — burning compute and model spend
on a run the database already calls failed — then throws on an invalid transition at
finalize.

**Fix:** clear `lease_owner` / `lease_expires_at` in the reap failure branch. That makes
`renewLease` return false and lights up the abort path that already exists.

### H9. The dashboard silently loses run history beyond 1,000 events

`ui/run.js:32-34`:

```js
const ev = await api('/api/runs/' + runId + '/events?after=' + lastSeq);
for (const e of ev.events || []) appendEvent(e);
lastSeq = ev.lastSequence || 0;   // true max sequence, not max of the returned page
connectSse();
```

`EventStore.list` caps at `limit = 1000` (`eventStore.ts:70`) and the route passes no
limit and returns no cursor — but `lastSequence` is the run's true maximum. For a run
with 5,000 events the UI renders 1–1000, sets `lastSeq = 5000`, subscribes from there,
and **events 1001–4999 are never fetched and never rendered**.

**Impact:** silent history loss on exactly the long-running runs Mercury exists to serve.
Violates §15 steps 2–3 and Definition of Done #14 ("Mercury reconstructs the complete
Run"). No test covers it.

**Fix:** advance from the last *returned* sequence and page until caught up; expose a
cursor from the events endpoint.

### H10. The daemon adapter's `terminate` never settles the exit promise

`daemonAgentAdapter.ts:240-246` sets `terminated`, `cancelled`, `done = true`, destroys
the socket and kills the process, but never sets `exitSettled` or calls `exitResolve`.
The process-exit handler at `:150` is guarded by `if (!session.done && !session.exitSettled)`
— and `done` is now `true`, so it refuses to settle. `handle.exit` never resolves.

The worker then falls through to `Promise.race([handle.exit, sleep(10_000)…])`
(`worker.ts:363-366`) and fabricates `{ code: null, signal: 'SIGKILL', reason: 'terminated' }`
after a full 10 seconds. `cancel()` in the same file (`:268-270`) settles correctly, so
this is an internal inconsistency rather than a deliberate design.

**Mitigation:** this is the non-default `MERCURY_AGENT_MODE=daemon` path, which
ARCHITECTURE.md roadmap item 9 already flags as unverified against a real daemon.

### H11. The sandbox does not pass environment, despite saying it does

`sandboxManager.ts:109-111`:

```ts
// Environment passthrough for the agent (API keys etc. are inherited by the
// worker; the container needs the same env to talk to providers).
args.push('--env', 'PATH=/usr/local/sbin:...');
```

The comment promises passthrough; the code forwards only `PATH`, and `buildCommand`
returns `env: {}`.

**Impact:** a sandboxed run cannot authenticate to any provider — every constrained run
fails at the first model call. Related: `--storage-opt size=` (`:103`) is unsupported on
common overlay2/ext4 docker setups, so requesting a disk limit makes `docker run` fail
outright; and the default image contains no `prime-agent` binary.

The container sandbox is well-designed on paper and largely non-functional in practice.
This matters for the Crew design, which *requires* sandbox for `untrusted` presets.

---

## Findings — Medium

| ID | Finding | Evidence |
| --- | --- | --- |
| M1 | **Stored XSS via `prUrl`.** `esc()` escapes `&<>"'` but not the URL scheme, so a `git.pr` event carrying `javascript:` yields a clickable payload. `prUrl` is agent- and repo-controlled. | `ui/run.js:55`, `ui/app.js:132-136` |
| M2 | **Skill ids are caller-controlled and uncontained.** `body.skills` flows straight through, and `resolveOne` does `join(rootDir, id)` with no containment. `skills: ["../../../../somewhere"]` resolves wherever a `SKILL.md` exists, and `writeSkills` then copies that whole tree into the workspace — an arbitrary-directory read. | `src/api/routes.ts:37`, `src/skills/skillRegistry.ts:45`, `src/worker/worker.ts:659-668` |
| M3 | **`requeueLostLease` bypasses the state machine.** Raw SQL `SET status = 'QUEUED'` from `STARTING`/`RUNNING`/`NEEDS_INPUT`, but `RUNNING → QUEUED` is not a legal transition and `assertTransition` is never called. It also contradicts §21, which says retry creates a *new* run with a fresh `runId`; requeue reuses the same `runId` and `attempt`. Two contradictory recovery semantics exist, and the one bypassing validation is wired to the lease path. | `src/queue/runQueue.ts:73-76`, `src/domain/stateMachine.ts:8` |
| M4 | **The §14 event whitelist is decorative.** `isEventType()` is never called; `append()` validates nothing; and two types the worker already appends — `lease.lost`, `sandbox.enabled` — are not in the whitelist at all. Root cause of H5. | `src/domain/types.ts:141-175`, `src/events/eventStore.ts:36` |
| M5 | **State and events are not atomic.** `reapExpiredLeases` commits `FAILED` inside its transaction, then the worker appends `error` and `run.failed` *after* it commits. A crash in that window leaves a run marked `FAILED` with no failure event. §14.1 requires atomicity. | `src/queue/runQueue.ts:98`, `src/worker/worker.ts:114-126` |
| M6 | **Unbounded `sessions` Map.** Set per run, never deleted anywhere in `src/adapters/`. Session objects and buffers live for the worker's lifetime. | `src/adapters/primeAgentAdapter.ts:78,120` |
| M7 | **`maxTokens` / `maxCost` are decorative.** Stored and validated, never read by the worker. Callers believe budgets apply. Crew presets would inherit this silently-broken behaviour. | `src/runs/runService.ts:73-74,241` |
| M8 | **Session cookie has no `Secure` flag**, unconditionally — including when TLS is enabled via `MERCURY_TLS_*`. `HttpOnly` and `SameSite=Strict` are correct. | `src/api/authRoutes.ts:55`, `src/api/sessions.ts:66` |
| M9 | **Rate limiting collapses behind a reverse proxy.** `trust proxy` is never set, so `req.ip` is the proxy address and every client shares one bucket — legitimate users lock each other out while an attacker sharing the bucket is not meaningfully throttled. The limiter is also fixed-window, in-memory and per-process. | `src/api/server.ts`, `src/api/rateLimit.ts:1` |
| M10 | **Wrong status codes and internal leakage.** A catch-all returns `400` with `String(err.message)` for every handler error, so a database failure is reported as a client error and internal messages reach the browser. AGENTS.md requires `404` for foreign runs; `GET /api/runs/:id` complies but `cancel`/`retry`/`input` return `400 "Run not found"`. | `src/api/routes.ts` catch blocks, `src/api/server.ts:98-100` |
| M11 | **The entire API/auth surface is untestable as checked out.** `node_modules` is absent and 4 of 202 tests fail with `ERR_MODULE_NOT_FOUND: express` — `api`, `auth`, `multiWorker`, `ui`. That is all authentication and authorization coverage. Nothing documents `npm install` as required. Measured: `tests 202 / pass 198 / fail 4`, 12.5 s. | `package.json`, `src/api/server.ts` |
| M12 | **`readFrame` silently drops pipelined frames.** It resolves with `buffer.subarray(4, 4 + len)` and discards everything after the first frame in that chunk, then starts a fresh buffer. Length-prefixed framing must preserve the remainder. It also registers `socket.once('error', reject)` and never removes it. | `src/adapters/daemonAgentAdapter.ts:308-324` |
| M13 | **Backup fallback can silently produce a torn backup.** `cp` is unsafe for a live WAL database — it can capture the DB without its `-wal` file. Restore never removes stale `-wal`/`-shm` files, which can corrupt the restored database. No `PRAGMA integrity_check` verification. | `deploy/backup.sh:19-21`, `deploy/README.md:27-32` |
| M14 | **Deploy path mismatch trap.** App defaults are `./mercury.db` and `./workspaces` under `/opt/mercury`, but the backup cron targets `/var/lib/mercury/mercury.db`. `EnvironmentFile` is mandatory (no `-` prefix) and the ops guide never spells out the required repointing. | `src/config.ts:76,80`, `deploy/README.md:24` |
| M15 | **Lease leak on the skip path.** The ownership guard returns at `worker.ts:155`, but the `try {` owning the lease-releasing `finally` starts at `:159`. A skipped run — including one cancelled between claim and execute — keeps `lease_owner` permanently, since `reapExpiredLeases` only selects non-terminal statuses. | `src/worker/worker.ts:152-159` |
| M16 | **Races are simulated, not multi-process.** Duplicate-claim uses two `claim()` calls on one in-process queue; the idempotency race fakes the interleaving; the "cross-process" poller test does a direct SQL insert in-process. The exact API-vs-worker append contention in H4 is therefore untested. | `test/worker.test.ts:253-268`, `test/runService.test.ts:214-243`, `test/events.test.ts:139-158` |

---

## Findings — Low

| ID | Finding | Evidence |
| --- | --- | --- |
| L1 | `detectRuntime()` is dead code — exported, never referenced outside its own file. | `src/sandbox/sandboxManager.ts` |
| L2 | Backlog alerts stall during runs: `checkBacklog()` shares a loop iteration with `await this.execute(run)`, so a multi-hour run suppresses backlog alerting for its duration — against §25. | `src/worker/worker.ts:130` |
| L3 | Stuck-run detection caps at 200 per status; runs beyond that are never examined. | `src/worker/worker.ts:616` |
| L4 | Shipped logrotate config is a no-op — the app logs JSON to stdout only, so nothing writes `/var/log/mercury/*.log`. | `deploy/logrotate.conf`, `src/logger.ts:29-30` |
| L5 | Admin token compared with `===` — not constant-time. Theoretical over a network. | `src/api/authRoutes.ts` |
| L6 | SSE streams stay open for terminal runs; nothing server-side closes them. Also the mechanism behind H7. | `src/api/routes.ts:120-145` |
| L7 | `run.js:44` assigns markup via `textContent`, so the retry-of link renders as literal `<a href=...>`. Display bug, not XSS. | `ui/run.js:44` |
| L8 | Temp-dir leaks in tests: 13 `mkdtempSync` with 0 `rmSync` in `worker.test.ts`; same pattern in localAgentAdapter, primeAgentAdapter, hermes, api, multiWorker. | `test/worker.test.ts` |
| L9 | Doc drift on test counts: `ARCHITECTURE.md` says 112, `QUICKSTART.md:133` and `README.md:328` say 201, actual is 202. | `ARCHITECTURE.md`, `QUICKSTART.md:133` |
| L10 | systemd hardening as shipped blocks the docker sandbox (`ProtectSystem=strict`, no socket access); no `TimeoutStopSec` in either unit. | `deploy/mercury-worker.service:13-14` |
| L11 | No metrics endpoint. Durations and queue-wait exist only as event payloads; worker-death detection relies on scraping `/healthz/workers`. Logger redaction is itself untested. | `src/api/server.ts:60-75`, `src/logger.ts:24-30` |
| L12 | Spec self-inconsistency: the §6 mermaid diagram includes `CANCELLED --> RUNNING: resume`, but the "complete transition table" below it omits that edge and the code makes `CANCELLED` terminal. No adapter implements resume-from-cancelled. Deleting the edge is cheaper than implementing it. | `ARCHITECTURE.md` §6, `src/domain/stateMachine.ts` |

---

## Root cause analysis

Thirty-nine findings (11 High, 16 Medium, 12 Low) reduce to four causes. Fixing the cause closes the group; fixing
individual findings does not.

### 1. Nothing owns process, connection and session lifecycle

H1, H2, H6, H7, H10, M6, L6.

Exit settlement is hand-rolled in five adapters with three different answers, one of them
wrong. Shutdown handlers close a database and exit. The worker has a `stop()` method that
nothing ever calls. SSE connections are opened and never closed server-side.

This is also the strongest argument for a shared adapter base class handling spawn,
stderr buffering, exit settlement and session lifetime. That is a **correctness**
argument, not an aesthetic one: the same bug is reproduced five times.

### 2. Check-then-act without atomic guards

H3, H4, H8, M3, M5, M15, M16.

The pattern repeats: read state, validate it in JavaScript, write it back unconditionally.
`transition` validates then writes without a status guard. The lease system infers
ownership from a field that the failure path never clears. State and events are written
in separate transactions. And the transaction primitive itself fails instantly under
contention instead of waiting, so even correct guards would be unreliable.

**H4 is the prerequisite for this whole group.** Atomic guards are pointless if the
transaction throws `database is locked` in 300 ms.

### 3. No validation at trust boundaries

H5, M1, M2, M4, M8, M9, M10.

Agent-produced data (event types, PR URLs, skill ids) is treated as trusted when it
crosses into the browser and into the filesystem. The event whitelist exists but is never
applied — and is not even obeyed internally. Error messages are forwarded verbatim.

### 4. Silent data loss in the user-facing path

H9, H11, M7, M13.

The most dangerous category, because nothing surfaces it. History is truncated with no
error. Sandbox env is documented but absent. Budgets are stored but ignored. Backups can
be torn and nothing verifies them. Each of these would look "green" in a demo.

---

## Specification vs implementation

| Spec | Implementation |
| --- | --- |
| §6 *"Invalid transitions SHOULD be rejected"* | Rejected in `canTransition`, but the check is not atomic with the write (H3) and `requeueLostLease` bypasses it entirely (M3) |
| §6 *"A worker receiving a terminal Run MUST NOT execute it again"* | Checked at `worker.ts:152-156` — correct — but a cancel landing *after* the check is not caught (H2) |
| §14 *"events MUST be persisted before, or atomically with, broadcasting"* | Reap commits state, appends events afterwards (M5) |
| §14 event type list | Not enforced; two internal types not even in the list (M4) |
| §14.1 *"sequence assigned by a single writer"* | `UNIQUE` constraint holds the invariant, but concurrent appends throw rather than wait (H4) |
| §15 *"fetch historical events, then subscribe from last observed sequence"* | Advances from the true max instead of the last returned page (H9) |
| §17 *"worker MUST verify it holds the lease"* | Verified at entry; lease loss during execution is undetectable by construction (H8) |
| §21 *"retry creates a new Run with a fresh runId"* | Also requeues the same runId via raw SQL (M3) |
| §24 *"secrets redacted from events and logs"* | Redaction is genuinely well implemented at the write choke point; the logger path is untested (L11) |
| §24 *"resourceLimits enforced by container"* | Wired and fail-closed, but non-functional in practice (H11) |
| Roadmap item 5 *"lease-loss recovery (abort + requeue)"* | Implemented and unreachable (H8) |

---

## What is genuinely good

Worth stating plainly, because the finding list could otherwise misrepresent the codebase.

- **Skill content snapshots.** `SkillRegistry.resolveOne` returns files plus a sha256
  hash, persisted per run. That is real reproducibility, not version pinning, and it is
  the pattern the Crew design reuses.
- **Fail-closed posture.** The sandbox refuses to start a constrained run with no runtime
  (`worker.ts:169`) rather than running it unconstrained. Correct instinct, even where the
  implementation is broken.
- **Redaction at a single choke point.** Every event passes through `append()`, so secret
  scrubbing cannot be bypassed by forgetting a call site. Recent history (issues #36, #43)
  shows this being maintained deliberately.
- **Test discipline.** 52 uses of a condition-polling `waitFor()` against only 5 raw
  sleeps repo-wide; real RPC JSONL protocol fixtures; a genuine cross-thread
  `SQLITE_BUSY` test; `finally` cleanup in 130 places. Above average.
- **The entry guard at `worker.ts:152-156`** implements the §17 MUST exactly — non-terminal
  *and* lease ownership. It is the one place in the lease machinery where the spec is
  honoured precisely.
- **The spec is honest about what it does not promise.** §16 explicitly refuses to
  checkpoint agent in-flight state; §13 keeps skills as guidance rather than an enforced
  pipeline. Resisting that overreach is a design maturity signal.

---

## Remediation sequence

Ordered by dependency, not severity. Each step is independently shippable.

The ordering was the point of this table, and it held up: doing step 1 (`BEGIN IMMEDIATE`)
before step 3 was load-bearing, because a conditional `UPDATE ... WHERE status = ?` is only
atomic once the write lock is taken up front. Shipping them the other way round would have
produced guards that looked correct and were not.

| Step | Change | Unblocks | Status |
| --- | --- | --- | --- |
| 1 | `BEGIN IMMEDIATE` in `tx()` (`database.ts:141`) | H4; makes every guard in group 2 actually hold | ✅ #89 |
| 2 | Path containment helper, wired into `writeSkills` and skill resolution | M2; also a blocking prerequisite for Crew Phase 5 | ✅ #92, #117 |
| 3 | Conditional `transition` (`WHERE id = ? AND status = ?`, check `changes`) | H3 | ✅ #90 |
| 4 | Enforce `EVENT_TYPES` in `EventStore.append`; add `lease.lost`, `sandbox.enabled` to the set | H5, M4 | ✅ #93 |
| 5 | Clear `lease_owner` in the reap failure branch | H8 | ✅ #94, #115 |
| 6 | Terminate the handle on *every* worker exit path, including the throwing one; guard the drive loop on persisted status | H1, H2 | ✅ #96 |
| 7 | Graceful shutdown: `worker.stop()` + lease release + `closeAllConnections()` + `TimeoutStopSec` | H6, H7, L10 | ✅ #98, #99, #129 |
| 8 | Page events from the last *returned* sequence; add a cursor to the events endpoint | H9 | ✅ #100, #116 |
| 9 | Shared adapter base for spawn / stderr / exit settlement / session lifetime | H10, M6, M12 | ✅ #102, #103, #111 |
| 10 | Sandbox env passthrough, disk-limit portability, image contents | H11 | ✅ #104 |
| 11 | `Secure` cookie when TLS is on; `trust proxy`; 404 for foreign runs; stop leaking `err.message` | M8, M9, M10 | ✅ #108, #109, #110 |
| 12 | CI installs dependencies so the API surface is actually tested | M11, M16 | ✅ #112, #113 |

Steps 1-5 are each small, local, and testable. Steps 6-9 are the real work.

Two deviations from this table, both deliberate:

- **Step 5 became a deletion, not a repair.** The lease-loss path was worse than the review
  described — it cleared *another* worker's lease — so `requeueLostLease` was removed and the
  reaper made the single recovery path. See §6.1 of `ARCHITECTURE.md`.
- **Step 12 was held, then landed.** The multi-process contention tests (#113) merged first; the CI
  that installs dependencies (#112) was held because its checks appeared unobservable on this private
  repository. That turned out to be a wrong reading of the wrong API — see
  [Corrections](#corrections-found-in-round-2). Both merged.

**Recommendation on process:** findings in group 3 are security issues in a public
repository. Fix them on a branch with the usual review, not by pushing to `main`. This was
followed: every fix in this table went through a branch and a PR.

---

## Follow-on design

Two items survived remediation as design work rather than defects, and both are now written up:

- **Cross-process event push for multi-host scale** —
  [`cross-process-event-push.md`](cross-process-event-push.md). Relevant to this review because
  M16 (races simulated rather than multi-process) is a standing requirement on any design there:
  the cross-process path is currently untested by construction, so a push design must be validated
  with a real spawned worker process and not an in-process SQL insert.
- **Role presets ("crews")** — [`crew-design.md`](crew-design.md). Its Phase 0 dependency was the
  skill path containment work in #58, which landed as step 2 above.

---

## Unverified

Claims raised during review that this document does **not** assert, because they could not
be confirmed in source:

- A specific LOC saving from adapter deduplication. The duplication is real and
  structural (session maps, exit settlement, `done` discipline, spawn and stderr handling
  across five adapters); the number was not measured.
- Whether `docker`'s `--storage-opt size=` failure affects the deployment actually in use,
  which depends on the host storage driver.

---

## Appendix — reproduction

H4, the measured transaction race. Self-contained — save as `race.mjs` and run
`node race.mjs` (needs only Node; no dependencies):

```js
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
const DB = '/tmp/seqrace.db', mode = process.argv[2];

if (!mode) {                                   // parent: seed, hold a write lock 1.2s
  const s = new DatabaseSync(DB);
  s.exec('PRAGMA journal_mode = WAL;');
  s.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, run_id TEXT, ' +
         'sequence INTEGER, UNIQUE(run_id, sequence));');
  s.exec("INSERT OR IGNORE INTO events VALUES ('seed','r1',0);"); s.close();
  const par = new DatabaseSync(DB);
  par.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  par.exec('BEGIN IMMEDIATE');
  par.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?)').run('hold','r2',0);
  setTimeout(() => { try { par.exec('COMMIT'); } catch {} }, 1200);
  const out = [];
  await Promise.all(['deferred','immediate'].map(m => new Promise(r => {
    const c = spawn(process.execPath, [import.meta.filename, m]);
    c.stdout.on('data', d => out.push(d.toString().trim())); c.on('exit', r);
  })));
  console.log(out.join('\n')); process.exit(0);
}

const db = new DatabaseSync(DB);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
const t0 = Date.now();
try {
  db.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  const r = db.prepare('SELECT COALESCE(MAX(sequence),0) m FROM events WHERE run_id=?').get('r1');
  if (mode === 'deferred') { const w = Date.now() + 300; while (Date.now() < w) {} }
  db.prepare('INSERT INTO events VALUES (?,?,?)').run(mode, 'r1', r.m + 1);
  db.exec('COMMIT');
  console.log(`${mode}: OK  seq=${r.m + 1}  after ${Date.now() - t0}ms`);
} catch (e) {
  console.log(`${mode}: FAIL after ${Date.now() - t0}ms  msg=${e.message}  (busy_timeout is 5000ms)`);
}
```

Observed output (timings vary by run; the shape does not). The deferred form gives up
almost immediately despite a 5 s timeout, while the immediate form waits for the lock and
succeeds:

```text
deferred : FAIL after  ~300ms  msg=database is locked  (busy_timeout is 5000ms)
immediate: OK  seq=1  after ~1200ms
```

Test suite state (M11), from the project's own environment:

```bash
cd /Users/roman/devops/mercury
npm run typecheck   # tsc: command not found (exit 127) — node_modules absent
npm test            # tests 202 / pass 198 / fail 4 / 12.5s
                    # all 4 failures: ERR_MODULE_NOT_FOUND 'express'
                    # failing: api, auth, multiWorker, ui
```

Dead whitelist check (M4):

```bash
grep -rn "isEventType" src/    # only the definition at types.ts:174 — never called
```

# Mercury — Architecture & Design Review · Round 2

Reviewed at commit `6e7a035` (`main`). Node v26.7.0.
Scope: all of `src/` (9,256 lines of TypeScript), `ui/` (854), `test/` (10,259), `deploy/`, and the
four documents under `docs/`, measured against [`ARCHITECTURE.md`](../ARCHITECTURE.md).

**Previous round:** [Round 1 — archived](architecture-review-round-1.md). Its 39 findings are closed
and dispositioned there; nothing below repeats them. This file is the current backlog.

---

## Verdict

Round 1 found that the specification was sound and the implementation failed to enforce it. That
assessment still holds, and the remediation largely delivered: the fixes are real, they are commented
with the reasoning that produced them, and spot-checking the hard ones (lease ownership, shutdown
ordering, transaction atomicity, event paging) found them to do what they claim.

What Round 2 found is a different class of problem. **Three of the closed findings are not actually
closed**, and in each case the closing record is more confident than the code:

- **L3** was recorded as "already fixed before being reached". It was never fixed. The cap is still in
  the source, and it is biased so that the runs most likely to be stuck are the ones never examined.
- **L5** (constant-time admin token comparison) was fixed at one of its two call sites. The unfixed one
  is the path every API request takes.
- **M11/L10/L4/L6/L8/L11** were all genuinely resolved, but the prose describing them was frozen
  mid-remediation and contradicted the table beneath it. A reader who trusted the prose would conclude
  daemon mode was unsafe to enable and the backlog was unmonitored. Neither is now true.

Beyond that, the new findings cluster in one place: **the SSE path advances its cursor before delivery
is known to have succeeded**, which is the same mistake as issue #133 in a different function, and
directly contradicts the invariant written into `docs/cross-process-event-push.md`. The mechanism is
proven below; a production trigger is not, and the finding is graded accordingly.

The most useful thing this round produced is the [status-set table](#the-status-set-has-no-owner). Four
subsystems each hardcode their own list of "live" run statuses and no two agree. That single
inconsistency generates two of the findings below and will generate more.

### Tracking

Every finding below is filed. None is fixed at the time of writing.

| ID | Finding | Sev | Issue |
| --- | --- | --- | --- |
| R2-1 | Stuck-run scan skips the oldest runs | High | [#137](https://github.com/aywengo/mercury/issues/137) |
| R2-2 | Cursor advances before delivery succeeds | Medium | [#138](https://github.com/aywengo/mercury/issues/138) |
| R2-3 | `poll()` swallows every error; comment lies about it | Medium | [#139](https://github.com/aywengo/mercury/issues/139) |
| R2-4 | Two credential-resolution paths, one unfixed | Medium | [#140](https://github.com/aywengo/mercury/issues/140) |
| R2-5 | `activeLeases()` omits `NEEDS_INPUT` | Medium | [#141](https://github.com/aywengo/mercury/issues/141) |
| R2-6 | Every worker re-sends every alert | Medium | [#142](https://github.com/aywengo/mercury/issues/142) |
| R2-7 | SSE handler has no error handling after headers | Medium | [#143](https://github.com/aywengo/mercury/issues/143) |
| R2-8 | Rate-limiter map unbounded, sweep O(n) | Low | [#144](https://github.com/aywengo/mercury/issues/144) |
| R2-9 | SSE writes ignore backpressure | Low | [#145](https://github.com/aywengo/mercury/issues/145) |
| R2-10 | One poll query per subscriber | Low | [#146](https://github.com/aywengo/mercury/issues/146) |
| R2-11 | `slowDown()` fires with no subscribers | Low | not filed — already Stage 0 in [cross-process-event-push.md](cross-process-event-push.md) |

**Suggested order.** R2-3 and R2-7 first: they are small, and they are what would make R2-2 visible
instead of silent. Then R2-2. R2-1 is independent and the highest severity. R2-4, R2-5 and R2-6 are
each a single-file change plus a test.

---

## Method, and what I could not do

Every finding below was read in source at `6e7a035` and, where a claim is numerical or behavioral,
**executed**. Each reproduction is inlined in
[Appendix — reproduction](#appendix--reproduction) and was run on this commit.

Two things did not go as planned, and both changed what this document is allowed to claim:

- **Parallel reviewer subagents were unavailable.** Every model the host listed failed to spawn
  (`unavailable, unauthenticated, or expired`), and the default model produces no report text at all.
  Round 1 hit the same wall and reached the same conclusion: findings must be re-verified in source by
  the author. Nothing below rests on a delegated report.
- **One of my own hypotheses was wrong and is reported as wrong.** I predicted that a client
  disconnecting mid-backlog would make `res.write` throw, crash the worker, or leak a subscriber. I
  tested it against a real HTTP server with a real socket destroyed mid-stream: no uncaught exception,
  and the subscriber was cleaned up correctly. That is why **R2-2 is graded Medium and not High** — the
  ordering defect is real and proven in isolation, but I could not produce a caller that trips it.

Where a finding rests on reading rather than execution, it says so.

---

## Findings — High

### R2-1. Stuck-run detection never looks at the runs most likely to be stuck

**Issue:** [#137](https://github.com/aywengo/mercury/issues/137)

`src/worker/worker.ts:829-831`

```ts
for (const status of ['RUNNING', 'NEEDS_INPUT'] as const) {
  const { runs } = this.deps.runs.list({ status, limit: 200 });
```

`RunStore.list` (`src/runs/runStore.ts:110`) is `ORDER BY created_at DESC, id DESC LIMIT ?` — newest
first — and returns a `nextCursor` that this caller discards. There is no cursor loop and no
`hasMore` check. So the scan covers the **200 most recently created** runs per status and silently
ignores the rest.

The bias is the whole problem. A run becomes stuck by being old and quiet. Sorting newest-first means
that once a deployment has more than 200 runs in these statuses, the runs that qualify are precisely
the ones excluded. The safety net does not degrade gracefully under load; it inverts.

**Measured.** 260 runs forced to `RUNNING` with a 10-hour-old `started_at`, then the exact call above:

```text
totalRunning:              260
examinedByStuckCheck:      200
runsNeverExamined:          60
oldestExaminedCreationRank: 60      # examined = ranks 60..259, i.e. the newest 200
nextCursorFromList:  "RETURNED but checkStuckRuns ignores it (no pagination loop)"
```

**How confirmed:** executed against the real `RunStore` on this commit.

**This is a reopened Round 1 finding.** Round 1 listed it as L3 and closed it as "already fixed before
being reached", asserting the `LIMIT 200` "was gone by the time the item was picked up". It was not
gone. The archive now records the correction.

**Fix.** Page the scan: loop on `nextCursor` until exhausted, or replace the two status queries with
one indexed query that selects `status IN (...) AND <idle predicate>` in SQL and pushes the threshold
into the `WHERE` clause. The second is better — it stops shipping 200 rows to JavaScript to discard
almost all of them, and it makes the threshold a single named value. Either way, add a test with
**more than 200** runs in which the oldest is the stuck one; a test with fewer than 200 cannot fail.

---

## Findings — Medium

### R2-2. The event cursor advances before delivery succeeds

**Issue:** [#138](https://github.com/aywengo/mercury/issues/138)

`src/events/eventStream.ts:42-43`, `:90-91`, `:144-145`

All three delivery paths set the cursor first and hand the events over second:

```ts
sub.afterSeq = event.sequence;                 // :42  append hook
sub.onEvents([event]);

sub.afterSeq = backlog[backlog.length - 1].sequence;   // :90  subscribe() backlog
onEvents(backlog);

sub.afterSeq = events[events.length - 1].sequence;     // :144 poll()
sub.onEvents(events);
```

If `onEvents` throws partway through a batch, the cursor already claims the whole batch was delivered.
`poll()` reads `WHERE sequence > afterSeq`, so the remainder is never re-read. The loss is permanent for
the life of that subscription.

```mermaid
sequenceDiagram
    autonumber
    participant DB as events table
    participant ES as EventStream
    participant CB as send() in routes.ts
    participant CL as browser
    Note over DB: backlog holds sequences 1-5
    ES->>ES: readAfter(0) returns 1-5
    ES->>ES: afterSeq = 5  <-- cursor set BEFORE delivery
    ES->>CB: onEvents([1,2,3,4,5])
    CB->>CL: write event 1
    CB--xCB: throws on event 2
    Note over ES: cursor already says 5
    ES->>DB: poll: WHERE sequence > 5
    DB-->>ES: no rows
    Note over CL: events 2-5 lost permanently<br/>no error, no log, no gap marker
```

**Measured — single-event push path.** Handler throws on sequence 3:

```text
appended:    [1, 2, 3, 4, 5, 6]
delivered:   [1, 4, 5, 6]
permanentlyLost: [3]
```

**Measured — batch backlog path.** Five events already in the database, handler throws on sequence 2:

```text
backlogInDb:       [1, 2, 3, 4, 5]
delivered:         [1]
permanentlyLost:   [2, 3, 4, 5]
```

One throw loses four fifths of the page. `subscribe()` also rethrows, which is what makes R2-7 reachable.

**Why this is the right thing to be worried about** is not that `onEvents` can throw — it is that this
repository already decided the rule. `docs/cross-process-event-push.md` states that push must never own
the cursor and that the cursor advances only when bytes have been handed to the client, and issue #133
was a lost event prefix caused by exactly that. The invariant is written down and this file does not
follow it.

**Blast radius, stated honestly.** The dashboard tracks its own `lastSeq` and reconnects with it
(`ui/run.js:157-165`), so a reconnect recovers lost events. But the client reconnects **only on an SSE
error**. A silent drop with the connection alive — the server sends a keepalive every 15 s, so the
socket looks healthy — leaves a permanent hole in the timeline. If the lost event is the terminal one,
`stopSse()` never fires, `loadRun()` never refreshes, and the UI stays "running" forever; that also
re-opens L6, since the server-side stream then never closes.

**What I could not show.** A caller that actually throws. I ran a real server, opened a stream against a
1,200-event backlog, and destroyed the client socket after the first chunk: no uncaught exception, and
the subscriber was removed correctly. Node returns `false` from `res.write` on a destroyed socket rather
than throwing. So this is a latent defect with a proven mechanism and no demonstrated trigger, graded
Medium on that basis rather than High.

**Fix.** Advance the cursor after `onEvents` returns, in all three places. In `subscribe()` and `poll()`
that means the caller must be re-entrant-safe against re-delivery, which it already is: `send()` writes
duplicates rather than losing them, and the UI filters on `data.sequence > lastSeq`. Prefer
at-least-once over at-most-once — a duplicated timeline row is a cosmetic bug, a missing one is a lie.

### R2-3. `poll()` swallows every error, and its comment describes behavior that does not exist

**Issue:** [#139](https://github.com/aywengo/mercury/issues/139)

`src/events/eventStream.ts:146-148`

```ts
      } catch {
        // drop failing subscription on next poll
      }
```

The `catch` body is empty. Nothing is dropped: the subscription stays in `this.subs` and is retried on
every tick, forever. The comment asserts a recovery policy that is not implemented.

This is the mechanism that would make R2-2 self-healing if the comment were true, and it is why the
ordering bug is invisible rather than loud: any throw from `send()` is discarded with no log line, on a
path where a log line is the only way anyone would ever learn.

**How confirmed:** read, plus the R2-2 single-event run — after the handler threw on sequence 3, the
same subscription went on receiving 4, 5 and 6, which is only possible if it was never dropped.

**Fix.** Either implement the comment (drop the subscription, log it, decrement `subscriptionCount`) or
delete the comment. Do not leave the two disagreeing. A `catch {}` with no log on the only path that
observes delivery failure should be treated as a bug regardless of intent.

### R2-4. Two credential-resolution implementations, and the security fix reached only one

**Issue:** [#140](https://github.com/aywengo/mercury/issues/140)

`src/api/auth.ts:38` versus `src/api/authRoutes.ts:52`

The same bearer token is resolved twice, by two functions that do not share code:

| Path | Resolves via | Admin comparison |
| --- | --- | --- |
| `POST /api/auth/login` (dashboard) | `resolveCredential()` in `authRoutes.ts:51-56` | `secretsEqual` → `timingSafeEqual` |
| **every `/api/*` request** | inline in `createAuthMiddleware`, `auth.ts:38` | `token === adminToken` |

Round 1 filed this as L5 and #124 fixed it — in `authRoutes.ts` only. The middleware that gates the
entire API still uses `===`. The comment on the fixed copy describes the vulnerability precisely:

> `===` short-circuits on the first differing byte, so a caller able to measure response timing could
> walk the admin token one byte at a time.

That sentence is true of `auth.ts:38` today, and that is the higher-traffic of the two paths.

**How confirmed:** read both files; `grep` for `timingSafeEqual` and for `=== adminToken` shows exactly
one site fixed and one not.

**Fix.** Export `resolveCredential` from one module and have both callers use it. The duplication is the
root cause — the timing comparison is just the defect it has already produced. Two implementations of
credential resolution that can drift is the finding; the `===` is the symptom.

### R2-5. `activeLeases()` is the only subsystem that does not consider `NEEDS_INPUT`

**Issue:** [#141](https://github.com/aywengo/mercury/issues/141)

`src/queue/runQueue.ts:224`

```mermaid
flowchart LR
    SM["state machine<br/>TRANSITIONS"]
    subgraph DERIVED["Generated from the machine"]
      RS["requeueForShutdown<br/>SQL filter"]
    end
    subgraph HARDCODED["Handcoded, three different answers"]
      RP["reapExpiredLeases<br/>QUEUED STARTING RUNNING NEEDS_INPUT"]
      ST["checkStuckRuns<br/>RUNNING NEEDS_INPUT"]
      AL["activeLeases<br/>RUNNING STARTING"]
    end
    SM -.->|only this one is derived| RS
    AL ==>|"NEEDS_INPUT missing"| GAP["metrics blind spot<br/>R2-5"]
    ST ==>|"no pagination"| GAP2["stuck-run blindness<br/>R2-1"]
    style AL fill:#8b0000,color:#fff
    style GAP fill:#8b0000,color:#fff
    style GAP2 fill:#8b0000,color:#fff
    style SM fill:#1f4d3d,color:#fff
```

Four subsystems each hardcode which run statuses count as live. They do not agree:

| Subsystem | QUEUED | STARTING | RUNNING | NEEDS_INPUT |
| --- | :-: | :-: | :-: | :-: |
| `reapExpiredLeases` (`runQueue.ts`) | yes | yes | yes | yes |
| `requeueForShutdown` (generated from the state machine) | no | yes | yes | yes |
| `checkStuckRuns` (`worker.ts:829`) | no | no | yes | yes |
| **`activeLeases` (`runQueue.ts:224`)** | **no** | **yes** | **yes** | **no** |

A run in `NEEDS_INPUT` holds its lease — the worker is parked in `waitForInput` still owning it — and the
reaper knows that. `activeLeases` does not. Consequences, all on `/metrics`:

- `mercury_workers` and `mercury_claimed_runs` under-report. A worker whose only run is waiting for input
  reports **zero workers and zero claimed runs** while holding a live lease and a live agent process.
- `mercury_lease_seconds_remaining` ignores `NEEDS_INPUT` entirely, so the lease that is most likely to be
  close to expiry — one parked on a human who has not answered — is the one the gauge cannot see.

`test/metrics.test.ts` never mentions `NEEDS_INPUT`, so nothing pins this.

**How confirmed:** read all four status sets and tabulated them; confirmed the worker transitions to
`NEEDS_INPUT` at `worker.ts:565` without releasing the lease.

**Fix.** Add `NEEDS_INPUT` to `activeLeases`. Better, derive all four sets from one place —
`shutdownRequeueSources` already proves this is possible by generating SQL from `TRANSITIONS`, and the
comment at `runQueue.ts:104-110` explains that doing so was the entire point of issue #59. The same
argument applies here verbatim and was not carried across.

### R2-6. Every worker sends its own copy of every alert

**Issue:** [#142](https://github.com/aywengo/mercury/issues/142)

`src/worker/worker.ts:71`, `:785-800`, `:823-862`

Both alert paths measure a **cluster-global** quantity and dedupe with **per-process** state:

- `checkBacklog` reads `queue.queuedCount()` — the whole queue — and gates on `private backlogAlerted`,
  whose comment claims it "prevents spam". It prevents one worker from spamming. With N workers it
  produces N alerts for one backlog, because each worker owns an independent flag.
- `checkStuckRuns` lists runs with no `lease_owner` filter, so every worker examines every run in the
  cluster and POSTs its own webhook for the same stuck run.

`deploy/` ships a single worker unit, but multi-worker is a supported topology — there is a dedicated
`test/multiWorker.test.ts`, and `/metrics` exposes a worker count precisely because more than one is
expected. On a 4-worker deployment the operator gets 4× the alerts for a single incident, which is how
alerting gets muted and then ignored.

**How confirmed:** read both methods and the flag's declaration; no ownership or leader guard exists.

**Fix.** Either scope the work to the owner (`WHERE lease_owner = ?` for stuck runs, which also makes
each worker responsible for its own) or elect one alerting worker. Scoping is cheaper and also fixes the
"worker A alerts about a run it cannot act on" confusion. Backlog depth has no owner, so that one needs a
leader or a shared dedupe row; if that is judged not worth it, fix the comment, which currently promises
a guarantee it does not provide.

### R2-7. The SSE route handler has no error handling, after it has already sent headers

**Issue:** [#143](https://github.com/aywengo/mercury/issues/143)

`src/api/routes.ts:214-289`

`/runs/:runId/stream` is the only route in the file without a `try`/`catch`. It calls
`res.writeHead(200, …)` at `:222`, then `deps.stream.subscribe(...)` at `:256` — and `subscribe()`
rethrows if the backlog handler throws, which R2-2 proves it can. The throw escapes to Express's default
handler, which attempts a 500 response on a response whose headers are already sent.

**How confirmed:** read the handler (no `try` in its body, unlike every sibling route); confirmed the
rethrow by execution in the R2-2 batch reproduction, which printed
`subscribe() rethrew: Error: res.write threw (client gone)`.

**Fix.** Wrap the post-headers section, and on error call `end()` rather than delegating to Express —
once headers are out, the only correct action is to close the stream. This also gives R2-3's log line
somewhere to live.

---

## Findings — Low

### R2-8. Rate-limiter bucket map grows without bound and the sweep frees nothing

**Issue:** [#144](https://github.com/aywengo/mercury/issues/144)

`src/api/rateLimit.ts:30`, `:54-58`

`sweep()` deletes only buckets whose window has elapsed, and it runs only once `buckets.size >= 10_000` —
after which it runs on **every request that introduces a new key**. When key churn outruns the window,
the sweep frees nothing, the map grows without bound, and each new-key request pays an `O(size)` scan.

**Measured** — 40,000 distinct keys inside one 60 s window:

```text
cumulativeMs: { first_5k: 3, first_10k: 4, first_20k: 531, first_40k: 2492 }
ms/req first 5k   = 0.0006
ms/req 20k -> 40k = 0.0980      slowdown = 163x
```

Cost per request grows linearly in map size, so total cost is quadratic.

**The obvious attack does not work, and I checked.** I expected `MERCURY_TRUST_PROXY=1` to let a caller
mint keys via `X-Forwarded-For`. It does not: Express takes the hop counted from the **right**, so with a
real proxy appending the true client address, `req.ip` is the real address. Verified against Express with
`trust proxy = 1` — sending `X-Forwarded-For: 203.0.113.140, 198.51.100.7` yielded `req.ip =
198.51.100.7`. Triggering this therefore needs many genuine source addresses, or a `trustProxy` depth set
higher than the real hop count. Graded Low for that reason.

**Fix.** Bound the map with an LRU or a periodic timed sweep independent of the insert path, and cap the
number of distinct keys per window.

### R2-9. SSE writes ignore backpressure

**Issue:** [#145](https://github.com/aywengo/mercury/issues/145)

`src/api/routes.ts:246-253` — `send()` loops `res.write(...)` over up to 500 events and discards the
return value. A client that stops reading leaves Node buffering the socket without limit. Authenticated,
so not the worst exposure, but one browser tab on a run with a large backlog is enough to make the server
hold the whole backlog in memory. Fix: on `false`, stop and resume on `drain`, or drop the subscription.

### R2-10. `poll()` issues one query per subscriber, with no dedup by run

**Issue:** [#146](https://github.com/aywengo/mercury/issues/146)

`src/events/eventStream.ts:139-149` — each subscription gets its own `readAfter` every tick. Ten tabs on
one run is ten identical `SELECT … LIMIT 500` queries four times a second. Group subscriptions by
`runId` and read once.

### R2-11. `slowDown()` fires on every append, including with no subscribers

`src/events/eventStream.ts:45` — the call sits outside the subscriber loop, so any event on any run drops
the poller to the 2 s cadence, and the cadence is slowest exactly when the system is busiest. Already
analyzed and given a Stage 0 fix in `docs/cross-process-event-push.md`; listed here so the backlog is
complete, not as new work.

---

## The status set has no owner

Worth separating from the finding list because it generates findings rather than being one.

Four places hardcode "which statuses count as live" and three different answers are in use
(the table is in [R2-5](#r2-5-activeleases-is-the-only-subsystem-that-does-not-consider-needs_input)).
Round 1 already solved this exact shape of problem once: `requeueForShutdown` had a hardcoded status list
that happened to be correct, issue #59 called that out as correct "only by coincidence", and the fix
generates the SQL filter from `TRANSITIONS` so it cannot drift.

That solution exists, is documented, and was not applied to the three other places that need it. The
`NEEDS_INPUT` blind spot in `/metrics` is what the un-fixed copies look like.

---

## What Round 1 got right

Verified rather than assumed, because a review that only lists defects misrepresents a codebase.

- **Shutdown ordering is correct.** `cli.ts:244-257` stops claiming, then **bounded-waits on
  `activeCount()`** before closing the database, and a second signal exits immediately with the reaper as
  the documented backstop. I expected `activeCount()` to be an unobserved getter; it is awaited.
- **`releaseLease` is guarded by terminality with the reasoning written down** (`runQueue.ts:47-80`),
  including the measurement that shows why clearing a lease on an active run strands it forever.
- **`requeueLostLease` stayed deleted**, with the proof of what it did preserved at `runQueue.ts:118-131`.
- **`BEGIN IMMEDIATE`, conditional transitions, and the re-entrant `tx()`** are all in place, and the
  failure-bookkeeping writes are inside one transaction at both sites (`worker.ts:342-347`).
- **`parseLimit`** (`routes.ts:53-69`) handles absent, empty, whitespace, non-numeric, repeated and
  out-of-range values, and the comment explains why the floor is 1 rather than 0.
- **The metrics module documents its own preconditions** — why the histograms are legitimately monotonic,
  why `strftime('%s')` rather than `julianday`, why `le` is inclusive — and `grep` confirms there is still
  no `DELETE FROM` anywhere in `src/`, which is the assumption those histograms rest on.

---

## Not re-examined

- **`DaemonAgentAdapter` protocol correctness.** Assessed exhaustively against the real daemon in
  [daemon-agent-sessions.md](daemon-agent-sessions.md); that document supersedes anything that could be
  said here.
- **Multi-host / cross-process event transport.** Design-only in
  [cross-process-event-push.md](cross-process-event-push.md); no implementation exists to review.
- **`ui/` type safety.** `ui/` is outside the tsconfig program (`allowJs` off), so `npm run typecheck`
  proves nothing about 854 lines of browser JavaScript. This round read it for logic only. A standing
  gap, not a new one.

## Unverified

Claims raised during this round that the document does **not** assert:

- That any production caller can make `send()` throw. Tested against a real server and a destroyed
  socket; it did not. R2-2 is graded on the mechanism, not on a demonstrated trigger.
- Whether the rate-limiter growth is reachable on the deployment actually in use, which depends on
  `MERCURY_TRUST_PROXY` and the real proxy hop count.
- Whether alert duplication has been observed. It is derived from the code, not from an incident report.

---

## Appendix — reproduction

Three scripts, each run on `6e7a035`. They are written to be pasted into a file under `test/` or
`src/` and deleted afterwards; none of them mutate the repository.

**1. R2-1 — the stuck-run scan skips the oldest runs.**

```ts
import { openDatabase } from '../src/db/database.ts';
import { RunStore } from '../src/runs/runStore.ts';
const db = openDatabase(':memory:');
const store = new RunStore(db);
const N = 260, now = Date.now(), ids: string[] = [];
for (let i = 0; i < N; i++) {
  const id = 'run' + String(i).padStart(4, '0');
  ids.push(id);
  store.insert({
    id, ownerId: 'o', task: 't' + i,
    repository: { url: 'https://example.com/a.git', ref: 'main' }, repositories: [],
    workspaceBranch: 'b', workspacePath: '/tmp/x', agent: 'fake', status: 'RUNNING',
    attempt: 1, retryOf: null, error: null, errorKind: null,
    constraints: { maxDurationMs: 3600000, maxRetries: 0 },
    createdAt: new Date(now - (N - i) * 60000).toISOString(),
    startedAt: new Date(now - 10 * 3600e3).toISOString(), completedAt: null,
    leaseOwner: 'w1', leaseExpiresAt: new Date(now + 600000).toISOString(),
    cancellationRequestedAt: null, finalCommits: [], prUrl: null,
  });
}
// exactly what checkStuckRuns does
const { runs, nextCursor } = store.list({ status: 'RUNNING', limit: 200 });
const seen = new Set(runs.map((r) => r.id));
console.log({
  examined: runs.length,
  neverExamined: ids.filter((id) => !seen.has(id)).length,
  oldestExaminedRank: ids.findIndex((id) => seen.has(id)),   // 60 -> the 60 oldest are skipped
  nextCursorIgnored: nextCursor !== null,
});
```

**2. R2-2 — one throw loses the rest of the page.**

```ts
import { openDatabase } from '../src/db/database.ts';
import { EventStore } from '../src/events/eventStore.ts';
import { EventStream } from '../src/events/eventStream.ts';
const db = openDatabase(':memory:');
const store = new EventStore(db);
const stream = new EventStream(db, store, 20, 20);
stream.start();
for (let i = 1; i <= 5; i++) store.append('run1', 'agent.message', { n: i });
const delivered: number[] = [];
let boom = false;
try {
  stream.subscribe('run1', 0, (evs) => {
    for (const e of evs) {
      if (!boom && e.sequence === 2) { boom = true; throw new Error('write failed'); }
      delivered.push(e.sequence);
    }
  });
} catch (e) { console.log('subscribe rethrew:', String(e)); }
await new Promise((r) => setTimeout(r, 300));   // many poll ticks
stream.stop();
console.log({ delivered, lost: [1,2,3,4,5].filter((s) => !delivered.includes(s)) });
// -> delivered [1], lost [2,3,4,5]
```

**3. R2-8 — sweep cost once the map passes the threshold.**

```ts
import { createRateLimiter } from './rateLimit.ts';
const lim = createRateLimiter({ windowMs: 60_000, max: 5, group: 'auth-login' });
const req = (ip: string) => new Promise<void>((resolve) => {
  const rq: any = { ip, method: 'POST', auth: undefined };
  const rs: any = { set(){ return rs; }, status(){ return rs; }, json(){ resolve(); } };
  lim(rq, rs, () => resolve());
});
const marks: Record<string, number> = {}; const t0 = performance.now();
for (let i = 0; i < 40_000; i++) {
  await req(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
  if (i === 4_999) marks.first_5k = Math.round(performance.now() - t0);
  if (i === 19_999) marks.first_20k = Math.round(performance.now() - t0);
  if (i === 39_999) marks.first_40k = Math.round(performance.now() - t0);
}
console.log(marks);   // 3ms / 531ms / 2492ms -> 163x per-request slowdown
```

**4. R2-2 trigger test — negative result, reported as such.** Start the real app with a 1,200-event
backlog, open `/api/runs/:id/stream` on a raw `net` socket, destroy the socket after the first chunk,
wait, then read `stream.subscriptionCount`. Observed: no `uncaughtException`, and the subscriber count
returned to 0. The disconnect path is handled correctly.

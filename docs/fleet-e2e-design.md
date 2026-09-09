# Fleet end-to-end testing

Status: **Phases 0-3 implemented** (`test/fleetContract.test.ts`, 6 tests, 6/6 mutations caught). Phases
4-5 are design. See §7.

## 1. Problem

Fleet has 191 tests across 19 files. Almost all of them build a server in-process with
`createFleetServer(...)`, and the one test that crosses a process boundary — `journey.test.ts`,
which spawns the real `fleet serve` — points it at a **hand-written fake Mercury**:

```ts
url === '/healthz/workers'
  ? { workers: [{ workerId: 'w1', activeRuns: 0 }], queueDepth: 0 }
  : url === '/api/agents' ? { agents: ['prime-agent'] } : { ok: true }
```

That literal is the problem. It was written by the same author, at the same time, as the probe that
reads it. It asserts that Fleet agrees with a description of Mercury that nobody but Fleet has ever
read.

The real host answers differently:

| endpoint | real host (`src/api/server.ts`) | the fake |
| --- | --- | --- |
| `/healthz` | `{ ok, ts, product, version }` | `{ ok: true }` |
| `/healthz/workers` | `{ workers: ActiveLease[], queueDepth }` where `ActiveLease = { workerId, activeRuns, oldestLeaseExpiresAt }` | `{ workers: [{ workerId, activeRuns: 0 }], queueDepth: 0 }` |
| `/healthz/workers` with no queue | **503** `{ error: 'queue not configured' }` | never happens |
| `/api/agents` | `{ agents, defaultAgent }` | `{ agents }` |

Nothing ties the two columns together. The host's own tests assert the host's shape; Fleet's tests
assert the fake's shape. If `activeRuns` were renamed, or `oldestLeaseExpiresAt` dropped, or
`/api/agents` nested its list, **both suites would stay green and Fleet would break in production.**
That is the classic integration failure, and it is invisible precisely because each side tests itself.

Two concrete holes the fake already has:

- `activeRuns` is hardcoded to `0`, so **Fleet's capacity arithmetic has never been exercised with a
  non-zero number across the process boundary.** The unit tests cover summing; nothing covers the real
  host producing a real number.
- The fake never returns 503, so the "reachable but not serving work" path is proven only against a
  status code Fleet's author invented, not the one Mercury actually sends.

## 2. Goals

- Make Fleet's view of a host derive from **what the real host sends**, not from a description of it.
- Detect drift in either direction: a host-side rename must fail a Fleet test, and a Fleet-side
  assumption the host does not satisfy must fail a Fleet test.
- Exercise capacity with real numbers from a real `RunQueue`.
- Cover the real 503 path.
- Run in CI. `e2e/` is Docker-gated and deliberately excluded from CI; this must not be.

## 3. Non-goals

- **Not containers.** Nothing here needs Docker. Spawning the real host in-process and the real
  `fleet serve` as a child gives a true process boundary at a fraction of the cost, and keeps the test
  in `test:fleet`, which CI runs. `e2e/` stays the place for container topology.
- **Not a second copy of `journey.test.ts`.** The happy path across the process boundary is covered.
  This file is about the *shape of the wire*.
- **Not re-testing Fleet's internals.** Routing, sweeping, mirroring and dispatch already have deep
  coverage against in-process doubles. This does not duplicate them.

## 4. Design decisions

### 4.1 Real host in-process, real Fleet as a child

`makeEnv()` builds a real SQLite database, `RunStore`, `EventStore` and `RunQueue`; `createApp()` builds
the real Express router. So the host side is Mercury's actual code, including `activeLeases()` and its
SQL. Only the *process* is shared. Fleet runs as a real `node cli.ts serve` child, exactly as
`journey.test.ts` does, so the Fleet side is genuinely out-of-process.

The thing under test is the **wire between them**, and a wire is fully exercised as long as both ends
are real code.

### 4.2 Pass `queue` to `createApp`

`test/api.test.ts` builds its app without `queue`, which makes `/healthz/workers` answer 503. That is
correct for those tests. Here it would mean every capacity assertion silently tests the 503 path.
So the contract test passes `queue: env.queue` explicitly, and a separate test builds the app
*without* it to prove the 503 path against the real host rather than an invented status.

### 4.3 Bind loopback explicitly

`app.listen(0)` with no host binds the wildcard, and on macOS/BSD a wildcard bind can coexist with
another process already holding 127.0.0.1 on that port — requests meant for this app get answered by
an unrelated server (issue #185). Every listener here binds `127.0.0.1` explicitly.

### 4.4 Drift is asserted structurally, not by example

Beyond behaviour, the test asserts the **key sets** the host actually returns against the keys Fleet
parses. A rename on either side fails with a message naming both sides. This is the part the fake
cannot provide even if it is kept up to date, because it checks the real object.

## 5. Where the test lives, and why that is not `fleet/test/`

`fleet/test/coupling.test.ts` forbids any file under `fleet/` importing anything outside `fleet/`. That
rule is what keeps Fleet a separate product rather than a subdirectory that reaches into host internals.
A contract test must import the host's real code to be worth anything, so it cannot live in `fleet/test/`
without breaking the rule it is supposed to complement.

It lives in `test/` instead, and reaches Fleet **only** by spawning `fleet/cli.ts` and speaking HTTP.
The last test in the file asserts exactly that, by scanning its own imports: if someone later imports
Fleet source there to "simplify" the harness, the test fails, because the file would then be proving that
two modules agree rather than that two processes agree -- a much weaker claim the in-process suite already
makes.

## 6. Phases

| Phase | Content | State |
| --- | --- | --- |
| 0 | Real host + real `fleet serve`; probe derives from real JSON | implemented |
| 1 | Real capacity: a real claimed-and-started Run produces non-zero `activeRuns` and `queueDepth` | implemented |
| 2 | The real 503 path (app built without `queue`) -> `not_serving` | implemented |
| 3 | Structural drift guard on the key sets, both directions | implemented |
| 4 | Capacity changes underneath a live Fleet: finish a Run, re-probe, no stale cache | implemented |
| 5 | Dispatch across the wire: submit through Fleet, host runs it, Fleet's sweeper reconciles | design |
| 6 | Event mirroring across the wire with the real `EventStream` | design |

## 6b. Two sharp edges this found by being wrong

Both were bugs in the test, not in Fleet, and both are worth recording because they are easy to write
invisibly.

**Claiming a Run is not capacity.** `RunQueue.claim()` sets `lease_owner` and `lease_expires_at` and
leaves the status `QUEUED`. `activeLeases()` deliberately excludes `QUEUED` -- a queued Run holding a
lease is the claim-to-`STARTING` window, where a worker may have died, so it is not evidence of a live
worker (see `ACTIVE_WORK_STATUSES` and issue #141). A first draft claimed a Run, asserted
`activeRuns === 0`, and would have passed forever while proving nothing about capacity. The test now
claims **and** transitions to `STARTING`, which is what a worker actually does.

**`releaseLease()` is terminal-only and returns `void`.** It opens with
`if (!row || !isTerminal(row.status)) return;`. Calling it on an active Run is a silent no-op. A draft
used it to "finish" a Run, observed `activeRuns` stay at 1, and looked like a Fleet staleness bug. Fleet
was right; the test had changed nothing. The test now drives `STARTING -> RUNNING -> COMPLETED`.

## 6c. Mutation results

A contract test that passes proves nothing until it is shown to fail. Each mutation was applied to host
source, the suite run, and the source restored.

| Mutation to the host | Caught by |
| --- | --- |
| rename `activeRuns` -> `runningRuns` | capacity tests + drift guard |
| drop `oldestLeaseExpiresAt` | drift guard |
| rename `workerId` -> `lease_owner` | capacity test + drift guard |
| queue-less host answers 200 instead of 503 | `not_serving` test |
| add a field to `/api/agents` | drift guard |
| rename `queueDepth` -> `depth` | capacity test + drift guard |

The second row initially **passed**. The drift guard asserted the lease key set only `if (lease)` was
truthy, and the test never created a lease, so `workers` was `[]` and the assertion was vacuous. It now
creates a lease and asserts exactly one exists before comparing keys. A guard whose only observed
behaviour is "no violations" has not been tested.

## 7. Why this is not just `journey.test.ts` with a different stub

Swapping the fake for the real server would be the small version of this. It is worth doing and is
done, but the value is not the swap — it is that the assertions are now **about the host's object**.
A test that reads `workers[0].activeRuns` from a real `activeLeases()` result fails when the column is
renamed. A test that reads it from a literal never can.

## 8. Running

```bash
npm run test:fleet                       # includes this file; runs in CI
node --test fleet/test/contract.test.ts  # just this file
```

No Docker, no network, no credentials. Every listener is loopback-only and every process is a child of
the test, torn down in `finally`.

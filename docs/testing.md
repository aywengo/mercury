# Testing

Mercury uses Node's built-in test runner. Normal tests do not require a real
PrimeAgent process, an LLM API or external network services.

## Commands

```bash
npm install
npm run typecheck
npm test
```

Focused suites:

```bash
npm run test:core
npm run test:fleet
node --test --test-timeout=180000 test/worker.test.ts
node --test --test-timeout=180000 fleet/test/routing.test.ts
```

`npm test` runs core and Fleet sequentially. TypeScript checks include both
`src/` and `fleet/`.

Do not publish evergreen test counts in overview documentation; counts change
frequently. The test command is the source of truth.

## Bound every command

A hung command is operationally different from a failed test. Every invocation
needs an external time bound.

macOS does not provide GNU `timeout` by default. Use the test runner's
`--test-timeout`, `gtimeout` when installed, or Python without a shell:

```python
import subprocess

subprocess.run(
    ["npm", "test"],
    cwd="/path/to/mercury",
    check=True,
    timeout=180,
)
```

Expected order of magnitude:

- typecheck: about 10 seconds;
- full suite: about 25 seconds;
- focused file: usually 1–5 seconds.

Past roughly two minutes, investigate a hang instead of extending waits
indefinitely.

## Test doubles

### FakeAgentAdapter

Core worker and API tests use a deterministic fake adapter. Scripts can emit:

- agent and tool events;
- test and Git events;
- human-input requests;
- delays;
- failures and completion.

This covers orchestration without model variability.

### PrimeAgent RPC fixture

`test/fixtures/mock-prime-agent-rpc.mjs` speaks the RPC JSONL protocol used by
`PrimeAgentAdapter`. Environment knobs control modes, argv capture, environment
capture, sessions and logs.

The fixture tests protocol translation and process behavior without launching a
model.

### Other adapter fixtures

Local, remote, Hermes, Claude and daemon adapters use focused fixtures matching
their expected interfaces. A fixture proves Mercury's interpretation of that
interface; it does not replace compatibility testing against the real
third-party binary or service.

The daemon fixture is a known example of this distinction: its tests pass while
the canonical real-daemon verification remains negative. See
[`daemon-agent-sessions.md`](daemon-agent-sessions.md).

## Core coverage

Core tests cover:

- Run creation, persistence and owner-scoped idempotency;
- state-machine transitions and terminal behavior;
- queue claims, leases and duplicate-execution prevention;
- worker success, failure, timeout, cancellation and shutdown;
- human input and input timeout;
- infrastructure retry and pinned base commits;
- event sequencing, validation, pagination and SSE reconnect;
- authentication, sessions, rate limiting and safe errors;
- secret redaction in events and logs;
- skill validation, selection, hashing and containment;
- agent adapter startup, translation, resume and cleanup;
- workspace isolation, extra repositories and garbage collection;
- container command construction and fail-closed sandbox behavior;
- metrics and health endpoints;
- deployment, backup and test-hygiene guards.

When changing a lifecycle or security invariant, add a regression test at the
write or transition choke point rather than testing only one caller.

## Fleet coverage

Fleet tests cover:

- host registry and credential references;
- probing and health-state classification;
- explicit dispatch and crash-safe pending bindings;
- reconciliation and `UNKNOWN` semantics;
- event cursor mirroring and SSE;
- locality, label, agent and capacity routing;
- input, cancellation and retry forwarding;
- per-host metrics relabeling;
- authentication and caller host allowlists;
- the rule that Fleet imports nothing from Mercury `src/`.

Fleet tests may use localhost servers but do not depend on external hosts.

## Timing-sensitive tests

Cancellation, input timeout, lease expiry and stuck-run tests need margins wide
enough for loaded CI. Prefer:

- event or state polling with a bounded deadline;
- deterministic injected delays;
- generous relationships between heartbeat, lease and timeout values.

Do not add sleeps to production code to stabilize a test.

## Temporary resources

Use `test/helpers.ts::makeEnv` for isolated core environments. It creates a
temporary database and fake worker; close it in `finally`.

Tests that create temporary directories must register cleanup. The hygiene test
guards against leaked directories.

Use ephemeral localhost ports and close servers, event streams, timers,
databases and child processes on every path.

## Verification by change type

### Domain or persistence

Run the focused domain/store test, migration tests where relevant, typecheck and
the full suite.

### Worker or adapter

Run the adapter test and `test/worker.test.ts` first, then the full suite. Verify
process cleanup on success and failure.

### API or UI

Run API/auth/rate-limit/UI tests, then the full suite. Check owner scoping and
safe error behavior.

### Fleet

Run the relevant `fleet/test/*.test.ts`, then `npm run test:fleet` and
typecheck.

### Documentation only

Check relative links, code fences, Mermaid syntax, diagnostics and:

```bash
git diff --check
```

The full suite is unnecessary unless documentation generation or validation
tooling depends on code.

## Reporting

Before completion, report:

- commands executed;
- passing, failing and skipped tests;
- whether the full suite ran;
- unresolved failures and whether they predated the change.

Never claim a test passed unless it was executed.

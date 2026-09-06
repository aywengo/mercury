# Local pre-PR E2E gate

Design: [../docs/local-e2e-design.md](../docs/local-e2e-design.md). This directory is the
implementation; the design document stays authoritative for intent and trade-offs.

## What is here

| File | Owns |
| --- | --- |
| `Dockerfile` | The test image: the supported Node floor, git, an image copy of the checkout, non-root. |
| `compose.yml` | The production-shaped topology: one-shot `fixture`, then separate `api` and `worker` sharing one named volume. |
| `preflight.ts` | Checks that fail fast and readably before any container exists, plus the shared deadlines. |
| `system.test.ts` | The gate itself: lifecycle, isolation assertions, diagnostics, teardown. |
| `helpers.ts` | Public-interface client, deadline-based Run polling and the SSE parser. Nothing here imports Mercury internals. |
| `helpers.test.ts` | Control-flow tests for the above against a stub HTTP server. Needs no Docker daemon. |

## Commands

```bash
npm run test:e2e         # build the image, start the stack, assert, tear down
npm run test:e2e:config  # validate the compose model without starting anything
node --test e2e/helpers.test.ts   # helper control-flow only, no Docker needed
```

`npm test` deliberately does **not** run these. It stays Docker-free and fast; CI never runs this
suite.

## Requirements

A running Docker (or Podman) daemon with Compose v2. If it is missing, the gate says so during
preflight rather than failing a scenario.

## Debugging a failure

Every failure writes bounded logs and a summary to `/tmp/mercury-e2e-<project>/` and prints the
path. That directory is removed on success.

```bash
MERCURY_E2E_KEEP_ON_FAIL=1 npm run test:e2e   # leave the stack up after a failure
MERCURY_E2E_VERBOSE=1      npm run test:e2e   # startup detail on stderr
```

With keep-on-fail, automatic cleanup is disabled **before** startup, so a failed run leaves
containers, a network and a volume behind. The harness prints the exact project name and the
cleanup command; a successful run still tears down.

## What is asserted

Foundation: the image builds from the checkout, API and worker are separate non-root containers
sharing one volume at `/state`, only a random loopback port is published, no host path or Docker
socket reaches a container, and teardown leaves nothing.

Journey: a fake Run submitted over public HTTP is claimed by the *other* process, gets a real git
worktree, completes, and is observed consistently through SSE and REST -- strictly increasing event
sequences, terminal state agreement, and owner scoping returning 404 rather than 403. The last
scenario stops the worker on purpose and asserts the failure message names the Run, reports the last
status it saw, and points at the logs.

## Status

Phases 1-2 of the design. Not implemented: the `npm run prepr` wrapper (Phase 3) and the mock-RPC
human-input journey (Phase 4). Nothing here is wired into CI.

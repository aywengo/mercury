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

## Commands

```bash
npm run test:e2e         # build the image, start the stack, assert, tear down
npm run test:e2e:config  # validate the compose model without starting anything
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

## Status

Phase 1 only: the foundation. The API/worker Run lifecycle, SSE and owner-scoping journeys are
Phase 2, and the `npm run prepr` wrapper is Phase 3. Nothing here is wired into CI.

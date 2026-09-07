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
| `prepr.ts` | The one-command pre-PR gate: build, verify, e2e -- each under its own deadline. |
| `prepr.test.ts` | Guards on the gate itself: bounded stages, propagated status, image layer order, and staying out of CI. |
| `mock-rpc.test.ts` | The human-input journey: a `primeagent` Run parked on `NEEDS_INPUT`, answered through the public API, against the repository's mock RPC fixture. |

## Commands

```bash
npm run prepr            # the whole local gate: build -> verify -> e2e
npm run test:e2e         # build the image, start the stack, assert, tear down
npm run test:e2e:config  # validate the compose model without starting anything
node --test e2e/helpers.test.ts   # helper control-flow only, no Docker needed
node --test e2e/prepr.test.ts     # gate guards only, no containers started
```

## `npm run prepr`

Three stages, cheapest first, stopping at the first failure:

| Stage | Runs | Why it is here |
| --- | --- | --- |
| `build` | `docker compose build` | The image, including `npm ci`. The dependency layer is invalidated only by manifest changes. |
| `verify` | `npm run typecheck` then `npm test`, **inside the image** | The existing suites in the same Linux image the journey runs in. This is where "works on my machine" dies. |
| `e2e` | `npm run test:e2e` | The production-shaped system journey. |

`verify` runs in its own short-lived Compose project that is torn down before the journey starts, so
a typecheck failure never pays for containers it will not use.

Each stage has its own deadline (15-20 minutes, several times the measured cost). A stage that hangs
is killed and reported as `TIMEOUT` with its name, rather than leaving a silent terminal; the command
then exits 124. Any other failure exits with that stage's own status, so a caller can branch on it.

It is deliberately **not** wired into CI: CI already runs the suites on a Node matrix, and this needs
a Docker daemon CI does not provide here.

`npm test` deliberately does **not** run these. It stays Docker-free and fast; CI never runs this
suite.

## Requirements

A running Docker (or Podman) daemon with Compose v2. If it is missing, the gate says so during
preflight rather than failing a scenario.

No `sqlite3` binary on the host. The client helpers used to shell out to it, which made the suite
pass on macOS and CI and fail in any slim container; they use `node:sqlite` now (issue #290).

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

### The image will not build: keychain / buildx

On macOS under a non-interactive session, `docker compose build` can fail while booting BuildKit:

```
error getting credentials - err: exit status 1,
out: `keychain cannot be accessed because the current session does not allow user interaction`
```

This is Docker Desktop reaching for the login keychain to resolve registry credentials, including for
its own BuildKit image. It is an environment problem, not a repository one. Running the build from an
interactive terminal fixes it; so does pre-loading `moby/buildkit:buildx-stable-1` and pointing
`DOCKER_CONFIG` at a config with `credsStore` removed.

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

Phases 1-4 of the design. Not implemented: the robustness hardening of Phase 5 and the opt-in tiers
above it. Nothing here is wired into CI.

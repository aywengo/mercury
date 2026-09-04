# Mercury

Durable long-running coding orchestration for PrimeAgent — a working vertical slice of the architecture in [`ARCHITECTURE.md`](ARCHITECTURE.md).

Mercury owns intent, orchestration, state and interaction. PrimeAgent (or any agent backend behind an `AgentAdapter`) owns coding execution. The central abstraction is a durable **Run** whose lifetime does not depend on any browser, HTTP, WebSocket, SSE or chat connection.

> **Note:** [`ARCHITECTURE.md`](ARCHITECTURE.md) is the design spec. Its status numbers are
> historical; this README (and `npm test`) is the source of truth for current test counts.

## Quickstart

**New here? Start with [`QUICKSTART.md`](QUICKSTART.md)** — prerequisites, install, first Run in
under five minutes, dashboard, troubleshooting.

**Adding another agent backend?** See [`docs/agent-adapters.md`](docs/agent-adapters.md) — the
roadmap for Codex / Claude Code / Hermes Agent / Gemini / Aider adapters, plus the design for the
generic `LocalAgentAdapter`, `RemoteAgentAdapter`, and `RpcAgentAdapter` (pi / omp / any RPC
JSONL CLI). The two worker-level leftovers (resume wiring into retry, cancel race for hanging
agents) are implemented — see §7 "Known gaps".

The short version:

```bash
npm install
MERCURY_EMBEDDED_WORKER=true MERCURY_API_TOKENS="tok-alice:alice" npm run dev
```

```bash
# create a run
curl -X POST http://localhost:3000/api/runs \
  -H "Authorization: Bearer tok-alice" -H "Content-Type: application/json" \
  -d '{"task":"Fix the failing integration tests and prepare a PR","repository":{"localPath":"/path/to/repo","baseBranch":"main"}}'

# watch it live
curl -N http://localhost:3000/api/runs/<runId>/stream -H "Authorization: Bearer tok-alice"
```

## Architecture

```
Mercury API/UI
    ↓
durable Run (SQLite)
    ↓
background scheduling (SQLite-backed queue + leases)
    ↓
Worker (separate process)
    ↓
AgentAdapter
    ├── PrimeAgentAdapter (prime-agent --mode rpc, real protocol)
    ├── HermesAgentAdapter (hermes chat -Q, text)
    ├── LocalAgentAdapter (declarative local CLI configs)
    ├── RemoteAgentAdapter (declarative remote HTTP API configs)
    ├── RpcAgentAdapter (declarative RPC JSONL configs: pi / omp / ...)
    └── FakeAgentAdapter (deterministic, for tests)
    ↓
selected Skills (.agents/skills, snapshotted per Run)
    ↓
isolated workspace (git worktree / copy)
    ↓
structured events (persisted, monotonic sequences)
    ↓
live Mercury updates (SSE with ?after= reconnect)
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API; embedded worker when `MERCURY_EMBEDDED_WORKER=true` (single process, dev only) |
| `npm run server` | API only — never executes agent processes |
| `npm run worker` | Worker only — claims and executes Runs |
| `npm run migrate` | Apply DB migrations and exit |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Full test suite (node:test, no external services) |
| `npm run gc` | One workspace GC pass (retention + quota), prints a report |

## API

| Endpoint | Description |
| --- | --- |
| `POST /api/auth/login` | Exchange an API token for an `HttpOnly` session cookie (public, rate-limited 10/min/IP) |
| `POST /api/auth/logout` | Delete the session, clear the cookie |
| `GET /api/auth/me` | Current identity `{ownerId, isAdmin}` (401 without a valid credential) |
| `POST /api/runs` | Create a Run (supports `Idempotency-Key` header; rate-limited 30/min/owner+IP) |
| `GET /api/agents` | Registered agent ids for the UI dropdown `{ agents: string[] }` |
| `GET /api/runs` | List Runs (`owner`, `status`, `limit`, `cursor`) |
| `GET /api/runs/:runId` | Run detail + selected skills |
| `POST /api/runs/:runId/input` | Answer a pending human-input request |
| `POST /api/runs/:runId/cancel` | Cancel (cooperative, then forceful) |
| `POST /api/runs/:runId/retry` | New Run referencing the original (`retryOf`) |
| `GET /api/runs/:runId/events` | Historical events (`?after=<sequence>`) |
| `GET /api/runs/:runId/stream` | SSE live stream (`?after=<sequence>` for reconnect) |
| `GET /healthz` | Liveness (public) |
| `GET /healthz/workers` | Live lease holders + queue depth (public) |
| `GET /metrics` | Prometheus text exposition (issue #131). **Authenticated**, unlike the health endpoints: it exposes accumulated run volume, duration distribution, failure kinds and sandbox usage rather than a momentary liveness bit. Point Prometheus `authorization` at an API token. |

Authenticated endpoints accept **either** `Authorization: Bearer <token>` (API clients, curl, CI) **or** the `mercury_session` cookie issued by `POST /api/auth/login` (dashboard). Tokens map to owners via `MERCURY_API_TOKENS="token:owner,..."`; `MERCURY_ADMIN_TOKEN` sees all Runs. `POST /api/runs` is additionally rate-limited (default 30/min per owner+IP) and `POST /api/auth/login` (default 10/min per IP) — over-limit requests get `429` with `Retry-After`. `GET /healthz` and the static dashboard assets are public. The token→owner map remains the identity source (OIDC/SSO is the planned replacement).

## Dashboard UI

A small static dashboard is served at `/` (no build step, vanilla JS + SSE):

- **Run list** (`/`) — login with your API token, create a run, filter by status, auto-refresh every 3s
- **Run detail** (`/run.html?run=<id>`) — run info, selected skills, constraints, event timeline, live updates via SSE (fetch-based streaming with session-cookie credentials — `EventSource` cannot set credentials), and controls:
  - **cancel** (QUEUED/STARTING/RUNNING/NEEDS_INPUT)
  - **retry** (FAILED/CANCELLED/TIMED_OUT)
  - **input panel** (NEEDS_INPUT) — renders `select` options, `confirm` yes/no, or a text field/editor depending on the `input.required` payload

Static assets are public; all data access stays gated through `/api`. The login form exchanges the API token for an `HttpOnly; SameSite=Strict` session cookie via `POST /api/auth/login` — the token itself is **not** stored in the browser. Every request (including SSE) sends the cookie via `credentials: 'same-origin'`; `401` bounces back to the login screen.

## Workspace GC

Workspaces are retained after a Run reaches a terminal state, then garbage-collected:

- **Retention** — terminal workspaces older than `MERCURY_WORKSPACE_RETENTION_MS` (default 7 days) are removed.
- **Quota** — if total workspace storage exceeds `MERCURY_WORKSPACE_QUOTA_BYTES` (default 10 GiB, `0` disables), the oldest terminal workspaces are evicted until under quota.
- **Orphans** — workspace dirs with no matching Run row older than 1 hour are removed (covers crashed workers / interrupted creation).
- **Safety** — workspaces of non-terminal Runs (QUEUED/STARTING/RUNNING/NEEDS_INPUT) are never touched. Removal is best-effort; failures are reported, not fatal.

The worker runs a GC pass at startup and every `MERCURY_GC_INTERVAL_MS` (default 1h). Run it manually with `npm run gc` (or `node src/cli.ts gc`).

## Run lifecycle

```
QUEUED → STARTING → RUNNING ⇄ NEEDS_INPUT → COMPLETED / FAILED / CANCELLED / TIMED_OUT
```

- Retry creates a **new** Run with `retryOf` pointing at the original (never a state transition).
- Cancellation is cooperative first (`run.cancelling` → adapter `cancel()` → SIGTERM), forceful after a grace period.
- Timeouts (`maxDurationMs`) produce `TIMED_OUT`; input timeouts produce `TIMED_OUT` with reason `input-timeout`.
- Infrastructure failures auto-retry with backoff up to `maxRetries`; agent/task failures are manual-retry only.
- Shutdown is graceful on SIGTERM, and the two processes are bounded separately. The **API** stops admitting connections, gives ordinary in-flight requests a fixed 2 s grace, then force-closes the rest — necessary because SSE streams are long-lived by design and would otherwise stall every deploy until SIGKILL. The **worker** stops claiming, lets the in-flight Run terminate its agent and requeue itself (bounded by `MERCURY_SHUTDOWN_GRACE_MS`), then closes the database. Past either bound the Run is recovered by lease reaping rather than clean requeue. A second SIGTERM exits immediately, which is safe for the same reason.

## Configuration (env)

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_DB` | `./mercury.db` | SQLite database file |
| `MERCURY_PORT` | `3000` | API port |
| `MERCURY_BIND_HOST` | `127.0.0.1` | API bind address (secure default; set `0.0.0.0` to expose, then use TLS or a reverse proxy) |
| `MERCURY_TLS_CERT` | — | Path to TLS certificate; with `MERCURY_TLS_KEY` the API serves https |
| `MERCURY_TLS_KEY` | — | Path to TLS private key (requires `MERCURY_TLS_CERT`) |
| `MERCURY_WORKSPACE_BASE` | `./workspaces` | Workspace root |
| `MERCURY_WORKSPACE_MODE` | `git-worktree` | `git-worktree` or `copy` |
| `MERCURY_API_TOKENS` | — | `token:owner,...` map |
| `MERCURY_ADMIN_TOKEN` | — | Admin token (sees all Runs) |
| `MERCURY_SECRETS` | — | Comma-separated literals redacted from events/logs |
| `MERCURY_PRIMEAGENT_CMD` | `prime-agent` | Command spawned by PrimeAgentAdapter |
| `MERCURY_PRIMEAGENT_ARGS` | — | Extra args passed to prime-agent after `--mode rpc` (e.g. `--provider omlx --model ...`) |
| `MERCURY_EMBEDDED_WORKER` | `false` | Run worker inside the API process (dev) |
| `MERCURY_LEASE_MS` | `60000` | Queue lease duration |
| `MERCURY_LEASE_HEARTBEAT_MS` | `15000` | Lease renewal interval |
| `MERCURY_MAX_RETRIES` | `2` | Auto-retries for infrastructure failures |
| `MERCURY_RETRY_BACKOFF_MS` | `5000` | Base backoff for auto-retry |
| `MERCURY_INPUT_TIMEOUT_MS` | `1800000` | Max time a Run may wait for human input before `TIMED_OUT` (reason `input-timeout`); `0` = no limit |
| `MERCURY_STUCK_RUN_THRESHOLD_MS` | `1800000` | Alert when a RUNNING/NEEDS_INPUT Run has no event activity for this long; `0` = disabled |
| `MERCURY_STUCK_CHECK_INTERVAL_MS` | `60000` | How often stuck Runs are checked |
| `MERCURY_BACKLOG_ALERT_THRESHOLD` | `10` | Queue depth that triggers a backlog alert |
| `MERCURY_ALERT_WEBHOOK_URL` | — | Webhook for backlog + stuck-run alerts (fire-and-forget); unset = log only |
| `MERCURY_GC_INTERVAL_MS` | `3600000` | Worker workspace-GC pass interval |
| `MERCURY_AGENT_MODE` | `rpc` | `rpc` (subprocess per Run) or `daemon` (resident sessions) |
| `MERCURY_HERMES_CMD` | `hermes` | Hermes Agent binary for the `hermes` agent id |
| `MERCURY_HERMES_ARGS` | — | Extra args for `hermes chat` (e.g. `--ignore-user-config`) |
| `MERCURY_HERMES_MAX_TURNS` | — | `--max-turns N` for hermes runs |
| `MERCURY_HERMES_RUN_BUDGET_SECONDS` | — | `--run-budget SECONDS` for hermes runs |
| `MERCURY_HERMES_YOLO` | `false` | `true` = pass `--yolo` (bypass approval prompts) |
| `MERCURY_HERMES_ACCEPT_HOOKS` | `false` | `true` = pass `--accept-hooks` |
| `MERCURY_LOCAL_AGENTS_DIR` | `./local-agents` | Directory of JSON `LocalAgentConfig` files; each file registers a declarative local CLI agent (see `docs/agent-adapters.md` §4) |
| `MERCURY_REMOTE_AGENTS_DIR` | `./remote-agents` | Directory of JSON `RemoteAgentConfig` files; each file registers a declarative remote API agent (see `docs/agent-adapters.md` §5) |
| `MERCURY_RPC_AGENTS_DIR` | `./rpc-agents` | Directory of JSON `RpcAgentConfig` files; each file registers a declarative RPC-protocol agent — `pi`, `omp`, or any CLI speaking the RPC JSONL family (see `docs/agent-adapters.md` §6) |
| `MERCURY_TRUST_PROXY` | `0` | Number of reverse-proxy hops to trust for client-IP attribution. Set to the proxy count (usually `1`) when the API sits behind nginx/Caddy, otherwise every client shares one rate-limit bucket. Decimal digits only; anything else falls back to `0` — see Behind a reverse proxy |
| `MERCURY_COOKIE_SECURE` | `false` | Force `Secure` on the session cookie. Only needed behind a TLS-terminating proxy that does **not** forward `X-Forwarded-Proto`; otherwise encryption is detected per request |
| `MERCURY_SANDBOX_RUNTIME` | — | `docker` or `podman` to run the agent in a container with resource/network limits; `none` disables |
| `MERCURY_SANDBOX_IMAGE` | — | Container image for sandboxed execution; must contain the agent binary and git (see Sandboxed execution) |
| `MERCURY_SANDBOX_ENV` | provider keys | Comma-separated env vars forwarded into the container. Empty = forward nothing but `PATH`. Never a copy of the worker's environment |
| `MERCURY_SANDBOX_DISK_LIMITS` | `false` | Set `true` only when the host storage driver honours `--storage-opt size=` |
| `MERCURY_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. Structured JSON to stdout, consumed by journald |
| `MERCURY_POLL_MS` | `250` | Worker claim-loop interval when the queue is idle |
| `MERCURY_INPUT_POLL_MS` | `200` | How often the worker polls for queued human input |
| `MERCURY_SHUTDOWN_GRACE_MS` | `30000` | **Worker only.** On SIGTERM, how long to wait for the in-flight Run to terminate its agent and hand itself back before giving up and leaving it to the reaper. Keep it **below** `mercury-worker.service`'s `TimeoutStopSec` (45 s), or systemd sends SIGKILL first and the Run is reaped as a crashed lease. The API's own drain is a separate fixed 2 s (`SHUTDOWN_GRACE_MS` in `src/api/server.ts`), bounded by `mercury.service`'s `TimeoutStopSec` (15 s) |
| `MERCURY_BACKLOG_CHECK_INTERVAL_MS` | `60000` | How often queue-backlog alerting runs. On its own timer, so a multi-hour Run cannot suppress it |

## Local CLI agents (LocalAgentAdapter)

Any local CLI agent that can run non-interactively becomes a Mercury agent via a
declarative JSON config — no code. Drop a `LocalAgentConfig` file into
`MERCURY_LOCAL_AGENTS_DIR` (default `./local-agents`) and the agent id is
immediately available for Runs:

```json
{
  "id": "my-agent",
  "description": "hypothetical jsonl agent",
  "command": "my-agent",
  "taskInput": { "mode": "arg", "flag": "--task" },
  "output": { "format": "jsonl", "stream": true, "eventPath": "type" },
  "eventMap": {
    "started": "step.started",
    "message": "agent.message",
    "toolStarted": "tool.started",
    "toolCompleted": "tool.completed",
    "completed": "done"
  },
  "input": { "mode": "stdin", "promptEvent": "ask" },
  "cancel": { "signal": "SIGTERM", "graceMs": 3000 },
  "resume": { "flag": "--resume", "sessionIdSource": "event", "sessionIdPath": "session_id" }
}
```

Supports: task via arg/stdin/file, output as jsonl/json/text, arbitrary event-type
mapping, human input (stdin/flag/prompt-file), cancellation (SIGTERM/SIGINT/stdin),
session resume, skills → tool flags, sandbox policy flags. Full schema and design:
[`docs/agent-adapters.md`](docs/agent-adapters.md) §4.

## Remote API agents (RemoteAgentAdapter)

Any cloud/SaaS coding agent with an HTTP API becomes a Mercury agent via a
declarative JSON config — no code. Drop a `RemoteAgentConfig` file into
`MERCURY_REMOTE_AGENTS_DIR` (default `./remote-agents`) and the agent id is
immediately available for Runs:

```json
{
  "id": "devin",
  "description": "Devin cloud agent",
  "api": {
    "baseUrl": "https://api.devin.ai/v1",
    "auth": { "type": "bearer", "headerName": "Authorization", "envVar": "MERCURY_DEVIN_API_KEY" },
    "createTask": { "method": "POST", "path": "/sessions", "body": { "prompt": "{task}", "repository": "{workspace}" }, "idField": "session.id" },
    "getTask": { "method": "GET", "path": "/sessions/{id}", "statusField": "status", "statusMap": { "running": "running", "blocked": "running", "success": "completed", "error": "failed", "cancelled": "cancelled" } },
    "events": { "method": "GET", "path": "/sessions/{id}/events", "eventField": "events", "eventTypeField": "type" },
    "sendInput": { "method": "POST", "path": "/sessions/{id}/messages", "body": { "message": "{input}" } },
    "cancel": { "method": "POST", "path": "/sessions/{id}/cancel" }
  },
  "poll": { "intervalMs": 5000, "timeoutMs": 3600000 },
  "eventMap": { "message": "agent.message", "tool_started": "tool.started", "tool_completed": "tool.completed", "error": "error" }
}
```

Supports: bearer/header/query auth (credential from `api.auth.envVar`, never in
events/logs), create/get/events/input/cancel endpoints with `{id}`/`{task}`/
`{workspace}`/`{input}` templating, polling with timeout, human input, cancel,
resume (re-attach to the existing task). Full schema and design:
[`docs/agent-adapters.md`](docs/agent-adapters.md) §5.

## RPC agents (RpcAgentAdapter)

Any CLI that speaks the RPC JSONL protocol family — PrimeAgent, Pi Agent
(`pi --mode rpc`), Oh my Pi (`omp --mode rpc`) — becomes a Mercury agent via a
declarative JSON config, reusing the same protocol machinery as the built-in
`primeagent` adapter. Drop a `RpcAgentConfig` file into `MERCURY_RPC_AGENTS_DIR`
(default `./rpc-agents`) and the agent id is immediately available for Runs:

```json
{
  "id": "pi",
  "description": "Pi Agent (pi.dev)",
  "command": "pi",
  "args": [],
  "protocol": { "modeFlag": "--mode", "modeValue": "rpc" },
  "eventMap": {},
  "input": { "enabled": true },
  "resume": { "enabled": true }
}
```

Vendor extras are ignored by default (unknown event types never break the
stream); omp's protocol-v2 frames (`ready`, `negotiate_protocol`,
`subagent_lifecycle`, `host_tool_call`) can also be listed in
`protocol.ignoreEventTypes`. Install the binaries (`npm i -g
@earendil-works/pi-coding-agent`, `bun i -g @oh-my-pi/pi-coding-agent`); both
authenticate through their own credential stores. See `docs/agent-adapters.md`
§6 for the full schema.

## Hermes Agent (HermesAgentAdapter)

Nous Research's Hermes Agent runs as a first-class agent id (`hermes`), driven
in quiet programmatic mode:

```bash
hermes chat -Q --query-file - --in <workspace> [-s <skill>]... [--max-turns N] [--run-budget S] [--yolo] [--accept-hooks]
```

- **Task** goes via stdin (`--query-file -` — safe for arbitrary text).
- **Output**: the final response becomes `agent.message`; the session id
  (`session_id: <id>` on stderr) is captured for `--resume`.
- **Fidelity is text-level** (no tool-level events in `-Q` mode); human input is
  covered by `--yolo`/`--accept-hooks` rather than an `input.required` bridge.
- Configure via `MERCURY_HERMES_CMD`/`MERCURY_HERMES_ARGS` (e.g. point at a
  wrapper or `--ignore-user-config` for isolated runs).

## PrimeAgent integration

`PrimeAgentAdapter` spawns `MERCURY_PRIMEAGENT_CMD --mode rpc` — PrimeAgent's documented language-agnostic programmatic interface (strict JSONL over stdio). Each Run gets its own RPC process, isolated in the Run's workspace:

- **spawn**: `prime-agent --mode rpc --cwd <workspace> --session-dir <workspace>/.mercury-sessions [--skill <path>]... [MERCURY_PRIMEAGENT_ARGS]`
- **task prompt**: points the agent at `.mercury-context.json` (run id, task, repository, branch, base commit, constraints, selected skills) and the skill files under `.agents/skills/`
- **event mapping** (RPC → Mercury):
  - `message_update` (text deltas) → accumulated, emitted as `agent.message` on `message_end`
  - `tool_execution_start/end` → `tool.started` / `tool.completed` (or `tool.failed` on error)
  - `extension_ui_request` (select/confirm/input/editor) → `input.required`; the human answer is sent back as `extension_ui_response` (Mercury' `NEEDS_INPUT` flow)
  - `agent_end` → run completion (exit code 0)
  - `compaction_*` / `auto_retry_*` → informational `agent.message` events
- **session persistence**: each Run's session JSONL is stored under `<workspace>/.mercury-sessions/`; the path is recorded in `.mercury-session-path` so a Run can be resumed via `--resume <sessionFile>` (ARCHITECTURE.md §16)
- **trace context**: the agent process is spawned with `MERCURY_RUN_ID` / `MERCURY_TRACE_ID` (the Run ID) and `MERCURY_WORKER_ID` so agent logs correlate back to the Run and worker (ARCHITECTURE.md §25)
- **cancellation**: cooperative `abort` command, then SIGTERM / SIGKILL after a grace period
- **timeout**: SIGTERM / SIGKILL via `terminate()`, producing `TIMED_OUT`

The RPC client (`src/adapters/rpc/`) implements the protocol directly: strict LF-only JSONL framing (Node `readline` is NOT protocol-compliant — it splits on U+2028/U+2029), id-correlated request/response, event dispatch, stderr capture. No extra dependency beyond the `prime-agent` binary.

## Skills

`.agents/skills/<id>/SKILL.md` with frontmatter (`name`, `version`, `description`, `capabilities`). Per Run:

1. skills are resolved explicitly (request body) or automatically (deterministic keyword scoring)
2. resolved skills are **snapshotted** (content + sha256) into the Run record — reproducible and auditable
3. the snapshot is written into the isolated workspace at `.agents/skills/`
4. `skill.selected` / `skill.started` / `skill.completed` events are recorded

## Workspace isolation

- `git-worktree` (default): base repo cloned once under `workspaces/repos/`, each Run gets `workspaces/worktrees/run_<id>` on branch `agent/run_<id>` pinned to the base commit.
- The resolved base commit is persisted on the Run record, so a retry reuses the exact base (ARCHITECTURE.md §21) instead of re-resolving a moved branch.
- `copy`: recursive copy of a local template (for non-git sources / tests).
- Multi-repo Runs (roadmap #6): extra `repositories[]` are cloned under `<workspace>/repos/<name>`; the primary is `repository` (or the first list entry) and is never duplicated under `repos/`.
- Workspaces are retained after completion for inspection; cleanup/retention policy is an ops concern (see Workspace GC).

## Sandboxed execution

When a Run's constraints request isolation (`resourceLimits` and/or `allowedNetworks`) and a
container runtime is configured (`MERCURY_SANDBOX_RUNTIME=docker|podman`), the agent process runs
inside a container with the Run's cpu/memory/disk limits and network policy (`none` = no network,
otherwise bridge). The worker **fails closed**: a Run that requests isolation but has no
runtime available is FAILED at setup instead of silently running unsandboxed. Runs without the
constraint run directly on the host.

### Image requirements

Nothing verifies these, and each failure looks unrelated to the sandbox, so build the image
yourself and point `MERCURY_SANDBOX_IMAGE` at it. The image MUST contain:

1. **the agent binary** the Run's adapter invokes. The default `node:22-bookworm-slim` does
   **not** contain `prime-agent`, so sandboxed runs fail with `executable not found` — an error
   that mentions neither the sandbox nor the image.
2. a compatible Node runtime for that binary;
3. **git**, because the workspace mount is committed from inside the container.

### Environment passthrough

The container runs **untrusted** agents, so its environment is an allowlist, never a copy of the
worker's. By default only model-provider keys are forwarded (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`,
`GROQ_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`) — and only those actually set.

Forwarding them means **the container can spend your inference budget**; that is the trade, and
the reason this is an allowlist. `MERCURY_SANDBOX_ENV` overrides the list; set it to empty to
forward nothing but `PATH` (sandboxed runs then cannot authenticate).

**Refused regardless of configuration** — an over-broad `MERCURY_SANDBOX_ENV` cannot re-enable
these, and `PATH` is always ignored in the allowlist because it is pinned:

| prefix | why |
| --- | --- |
| `MERCURY_*` | admin token, API tokens, database path, webhook URLs |
| `GH_*`, `GITHUB_*`, `GIT_*` | an untrusted agent must not push, or read the operator's repos |
| `AWS_*`, `AZURE_*`, `GOOGLE_APPLICATION_*`, `GOOGLE_CLOUD*`, `CLOUDSDK_*`, `GCLOUD_*` | cloud account credentials |
| `KUBE*`, `SSH_*`, `DOCKER_*`, `TF_VAR_*`, `TERRAFORM*`, `CIRCLE_*`, `TN_*`, `DIGITALOCEAN_*` | infrastructure and CI secrets, never needed for inference |

Because the cloud families are blocked wholesale, **Bedrock and Azure OpenAI are not in the
default list.** If you need them, add the exact variable to `MERCURY_SANDBOX_ENV` and accept
that it is forwarded — the block is on the *account-level* credential families, and a
family-wide block cannot also exempt individual keys inside itself without becoming a lie.

### Disk limits are off by default

`docker run --storage-opt size=` is honoured only on overlay2-on-**xfs**, btrfs, zfs or
devicemapper. On the default overlay2-on-ext4 install docker **rejects the flag**, so the Run
dies before the agent starts with an error naming neither disk nor Mercury. Mercury therefore
does not emit the flag unless you set `MERCURY_SANDBOX_DISK_LIMITS=true`, and fails a Run that
requests `resourceLimits.disk` with an explanation instead.

## Testing

`npm test` — the whole suite runs with no network and no LLM APIs (PrimeAgentAdapter is tested against a mock RPC server speaking the real protocol):

- state machine (valid/invalid transitions, terminal states)
- secret redaction
- skill registry + deterministic selection + snapshots
- run service (create, idempotency, cancel, retry, ownership, pagination)
- events (monotonic sequences, cursor reads, JSON round-trip)
- worker (happy path with real git worktree, agent failure, cancellation, human input, input timeout, run timeout, retry base-commit pinning, duplicate-claim prevention, lease expiry, auto-retry)
- multi-worker (backlog alerting + webhook, `/healthz/workers`, expired-lease reaping — an active run becomes FAILED, it is **not** requeued — stuck-run detection + webhook)
- API (bearer + session-cookie auth, owner scoping, admin, login/logout/me, rate limiting 429, SSE live + reconnect, cancel/input via HTTP)
- JSONL framing (strict LF-only, U+2028/U+2029 inside strings, chunk splits, overflow)
- RPC client (get_state, prompt streaming, extension UI round trip, send timeout, spawn failure)
- RpcAgentAdapter (happy path, argv construction, input round trip, cancel, resume, vendor-extras tolerance, registry)
- PrimeAgentAdapter (happy path, skills via --skill, human input, spawn failure, agent crash, cancel, terminate, resume, trace-env propagation)
- DaemonAgentAdapter (JSONL against a supervisor fixture derived from a captured real hello: envelope correctness checked against the vendor's own envelope builder, `create`→`attach`→`prompt` ordering on the wire, `session_event` translation, dialog round trip in the daemon's own payload form, session release, `session_closed`, internal-transport refusal, protocol/capability negotiation, socket discovery and length, sandbox refusal, plus a read-only contract test against a live supervisor)
- Dashboard UI (static assets served without auth, API still token-gated, UI modules parse)
- Workspace GC (retention expiry, quota eviction, active-run protection, orphan cleanup, git-worktree removal, multi-repo extras + primary dedupe)
- `/metrics` (auth gating, aggregate correctness, cumulative `+Inf` histogram invariants, bounded label cardinality, Prometheus family-name collisions, and that the `events(type)` index is actually used by the planner)
- Operations guards (backup script integrity check + restore, deploy docs path/ordering agreement, systemd hardening stays fail-closed)
- Test hygiene (no test may create a temp dir without registering it for teardown, so the suite cannot leak temp dirs again)

## Known limitations

- Auth: the `MERCURY_API_TOKENS` token→owner map remains the identity source; dashboard sessions are in-memory (lost on restart); OIDC/SSO is still future work.
- **The API is single-process.** Login and run-creation rate limits are fixed-window counters in the process's own memory, and dashboard sessions live in an in-memory `Map`. Running two API instances behind a load balancer therefore gives each instance its own independent limits and its own session table: a session created on one node is unknown to the other (spurious logouts), and an attacker gets `N × max` request budget across `N` nodes. Horizontal scaling needs both moved to shared storage (e.g. SQLite/Redis) first. `MERCURY_TRUST_PROXY` fixes attribution *within* a process; it does not make the API scalable.

### Behind a reverse proxy

Set `MERCURY_TRUST_PROXY` to the number of proxy hops in front of the API (`1` for nginx/Caddy on the same host, `2` for a CDN plus a local proxy). Without it Express takes `req.ip` from the socket, which is the proxy's own address, so **every client behind that proxy shares a single rate-limit bucket** — legitimate users collectively exhaust the login budget and lock each other out, while an attacker inside that shared bucket is barely throttled.

Use a depth, not blanket trust. `trust proxy = true` makes Express accept the whole `X-Forwarded-For` chain, so a client can append its own fake hop and receive a fresh bucket per request — strictly worse than no limiting. A depth peels exactly N addresses off the right-hand end, which is the part a real proxy appended and a client cannot overwrite. `MERCURY_TRUST_PROXY` only accepts non-negative integers for this reason; anything else falls back to `0`.

Setting a depth also makes `req.secure` honour `X-Forwarded-Proto`, so the session cookie picks up `Secure` automatically (see `MERCURY_COOKIE_SECURE`).
- `PrimeAgentAdapter` uses `prime-agent --mode rpc` (subprocess). The daemon API (`prime-agent send` / `send_message` to resident sessions) is a possible future path for sharing long-lived agent sessions across Runs.
- SSE fan-out is in-process push (EventStore append hook) plus a DB poller as the cross-process fallback. Poll cadence is **per subscription**, not process-wide: a stream is polled fast while it is delivering and relaxes to 2 s only after it goes quiet, and a poll that finds new rows sharpens it again (#197). Worst-case cross-process latency is one fast interval, measured at 250 ms.
- Same-host worker → API wake-up exists over a Unix stream socket (`MERCURY_EVENT_WAKEUP_SOCKET`, #203) and cuts measured p50 from 141 ms to 0.6 ms. It is **off by default** because poll-only already meets an "under 1 s" budget. A worker → server HTTP callback was analysed and **rejected** — most coupling, least correctness benefit.
- Resource limits (`cpu`/`memory`/`disk`) and egress policy (`allowedNetworks`) are enforced via a container runtime when `MERCURY_SANDBOX_RUNTIME` is set (see Sandboxed execution); without a runtime, constrained Runs fail closed instead of running unsandboxed.
- Dashboard is a static vanilla-JS SPA (no framework, no build step); a richer UI (React/Vite) would need a build pipeline.
- Workspace GC runs in the worker (startup + hourly); a standalone scheduler/daemon is not needed for the single-PC deployment.

## Infrastructure requirements

- Node.js ≥ 22.18 (uses built-in `node:sqlite` and native TypeScript type-stripping — no build step, no native deps)
- `git` (for worktree isolation)
- SQLite (embedded via `node:sqlite`)

## Recommended next steps

1. ~~Real auth (offline)~~ — done: HttpOnly session cookies, rate limiting, `127.0.0.1` bind default, optional TLS. Next: OIDC/SSO to replace the token→owner map
2. ~~Workspace retention/GC job~~ — done: retention + quota + orphan cleanup, `mercury gc`, hourly worker pass
3. ~~Push-based event fan-out~~ — done: in-process push via EventStore append hook + per-subscription poller; same-host cross-process wake-up over a Unix socket also exists, shipped off by default
4. ~~Multi-worker deployment~~ — done: backlog alerting (+ optional webhook), `/healthz/workers`, expired-lease reaping (one owner: `reapExpiredLeases`; an active run goes FAILED/infrastructure and recovers by retry-as-new-run, never by requeue)
5. ~~Multi-repository Runs~~ — done: `repositories[]` in the Run model, API + workspace support
6. ~~Expand skill library~~ — done: 12 skills (added documentation, deployment, frontend, issue-fix-loop)
7. ~~Deployment packaging~~ — done: systemd units, integrity-checking backup/restore script, ops guide in `deploy/` (logs go to journald, so `logrotate` is not used and the config that implied otherwise was removed)
8. ~~Daemon-based agent sessions~~ — done: `MERCURY_AGENT_MODE=daemon` now speaks the protocol the
    supervisor actually uses (JSONL, command envelope, `create`→`attach`→`prompt`, the per-uid supervisor
    socket, never spawning one), verified end to end against a live supervisor. RPC remains the default.
    Session reuse across Runs, multi-tenancy and supervisor provisioning are still open; see
    [`docs/daemon-agent-sessions.md`](docs/daemon-agent-sessions.md).
9. ~~Sandboxed execution (containers)~~ — done: `SandboxManager` enforces `resourceLimits` + `allowedNetworks` via docker/podman; fails closed when a constrained Run has no runtime
10. ~~Input timeout + observability~~ — done: configurable `MERCURY_INPUT_TIMEOUT_MS` (`TIMED_OUT` reason `input-timeout`), stuck-run alerting, `GET /metrics` in Prometheus format (run duration, queue wait, status gauges, worker/lease state), and run/worker trace env (`MERCURY_RUN_ID`/`MERCURY_TRACE_ID`/`MERCURY_WORKER_ID`) propagated to the agent process
11. ~~Cross-process event push (worker → server)~~ — done for same-host, **multi-host still blocked on
    storage**. Stage 0 (per-subscription cadence + delivery metrics) and Stage 1 (Unix-socket wake-up,
    off by default) are merged; poll-only already meets an "under 1 s" budget at 250 ms worst case.
    Stage 2 (Postgres `LISTEN/NOTIFY`) is deliberately unbuilt: the multi-host blocker is the single-file
    SQLite database, not the transport, and replacing it is out of scope. See
    [`docs/cross-process-event-push.md`](docs/cross-process-event-push.md) §7 and §14.
12. OIDC/SSO identity to replace the token→owner map — remaining

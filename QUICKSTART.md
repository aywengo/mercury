# Mercury QuickStart

Get Mercury running and complete a first Run without installing a coding-agent CLI.

Mercury is a durable control plane for coding agents: you submit a task, get a `runId`,
close the browser, and the Run keeps executing in the background. Omitting `agent` (or
selecting `fake`) exercises that path with no LLM and no extra binaries.

---

## 1. Prerequisites

Required to run Mercury:

| Requirement | Version | Check |
| --- | --- | --- |
| Node.js | ≥ 22.18 (built-in `node:sqlite`, no build step) | `node --version` |
| `git` | any modern version (worktree isolation) | `git --version` |

No database server, no Docker, and no coding-agent CLI are required for this walkthrough.
Docker/podman is only needed for sandboxed (resource-limited) execution.

PrimeAgent, Hermes, and Claude are optional. Install one of them only when you want a real
coding Run — see [section 6](#6-real-coding-agents-optional).

Work from the repository root (the directory that contains `package.json`). Migrations
apply automatically when the process opens the database; you do not need `npm run migrate`
first.

## 2. Install

```bash
npm install
```

Install dependencies before starting the server, running tests, or typechecking.

Optional checkout check:

```bash
npm run typecheck
npm test
```

## 3. Start the server

```bash
MERCURY_EMBEDDED_WORKER=true MERCURY_API_TOKENS="tok-alice:alice" npm run dev
```

`MERCURY_API_TOKENS` is `token:owner` pairs, comma-separated:

- left of the colon is the **bearer token** (`tok-alice`) — use this in `Authorization`
  headers and in the dashboard login box;
- right of the colon is the **owner id** (`alice`) — this is not a password.

The API listens on `http://127.0.0.1:3000` (loopback only). Confirm it is up:

```bash
curl -s http://127.0.0.1:3000/healthz
```

The dashboard is `http://127.0.0.1:3000/`. Sign in with `tok-alice`, not `alice` and not
the whole `tok-alice:alice` string.

Production-style split (separate processes, same DB) is documented in
[`docs/operations.md`](docs/operations.md). For a first run, keep the embedded worker.

## 4. Submit a plumbing Run

Default workspace mode is `git-worktree`, so `repository.localPath` must be a git repo.
Use this checkout (replace the path if you cloned elsewhere):

```bash
curl -X POST http://127.0.0.1:3000/api/runs \
  -H "Authorization: Bearer tok-alice" -H "Content-Type: application/json" \
  -d '{"task":"smoke test","repository":{"localPath":"'"$PWD"'","baseBranch":"main"}}'
```

Omitting `agent` selects `fake` (in-process, no LLM). You can also send `"agent":"fake"`.

Do not use `/tmp` as `localPath` unless you started with `MERCURY_WORKSPACE_MODE=copy`.
`/tmp` is not a git repo, so git-worktree setup fails.

Response (the API returns immediately — the Run keeps going in the background):

```json
{ "runId": "run_01hx...", "status": "QUEUED" }
```

## 5. Watch it

```bash
# live event stream (SSE)
curl -N http://127.0.0.1:3000/api/runs/<runId>/stream -H "Authorization: Bearer tok-alice"

# status + events
curl http://127.0.0.1:3000/api/runs/<runId> -H "Authorization: Bearer tok-alice"
curl http://127.0.0.1:3000/api/runs/<runId>/events -H "Authorization: Bearer tok-alice"
```

Or open the dashboard, create/observe Runs, answer human-input questions, cancel, retry.

A Run goes through `QUEUED → STARTING → RUNNING → COMPLETED` (or `FAILED / CANCELLED / TIMED_OUT`).
The Run survives browser/terminal closure. That is the point of Mercury.

## 6. Real coding agents (optional)

Pick one CLI, put it on `PATH`, then create a Run with that `agent` id. Capability details:
[`docs/agents.md`](docs/agents.md).

Each of these needs its own model/provider credentials. Mercury does not bundle them.

### PrimeAgent (`agent`: `primeagent`)

Binary: `prime-agent`. Highest-fidelity builtin: RPC events, tools, human input.

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
which prime-agent
```

```bash
curl -X POST http://127.0.0.1:3000/api/runs \
  -H "Authorization: Bearer tok-alice" -H "Content-Type: application/json" \
  -d '{"task":"Fix the failing integration tests and prepare a PR","agent":"primeagent","repository":{"localPath":"'"$PWD"'","baseBranch":"main"}}'
```

Need explicit provider/model flags? Start Mercury with
`MERCURY_PRIMEAGENT_ARGS="--provider omlx --model <name>"`. Command override:
`MERCURY_PRIMEAGENT_CMD`.

To make omitted `agent` select PrimeAgent again: `MERCURY_DEFAULT_AGENT=primeagent`.

### Hermes (`agent`: `hermes`)

Binary: `hermes`. Quiet CLI: final text plus a session id; no tool events and no
interactive input bridge.

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
which hermes
```

```bash
curl -X POST http://127.0.0.1:3000/api/runs \
  -H "Authorization: Bearer tok-alice" -H "Content-Type: application/json" \
  -d '{"task":"Summarize the repository layout","agent":"hermes","repository":{"localPath":"'"$PWD"'","baseBranch":"main"}}'
```

Knobs: `MERCURY_HERMES_CMD`, `MERCURY_HERMES_ARGS`. Approval-bypass flags
(`MERCURY_HERMES_YOLO`, `MERCURY_HERMES_ACCEPT_HOOKS`) change execution safety —
see [`docs/configuration.md`](docs/configuration.md#hermes).

### Claude (`agent`: `claude`)

Binary: `claude` (Claude Code CLI). Stream-JSON tool events; no interactive
`sendInput` in the verified CLI version.

```bash
curl -fsSL https://claude.ai/install.sh | bash
which claude
```

```bash
curl -X POST http://127.0.0.1:3000/api/runs \
  -H "Authorization: Bearer tok-alice" -H "Content-Type: application/json" \
  -d '{"task":"Fix the failing integration tests and prepare a PR","agent":"claude","repository":{"localPath":"'"$PWD"'","baseBranch":"main"}}'
```

Knobs: `MERCURY_CLAUDE_CMD`, `MERCURY_CLAUDE_ARGS`, `MERCURY_CLAUDE_MODEL`.
`MERCURY_CLAUDE_SKIP_PERMISSIONS` is a dangerous permission bypass.

Declarative local, RPC, and remote agents: [`docs/agents.md`](docs/agents.md).

## 7. Useful environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_API_TOKENS` | — | `token:owner,...` map (required for auth) |
| `MERCURY_PORT` | `3000` | API port |
| `MERCURY_EMBEDDED_WORKER` | `false` | Run worker inside the API process (dev) |
| `MERCURY_DEFAULT_AGENT` | `fake` | Agent id when create omits `agent` |
| `MERCURY_PRIMEAGENT_CMD` | `prime-agent` | PrimeAgent executable |
| `MERCURY_PRIMEAGENT_ARGS` | — | Extra PrimeAgent args |

Full reference: [`docs/configuration.md`](docs/configuration.md).

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `401` on `/api/runs` | Wrong/missing `Authorization: Bearer <token>`; token is the left side of `MERCURY_API_TOKENS` |
| Dashboard login fails | Enter `tok-alice`, not `alice` and not `tok-alice:alice` |
| Run stuck `QUEUED` | Worker not running — start it (`MERCURY_EMBEDDED_WORKER=true` or `npm run worker`) |
| Run `FAILED` at setup, "Workspace requires repository..." | `repository.localPath` missing |
| Run `FAILED` at setup on a non-git folder | Default mode is git-worktree; use a git repo or `MERCURY_WORKSPACE_MODE=copy` |
| Agent exits immediately | Coding-agent CLI not on PATH or bad `MERCURY_*_ARGS`; check `agent-output.log` in the workspace |
| `429 Too Many Requests` | Rate limit (login 10/min/IP, run creation 30/min/owner+IP); wait for `Retry-After` |
| Sandbox error at setup | Run requested `resourceLimits`/`allowedNetworks` but no container runtime — configure docker/podman or remove the constraints |

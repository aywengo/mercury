# Mercury QuickStart

Get Mercury running in under five minutes and submit your first coding Run.

Mercury is the durable orchestration layer for PrimeAgent: you submit a task, get a `runId`,
close the browser, and the Run keeps executing in the background.

---

## 1. Prerequisites

| Requirement | Version | Check |
| --- | --- | --- |
| Node.js | ≥ 23.6 (built-in `node:sqlite`, no build step) | `node --version` |
| `prime-agent` | on `PATH` (for real agent Runs) | `which prime-agent` |
| `git` | any modern version (worktree isolation) | `git --version` |

No database server, no Docker, no external services required for a basic run.
Docker/podman is only needed for sandboxed (resource-limited) execution.

## 2. Install

```bash
cd mercury
npm install
```

## 3. Start the server (dev mode: API + worker in one process)

```bash
MERCURY_EMBEDDED_WORKER=true MERCURY_API_TOKENS="tok-alice:alice" npm run dev
```

- `MERCURY_API_TOKENS` maps a bearer token to an owner (`token:owner,...`). This is your login.
- Server listens on `http://127.0.0.1:3000` by default (loopback only — secure default).
- The dashboard is served at `http://127.0.0.1:3000/`.

Production-style split (separate processes, same DB):

```bash
MERCURY_API_TOKENS="tok-alice:alice" npm run server   # terminal 1: API only
MERCURY_API_TOKENS="tok-alice:alice" npm run worker   # terminal 2: worker only
```

## 4. Submit a Run

### Plumbing check (fake agent — no LLM, completes instantly)

```bash
curl -X POST http://127.0.0.1:3000/api/runs \
  -H "Authorization: Bearer tok-alice" -H "Content-Type: application/json" \
  -d '{"task":"smoke test","agent":"fake","repository":{"localPath":"/tmp"}}'
```

### Real PrimeAgent Run

```bash
curl -X POST http://127.0.0.1:3000/api/runs \
  -H "Authorization: Bearer tok-alice" -H "Content-Type: application/json" \
  -d '{"task":"Fix the failing integration tests and prepare a PR","repository":{"localPath":"/path/to/repo","baseBranch":"main"}}'
```

- `agent` defaults to `primeagent` (runs via `prime-agent --mode rpc` with your local model config).
- Need explicit provider/model flags? Start the server with
  `MERCURY_PRIMEAGENT_ARGS="--provider omlx --model <name>"`.
- `repository.localPath` = local git repo; `repository.url` = remote git URL.
- Default workspace mode is `git-worktree` (needs a git repo). For a non-git folder:
  `MERCURY_WORKSPACE_MODE=copy`.

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

Or open the dashboard: **http://127.0.0.1:3000/** — log in with your token, create/observe Runs,
answer human-input questions, cancel, retry.

## 6. What you should see

A Run goes through `QUEUED → STARTING → RUNNING → COMPLETED` (or `FAILED / CANCELLED / TIMED_OUT`).
Structured events are persisted per Run: `run.started`, `skill.started/completed`,
`agent.message`, `tool.started/completed`, `test.completed`, `run.completed`, ...

The Run survives browser/terminal closure. Close everything, come back hours later, and the
Run is still there — that is the whole point of Mercury.

## 7. Useful environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_API_TOKENS` | — | `token:owner,...` map (required for auth) |
| `MERCURY_ADMIN_TOKEN` | — | Admin token (sees all Runs) |
| `MERCURY_PORT` | `3000` | API port |
| `MERCURY_BIND_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose — use TLS/reverse proxy) |
| `MERCURY_DB` | `./mercury.db` | SQLite database file |
| `MERCURY_WORKSPACE_BASE` | `./workspaces` | Workspace root |
| `MERCURY_WORKSPACE_MODE` | `git-worktree` | `git-worktree` or `copy` |
| `MERCURY_PRIMEAGENT_CMD` | `prime-agent` | Agent command |
| `MERCURY_PRIMEAGENT_ARGS` | — | Extra agent args (e.g. `--provider omlx --model <name>`) |
| `MERCURY_EMBEDDED_WORKER` | `false` | Run worker inside the API process (dev) |
| `MERCURY_INPUT_TIMEOUT_MS` | `1800000` | Human-input wait timeout (`0` = no limit) |
| `MERCURY_SANDBOX_RUNTIME` | — | `docker`/`podman` for resource/network-limited Runs |

Full reference: `README.md` → Configuration.

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `401` on `/api/runs` | Wrong/missing `Authorization: Bearer <token>`; token must be in `MERCURY_API_TOKENS` |
| Run stuck `QUEUED` | Worker not running — start it (`MERCURY_EMBEDDED_WORKER=true` or `npm run worker`) |
| Run `FAILED` at setup, "Workspace requires repository..." | `repository.localPath` missing/not a git repo (or use `MERCURY_WORKSPACE_MODE=copy`) |
| Agent exits immediately | `prime-agent` not on PATH or bad `MERCURY_PRIMEAGENT_ARGS`; check `agent-output.log` in the workspace |
| `429 Too Many Requests` | Rate limit (login 10/min/IP, run creation 30/min/owner+IP); wait for `Retry-After` |
| Sandbox error at setup | Run requested `resourceLimits`/`allowedNetworks` but no container runtime — install docker/podman or set `MERCURY_SANDBOX_RUNTIME=none` |

## 9. Verify the install (optional)

```bash
npm run typecheck   # tsc --noEmit
npm test            # 183 tests, no network, no LLM
```

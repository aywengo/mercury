# Configuration

Mercury configuration is environment-based. Application settings use the
`MERCURY_*` prefix. Defaults favor one developer machine and loopback-only
access.

For a production systemd example, see [`deploy/README.md`](../deploy/README.md).

## Minimal development configuration

```bash
MERCURY_EMBEDDED_WORKER=true
MERCURY_API_TOKENS="tok-alice:alice"
npm run dev
```

The API listens on `127.0.0.1:3000` and stores `mercury.db` plus workspaces
relative to the current directory.

## Core

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_DB` | `./mercury.db` | SQLite database file |
| `MERCURY_PORT` | `3000` | API port |
| `MERCURY_BIND_HOST` | `127.0.0.1` | API bind address |
| `MERCURY_TLS_CERT` | unset | TLS certificate path |
| `MERCURY_TLS_KEY` | unset | TLS private-key path; TLS requires both values |
| `MERCURY_EMBEDDED_WORKER` | `false` | Run a worker in the API process for development |
| `MERCURY_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

Production should set absolute database and workspace paths. Relative defaults
are resolved from the service working directory.

## Authentication and HTTP

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_API_TOKENS` | unset | Comma-separated `token:owner` mappings |
| `MERCURY_ADMIN_TOKEN` | unset | Credential with access to every Run |
| `MERCURY_SECRETS` | unset | Comma-separated literal values redacted from events and logs |
| `MERCURY_COOKIE_SECURE` | `false` | Force the browser session cookie's `Secure` attribute |
| `MERCURY_TRUST_PROXY` | `0` | Number of trusted reverse-proxy hops |

Tokens and secret values must come from a protected environment file or secret
manager. Do not place them in command-line arguments, repository files or Git
remote URLs.

### Reverse proxy

Set `MERCURY_TRUST_PROXY` to the exact number of proxies between the client and
Mercury:

- `0` — direct connection; trust no forwarded addresses;
- `1` — one local reverse proxy such as nginx or Caddy;
- `2` — for example, a CDN plus a local reverse proxy.

Mercury accepts decimal digits only. Do not use blanket proxy trust: accepting
the complete `X-Forwarded-For` chain lets a client forge addresses and bypass
per-IP rate limits.

With the correct depth, Express also honors the trusted
`X-Forwarded-Proto: https` value and marks session cookies `Secure`. Use
`MERCURY_COOKIE_SECURE=true` when a TLS-terminating proxy does not forward that
header.

When binding outside loopback, terminate TLS either in Mercury or a trusted
reverse proxy.

## Queue and lifecycle

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_LEASE_MS` | `60000` | Queue lease duration |
| `MERCURY_LEASE_HEARTBEAT_MS` | `15000` | Active lease renewal interval |
| `MERCURY_MAX_RETRIES` | `2` | Automatic infrastructure retries |
| `MERCURY_RETRY_BACKOFF_MS` | `5000` | Base retry backoff |
| `MERCURY_POLL_MS` | `250` | Idle queue and event poll interval |
| `MERCURY_INPUT_POLL_MS` | `200` | Pending input poll interval |
| `MERCURY_INPUT_TIMEOUT_MS` | `1800000` | Maximum input wait; `0` disables |
| `MERCURY_SHUTDOWN_GRACE_MS` | `30000` | Worker shutdown grace before lease recovery takes over |

Keep `MERCURY_LEASE_HEARTBEAT_MS` comfortably below `MERCURY_LEASE_MS`. Keep
worker shutdown grace below the process supervisor's stop timeout.

The API uses its own fixed short connection-drain period. It is not controlled
by `MERCURY_SHUTDOWN_GRACE_MS`.

## Workspace and retention

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_WORKSPACE_BASE` | `./workspaces` | Repository cache and Run workspace root |
| `MERCURY_WORKSPACE_MODE` | `git-worktree` | `git-worktree` or `copy` |
| `MERCURY_WORKSPACE_RETENTION_MS` | `604800000` | Retain terminal workspaces for seven days |
| `MERCURY_WORKSPACE_QUOTA_BYTES` | `10737418240` | Workspace quota, 10 GiB; `0` disables quota eviction |
| `MERCURY_GC_INTERVAL_MS` | `3600000` | Worker GC interval |

Git-worktree mode is the production default. Copy mode is useful for tests and
non-Git local inputs but does not preserve Git branch metadata.

## Sandbox

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_SANDBOX_RUNTIME` | unset | `docker`, `podman` or `none` |
| `MERCURY_SANDBOX_IMAGE` | `node:22-bookworm-slim` | Image used for constrained Runs |
| `MERCURY_SANDBOX_ENV` | model-provider allowlist | Comma-separated environment names forwarded to the container |
| `MERCURY_SANDBOX_DISK_LIMITS` | `false` | Enable `--storage-opt size=` on a verified storage driver |

An unset runtime means constrained Runs fail closed. Runs without sandbox
constraints continue directly on the host.

The default image does not contain PrimeAgent or Git and is not sufficient for
a real sandboxed coding Run. Build an image containing:

1. the selected agent binary;
2. its compatible runtime;
3. Git.

An unset `MERCURY_SANDBOX_ENV` forwards the built-in model-provider credential
names that are actually present. Setting it to an empty string forwards only a
pinned `PATH`.

Mercury refuses administration, source-control and broad infrastructure
credential families even when they are named in the custom list. See
[`operations.md`](operations.md) for the boundary and network semantics.

## PrimeAgent

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_AGENT_MODE` | `rpc` | `rpc` or experimental `daemon` |
| `MERCURY_PRIMEAGENT_CMD` | `prime-agent` | PrimeAgent executable |
| `MERCURY_PRIMEAGENT_ARGS` | unset | Static arguments appended to the RPC command |
| `MERCURY_DAEMON_SOCKET` | platform default | Explicit experimental PrimeAgent daemon socket |

RPC is the supported default. Daemon mode is not production-ready; see
[`daemon-agent-sessions.md`](daemon-agent-sessions.md).

## Hermes

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_HERMES_CMD` | `hermes` | Hermes executable |
| `MERCURY_HERMES_ARGS` | unset | Static Hermes arguments |
| `MERCURY_HERMES_MAX_TURNS` | unset | Maximum Hermes turns |
| `MERCURY_HERMES_RUN_BUDGET_SECONDS` | unset | Hermes time budget |
| `MERCURY_HERMES_YOLO` | `false` | Enable Hermes unattended tool approval |
| `MERCURY_HERMES_ACCEPT_HOOKS` | `false` | Allow Hermes hooks |

Approval-bypass options materially change execution safety. Use them only with
an appropriate sandbox and reviewed agent configuration.

## Claude

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_CLAUDE_CMD` | `claude` | Claude CLI executable |
| `MERCURY_CLAUDE_ARGS` | unset | Static Claude arguments |
| `MERCURY_CLAUDE_MODEL` | unset | Process-wide model override |
| `MERCURY_CLAUDE_ALLOWED_TOOLS` | unset | Claude tool allowlist |
| `MERCURY_CLAUDE_DISALLOWED_TOOLS` | unset | Claude tool deny list |
| `MERCURY_CLAUDE_MCP_CONFIG` | unset | Process-wide Claude MCP configuration |
| `MERCURY_CLAUDE_SKIP_PERMISSIONS` | `false` | Pass Claude's dangerous permission-bypass flag |

Claude MCP configuration is static for the process, not a generic per-Run
Mercury capability. The Crew MCP design does not describe current behavior; it
is future work.

## Declarative adapter registries

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_LOCAL_AGENTS_DIR` | `./local-agents` | `LocalAgentConfig` JSON directory |
| `MERCURY_REMOTE_AGENTS_DIR` | `./remote-agents` | `RemoteAgentConfig` JSON directory |
| `MERCURY_RPC_AGENTS_DIR` | `./rpc-agents` | `RpcAgentConfig` JSON directory |

See [`agents.md`](agents.md) and the registry-specific READMEs:

- [`local-agents/README.md`](../local-agents/README.md)
- [`remote-agents/README.md`](../remote-agents/README.md)
- [`rpc-agents/README.md`](../rpc-agents/README.md)

## Events, alerts and observability

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_EVENT_WAKEUP_SOCKET` | unset | Optional same-host worker-to-API wake-up socket |
| `MERCURY_STUCK_RUN_THRESHOLD_MS` | `1800000` | Alert after no event activity; `0` disables |
| `MERCURY_STUCK_CHECK_INTERVAL_MS` | `60000` | Stuck-Run check interval |
| `MERCURY_BACKLOG_ALERT_THRESHOLD` | `10` | Queue depth that triggers an alert |
| `MERCURY_BACKLOG_CHECK_INTERVAL_MS` | `60000` | Backlog check interval |
| `MERCURY_ALERT_WEBHOOK_URL` | unset | Webhook for backlog and stuck-Run alerts |

The event wake-up socket is advisory. Database polling remains active and
provides delivery correctness when the socket is absent or drops a hint.

Webhook delivery is best effort and bounded. Alert state is deduplicated in the
shared SQLite database so several same-host workers do not all send the same
alert.

## Agent tracing environment

Mercury injects these values into local agent processes; operators normally do
not configure them:

- `MERCURY_RUN_ID`;
- `MERCURY_TRACE_ID`;
- `MERCURY_WORKER_ID`.

Declarative remote-agent configurations may name an additional environment
variable that contains that backend's credential.

## Production-style example

Use one environment file for both API and worker:

```bash
MERCURY_DB=/var/lib/mercury/mercury.db
MERCURY_WORKSPACE_BASE=/var/lib/mercury/workspaces
MERCURY_BIND_HOST=127.0.0.1
MERCURY_API_TOKENS=replace-me:operator
MERCURY_SANDBOX_RUNTIME=docker
MERCURY_SANDBOX_IMAGE=registry.example/mercury-agent:stable
```

Both processes must use the same database, workspace and security settings.
Protect the file with mode `0600`. Deployment, backup and restore steps live in
[`deploy/README.md`](../deploy/README.md).

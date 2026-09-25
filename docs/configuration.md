# Configuration

Mercury configuration is environment-based. Application settings use the
`MERCURY_*` prefix. Defaults favor one developer machine and loopback-only
access.

For a production systemd example, see [`deploy/README.md`](../deploy/README.md).
First-run walkthrough: [`QUICKSTART.md`](../QUICKSTART.md).

## Minimal development configuration

```bash
MERCURY_EMBEDDED_WORKER=true
MERCURY_API_TOKENS="tok-alice:alice"
npm run dev
```

The API listens on `127.0.0.1:3000`. Confirm with `curl -s http://127.0.0.1:3000/healthz`.
It stores `mercury.db` plus workspaces relative to the current directory.

`MERCURY_API_TOKENS` is comma-separated `token:owner` mappings:

- left of the colon is the bearer token (`tok-alice`) — curl `Authorization: Bearer`
  and the dashboard login box;
- right of the colon is the owner id (`alice`).

Each entry must contain exactly one colon. An entry with none (`tok-alice`) or
more than one (`tok-a:bot:maint`) fails config load, naming the entry's position
and never echoing the token (#729) — a silently truncated authorization mapping
would make two principals share one owner scope. Bot owner ids use the
colon-free form `bot-<alias>` (see `docs/dispatcher-bot-design.md` 4.2).

Do not type the owner id or the whole `tok-alice:alice` string into the dashboard.

Creating a Run without `agent` uses `fake` (no coding-agent CLI). Migrations apply
when the process opens the database; `npm run migrate` is a verify/apply CLI, not a
required first-run step.

The QuickStart inline environment is for loopback only. Tokens and secret values
must come from a protected environment file or secret manager in any shared or
networked install. Do not place them in command-line arguments, repository files
or Git remote URLs.

## Choosing an agent

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_DEFAULT_AGENT` | `fake` | Agent id used when create omits `agent` |

Startup fails if the configured id is not registered. Restore the previous
create-Run default with `MERCURY_DEFAULT_AGENT=primeagent`.

Builtin ids (the CLI must be on `PATH` except for `fake`):

| Id | Binary | Notes |
| --- | --- | --- |
| `fake` | — | In-process plumbing adapter; always registered |
| `primeagent` | `prime-agent` | Supported coding transport (RPC) |
| `hermes` | `hermes` | Quiet CLI; reduced fidelity |
| `claude` | `claude` | Stream-JSON CLI; no interactive input |

Install and capability notes: [`agents.md`](agents.md). Extra ids load from the
registry directories below. `npm install` does not ship those CLIs.

## Core

A new local install can keep every default in this section.

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

Leave these at defaults unless you are tuning leases or timeouts.

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

Default `git-worktree` needs a git repository. Use `copy` only for non-git
local inputs (tests, throwaway folders). `/tmp` is not a git repo.

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

Unset unless a Run requests `resourceLimits` or `allowedNetworks`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_SANDBOX_RUNTIME` | unset | `docker`, `podman` or `none` |
| `MERCURY_SANDBOX_IMAGE` | `node:22-bookworm-slim` | Image used for constrained Runs |
| `MERCURY_SANDBOX_ENV` | model-provider allowlist | Comma-separated environment names forwarded to the container |
| `MERCURY_SANDBOX_DISK_LIMITS` | `false` | Enable `--storage-opt size=` on a verified storage driver |

An unset runtime (or `MERCURY_SANDBOX_RUNTIME=none`) means constrained Runs fail closed. Runs without sandbox
constraints continue directly on the host. To run unsandboxed, omit `resourceLimits` and `allowedNetworks`
from the Run constraints.

The default image does not contain a coding-agent binary or Git and is not
sufficient for a real sandboxed coding Run. Build an image containing:

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

RPC is the supported coding transport. Daemon mode is not production-ready; see
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


## Knowledge base

These variables configure the host-side knowledge-base integration. Leave them all unset when
no Atlas is configured.

`MERCURY_ATLAS_URL` is the gate: unset means the feature is entirely off. Setting it without
`MERCURY_ATLAS_TOKEN` or `MERCURY_ATLAS_PROJECT` is an error that fails at startup.

### Core Atlas connection

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_ATLAS_URL` | unset | Atlas base URL; unset disables the entire knowledge feature |
| `MERCURY_ATLAS_TOKEN` | unset | Contributor token for pushing Run-derived notes and pulling packs |
| `MERCURY_ATLAS_PROJECT` | unset | Project id that notes land in and packs are pulled from |
| `MERCURY_ATLAS_HOST_ID` | hostname | Provenance id recorded on every outgoing note |
| `MERCURY_ATLAS_CA_FILE` | unset | Path to a CA certificate for Atlas TLS verification |
| `MERCURY_ATLAS_ADMIN_TOKEN` | unset | Admin token required to accept and deliver operator notes (optional; see below) |

### MERCURY_ATLAS_ADMIN_TOKEN

**Optional.** Operator notes (`POST /api/knowledge/notes`) land in Atlas as promoted, which
requires an admin token. The everyday `MERCURY_ATLAS_TOKEN` is a contributor credential and
cannot promote notes.

`MERCURY_ATLAS_ADMIN_TOKEN` is deliberately **excluded from the startup check** that refuses a
half-configured Atlas when `MERCURY_ATLAS_URL` is set without a token or project. The reason
is stated in `src/config.ts`: every Run-side feature (outbox drain, pack pull, pack injection)
works without it, and refusing to start over an optional token would disable a working host
for an operator who simply has not set up operator notes yet. What refuses instead is the note
route itself, with a `409` that names this variable.

If this variable is unset, `POST /api/knowledge/notes` returns `409` with a message that names
`MERCURY_ATLAS_ADMIN_TOKEN`. No note is queued; a queued note that could never be delivered
would be silently lost rather than durably stored.

### Knowledge synchronisation tuning

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_KNOWLEDGE_INJECT` | `true` | Whether Runs receive a pack by default |
| `MERCURY_KNOWLEDGE_PACK_MAX_BYTES` | `32768` | Maximum pack size delivered to a Run |
| `MERCURY_KNOWLEDGE_PUSH_INTERVAL_MS` | `30000` | Outbox push interval |
| `MERCURY_KNOWLEDGE_PUSH_BATCH` | `100` | Notes per push batch |
| `MERCURY_KNOWLEDGE_PULL_INTERVAL_MS` | `60000` | Replica pull interval |
| `MERCURY_KNOWLEDGE_OUTBOX_ALERT_DEPTH` | `1000` | Outbox depth that triggers an alert |
| `MERCURY_KNOWLEDGE_MAX_NOTES_PER_RUN` | `50` | Maximum notes a single Run may contribute |
| `MERCURY_KNOWLEDGE_MAX_CLAIM_BYTES` | `1024` | Maximum claim length in bytes |
| `MERCURY_KNOWLEDGE_MAX_DETAIL_BYTES` | `4096` | Maximum detail length in bytes |
| `MERCURY_KNOWLEDGE_MAX_EVIDENCE` | `8` | Maximum evidence references per note |
| `MERCURY_KNOWLEDGE_HARVEST_TIMEOUT_MS` | `10000` | Timeout for harvesting notes from a workspace |

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

## Knowledge base

Requires `MERCURY_ATLAS_URL` to be set; omitting the URL disables the whole feature.

| Variable | Default | Notes |
| --- | --- | --- |
| `MERCURY_ATLAS_URL` | unset | Atlas base URL. Required to enable the feature. |
| `MERCURY_ATLAS_TOKEN` | unset | Contributor token for this host. Required when URL is set. |
| `MERCURY_ATLAS_PROJECT` | unset | Project identifier this host contributes to. Required when URL is set. |
| `MERCURY_ATLAS_HOST_ID` | hostname | Host identifier recorded as provenance on notes. |
| `MERCURY_ATLAS_CA_FILE` | unset | Private CA certificate file for the Atlas endpoint. |
| `MERCURY_KNOWLEDGE_INJECT` | `true` | Whether Runs receive a knowledge pack by default. |
| `MERCURY_KNOWLEDGE_PACK_MAX_BYTES` | `32768` | Byte budget for a knowledge pack (§9.1 of knowledge-base.md). |
| `MERCURY_KNOWLEDGE_PUSH_INTERVAL_MS` | `30000` | How often the pusher sends harvested notes to Atlas (ms). |
| `MERCURY_KNOWLEDGE_PUSH_BATCH` | `100` | Notes per push batch. |
| `MERCURY_KNOWLEDGE_PULL_INTERVAL_MS` | `60000` | How often the puller refreshes the local replica from Atlas (ms). |
| `MERCURY_KNOWLEDGE_RETIRED_RETENTION_MS` | `604800000` | How long non-promoted (retired) rows are kept in the host-side replica before being swept, in ms. Default is 7 days. Must be at least several multiples of `MERCURY_KNOWLEDGE_PULL_INTERVAL_MS` so the cursor has advanced past any in-flight page before a swept row could be replayed. See §8.3 of [knowledge-base.md](../docs/knowledge-base.md). |
| `MERCURY_KNOWLEDGE_OUTBOX_ALERT_DEPTH` | `1000` | Outbox depth that triggers a `knowledge.outbox.alert` event. |

## Bots

Dispatcher-bot configuration (§4 of `dispatcher-bot-design.md`) is one JSON
file per bot:

```text
${XDG_CONFIG_HOME:-~/.config}/mercury/bots/<alias>.json
```

The alias is the file name and must match `^[a-z][a-z0-9-]{0,31}$`. Unknown
keys are refused with a did-you-mean suggestion; `triggers` and `brain` are
reserved and refused until B2/B3. Each task needs `name` (unique per bot,
`[a-z0-9-]+`), `cron` (5-field, UTC unless `tz`), and `template` (create-Run
request fields, `task` required). Validate offline:

```bash
mercury host bot validate --alias <a>
```

The command checks the config, the credentials file, and the two-copy token
agreement; it makes no network calls and never prints a token value.

The bot's API token lives in two deliberate places (§4.2): the server side of
`MERCURY_API_TOKENS` (as `tok-bot-<alias>:bot-<alias>`), and the bot's own

```text
${XDG_CONFIG_HOME:-~/.config}/mercury/bot-credentials.json  (mode 0600)
```

keyed by alias with an `api` token per bot (an optional `llm` token per entry
is accepted for the B3 brain; other keys are refused). `host bot validate`
reports the pair as drifted when the copies disagree.

Manual fire and status (§11):

```bash
mercury host bot dispatch --alias <a> --task <name>   # refused without --yes
mercury host bot dispatch --alias <a> --task <name> --dry-run
mercury host bot status   --alias <a>
```

`dispatch` resolves the task template exactly as the scheduler would fire it
now and writes with an idempotency key of
`bot-<alias>:<task>:manual-<w<UTC wall minute>>` — two invocations inside the
same minute replay to one Run, a retry after a crash replays, and the key can
never collide with a scheduled fire's. `singleFlight` applies as configured; a
refusal names the parked Run rather than stacking. `--dry-run` prints the
resolved body and key and writes nothing. `status` prints the next fire per
task (config + cron, works offline), the bot's recent Runs, and the
dispatches-in-the-last-hour count read from the API — never from local state;
unreachable API marks those two sections UNAVAILABLE and exits non-zero.

## Host installer

Variables written by `mercury host setup` (docs/host-installer.md M3). The wizard
writes them to `${XDG_CONFIG_HOME:-~/.config}/mercury/mercury.env` (mode 0600) and the
generated launchd/systemd user unit loads that file exactly as the system units load
`/etc/mercury/mercury.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERCURY_ADMIN_TOKEN` | unset | Admin/API token: full access to this host's API (admin session, smoke Runs). `mercury host setup` generates one and prints it exactly once; register the same value on the Fleet side as the Bearer token Fleet presents to this host (issue #648). |
| `MERCURY_HARNESSES` | unset | Comma-separated allowlist of shipped host harnesses to register adapters for (`primeagent`, `hermes`, `claude`). Unset registers every shipped harness. `fake` and the declarative local/remote/rpc agents are not host harnesses and are never filtered (issue #645). Fleet is pull, not push: it calls the host's API with a Fleet-held token, so there is no host-side Fleet URL or host token. |

## Production-style example

Use one environment file for both API and worker. Set `MERCURY_DEFAULT_AGENT` to
the coding backend this host should run when callers omit `agent`:

```bash
MERCURY_DB=/var/lib/mercury/mercury.db
MERCURY_WORKSPACE_BASE=/var/lib/mercury/workspaces
MERCURY_BIND_HOST=127.0.0.1
MERCURY_API_TOKENS=replace-me:operator
MERCURY_DEFAULT_AGENT=primeagent
MERCURY_SANDBOX_RUNTIME=docker
MERCURY_SANDBOX_IMAGE=registry.example/mercury-agent:stable
```

Both processes must use the same database, workspace and security settings.
Protect the file with mode `0600`. Deployment, backup and restore steps live in
[`deploy/README.md`](../deploy/README.md).

# Operations

This guide covers runtime topology, workspaces, sandboxing, cleanup,
observability and recovery. For systemd installation, backup and restore
commands, use [`deploy/README.md`](../deploy/README.md).

Configuration reference: [`configuration.md`](configuration.md).

## Deployment topology

Production uses two processes on one host:

```text
mercury server  -> HTTP API, dashboard, SSE
mercury worker  -> queue claims, workspaces, agents, cleanup
                 |
                 +-> one shared local SQLite database
```

The API does not execute agents. The worker and API must use the same
`MERCURY_DB` and compatible workspace/security configuration.

SQLite WAL supports several same-host processes. Do not put the database on
network storage or run one Mercury database across hosts. Use Fleet to federate
independent Mercury installations.

For development only, `MERCURY_EMBEDDED_WORKER=true npm run dev` combines API
and worker.

## Process supervision

Run API and worker under a supervisor such as systemd. The supplied units:

- use separate service processes;
- require `/etc/mercury/mercury.env`;
- bind Mercury to loopback by default;
- use journald for logs;
- set bounded stop timeouts;
- apply filesystem and process hardening.

The environment file should be mode `0600` because it contains API and provider
credentials.

## Graceful shutdown

API shutdown:

1. stop admitting connections;
2. allow ordinary requests a short fixed drain;
3. force-close remaining connections, including long-lived SSE;
4. close resources.

Worker shutdown:

1. stop claiming new Runs;
2. signal the active drive loop;
3. terminate the agent;
4. requeue the still-owned Run for graceful shutdown;
5. close the database after active work drains or grace expires.

`MERCURY_SHUTDOWN_GRACE_MS` applies to the worker. Keep it below the service
manager's stop timeout. If shutdown is not graceful, lease expiry and retry
provide recovery.

A second termination signal may exit immediately. The durable Run and lease
model is the recovery boundary.

## Workspace layout

Default layout:

```text
workspaces/
  repos/
    <repository-hash>/       shared local Git cache
  worktrees/
    <runId>/                 isolated mutable Run workspace
```

Each Run records:

- primary repository and optional additional repositories;
- resolved base commit;
- branch `agent/<runId>`;
- workspace path;
- final commits and pull-request URL.

Additional repositories are cloned or copied below
`<workspace>/repos/<name>`. The primary repository is not duplicated there.

Do not allow unrelated Runs to share one mutable worktree.

## Workspace garbage collection

The worker runs GC at startup and every `MERCURY_GC_INTERVAL_MS`. Run one pass
manually with:

```bash
npm run gc
```

Policies:

- **retention** — remove terminal workspaces older than
  `MERCURY_WORKSPACE_RETENTION_MS`;
- **quota** — when total storage exceeds
  `MERCURY_WORKSPACE_QUOTA_BYTES`, evict oldest terminal workspaces until under
  quota;
- **orphans** — remove old workspace directories without a matching Run;
- **active protection** — never remove `QUEUED`, `STARTING`, `RUNNING` or
  `NEEDS_INPUT` workspaces.

Cleanup is best effort. Failures are reported and retried on a later pass.

Git-worktree removal cleans Git metadata and the Run branch. Copy-mode cleanup
removes the directory recursively.

## Sandboxed execution

A Run requests container isolation when it supplies `resourceLimits` or
`allowedNetworks`. `SandboxManager` wraps local agent processes with Docker or
Podman.

Policy:

- unconstrained Run — execute directly on the host;
- constrained Run with available runtime — execute in a container;
- constrained Run without runtime — fail before agent startup.

This is fail-closed with respect to requesting a container. It is not a claim
that every field expresses a fine-grained policy.

### Resource limits

Supported values:

- `cpu` → container CPU limit;
- `memory` → container memory limit;
- `disk` → storage-driver size option when explicitly enabled.

Disk limits are disabled by default. `docker run --storage-opt size=` works only
with certain storage drivers. Set `MERCURY_SANDBOX_DISK_LIMITS=true` only after
verifying the host; otherwise a Run requesting disk limits fails with an
actionable error.

### Network behavior

Current behavior is binary:

- `allowedNetworks: []` → `--network none`;
- any non-empty `allowedNetworks` → `--network bridge`.

Bridge mode is unrestricted container egress. Names in the array are recorded
but are not translated into destination allowlists, firewall rules or Docker
network names.

Do not describe values such as `["cluster-api"]` as enforced host restrictions.
Real destination policy requires an egress proxy, container network policy or
equivalent control. The Crew MCP security design tracks that future boundary:
[`crew/mcp-security.md`](crew/mcp-security.md).

### Image requirements

The default `node:22-bookworm-slim` image is not a complete Mercury agent image.
A real image must contain:

1. the selected agent executable;
2. a compatible language runtime;
3. Git.

Point `MERCURY_SANDBOX_IMAGE` at a purpose-built image and smoke-test every
enabled adapter.

### Environment forwarding

The sandbox receives a pinned `PATH` and an allowlisted subset of the worker
environment. The default names are model-provider credentials:

```text
ANTHROPIC_API_KEY
OPENAI_API_KEY
GEMINI_API_KEY
GOOGLE_API_KEY
DEEPSEEK_API_KEY
MISTRAL_API_KEY
XAI_API_KEY
GROQ_API_KEY
OPENROUTER_API_KEY
HF_TOKEN
```

Only values actually set are forwarded. Forwarding allows the container to
spend model budget.

Set `MERCURY_SANDBOX_ENV` to a comma-separated custom list, or to an empty
string to forward nothing beyond `PATH`.

Mercury always refuses these families:

- `MERCURY_*`;
- `GH_*`, `GITHUB_*`, `GIT_*`;
- `AWS_*`, `AZURE_*`, `GOOGLE_APPLICATION_*`, `GOOGLE_CLOUD*`,
  `CLOUDSDK_*`, `GCLOUD_*`;
- `KUBE*`, `SSH_*`, `DOCKER_*`, `TF_VAR_*`, `TERRAFORM*`, `CIRCLE_*`,
  `TN_*`, `DIGITALOCEAN_*`.

This protects Mercury administration, source control and broad infrastructure
credentials from untrusted agent processes. Provider-specific products blocked
by these families need a deliberate design rather than a broad exception.

### Systemd and the container runtime

Strict systemd hardening may prevent access to the Docker or Podman socket. The
deployment guide provides an opt-in sandbox drop-in. Do not weaken the base
service unit on installations that do not need container execution.

## Secret redaction

Events and logs pass through a redactor before persistence or output. It covers:

- operator-declared `MERCURY_SECRETS`;
- exact values of credentials forwarded by the sandbox;
- common labelled secret patterns;
- known bare provider-token shapes.

Redaction is mitigation, not an isolation boundary. It cannot guarantee removal
of a transformed or unrecognized secret that Mercury never observed. Primary
controls remain minimal credential forwarding and network isolation.

Values guessed from forwarded environment variables below the redaction length
floor generate a startup warning by variable name.

## Metrics

`GET /metrics` returns authenticated Prometheus text. It includes bounded-label
aggregates for:

- Run status and failure kind;
- queue and worker state;
- Run, queue-wait and agent duration;
- retries and input waits;
- sandbox usage;
- event-delivery behavior.

Configure Prometheus with an API bearer token. Do not expose metrics publicly:
they reveal activity and failure information beyond simple liveness.

## Health

`GET /healthz` reports API liveness.

`GET /healthz/workers` reports:

- active worker lease holders;
- active Run counts;
- oldest lease expiration;
- queue depth.

When queue dependencies are absent, worker health returns `503`. The API can
still be alive while unable to execute Runs.

## Alerts

The worker checks:

- queue backlog against `MERCURY_BACKLOG_ALERT_THRESHOLD`;
- Runs without event activity beyond `MERCURY_STUCK_RUN_THRESHOLD_MS`.

Alerts are structured logs and optionally POSTed to
`MERCURY_ALERT_WEBHOOK_URL`. Webhook calls are bounded and best effort.

Alert claims are deduplicated in SQLite so multiple workers do not send one
cluster-wide alert each.

Stuck detection is activity-based. A legitimately quiet long-running tool can
look stuck; alert recipients must inspect the timeline and worker health before
intervening.

## Event delivery

Durable events in SQLite are the source of truth. Delivery uses:

- direct in-process append notifications;
- an adaptive per-subscription database poller;
- optional same-host worker-to-API Unix-socket wake-up.

The socket sends only a hint to poll. Dropped hints cannot lose events because
polling never stops. Cross-host event push is not the scaling blocker; shared
SQLite storage is.

See [`cross-process-event-push.md`](cross-process-event-push.md).

## Backup and restore

Back up SQLite using its online backup mechanism or the supplied deployment
script, not a raw file copy while WAL writes are active.

The deployment guide provides:

- backup integrity verification;
- retention;
- restore steps;
- agreement checks for configured database paths.

Back up the database and retain repository/workspace artifacts according to
your recovery objective. A database restore cannot recreate workspaces that
were separately deleted.

## Common failure symptoms

### Run remains queued

Check `/healthz/workers`, queue depth and worker service logs. A running API
without a worker accepts Runs but does not execute them.

### Constrained Run fails before agent start

Check the sandbox runtime, socket access, image contents and requested disk
policy. Fail-closed setup failures are expected when these prerequisites are
missing.

### Agent cannot authenticate

Verify the credential is present in the worker environment and allowed into the
sandbox. Do not respond by forwarding the complete worker environment.

### Dashboard repeatedly logs out

The API process probably restarted or requests are reaching different API
processes. Sessions are in memory and not shared.

### Events arrive late but eventually appear

Check whether the optional wake-up socket is enabled. Polling remains correct,
so wake-up failure affects latency rather than durability.

# Current status and limitations

Mercury implements the complete single-host durable Run path: API, SQLite
queue, worker, isolated workspaces, agent adapters, events, dashboard, human
control, retries, sandbox integration, metrics and deployment packaging.

This page records active limitations without the long historical completion
list previously kept in the root README.

## Supported baseline

The production baseline is:

- one host;
- one local SQLite database shared by API and workers;
- separate `server` and `worker` processes;
- `fake` as the create-Run default when `agent` is omitted (`MERCURY_DEFAULT_AGENT`);
- PrimeAgent RPC as the supported coding-agent transport;
- Git-worktree isolation;
- optional Docker or Podman sandboxing;
- bearer-token or browser-session authentication;
- persisted event history with SSE delivery.

Fleet can federate several independent Mercury hosts over HTTP. It does not
turn them into one shared database or move active Runs between hosts.

## Active limitations

### Single-host storage

SQLite WAL is the coordination layer. It is unsuitable for a shared database on
network storage, so Mercury cannot run one control plane across several hosts.

Fleet is the supported federation direction. Replacing SQLite with a networked
transactional store would be a separate architecture project.

### Identity and API scaling

`MERCURY_API_TOKENS` remains the identity source. Browser sessions and rate
limits are process-local memory.

Consequences:

- sessions disappear on API restart;
- two API processes do not recognize each other's sessions;
- each API process has an independent rate-limit budget;
- OIDC/SSO and horizontally shared session/rate-limit storage remain future
  work.

`MERCURY_TRUST_PROXY` fixes source-IP attribution behind a proxy; it does not
make these stores shared.

### Skill snapshot execution

Run creation stores complete skill content and hashes in `run_skills`. The
worker currently reads those records, keeps only their ids and re-resolves the
live filesystem registry before workspace materialization.

Therefore:

- the persisted snapshot remains an audit record;
- changing a skill while a Run is queued can change the bytes it executes;
- retry also resolves current skill bytes by id.

Snapshot-backed materialization is Phase 0 of the
[`Crew roadmap`](crew/roadmap.md), but it is a correctness improvement
independent of Crew.

### Network policy granularity

Sandbox network behavior is:

- empty `allowedNetworks` → network disabled;
- non-empty `allowedNetworks` → unrestricted bridge networking.

Names in the array do not enforce destinations. Hostname allowlists, private
network restrictions and HTTP MCP egress require a real proxy or network policy
layer.

### Sandbox prerequisites

Constrained Runs fail closed without a configured container runtime. The
default Node image lacks PrimeAgent and Git, so operators need a purpose-built
image.

Disk limits depend on the host storage driver and are disabled unless explicitly
declared supported. Strict systemd hardening requires the documented opt-in
runtime-socket configuration.

### Token and cost budgets

`budgetTokens` and `budgetCost` are recorded but not enforced. Adapters do not
report normalized usage to the worker, so Mercury cannot stop a Run at those
budgets.

`maxDurationMs` and `maxRetries` are enforced.

### Agent capability differences

Not every adapter offers the same fidelity:

- PrimeAgent RPC supports structured tools, human input and session resume;
- Hermes quiet mode is text-level and has no live input bridge;
- the verified Claude CLI path has structured tool events and resume but no
  answerable interactive-input channel;
- declarative adapters provide only the capabilities expressed by their
  configuration and backend;
- remote agents execute inside the remote provider's security boundary.

Callers must not infer capabilities from an agent id alone. A richer
capabilities API remains useful for Fleet routing and future Role Presets.

### PrimeAgent daemon mode

The daemon adapter exists but is not production-ready. Verification against
PrimeAgent 0.8.1 found incompatibilities in framing, command envelope, session
identity and socket selection.

Mock-based daemon tests do not prove real-daemon compatibility. RPC remains the
supported default. See [`daemon-agent-sessions.md`](daemon-agent-sessions.md).

### Local repository paths

A `repository.localPath` is interpreted on the worker host. The API cannot
verify that a path exists on a different worker host, and Fleet relies on
operator-declared locality.

Prefer a Git URL for portable routing.

### Static dashboard

The dashboard is a small vanilla-JavaScript application with no build step.
This keeps deployment simple but limits component reuse and richer client-side
state management.

### Redaction is mitigation

Mercury redacts known patterns and exact credentials it forwards. It cannot
guarantee removal of an unknown secret that it never observed or a value
transformed by a malicious agent.

Minimal credential forwarding and network isolation remain the primary
boundaries.

## Designed but not implemented

### Crew

Crew is being designed as four staged products:

1. builtin Role Presets;
2. generic per-run MCP with enforceable policy;
3. Git-backed preset distribution and owner drafts;
4. bounded Workflow Templates.

No Crew API or source implementation currently exists. See
[`crew/README.md`](crew/README.md).

### OIDC/SSO

Replacing token-to-owner mappings with a real identity provider remains open.
It should be designed together with durable/shared browser sessions when more
than one API process is required.

### Destination-aware egress

Named network destinations remain design-only. Do not treat recorded
`allowedNetworks` strings as enforced allowlists.

## Recommended priority

1. Make workers execute stored skill snapshot bytes and preserve them on retry.
2. Bound workspace Git clone/fetch/worktree commands consistently.
3. Add identity and shared API state only when multi-user or multi-API
   deployment requires it.
4. Add destination-aware network policy before generic HTTP MCP.
5. Reverify and repair daemon mode only if resident PrimeAgent sessions provide
   concrete value over RPC.
6. Implement Crew in the dependency order documented in its roadmap.

## Sources of truth

- behavior and invariants: [`ARCHITECTURE.md`](../ARCHITECTURE.md);
- first-run instructions: [`QUICKSTART.md`](../QUICKSTART.md);
- deployment: [`deploy/README.md`](../deploy/README.md);
- daemon verification: [`daemon-agent-sessions.md`](daemon-agent-sessions.md);
- Crew phases: [`crew/roadmap.md`](crew/roadmap.md);
- current test outcome: `npm test`, not a stored count.

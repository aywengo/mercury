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

Callers must not infer capabilities from an agent id alone. `/api/agents`
now reports a static capability descriptor per agent -- skill delivery mode,
persona append and files, human input, resume and knowledge -- so a caller can
filter on capability rather than on a name. What remains unbuilt is the dynamic
half: advertising capabilities that depend on which harness version is installed,
and gate outcomes. `knowledge` is declared but unverified for every shipped
backend, so it must not be treated as a promise.

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

## Implemented

### Distribution

Four channels, all built by the release workflow in `release.yml`; what each artifact
contains and how it is produced is owned by
[`distribution.md`](distribution.md):

| Channel | Command |
| --- | --- |
| Git checkout | `git clone https://github.com/aywengo/mercury.git`, then `npm ci` (which compiles `dist/` as part of installing) |
| npm | `npm install -g @aywengo/mercury` |
| GitHub Release | bundle asset attached to the `host-v*` tag |
| Homebrew | `brew tap aywengo/mercury https://github.com/aywengo/mercury` then `brew install mercury-ai` |

`mercury-ai` is the formula name because homebrew-core already owns `mercury`: that is the
Mercury language compiler, and installing it fetches roughly a gigabyte of a different
project. The formula lives in this repository and is generated by the release job from the
digest of the artifact it just built, so it cannot drift from the release.

Whether anything has been published yet is not recorded here; see
[Releases](https://github.com/aywengo/mercury/releases).

### Operator CLI

`mercuryctl` is implemented and ships in the host package, so
`npm install -g @aywengo/mercury` puts it on `PATH`; it has no version of its own
and no tag of its own. It drives Runs over the public HTTP API: `agents list`;
`runs list`, `show`, `create`, `events`, `watch`, `input`, `cancel`, `retry`;
`config profiles`, `config current`; shell completion. Operator guide:
[`client.md`](client.md).

## Designed but not implemented

### Operator TUI

The terminal UI is Milestone 5 of the client design. It is deliberately not
built: the design gates it on demonstrated need for a TUI over the CLI and
dashboard, and that need has not been demonstrated. See
[`cli-tui-design.md`](cli-tui-design.md) for the architecture, protocol
contracts and milestone roadmap.

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

1. Add identity and shared API state only when multi-user or multi-API
   deployment requires it.
2. Add destination-aware network policy before generic HTTP MCP. This gates Crew
   Milestone B: `allowedNetworks` names do not yet restrict destinations, so
   per-run MCP would be advertised on top of a boundary that does not hold.
3. Reverify and repair daemon mode only if resident PrimeAgent sessions provide
   concrete value over RPC.
4. Implement Crew in the dependency order documented in its roadmap. Its Phase 0
   correctness prerequisites are complete, so Milestone A (Role Presets, Phases
   1-3) is the next work; Milestone B waits on item 2 above.

## Sources of truth

- behavior and invariants: [`ARCHITECTURE.md`](../ARCHITECTURE.md);
- first-run instructions: [`QUICKSTART.md`](../QUICKSTART.md);
- deployment: [`deploy/README.md`](../deploy/README.md);
- daemon verification: [`daemon-agent-sessions.md`](daemon-agent-sessions.md);
- Crew phases: [`crew/roadmap.md`](crew/roadmap.md);
- current test outcome: `npm test`, not a stored count.

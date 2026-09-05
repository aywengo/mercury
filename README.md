# Mercury

Mercury is a durable control plane for long-running coding agents, managing
runs, state, workspaces, events, retries, and human input independently of
browser sessions. Agents execute the coding work, while Mercury safely
orchestrates when, where, and with which tools and instructions they run.

It is a harness for harnesses. Mercury never inspects a repository, edits a
file, or runs a test; every one of those decisions belongs to the agent backend.
What Mercury owns is everything that has to survive the agent process: the Run's
identity and state, its workspace, its event history, the queue and lease that
decide when it runs, and the human-input loop that resumes it. That separation is
why one control plane can drive PrimeAgent, Claude, Hermes, a local CLI, a remote
API, or a fake adapter in tests without any of them knowing about the others.

Mercury is a working Node.js and SQLite implementation. Creating a Run without
an `agent` field uses the built-in `fake` adapter (no extra CLI). PrimeAgent,
Hermes, Claude, and declarative local/RPC/remote adapters are optional backends
behind `AgentAdapter`.

## What Mercury provides

- durable Runs whose lifetime is independent of HTTP, SSE and browser sessions;
- a separate API process and background worker;
- SQLite-backed scheduling, leases, state and event history;
- isolated Git worktrees and optional container sandboxing;
- structured progress events with resumable SSE;
- cancellation, retry and human-input flows;
- deterministic skill selection and per-Run skill records;
- a static operations dashboard;
- declarative local, remote and RPC agent adapters.

## Control plane

```mermaid
flowchart TD
    User[User] --> Surfaces["API, dashboard and chat"]

    subgraph controlPlane [Mercury control plane]
        Surfaces --> RunService[RunService]
        RunService --> RunStore["Run state and snapshots"]
        RunService --> Queue["Durable queue and leases"]
        RunService --> EventStore["Structured event store"]
    end

    Queue --> Worker[Worker]

    subgraph executionHarness [Execution harness]
        Worker --> Workspace["Isolated workspace"]
        Worker --> Skills["Selected skills"]
        Worker --> Sandbox["Optional sandbox"]
        Worker --> Adapter[AgentAdapter]
    end

    subgraph agentBackends [Agent backends]
        PrimeAgent[PrimeAgent]
        Hermes[Hermes]
        Claude[Claude]
        LocalAgent["Local CLI agents"]
        RpcAgent["RPC agents"]
        RemoteAgent["Remote API agents"]
        FakeAgent["Fake agent for tests"]
    end

    Adapter --> PrimeAgent
    Adapter --> Hermes
    Adapter --> Claude
    Adapter --> LocalAgent
    Adapter --> RpcAgent
    Adapter --> RemoteAgent
    Adapter --> FakeAgent
    Adapter --> Translation["Event translation"]
    Translation --> EventStore
    EventStore --> Surfaces
```

Mercury controls orchestration and process lifetime. Agent backends retain
responsibility for inspecting repositories, editing code, running tools and
producing results. Backends other than `fake` need their CLI (or remote API)
installed separately; `npm install` does not ship them.

## Quick start

Requires Node.js ≥ 22.18 (built-in `node:sqlite` and TypeScript type stripping).
For prerequisites and a complete first-run walkthrough, see
[`QUICKSTART.md`](QUICKSTART.md).

```bash
npm install
MERCURY_EMBEDDED_WORKER=true \
  MERCURY_API_TOKENS="tok-alice:alice" \
  npm run dev
```

The dashboard is available at `http://127.0.0.1:3000/`. Sign in with `tok-alice`
(the token, left of the colon — not the owner id `alice`). A first Run can omit
`agent` and will use `fake`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the API and, when enabled, the embedded development worker |
| `npm run server` | Start the API only |
| `npm run worker` | Start the background worker only |
| `npm run migrate` | Apply database migrations (also applied automatically on start) |
| `npm run gc` | Run one workspace-retention and quota pass |
| `npm run typecheck` | Run TypeScript checks |
| `npm test` | Run the core and Fleet test suites |
| `npm run fleet` | Manage federated Mercury hosts |

## Operating Runs from a terminal

`mercuryctl` is the remote operator client: it talks to a running Mercury over its
HTTP API and never starts a server or a worker.

```bash
export MERCURY_CLIENT_URL=https://mercury.example.com:3000
export MERCURY_CLIENT_TOKEN="$MY_TOKEN"     # never a flag: argv is readable with ps

npx mercuryctl agents list
npx mercuryctl runs create --task "fix the flaky test" --repo https://github.com/acme/api.git
npx mercuryctl runs list --status running --json | jq -r '.runs[].id'
npx mercuryctl runs watch "$RUN_ID"
```

`--json` emits exactly one machine-readable value on stdout, exit codes are stable
and documented, and `mercuryctl --help` lists the commands this build implements.
The design is in [`docs/cli-tui-design.md`](docs/cli-tui-design.md).

## Fleet

[`fleet/`](fleet/) is a separate product in this repository: a federation layer
that runs several independent Mercury instances as one fleet. It talks to each
Mercury over its public HTTP API, never touches a Mercury database, and imports
no Mercury code — a coupling test enforces the boundary.

The `fleet` CLI manages the host registry and probes it. `fleet serve` is the
part that has to outlive the operator who started it: submitting and routing Runs
across hosts, reconciling their state after a crash, aggregating events, and
serving one Prometheus rollup.

```bash
npm run fleet -- hosts add mac-studio --url https://studio.lan:3000 --credential mac-studio
npm run fleet -- hosts list --live
FLEET_API_TOKENS="tok-admin:admin" npm run fleet -- serve
```

Fleet has its own tests (`npm run test:fleet`), configuration, changelog, and
[operator documentation](fleet/README.md). Its design is in
[`docs/fleet-design.md`](docs/fleet-design.md).

## Documentation

Start with the [`documentation index`](docs/README.md), or go directly to:

- [`System overview`](docs/overview.md)
- [`API and dashboard`](docs/api.md)
- [`Configuration`](docs/configuration.md)
- [`Agent backends`](docs/agents.md)
- [`Operations`](docs/operations.md)
- [`Testing`](docs/testing.md)
- [`Current status and limitations`](docs/status.md)
- [`Deployment`](deploy/README.md)
- [`Architecture specification`](ARCHITECTURE.md)
- [`Crew design`](docs/crew/README.md)
- [`Fleet design`](docs/fleet-design.md)

## Current constraints

Mercury is intentionally single-host because its coordination store is SQLite.
PrimeAgent RPC is the supported coding-agent transport; create-Run omits `agent`
as `fake` unless `MERCURY_DEFAULT_AGENT` is set. Daemon mode is experimental and
not production-ready. Named network destinations are not currently enforced, and
stored skill snapshots are not yet the bytes materialized by the worker.

See [`docs/status.md`](docs/status.md) for the complete and current limitations.

## License and contributing

Mercury is [MIT](LICENSE) licensed. Host changes are recorded in
[`CHANGELOG.md`](CHANGELOG.md); Fleet has [`fleet/CHANGELOG.md`](fleet/CHANGELOG.md).
How to cut a release: [`docs/releasing.md`](docs/releasing.md).

- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`SECURITY.md`](SECURITY.md)
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)

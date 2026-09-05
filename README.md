# Mercury

Mercury is a durable control plane for long-running coding agents, managing
runs, state, workspaces, events, retries, and human input independently of
browser sessions. Agents execute the coding work, while Mercury safely
orchestrates when, where, and with which tools and instructions they run.

Mercury is a working Node.js and SQLite implementation. PrimeAgent RPC is the
default execution backend; other agents integrate through the `AgentAdapter`
boundary.

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
producing results.

## Quick start

For prerequisites and a complete first-run walkthrough, see
[`QUICKSTART.md`](QUICKSTART.md).

```bash
npm install
MERCURY_EMBEDDED_WORKER=true \
  MERCURY_API_TOKENS="tok-alice:alice" \
  npm run dev
```

The dashboard is available at `http://127.0.0.1:3000/`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the API and, when enabled, the embedded development worker |
| `npm run server` | Start the API only |
| `npm run worker` | Start the background worker only |
| `npm run migrate` | Apply database migrations |
| `npm run gc` | Run one workspace-retention and quota pass |
| `npm run typecheck` | Run TypeScript checks |
| `npm test` | Run the core and Fleet test suites |
| `npm run fleet` | Manage federated Mercury hosts |

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
PrimeAgent RPC is the supported default; daemon mode is experimental and not
production-ready. Named network destinations are not currently enforced, and
stored skill snapshots are not yet the bytes materialized by the worker.

See [`docs/status.md`](docs/status.md) for the complete and current limitations.

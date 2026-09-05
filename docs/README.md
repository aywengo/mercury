# Mercury documentation

Mercury is a durable control plane for long-running coding agents. This index
separates day-to-day usage from protocol research, feature designs and
historical reviews.

## Start here

- [`QuickStart`](../QUICKSTART.md) — install Mercury and submit the first Run.
- [`System overview`](overview.md) — control plane, worker, execution harness,
  lifecycle, skills, workspaces and events.
- [`API and dashboard`](api.md) — authentication, endpoints, pagination, SSE
  and controls.
- [`Configuration`](configuration.md) — complete `MERCURY_*` environment
  reference.
- [`Current status and limitations`](status.md) — supported baseline, active
  gaps and recommended priorities.

## Releases

Host and Fleet have independent versions. See [`releasing.md`](releasing.md).

- [`Host 0.1.0`](releases/host/0.1.0.md)
- [`Fleet 0.1.0`](releases/fleet/0.1.0.md)
- [`Host changelog`](../CHANGELOG.md)
- [`Fleet changelog`](../fleet/CHANGELOG.md)

## Operating Mercury

- [`Operations`](operations.md) — topology, shutdown, workspaces, sandbox,
  metrics, alerts and recovery.
- [`Deployment`](../deploy/README.md) — systemd units, environment file,
  backup and restore.
- [`Remote client setup`](remote-client-setup.md) — connect to a Mercury
  installation safely.
- [`Testing`](testing.md) — focused and full verification, fixtures and bounded
  command guidance.

## Operator client

- [`CLI and TUI design`](cli-tui-design.md) — CLI-first remote Run control,
  shared HTTP/SSE client architecture and implementation milestones. This is a
  design; the proposed `mercuryctl` executable is not implemented yet.

## Agent backends

- [`Agent overview`](agents.md) — supported adapters and their capability
  differences.
- [`Agent adapter design`](agent-adapters.md) — protocol research, adapter
  contracts and detailed implementation notes.
- [`Local agent registry`](../local-agents/README.md) — declarative local CLI
  agents.
- [`RPC agent registry`](../rpc-agents/README.md) — declarative RPC JSONL
  agents.
- [`Remote agent registry`](../remote-agents/README.md) — declarative remote
  HTTP agents.
- [`Daemon session verification`](daemon-agent-sessions.md) — why PrimeAgent
  daemon mode is not currently production-ready.

## Fleet

Fleet federates several independent Mercury installations over HTTP. It does
not share their databases or execute agents itself.

- [`Fleet operator guide`](../fleet/README.md)
- [`Fleet architecture and design`](fleet-design.md)

## Crew

Crew is a design for reusable execution configuration. The active design splits
the work into independently shippable products:

- [`Crew overview`](crew/README.md)
- [`Role Presets`](crew/role-presets.md)
- [`Per-run MCP security`](crew/mcp-security.md)
- [`Preset Store`](crew/preset-store.md)
- [`Workflow Templates`](crew/workflows.md)
- [`Crew roadmap`](crew/roadmap.md)

The original [`Crew agent preset store`](crew-design.md) document is retained
as a superseded historical proposal.

## Architecture

- [`Architecture specification`](../ARCHITECTURE.md) — normative system goals,
  boundaries and lifecycle.
- [`Cross-process event push`](cross-process-event-push.md) — event-delivery
  measurements and same-host wake-up design.

## Reviews

- [`Current architecture review`](architecture-review.md)
- [`Architecture review round 1`](architecture-review-round-1.md) — archived
  review and remediation record.

Review documents are point-in-time assessments. Prefer source behavior,
`status.md` and current test results over old line references or counts.

## Documentation ownership

Use the narrowest document for a change:

- user workflow and first run → `QUICKSTART.md`;
- endpoint or auth behavior → `docs/api.md`;
- environment setting → `docs/configuration.md`;
- runtime/recovery behavior → `docs/operations.md`;
- adapter behavior → `docs/agents.md` and `docs/agent-adapters.md`;
- deployment commands → `deploy/README.md`;
- architectural invariant → `ARCHITECTURE.md`;
- active limitation → `docs/status.md`;
- Crew design → `docs/crew/`;
- host release notes → `docs/releases/host/`;
- Fleet release notes → `docs/releases/fleet/`;
- how to cut a release → `docs/releasing.md`.

Avoid copying the same detailed table into several files. Link to the owning
document and keep summaries short.

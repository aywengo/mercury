# Changelog

All notable changes to the Mercury **host** (API, worker, dashboard, adapters)
are recorded here. Fleet has its own [`fleet/CHANGELOG.md`](fleet/CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-05

First public host release. Install from git or
`npm install -g @aywengo/mercury`.

### Added

- Durable Runs: Express API, separate worker, SQLite WAL queue and leases.
- Isolated git-worktree workspaces and optional Docker/Podman sandboxing.
- Structured events with resumable SSE, cancellation, retry, and human input.
- Static operations dashboard.
- Adapters: `fake` (create-Run default), PrimeAgent RPC, Hermes, Claude Code,
  plus declarative local, RPC, and remote registries.
- systemd units, backup script, and Prometheus `/metrics`.
- `GET /healthz` reports `{ ok, ts, product: "host", version }`.
- `mercury --version` prints `mercury-host <version>`.

### Known limitations

See [`docs/status.md`](docs/status.md). In brief: skill snapshots are stored
but the worker re-resolves live skill files; PrimeAgent daemon mode is not
production-ready; token and cost budgets are recorded not enforced; named
`allowedNetworks` entries are not a destination allowlist; sessions are
in-memory.

### Not included

- Crew APIs
- `mercuryctl` (operator CLI / TUI)
- OIDC / SSO
- Fleet (separate product, `@aywengo/mercury-fleet`)

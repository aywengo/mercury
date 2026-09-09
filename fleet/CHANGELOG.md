# Changelog

All notable changes to **Mercury Fleet** are recorded here. The host product
has its own [`../CHANGELOG.md`](../CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - not yet published

First published Fleet release, **pending**: `@aywengo/mercury-fleet` is still not on the npm
registry, so nothing here is installable yet. Fleet runs from a source checkout with
`npm run fleet`. See [the release notes](../docs/releases/fleet/0.1.0.md) for what publishing
still requires.

The one packaging change since `0.1.0-rc1` matters more than it looks: the package now ships
compiled JavaScript in `dist/` with `bin` pointing at `dist/cli.js`. It previously shipped
TypeScript sources with `bin` pointing at `cli.ts`, and Node refuses to strip types from a file
under `node_modules`, so the package would have installed cleanly and failed on its first command.

### Changed

- Ship `dist/*.js` instead of `*.ts`, so the installed package runs. `bin` now points at
  `dist/cli.js`; `files` now ships `dist/`.
- The package description names what Fleet actually does. It said "Phase 0, no dispatch" long
  after dispatch, routing, reconciliation, event mirroring and the metrics rollup had landed, and
  that string is what npm renders on the package page.

## [0.1.0-rc1] - 2026-09-06

Recorded here as a version but **never published**: `@aywengo/mercury-fleet`
is not on the npm registry (404), there is no `fleet-v0.1.0-rc1` tag and no GitHub Release for it, so
`npm install -g @aywengo/mercury-fleet` does not work. Fleet can only be run from a source checkout
(`npm run fleet`). See [`../docs/releases/fleet/0.1.0-rc1.md`](../docs/releases/fleet/0.1.0-rc1.md).

### Added

- Host registry and probe (`fleet hosts`, `fleet probe --watch`).
- `fleet serve` HTTP API and systemd unit.
- Credential file (mode `0600`); names travel on the command line, never secrets.
- `GET /healthz` reports `{ ok, ts, product: "fleet", version }`.
- `fleet --version` prints `mercury-fleet <version>`.
- Run dispatch: submission records a binding that survives the process that made it, and the same
  client token never produces a second child Run.
- The reconciliation sweep. A child Fleet cannot reach yields `UNKNOWN`, never `FAILED`.
- Event mirroring, metadata-only by default, with paging that resumes where it stopped.
- Routing across registered hosts, and forwarding of input, cancel and retry.
- `GET /metrics`, a Prometheus rollup that merges hosts into one HELP/TYPE block per metric.

### Not included

- Moving a Run between hosts. One Run, one host, for life.
- `mercuryctl` (separate, unreleased product).

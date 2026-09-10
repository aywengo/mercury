# Changelog

All notable changes to **Mercury Fleet** are recorded here. The host product
has its own [`../CHANGELOG.md`](../CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-10

First published Fleet release. `0.1.0` is on the npm registry and the `latest` dist-tag points
at it, so `npm install -g @aywengo/mercury-fleet` installs a real Fleet release. It was published
by the `fleet-v0.1.0` tag through GitHub Actions trusted publishing, with no repository secret,
and carries SLSA v1 provenance bound to that tag and commit. See
[the release notes](../docs/releases/fleet/0.1.0.md).

`latest` used to point at `0.0.1-bootstrap`, a throwaway version published once to create the
package page that trusted publishing requires before any tag can publish. That placeholder is
still on the registry under its own `bootstrap` tag and is not a release. Note that
`fleet --version` prints a compiled constant rather than reading `package.json`, so it reports
`0.1.0` even when the placeholder is what actually got installed; pin a version if that matters.

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

Recorded here as a version but **never published**: `0.1.0-rc1` is not on the
npm registry, there is no `fleet-v0.1.0-rc1` tag and no GitHub Release for it. A bare
`npm install -g @aywengo/mercury-fleet` does not install this version either -- it resolves `latest`,
which currently points at the `0.0.1-bootstrap` placeholder that created the package page, not at any
Fleet release. Fleet runs from a source checkout (`npm run fleet`). See [`../docs/releases/fleet/0.1.0-rc1.md`](../docs/releases/fleet/0.1.0-rc1.md).

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

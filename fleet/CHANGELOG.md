# Changelog

All notable changes to **Mercury Fleet** are recorded here. The host product
has its own [`../CHANGELOG.md`](../CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-rc1] - 2026-09-06

Fleet Phase 0, recorded here as a version but **never published**: `@aywengo/mercury-fleet`
is not on the npm registry (404), there is no `fleet-v0.1.0-rc1` tag and no GitHub Release for it, so
`npm install -g @aywengo/mercury-fleet` does not work. Fleet can only be run from a source checkout
(`npm run fleet`). See [`../docs/releases/fleet/0.1.0-rc1.md`](../docs/releases/fleet/0.1.0-rc1.md).

### Added

- Host registry and probe (`fleet hosts`, `fleet probe --watch`).
- `fleet serve` HTTP API and systemd unit.
- Credential file (mode `0600`); names travel on the command line, never secrets.
- `GET /healthz` reports `{ ok, ts, product: "fleet", version }`.
- `fleet --version` prints `mercury-fleet <version>`.

### Not included

- Dispatch: Fleet cannot start a Run or move Runs between hosts.
- `mercuryctl` (separate, unreleased product).

# Changelog

All notable changes to **Mercury Fleet** are recorded here. The host product
has its own [`../CHANGELOG.md`](../CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-05

First public Fleet release (Phase 0). Install from git or
`npm install -g @aywengo/mercury-fleet`.

### Added

- Host registry and probe (`fleet hosts`, `fleet probe --watch`).
- `fleet serve` HTTP API and systemd unit.
- Credential file (mode `0600`); names travel on the command line, never secrets.
- `GET /healthz` reports `{ ok, ts, product: "fleet", version }`.
- `fleet --version` prints `mercury-fleet <version>`.

### Not included

- Dispatch: Fleet cannot start a Run or move Runs between hosts.
- `mercuryctl` (separate, unreleased product).

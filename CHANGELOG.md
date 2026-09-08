# Changelog

All notable changes to the Mercury **host** (API, worker, dashboard, adapters)
are recorded here. Fleet has its own [`fleet/CHANGELOG.md`](fleet/CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-rc2] - 2026-09-08

**Release candidate, and a release-path test.** The source is **identical to 0.1.0-rc1** -- `[Unreleased]`
was empty when this was cut, so there are no user-visible changes here and none are claimed.

This exists to exercise the release path end to end for the first time. Every release before this one
published to npm by hand or failed before submitting, so the tag-triggered workflow had never completed a
submission. `0.1.0-rc2` goes to the npm dist-tag **`rc`**, so `latest` is untouched and nothing about
"what is stable" changes:

```bash
npm install -g @aywengo/mercury@rc     # 0.1.0-rc2
npm install -g @aywengo/mercury        # unchanged by this release
```

The release stages rather than publishes: `npm stage publish` defers proof-of-presence, so the version
appears under **Published packages -> Staged packages** on npmjs.com and must be approved there before it
is installable. That approval step is part of what this release is testing.

## [0.1.0-rc1] - 2026-09-06

First public host release, as a release candidate. Published to the npm dist-tag **`rc`**
(`npm install -g @aywengo/mercury@rc`), not `latest`. Install from a git checkout also
works, as does Homebrew: `brew tap aywengo/mercury https://github.com/aywengo/mercury`
then `brew install mercury-ai` (the formula is `mercury-ai` because homebrew-core already
owns `mercury`, which is a different project).

### Added

- Durable Runs: Express API, separate worker, SQLite WAL queue and leases.
- Isolated git-worktree workspaces and optional Docker/Podman sandboxing.
- Structured events with resumable SSE, cancellation, retry, and human input.
- Static operations dashboard.
- Adapters: `fake` (create-Run default), PrimeAgent RPC, Hermes, Claude Code,
  plus declarative local, RPC, and remote registries.
- `mercuryctl`, the remote operator client, shipped in the same package as the host
  (`bin.mercuryctl`). Runs over the public HTTP API: `agents`, `runs list/show/create/events/
  watch/input/cancel/retry`, `config`, shell completion. No separate install and no version of
  its own -- it is versioned with the host.
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
- OIDC / SSO
- Fleet (separate product, `@aywengo/mercury-fleet`)
- The `mercuryctl` terminal UI (Milestone 5); the `mercuryctl` CLI itself is included, see Added above

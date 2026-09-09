# Changelog

All notable changes to the Mercury **host** (API, worker, dashboard, adapters)
are recorded here. Fleet has its own [`fleet/CHANGELOG.md`](fleet/CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-08

First stable host release, and the release that moves the npm `latest` dist-tag onto a real version.

`0.1.0-rc1` was published to npm by hand without `--tag`, so npm applied `latest` to a prerelease and
`npm install -g @aywengo/mercury` has resolved to an RC ever since. npm refuses to delete `latest`
(400 Bad Request), so the only way to move it onto a real release is to publish one. This version does
that: the release workflow derives `dist_tag=latest` for a plain `X.Y.Z` and leaves prereleases on their
own tag. See issue #368 for the dist-tag history.

### Changes since 0.1.0-rc1

**Fix: concurrent first-open of a fresh database no longer fails to migrate exactly once (#285).**
`PRAGMA busy_timeout` does not cover the rollback-journal-to-WAL conversion: SQLite answers
`SQLITE_BUSY` for that one immediately, without consulting the busy handler. So N processes starting
together against a brand-new database file all attempted the same exclusive conversion and all but one
died at startup with `database is locked` -- which is exactly the API-plus-workers startup shape. The
WAL pragma is now retried until it converges. This is a user-visible behaviour change; the earlier
claim that 0.1.0 carried none was wrong.

Everything else since 0.1.0-rc1 is release tooling, CI, documentation and tests: the release workflow
now verifies the bundle digest before shipping a Homebrew formula that claims it (#427), and the
e2e harness, docs and test suites were extended. No other runtime behaviour changed.


## [0.1.0-rc2] - 2026-09-08

**Release candidate, and a release-path test.** This exists to exercise the release path end to end for
the first time. Every release before this one published to npm by hand or failed before submitting, so
the tag-triggered workflow had never completed a submission. `0.1.0-rc2` goes to the npm dist-tag
**`rc`**, so `latest` is untouched and nothing about "what is stable" changes:

```bash
npm install -g @aywengo/mercury@rc     # 0.1.0-rc2
npm install -g @aywengo/mercury        # unchanged by this release
```

The release stages rather than publishes: `npm stage publish` defers proof-of-presence, so the version
appears under **Published packages -> Staged packages** on npmjs.com and must be approved there before it
is installable. That approval step is part of what this release is testing.

> **Correction.** This entry originally read "the source is identical to 0.1.0-rc1 ... there are no
> user-visible changes here and none are claimed." That was false when it shipped: `fb1317e`
> (#285, concurrent first-open of a fresh database) landed between the two tags and is a user-visible
> fix. The published package and its npm-side notes cannot be amended, so the correction lives here.
> See the 0.1.0 entry for the change itself.

669527a7618f775e18c9316ed51340330943bd97

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

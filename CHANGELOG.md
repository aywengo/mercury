# Changelog

All notable changes to the Mercury **host** (API, worker, dashboard, adapters)
are recorded here. Fleet has its own [`fleet/CHANGELOG.md`](fleet/CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.1] - 2026-10-01

Patch release carrying the accumulated fixes from the first two weeks of the nightly self-development
loop plus the credential-profiles feature slice. The headline fix is for the nightly host itself:
**a Run whose agent dies on a provider error is now FAILED, not silently COMPLETED** — on the night of
2026-09-30 the host's model server was down and all 17 nightly Runs were recorded green with zero
output.

### Fixed

- **A zero-output agent turn no longer records a completed Run (#803, #804).** The PrimeAgent adapter
  tracks whether the session produced any substantive event — assistant text (excluding exactly the
  four synthetic `[agent] …` status lines the translator emits for compaction/auto-retry frames), a
  tool execution, an input dialog, or a goal report — and on `agent_end` with code 0 but no substance
  settles a failure whose message carries the provider's own error from
  `agent_end.messages[*].errorMessage`. `start()` and `resume()` share one event handler; the per-turn
  flag resets on resume. The worker records FAILED, so an outage reaches the morning digest instead of
  a green nothing.
- **Worktree builds from `localPath` when it is set (#791).** A workspace whose repository context
  points at a local path no longer re-clones the URL — removes a long-standing nightly flake class
  (#596).
- **Nightly e2e installs its own dependencies (#796).** A clean worktree without `node_modules` ran
  the suite against module-load failures and filed spurious defect issues; the e2e skill now runs
  `npm ci` when dependencies are absent.
- **E2E survives Docker 29's unhealthy-on-exit (#789, #790).** A container that exits before its first
  health probe is marked `unhealthy` with zero probes on Docker 29; the dead-service scenario uses a
  per-scenario startup check strategy so the intended death is not misreported.
- **Nightly example templates carry a `repository` (#785, #786).** Runs without one died at workspace
  setup on night one; the shipped example and its regression tests pin it down.

### Added

- **Credential profiles CP-2 (#784, #799).** The profile file schema at
  `${XDG_CONFIG_HOME}/mercury/credential-profiles.json` (mode 0600 gate), repository-id
  normalization, a strict loader that never prints values (malformed JSON, `git.httpsToken` and
  repository-entry errors are value-free; userinfo is redacted), and
  `mercury host credentials validate` with ok/FAIL lines and exit 1 on any FAIL.
- **Nightly loop implements feature requests (#800, #801).** A new rung 2 selects `enhancement`
  issues authored by @aywengo (or carrying a current `enhancement` label applied by @aywengo,
  timeline-verified like `nightly:ready`), ordered by priority then age, and runs them through the
  issue-fix-loop. Old rungs renumber (new unlabeled issues → 3, docs → proposals → 4).
- **Stale-claim reset (#800, #801).** The promised §4.3 reset is implemented: an `nightly:in-progress`
  claim whose label event predates the current night's local midnight is removed before selection, so
  a deadline-stopped Run no longer blocks its issue forever. Claim ownership is verified through the
  label timeline's final actor — GitHub's add-labels is idempotent, so the previously assumed
  422-already-exists race signal never fires.

### Changed

- **`nightly-next` gets feature-sized room (#800, #801).** The example task's cap goes 80 min → 4 h
  (five timeouts, including both credential-profile attempts; `notAfterAt` 06:00 still bounds every
  Run at the window edge) and its skills list grows to `issue-fix-loop`, `planning`, `implementation`,
  `testing`.
- **Owner-transfer for a removed bot's Runs (#760, #780)** and **`host bot status` clears partial view
  data when the API walk fails (#759, #782)**; the nightly blocking question rides on the issue body
  when the nightly identity owns it (#770, #778) and the nightly skills share one helper module
  (#769, #779).

## [0.2.0] - 2026-09-27

Minor release. Two headline additions: **dispatcher bots** (the host schedules agent Runs from a
cron config, with deadlines and single-flight), and the **knowledge system completed with Atlas
0.1.0** (harvest, replica, curation UI, and a second product on npm). Plus Crew presets, the
`mercury host` installer/lifecycle suite, the operator goal surface, and the nightly
self-development loop running on its own bot config.

### Added

- **Dispatcher bots (B0/B1, #728–#738).** A bot is one JSON config at
  `~/.config/mercury/bots/<alias>.json` listing scheduled tasks: a hand-rolled cron evaluator with
  fixed-offset timezones (#732, #752), derived idempotency keys so a retry replays to the same Run
  (#730, #751), config validation that refuses unknown keys with a did-you-mean hint and reserves
  `triggers`/`brain` for later phases (#733, #756), the scheduler process `mercury host bot run`
  (#735, #757), manual `dispatch`/`status` commands (#736, #758), per-alias systemd service
  install/uninstall (#737, #761), and the read-only `workspace-audit` skill for pre-GC audits
  (#734, #753).
- **`constraints.notAfter` on a Run (#731, #750).** An absolute deadline that counts queued time:
  a Run past it is never started, a running Run is stopped at it. Bot templates set it with
  `notAfterAt: "HH:MM"`, resolved on the fire's local date — the 06:00 nightly window.
- **The nightly self-development loop (N0–N1, #727–#742).** The machine identity
  `mercury-nightly` is documented with its credential boundary and the review-required ruleset
  (#727, #754); nightly labels + the trust rule live in the triage doc (#728, #755). Skills:
  deterministic ladder selection with origin-trust checks (#738, #762), the e2e skill — run the
  suite, dedupe by fingerprint, file-or-comment with trust restricted to the nightly identity
  (#739, #766; #764, #765), the `nightly-next` driver that takes the top rung and exits
  `finish`/`blocked` (#740, #767), the `nightly-report` digest — one GitHub issue per night under
  a 60k budget with Markdown sanitization and a single self-healing close rule (#741, #768), and
  the shipped bot config `deploy/nightly-bot.json.example` + the "Running the nightly bot"
  pre-first-night checklist in `docs/operations.md` (#742, #774).
- **Knowledge system finished and Atlas 0.1.0 released (A0–A6, #533–#712).** The Atlas service:
  notes with sequence-bearing replication, curation, a partial UNIQUE index backing the
  one-live-note-per-claim rule, a retention sweep, tombstoned deletion (#533–#537, #562–#571,
  #590). The host side: operator notes + a pusher that runs, the replica, the knowledge pack a
  Run is actually given (including Hermes via AGENTS.md and Claude Code via the pack),
  provenance-carrying pulls, repo-scope keys, harvest at finalize, decision-record parsing from
  `docs/decisions/`, checkout backfill, harness-memory import, and the pack named in the RPC
  prompt (#534–#548, #553–#567, #695–#698). Release plumbing for `@aywengo/mercury-atlas`:
  registry guards, systemd unit, backups, a containerized two-host e2e (#699–#702). Channel
  measurement for the claude adapter (#707, #711, #763).
- **Crew role presets (Phases 1–3 + Milestone A, #714–#747).** Built-in preset registry, Run
  resolution and snapshots, preset read API + the Roles dashboard + log/metric dimensions, the §8
  capability vocabulary enforced at Run creation, ceilings that can only narrow, skill-resolution
  semantics pinned (explicit `[]` means none, required-only keeps auto-selection), invalid
  CPU/memory/disk rejected before insert, and presets shipped as guidance (reviewer 1.1.0 uses
  the code-review severity scale).
- **The operator goal surface (#679–#681).** `mercuryctl runs goal`, `runs goal-cancel`,
  `create --goal`: the goal a Run serves is now settable and cancellable from the CLI.
- **`mercury host` installer and lifecycle (M1–M6, #628–#644).** `install.sh` +
  `mercury host install` with an installer CI matrix (Debian/Fedora containers, macOS), the
  `mercury host setup` wizard (probes before it prompts, muted token prompts, safe env charset,
  answers files that reject unknown keys, hand-set variables preserved on re-run, honest dry-run
  and root gate), a harness probe with per-adapter minimum versions, `mercury host service` +
  `mercury host doctor` (dials the LAN address behind a 0.0.0.0 bind), `mercury host
  status/upgrade/uninstall` + re-run guard with redacted diff, bats suite + checksum + install
  docs, and `/dev/tty` reading for every prompt (#651–#678).
- **Fleet knows more about hosts (#508–#510, #613, #615, #618).** API schema negotiation so an
  old host fails at registration, not at first use; Atlas project health via a reader token;
  hosts ranked by knowledge freshness without filtering on it; tool observability rendered in
  `mercuryctl agents` (#601–#603).

### Fixed

- **Skills execute from the Run's stored snapshot, not the live registry (#506).** A registry
  change between create and execute no longer alters a queued Run; unknown skill names in the
  snapshot are refused with a named error (#507, #520).
- **Workspace and git hardening (#509, #621, #703/#705).** Every git call is bounded and can no
  longer prompt; generated paths are excluded from Run git on every Run; the workspace base
  resolves to an absolute path; scp-form repository identities collapse dot segments (#558).
- **Adapters say what they can do (#519, #594, #599).** Capability summaries describe how a
  backend receives skills and goals; a harness that cannot be observed at tool level says so;
  `.mercury-context.json` is written by the claude adapter like the other three (#612).
- **Goals fixed across surfaces (goals 9, 13, 14; #481–#493).** Mid-run objective changes are
  recorded instead of dropped, the executing harness is named, "never attempted" is separable
  from "stopped short", the run list distinguishes both `unmet` kinds, and goal fields the agent
  cannot act on are refused at create.
- **Atlas fixes (#552, #559, #560, #564).** An admin retry no longer replays its own idempotency
  key; note provenance is carried into the replica; a retired note no longer swallows every later
  copy of its claim.

## [0.1.1] - 2026-09-11

Patch release. **Hermes could not execute a single Run in any published version**; this is the
first release in which the `hermes` adapter works, so `0.1.0` users who were told the backend
was available need it (#465).

### Added

- **The dashboard now has a favicon and brand marks (#429).** `ui/favicon.svg` and
  `ui/favicon.ico`, linked from both dashboard pages. Cosmetic; no behaviour change.

### Fixed

- **A Run can now carry zero skills, which is what lets a second harness run at all (#459).**
  `RunService.create()` treated an explicitly empty `skills` array as "unspecified" and fell
  through to automatic selection, whose fallback guarantees at least one skill. So every Run
  carried skill ids resolved from Mercury's own registry. PrimeAgent receives
  `--skill <workspace path>` and is unaffected; Hermes receives `-s <name>` and resolves it in
  its *own* installed-skill store, where none of those names exist and an unknown name is a
  fatal exit. Hermes therefore failed every Run in under a second with
  `Error: Unknown skill(s): ...` while `/api/agents` advertised it as available. An omitted
  `skills` still auto-selects and `null` still means omitted, so existing callers are
  unchanged.
- **`client/test/cli.test.ts` no longer reads the operator's real mercuryctl config (#458).**
  Test-only; no runtime effect.
- **`client/test/completion.test.ts` now enforces its own "no endpoint, no credential"
  premise (#463).** Test-only; no runtime effect.


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

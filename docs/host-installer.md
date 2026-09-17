# Mercury Host installer

Status: M0 (design), M1 (bootstrap skeleton) and M2 (harness probe) done; M3 (configuration wizard) next.

The Host installer is a bash wizard that takes a fresh macOS or Linux machine to a running Mercury host that reports to Fleet, with the locally installed harnesses detected, verified and enabled.

Harness scope for v1 is whatever has a shipped adapter in `src/adapters/` at the time: today PrimeAgent (`primeAgentAdapter.ts`), Hermes (`hermesAgentAdapter.ts`) and Claude Code (`claudeCodeAdapter.ts`). Codex CLI and Pi join the probe when their adapters land, not before; the installer never advertises a harness Mercury cannot run.

## 1. Design decisions

1. **Thin bash, thick `mercury`.** `install.sh` only bootstraps: detect OS/arch, satisfy prerequisites, install the pinned `@aywengo/mercury` version, then hand off to `mercury host setup`. Harness detection lives in the adapters (Node), built on the existing `versionProbe.ts`, and is exposed as `mercury host probe --json`; bash renders the wizard from that JSON. Duplicating "what a valid PrimeAgent install looks like" in bash and in the adapter is the same drift class as #444/#446/#447/#453 and the Hermes skill-namespace incident.
2. **Two distribution channels, one wizard.** `curl -fsSL …/install.sh | bash` for machines without Node, and `npx @aywengo/mercury host install` for machines that already have it. Both end in the same `mercury host setup`; `install.sh` is the only code that differs, and it contains nothing but bootstrap.
3. **macOS ships bash 3.2.** `install.sh` is written to bash 3.2: no associative arrays, no `mapfile`, no `${var,,}`. The installer must not require the thing it installs prerequisites for.
4. **Two modes, one code path.** Interactive wizard and `--non-interactive`, driven by an answers file or environment variables (`MERCURY_FLEET_URL`, `MERCURY_HOST_TOKEN`, `MERCURY_HARNESSES`, …). Fleet provisioning needs the second mode; if it is added later it diverges from the first.
5. **Idempotent re-run.** Running the installer on an already configured host reads the existing config, shows current state, and offers change / upgrade / uninstall. It never performs a fresh install over an existing one without confirmation.
6. **Pre-issued token; never on the command line or echoed.** The operator obtains a host token from Fleet beforehand. The installer accepts it via environment variable, stdin, or a no-echo prompt, and writes it with `umask 077`. The redacted summary shows only the token's presence and length. No enrollment-code exchange in v1.
7. **User-scoped only.** Everything lives under `$HOME` (launchd agent / systemd user unit, XDG config and data dirs). No root, no `/etc/mercury`, no system service. A system-wide mode can be added later without changing the wizard's questions.
8. **Reuse the host's existing configuration format; do not invent a wizard-owned one.** The host is environment-configured (`MERCURY_*`, `docs/configuration.md`), and the production units load it from an environment file (`deploy/README.md`: `EnvironmentFile=/etc/mercury/mercury.env`). The wizard writes the user-scoped equivalent, `${XDG_CONFIG_HOME:-~/.config}/mercury/mercury.env` (mode 0600), and the generated launchd agent / systemd user unit loads it exactly as the system units do. There is no second config file, no translation layer, and nothing the host reads that the wizard did not write in the host's own vocabulary. The client profile file `${XDG_CONFIG_HOME:-~/.config}/mercury/config.json` (`docs/cli-tui-design.md` §9) is a different product and is not touched.
9. **Detection is not installation.** The wizard detects harnesses and prints an install hint for missing ones. It does not install PrimeAgent, Hermes or Claude Code. Out of scope for v1.
10. **Written config is validated before it is trusted.** Every `MERCURY_*` name the wizard emits must exist in the documented variable table in `docs/configuration.md` (checked in CI, so the two cannot drift), and any declarative adapter config it writes passes the strict loader from #500 (`configSchema.ts`, `configKeys.ts`: recursive unknown-key rejection, "did you mean"). The wizard cannot produce a config the host would silently misread.

## 2. Milestones

Each milestone is one issue and one PR (issue-fix-loop). A milestone is done when its gate holds, not when its code merges.

### M0 — Design doc

This document. Done, apart from recording per-harness minimum versions from each adapter, which M2 needs and which belong in this file once read from the adapters.

Gate: doc merged; every question in section 3 has an answer or a written reason to defer. Met 2026-09-16.

### M1 — Bootstrap skeleton

`install.sh`:

- OS/arch detection: macOS and Linux, x64 and arm64. Alpine/musl is NOT rejected: Mercury has no native dependencies (`node:sqlite` is built into Node, `package.json` ships only `express`), so musl needs no prebuilt check. The earlier draft rejected Alpine for a missing `better-sqlite3` prebuilt; that rationale died when the database moved to `node:sqlite` (initial commit, `src/db/database.ts`).
- Prerequisite checks: `curl`, `git`, Node ≥ 22.18.0 (the `engines` floor, which also guarantees `node:sqlite`). No SQLite prebuilt check exists because there is nothing native to prebuild.
- Pinned package install with checksum verification, into the user's npm prefix (no `sudo`).
- Flags: `--dry-run`, `--yes`, `--version <v>`, `--non-interactive`.
- Structured log to `${XDG_STATE_HOME:-~/.local/state}/mercury/install.log`.
- `shellcheck` clean.
- `mercury host install` subcommand that performs the same post-bootstrap steps for the `npx` channel.

Gate: runs clean in a Docker matrix (Debian, Ubuntu, Fedora) and on macOS arm64 via both channels; `--dry-run` prints the exact action list and touches nothing. Met 2026-09-17: `install.sh` (bash 3.2, `shellcheck` clean, `--dry-run` touches nothing) and `mercury host install` (prereq checks, structured log, works on an unconfigured host) both land; the Docker matrix and the checksum-published-alongside-release half of the gate are M6 work (CI matrix + release signing), not M1.

### M2 — Harness probe — ✅ done

`mercury host probe --json` reports, for each harness with a shipped adapter: binary path, version, config path, auth/login state, and whether the version satisfies the adapter's declared minimum. The wizard renders a checklist:

- detected, enabled
- detected, too old (shown with the required version, cannot be enabled)
- missing (shown with an install hint)

The user toggles which detected harnesses to enable.

Gate: probe results agree with the adapters' own real-binary observations (the standard used for the Hermes v0.21.2 check); a deliberately downgraded harness is flagged, not enabled; a harness without an adapter does not appear at all.

**As built** (`src/host/probe.ts`, wired as `mercury host probe --json` before `loadConfig()`):

- Each shipped adapter declares `capabilities.minVersion` (the M0 remaining item): PrimeAgent `0.3.3` (the goals-matrix floor, docs/goals.md 13.2), Hermes `0.21.2` (the version the adapter was verified against), Claude Code `1.0.3` (the version the adapter was built against, docs/agent-adapters.md 8.2.1).
- Hermes and Claude adapters gained `detectVersion()` (bounded probe of the configured cmd, same `probeVersion` the PrimeAgent adapter already used); the default leading-dotted-number parser extracts `0.21.2` from `Hermes Agent v0.21.2 (…)` and `2.1.260` from `2.1.260 (Claude Code)`.
- Per-harness output: `binary`, `version`, `versionRaw`, `minVersion`, `status` (`ok`/`too-old`/`missing`/`unknown`), `configPath`, `configExists`, `auth` (`logged-in`/`not-logged-in`/`unknown`), `error`.
- Auth is a best-effort file signal that never EMITS secrets (it reports logged-in/not-logged-in only): PrimeAgent `~/.prime/agent/auth.json`, Hermes `~/.hermes/config.yaml` containing the `api_key:` key, Claude `~/.claude.json`.
- `fake` and declarative local agents are not host harnesses and never appear.
- Tests: `test/hostProbe.test.ts` (11 tests) — missing binary → `missing`, downgraded → `too-old`, floor satisfied → `ok`, no floor → `unknown`, env cmd override, no-config host, unknown flag rejected (first and after `--json`).

### M3 — Configuration wizard

Prompts: host name, data dir, workspace dir, GC retention, Fleet URL, host token, Atlas on/off, per-harness enable. Each answer maps to a documented `MERCURY_*` variable. Writes `mercury.env` atomically (temp file, validate, rename, 0600), prints a redacted summary.

Gate: an answers file fed to `--non-interactive` produces a byte-identical `mercury.env` to the interactive path with the same answers; an invalid answer, or a variable name not in `docs/configuration.md`, is rejected before anything is written.

### M4 — Service and verification

- launchd agent (`~/Library/LaunchAgents`) on macOS, systemd user unit (`~/.config/systemd/user`, with a `loginctl enable-linger` hint) on Linux, generated and enabled, both loading `mercury.env` the same way the units in `deploy/` do.
- `mercury host doctor`: healthz version check, Fleet reachability with the pre-issued token, one smoke Run per enabled harness using the real binary.

Gate: fresh VM → running host reporting to Fleet with at least one harness Run completed, with no manual steps beyond obtaining the token and running the installer.

### M5 — Lifecycle

- `--upgrade`: pin bump, `mercury.env` migration if a variable was renamed, service restart.
- `--uninstall`: removes package, service and `mercury.env`; prompts to keep or remove the data dir.
- Re-run on a configured host reads `mercury.env`, shows current state and the diff of any proposed change.

Gate: install vN → upgrade vN+1 → uninstall leaves nothing but the opted-in data dir; re-running on a configured host changes nothing without confirmation.

### M6 — Release hardening

- `bats` test suite for `install.sh`.
- CI matrix on every PR touching the installer or `mercury host` subcommands, including the `MERCURY_*`-name-vs-`docs/configuration.md` check.
- Script checksum (and signature, if a signing key exists by then) published alongside each release.
- Docs page with both one-liners and a `curl | bash` safety note (download, inspect, run).

Gate: someone who has not worked on the installer follows the docs only and reaches the M4 state.

## 3. Decisions log

All resolved 2026-09-16:

1. Distribution: both `curl | bash` and `npx` (decision 2).
2. Host token: pre-issued by Fleet (decision 6).
3. Harness scope: only harnesses with a shipped adapter — PrimeAgent, Hermes, Claude Code today.
4. Install scope: user-scoped only (decision 7).
5. Config file: reuse the host's existing environment-file format, user-scoped path (decision 8).

## 4. Non-goals for v1

- Native Windows (WSL is treated as Linux).
- System-wide / root install.
- Installing or upgrading harnesses.
- Fleet enrollment-code exchange (token is pre-issued).
- Harnesses without a shipped adapter (Codex CLI, Pi).
- A wizard-owned config format separate from `MERCURY_*`.
- Multi-host provisioning from one invocation (that is Fleet's job; the installer only has to be scriptable).

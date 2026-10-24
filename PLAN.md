# PLAN — Mercury issue tracker

The per-issue record for every filed issue set, grouped by workstream.
[`docs/status.md`](docs/status.md) is the one-page summary; each workstream's design doc
(linked per section) owns the reasoning. This file answers "which issues of that set are done,
and by which PR?".

## Rules

1. **Filing an issue set adds its rows here,** in the same PR or commit that files it: `open`
   state, PR `—`, under the workstream's section (create the section if it is new).
2. **The PR that closes an issue adds its row if the issue has none** (rule 1); it does NOT set
   the row `done`. The `plan-sync` workflow (on push to `main`) sets each closing issue's row to
   `done` with the merged PR's number, in one commit. This is what keeps two open PRs in one
   workstream from conflicting on adjacent rows. The `plan-tracker` job fails a pull request whose
   closing issues (`Closes #N` / `Fixes #N`) have no row here, unless the row is marked `untracked`.
3. **An issue closed without a PR** (a decision, a duplicate, a superseded proposal) has its row
   updated by whoever closes it: `done` (decided or answered) or `dropped` (not planned), PR `—`.
4. **States:** `open`, `in progress` (a PR is open), `done`, `dropped`, `untracked`. Nothing else.
   `untracked` means the issue is explicitly not part of a tracked set; the `plan-sync` workflow
   leaves it alone.
5. **One row per issue.** Titles may be shortened; the issue number is the key.

The procedure lives in [`.agents/skills/issue-fix-loop/SKILL.md`](.agents/skills/issue-fix-loop/SKILL.md)
(step 3); the PR-time check is `scripts/planTracker.ts` and the post-merge update is
`scripts/plan-sync.ts` (workflow `.github/workflows/plan-sync.yml`).

## Host installer

Record: [`docs/host-installer.md`](docs/host-installer.md)

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #628 | Host installer M1: bootstrap skeleton (install.sh + mercury host install) | done | #629 |
| #630 | M2: harness probe — mercury host probe --json with per-adapter minimum versions | done | #631 |
| #632 | M3: configuration wizard — mercury host setup writes mercury.env atomically | done | #633 |
| #634 | M4: service and verification — mercury host service + mercury host doctor | done | #635 |
| #636 | M5: lifecycle — mercury host status/upgrade/uninstall + re-run guard | done | #637 |
| #638 | M6: release hardening — bats suite, installer CI matrix, checksum, install docs | done | #639 |
| #929 | Host installer: the four "gate open" milestones (M1, M3, M4, M6) are verification work… | open | — |
| #1071 | host service install writes a host unit with no worker: a fresh host queues Runs forever | done | #1072 |
| #1074 | a fresh host cannot run: the service units drop the user bin from PATH, and nothing creates the data directory | in progress | — |
| #1029 | release: the formula push to main is refused by the ruleset, so every release leaves Homebrew… | done | #1046 |
| #1045 | release: a failed curl probe yields HTTP 000000 in the release notes (and the test stub hides it) | done | #1047 |

## Nightly self-development

Record: [`docs/nightly-self-development.md`](docs/nightly-self-development.md)

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #727 | Protect `main` and give the nightly host its own GitHub identity (N0-1) | done | #754 |
| #728 | Nightly labels and the trust rule in the triage doc (N0-2) | done | #755 |
| #738 | Deterministic ladder selection and trust check (N1-1) | done | #762 |
| #739 | `nightly-e2e` skill (N1-2) | done | #766 |
| #740 | `nightly-next` skill (N1-3) | done | #767 |
| #741 | `nightly-report` skill (N1-4) | done | #768 |
| #742 | Nightly bot config and first-night checklist (N1-5) | done | #774 |
| #860 | nightly: derive the review-cap hand-off from current-head findings, not every round | in progress | #966 |
| #881 | nightly: rung 4 files duplicate proposals; dedupe by source key before filing | done | #984 |
| #964 | nightly: report lists a one-night flake forever; the flake entry carries an absolute wo… | done | #1013 |
| #968 | nightly: resume PRs on the owner's changes-requested review, not only on Copilot findings | done | #969 |
| #980 | nightly: resume its own PRs when the required ci check is red, not only on reviews | in progress | #981 |
| #1020 | nightly: nothing notices a night with no report (host down 2026-10-19→20) | done | #1021 |
| #1023 | URGENT nightly host runs Mercury 0.2.0/0.2.1: stale skills; resume Runs commit but never push | done | — |
| #1024 | nightly: flag Runs that end with unpushed commits or without finish/blocked; report the loaded skill version | done | #1025 |
| #1026 | nightly: #1024 follow-ups from the #1025 round-2 review (scan budget, host-wide unpushed section, ledger temp race, doc drift) | open | — |
| #1001 | nightly: a claim whose Run ended with no PR and no comment is never released; rung 2 claims work with no ready signal | done | #1009 |

## Dispatcher bots

Record: [`docs/dispatcher-bot-design.md`](docs/dispatcher-bot-design.md)

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #729 | `parseTokens` truncates owners containing `:`; settle the bot owner-id form (B0-1) | done | #749 |
| #730 | Pin idempotency replay over HTTP (B0-2) | done | #751 |
| #731 | `constraints.notAfter`: an absolute deadline that counts queue time (B0-3) | done | #750 |
| #732 | Hand-rolled cron evaluator and derived idempotency keys (B0-4) | done | #752 |
| #733 | Bot config schema, credentials file and `host bot validate` (B0-5) | done | #756 |
| #734 | `workspace-audit` skill, run by hand (B0-6) | done | #753 |
| #735 | `host bot run`: the scheduler process (B1-1) | done | #757 |
| #736 | `host bot dispatch` and `host bot status` (B1-2) | done | #758 |
| #737 | Per-alias service install/uninstall (B1-3) | done | #761 |
| #906 | dispatcher B2-0: statusChangedAt on GET /api/runs (the trigger-matcher prerequisite) | done | #959 |
| #907 | dispatcher B2-1: trigger engine — matchers, one coalesced poll, cursor state; lift the… | open | — |
| #908 | dispatcher B2-2: trigger storm guards — includeBotRuns, chain depth, both cooldowns, AP… | open | — |
| #909 | dispatcher B2-3: the observer scope — a third posture in AuthContext, read-only across… | open | — |
| #912 | dispatcher B3: the LLM brain — LLMConnection, closed action vocabulary, budgets, script… | open | — |
| #915 | dispatcher B4: setup integration and hardening — host setup bots step, host doctor bots… | done | #1070 |

## Crew — Milestone A follow-ups

Record: [`docs/crew/roadmap.md`](docs/crew/roadmap.md)

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #720 | docs: roadmap and status claim Crew Milestone A complete while AC 7 and AC 8 are open (… | done | #726 |
| #721 | Enforce the role-presets §8 capability vocabulary at Run creation — AC 7 (Crew C-1) | done | #743 |
| #722 | Resume must carry the Role Preset like start does — AC 8 (Crew C-2) | done | #744 |
| #723 | Preset network/resource ceilings: bridge rejects narrowing, none lets defaults widen (C… | done | #745 |
| #724 | Skill resolution: code and role-presets §3.2 disagree — decide which moves (Crew C-4) | done | #746 |
| #725 | Reject invalid CPU, memory and disk values before Run insert, §3.3 (Crew C-5) | done | #747 |

## Crew — Workflow Templates and later phases

Record: [`docs/crew/roadmap.md`](docs/crew/roadmap.md)

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #808 | Crew Phase 8 W-1: Workflow Template schema and builtin registry (advisory mode) | done | #812 |
| #809 | Crew Phase 8 W-2: create one advisory Run from a template (snapshot-backed, determinist… | done | #842 |
| #810 | Crew Phase 8 W-3: workflows API and dashboard planned-steps view (advisory) | done | #934 |
| #875 | Crew Phase 4: per-run MCP foundation (bindings, policy registries, run-scoped redaction… | open | — |
| #870 | Crew Phase 5: reviewed read-only MCP — operator policy registries in use, enforced tool… | open | — |
| #873 | Crew Phase 6: read-only Git mirror — bounded sync, immutable commit dirs, atomic pointe… | open | — |
| #874 | Crew Phase 7: owner drafts and publishing — namespaced drafts, quotas, try-draft untrus… | open | — |
| #871 | Crew Phase 9: linear staged workflows — coordinator, commit handoff, run-completed gate… | open | — |
| #872 | Crew Phase 10: advanced gates and bounded loops — tests-pass and manual-approval gates,… | open | — |
| #868 | Crew Phase 11 CP-1: CI schema linting for builtin preset and workflow manifests (operat… | open | — |
| #869 | Crew Phase 11 CP-2: operator health endpoints, bounded-cardinality metrics, alerts, and… | open | — |

## Teams

Record: [`docs/crew/teams.md`](docs/crew/teams.md)

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #911 | Teams Phase 0: deliver per-Run persona capabilities (appendSystemPrompt, workspaceFiles… | open | — |
| #917 | Agent Templates Phase 2: manifest, fail-closed validation, owner-scoped template store… | open | — |
| #918 | Teams Phase 3: bounded mixed-harness stages with artifact handoff and a status cache th… | open | — |

## Credential profiles

Record: [`docs/credential-profiles-design.md`](docs/credential-profiles-design.md)

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #784 | Credential profiles CP-2: profile file schema, loader and `host credentials validate` (… | done | #799 |
| #807 | Credential profiles CP-3: resolve a profile per Run, refuse disallowed owners, creation… | done | #841 |
| #897 | Credential profiles CP-4: local adapter delivery — layered environment, isolated git/gh… | done | #977 |
| #898 | Credential profiles CP-5: workspace clone and fetch use the resolved profile, not the h… | open | — |
| #899 | Credential profiles CP-6: sandbox per-profile opt-in for profile credentials | open | — |
| #900 | Credential profiles CP-7: exact-value redaction of profile values, doctor checks, docs… | open | — |
| #954 | Credential profiles: the three §15 open questions are live — decide the no-profile defa… | open | — |
| #1035 | credentials validate: a placeholder owner id is accepted, and the profile then refuses every Run the bot creates | done | #1038 |

## Laya

Record: [`docs/laya-integration-design.md`](docs/laya-integration-design.md)

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #823 | Run-level `model`: API surface, persistence, retry, adapter context (P1-1) | done | #832 |
| #824 | Fleet: pin `model` pass-through (P1-5) | done | #833 |
| #825 | Laya client and scripted fake sidecar (L0-1) | done | #837 |
| #826 | Bot schema: `select` as a reserved key (L0-2) | done | #838 |
| #827 | Claude Code: honour `context.model`, declare `perRunModel` after measurement (P1-2) | done | #834 |
| #828 | PrimeAgent: per-Run model in RPC and daemon modes (P1-3) | done | #835 |
| #829 | Hermes: measure per-Run model support; declare only if real (P1-4) | done | #836 |
| #830 | `mercury doctor`: Laya line (L0-3) | done | #839 |
| #831 | Host installer: opt-in Laya sidecar (L0-4) | done | #840 |
| #845 | Laya sidecar: versioned venv directories instead of the in-place rebuild transaction (#… | done | #846 |
| #849 | runs: refuse a per-Run model value that starts with a dash | done | #850 |
| #851 | laya installer: label-agnostic launchd not-loaded check; bound the sweep to known data… | done | #862 |
| #852 | Laya sidecar: first real-host install and verification on the Mac Studio | open | — |
| #853 | Decide the "good selection" label rule before any shadow data exists (L1-0) | open | — |
| #854 | Server: optional `selection` record on `POST /api/runs` (L1-1) | done | #865 |
| #855 | Bot: candidate hard filter (pure) (L1-2) | done | #861 |
| #856 | Bot: the Laya question and the decision rule (pure) (L1-3) | done | #866 |
| #857 | Wire selection into both dispatch paths; lift the refusal for `shadow` (L1-4) | open | — |
| #955 | Laya: the five open §12 decisions beyond the L1-0 label rule have no issue — checkpoint… | open | — |
| #997 | Adapter resume: the resumed attempt settles on the PREVIOUS attempt's exit and drops its own output (hermes #829, claude #827) | done | #1011 |

## Fleet and bots

Record: [`docs/fleet-bots-design.md`](docs/fleet-bots-design.md)

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #970 | Fleet: per-host availability snapshot and a read-only view (FB0) | done | #978 |
| #971 | Fleet: owner-scoped, paged `GET /fleet/runs` (FB2a) | done | #982 |
| #972 | Fleet: availability-aware routing filter (FB1) | done | #1002 |
| #973 | Bots: `FleetSchedulerClient` and `api.via: "fleet"` (FB2b) | done | #1016 |
| #974 | End to end: a bot on host A dispatches through Fleet to host B (FB3) | open | — |

## Fleet tenancy

Record: [`docs/fleet-tenancy-design.md`](docs/fleet-tenancy-design.md)

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #884 | fleet: projects + project_members schema and ProjectStore | open | — |
| #885 | fleet: project admin routes and CLI (behaviour-inert) | open | — |
| #886 | fleet: tenancy visibility rule in visibleHosts (T1-1, the one behaviour change) | open | — |
| #887 | fleet: tenancy startup warning and per-caller project list (T1-2) | open | — |
| #888 | fleet: prove metrics and event scoping under tenancy (T1-3) | open | — |
| #889 | fleet: project reassignment and delete guards, lost-visibility report (T2-1) | open | — |
| #890 | fleet: fleet_runs.project_id bind-time snapshot, audit not authorization (T2-2) | open | — |
| #983 | fleet: record the per-project Atlas credential-namespace decision before T3 (§11.3) | open | — |

## A2A integration

Record: [`docs/a2a-design.md`](docs/a2a-design.md)

A2A is an edge protocol only (design §2): Mercury as an A2A server, then an A2A client
adapter; bots never talk to each other over A2A. Decisions settled 2026-10-18: server first,
HTTP+JSON/REST binding, official JS SDK under boundary rules (design §11). Milestone order
(design §13): **A0** → **A1** minimal server → **A2** streaming and listing → **A3** client
adapter → **A4** Fleet. A0 filed 2026-10-18; #986–#988 and #990 are done, and #989 follows
them. The SDK spike settled **handler-driven** (§11 decision 3): `@a2a-js/sdk@1.3.0` mounted
on Mercury's own Express app, so A1 can start.

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #986 | A2A SDK integration spike: pin @a2a-js/sdk, decide the integration shape, coupling test… | done | #1000 |
| #987 | Retry chains: link retries atomically and make "retry pending" durable (A0-2) | done | #995 |
| #988 | Server-stamped Run origin: a field no request body can set (A0-3) | done | #996 |
| #990 | Pure Run-chain → A2A TaskState mapping, exhaustive over RunStatus (A0-4) | done | #998 |
| #989 | Exposed-skill config, create-Run validation of every template, `host a2a validate` (A0-5) | open | — |
| #1030 | test: a2aServer section 6.6 blocking-bound test is timing-flaky and can block a release PR | done | #1039 |
| #1040 | nightly: a crashed model server still lets the Run claim an issue, so the night ends with 17 failed Runs and stale claims | done | #1041 |
| #1042 | nightly report: a model outage makes the digest say _none_ everywhere, so a lost night reads as a quiet one | done | #1043 |
| #1018 | nightly: rung 4 files nothing — the dedupe list walk caps at 10 pages (1000 items) and the repo has outgrown it | done | #1048 |
| #1010 | nightly: the rung-1 e2e gate is permanently permissive because MERCURY_API_URL/TOKEN are never provisioned | done | #1049 |
| #1051 | release: the workflow fails at checkout because the OPERATOR_PAT secret does not exist | done | #1052 |
| #1053 | nightly: the dedupe search quotes its queries, so a title or marker with punctuation is never matched | done | #1054 |

## Security follow-ups

Record: [`docs/status.md`](docs/status.md)

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #942 | security: GitHub revoked the nightly GH_TOKEN ('mercury-pat') after a PR-description le… | done | — |
| #944 | redactor: session transcripts and kernel-state snapshots store Run secrets unredacted | done | #965 |
| #976 | artifact redaction: sweep workspaces of runs the worker never finalized | open | — |
| #1060 | security: nightly Runs filed issues as the operator — the profile's token file held the operator's PAT, not the bot's (CP-4 was working; the tool shell had the Run's GH_CONFIG_DIR and GH_TOKEN) | done | #1061, #1062, #1063 |

## Release workflow

Record: [`docs/releasing.md`](docs/releasing.md)

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #994 | release: the npm notes section asserts an approval state it never observed | done | #1017 |

## Repository process

Record: [`PLAN.md`](PLAN.md) (rules above)

| Issue | Title | State | PR |
| --- | --- | --- | --- |
| #1004 | PLAN.md: move the closing-row update to a post-merge commit; open PRs conflict on adjacent rows | done | #1005 |
| #1007 | scratch: verify plan-sync marks a closing issue done (issue #1004 e2e) | done | #1008 |
| #1032 | migrate: schema_migrations can claim a version whose objects are missing, and every Run creation then returns 500 | done | #1034 |

## Host installer — milestone notes (historical)

The per-milestone notes kept before this file became the project-wide tracker.

### M1 — Bootstrap skeleton — DONE ✅ (PR #629, commit ca287f9, issue #628)
### M2 — Harness probe — DONE ✅ (PR #631, commit 5baf3c2, issue #630)
### M3 — Configuration wizard — DONE ✅ (PR #633, commit 25fa7ce, issue #632)

### M4 — Service and verification — DONE ✅ (PR #635, commit 0c6c90d, issue #634)
- mercury host service install|status|uninstall (src/host/service.ts)
  - macOS launchd plist + wrapper that sources mercury.env (launchd has no EnvironmentFile)
  - Linux systemd user unit with EnvironmentFile, systemctl --user enable --now, linger hint
  - Deterministic unit text; --dry-run writes nothing; absolute binary path (never PATH)
- mercury host doctor [--json] (src/host/doctor.ts)
  - healthz version check, Fleet reachability with the pre-issued token
  - one smoke Run per enabled harness (real API shape: run.status uppercase; throwaway
    git repo via ensureSmokeRepo; skipped checks don't fail the doctor)
- 24 tests (service 11, doctor 12, E2E 1); full suite 1210/1210
- Copilot (4 comments) + independent review (2 blocking: smokeRun API shape, smoke repo)
  + fix-check APPROVE addressed

### M5 — Lifecycle — DONE ✅ (PR #637, commit 7d5ef8c, issue #636)
- mercury host status (src/host/lifecycle.ts): read-only current state — configured?,
  env file, pinned version, harnesses, data dir, service presence (independent of env)
- mercury host upgrade --version <v> --yes: npm install -g @aywengo/mercury@<v>, record
  MERCURY_PINNED_VERSION atomically (temp + fsync + rename), restart service if present
  (launchctl kickstart with numeric uid / systemctl --user restart); --version required
- mercury host uninstall --yes [--keep-data|--remove-data]: forgiving service removal
  (like M4), removes env + package; keeps data dir by default, --remove-data deletes it
- Re-run guard: host setup on a configured host shows current state and refuses to
  overwrite without --yes (interactive or --non-interactive); --dry-run warns
- 16 lifecycle tests + 2 setup tests; full suite 1227/1227
- Copilot (8 comments) + independent review (F1-F9: uid interpolation, fsync, dirname,
  keep-data default, forgiving uninstall, --version required) + re-review APPROVE

### M6 — Release hardening — DONE ✅ (PR #639, commit b103368, issue #638)
- bats test suite for install.sh (test/install.bats, 21 tests): flag parsing, dry-run,
  platform/prerequisite gates, confirmation, npm hand-off, structured log, json_escape
- json_escape newline fix: awk splits on newlines so a newline in a log detail was
  emitted raw (invalid JSON); now re-emitted as \u000a (bash 3.2.57 + shellcheck clean)
- CI: host_installer path filter + host-installer job (bats + all host subcommand tests
  incl. MERCURY_*-vs-configuration.md check) wired into the ci aggregate; runs on
  installer-touching PRs even when docs-only
- Release: install.sh + sha256 published alongside each host release (notes + asset)
- Docs: Install section with both one-liners and the curl|bash safety note
- 21 bats + 1 releaseWorkflow test; full suite 1228/1228
- Copilot + independent review (P1: host_installer output undeclared, aggregate gated
  on skipped job; P2: checksum test) + re-review APPROVE

## Post-review fixes — in progress
- #648 — DONE ✅ (PR #652, f2d91ea): admin token written, all-skipped smoke is a doctor failure
- #647 — DONE ✅ (PR #653, 4630416): the wizard probes before it prompts; Copilot 3/3 addressed-or-waived
- #646 — DONE ✅ (PR #655, 0e82bce): prompt reads /dev/tty, never the script stream; 4 Copilot review rounds all addressed (open-detection, faithful bash -s pipe test, fd-2 leak, tty prompt); bats 25/25
- #654 — DONE ✅ (PR #656, ba5c56e): doctor fails on an explicit empty MERCURY_HARNESSES (mode-aware message), --allow-no-harnesses escape; Copilot round 1 fixed, round 2 approval, threads resolved
- #650 — DONE ✅ (PR #657, 535b888): claude auth signal (platform-aware tri-state), probeVersion `code` enum, idempotent launchctl (print->bootout->bootstrap), unlinkSync, docstring/unit agreement, pipefail; 8 Copilot rounds all addressed (2 lost-edit catches), 0 open threads at merge
- #649 §1 — DONE ✅ (PR #658, 88a66a6): muted-echo token prompts (admin + atlas), masked defaults, atlas re-run continuity; Copilot round 1 (incl. redraw leak) fixed, round 2 approval
- #649 §2 — DONE ✅ (PR #659, 0a023a0): answers files reject unknown keys (satisfies-pinned list, shared suggestionFor), non-object JSON rejected; Copilot 4 rounds, approval
- #649 §3 — DONE ✅ (PR #660, 6f51476): safe-charset gate [A-Za-z0-9._:/@+=,-] in validateAnswer + renderEnv (harness ids included); Copilot 3 rounds, approval
- #649 §4 — DONE ✅ (PR #661, 28faddc): honest dry-run, npm prefix fallback ($HOME/.local), root gate fail-closed, log trail; Copilot 10 rounds, approval
- #649 §5 — DONE ✅ (PR #662, 6e3a2dc): installer matrix — Ubuntu + debian:stable/fedora:latest containers (non-root ci user, runuser) + macOS (bash 3.2, service dry-run); Copilot 7 rounds, approval
- #649 §6 — DONE ✅ (PR #663, ec10fb1): re-run guard shows the redacted proposed diff; identical answers exit 0; M5 line flipped; Copilot 2 rounds, approval
- #649 — CLOSED ✅ with a close-out comment (all six bullets verified against the merged tree at ec10fb1; full suite green). Doc status sentence cleaned up in #664 (fa6b1d7).

## DONE (2026-09-20)
All host-installer issues (#645–#654, #649) are closed. Remaining M4/M6 gate work is verification only (fresh-VM run, checksum publishing), tracked in docs/host-installer.md milestone bullets.


## DONE (2026-09-20, second batch — #665/#666/#667)
- #665 CLOSED via PR #668 (squash 1eb09d0): wizard `bindHost` answer → `MERCURY_BIND_HOST` (omitted for loopback so config.ts keeps the default), honest hand-off (loopback → unreachable warning; exposed → real URL + TLS note), doctor `bindHealthzTarget` second check (loopback-equivalent + 0.0.0.0 skipped, case-insensitive). 6 Copilot rounds, all fixed.
- #666 CLOSED via PR #669 (squash 093ce34): install.sh and `mercury host install` exec `mercury host setup` with propagated flags; wizard exit code becomes the script's; `npm prefix -g` binary resolution when off PATH; hand-off rejections caught. 3 Copilot rounds, all fixed.
- #667 CLOSED via PR #670 (squash 821b188): M3 heading lists all landed work and stays gate-open per the done-when-the-gate-holds rule; status paragraph collapsed to two sentences; M1/M4/M6 headings attribute the fresh-VM run to M4. 4 Copilot rounds, all fixed.
- #671 CLOSED via PR #675 (squash 11ce4a1): the curl|bash hand-off redirects the wizard's stdin from /dev/tty (or refuses loudly without a terminal and without --non-interactive); setup.ts tries /dev/tty before the buffered-stdin fallback; bats cases prove refuse/propagate/pty-stdin. 2 Copilot rounds, all fixed.
- #672 CLOSED via PR #676 (squash 7a376a2): the Fleet hand-off block prints on every successful write; token line classifies unchanged vs rotated by comparing the pre-write token. 2 Copilot rounds, all fixed.
- #673 CLOSED via PR #677 (squash 622e441): a re-run preserves every hand-set variable the wizard does not own (charset-validated, named-not-valued in the summary; explicit empty values survive). 3 Copilot rounds, all fixed.
- #674 CLOSED via PR #678 (squash de83d6a): the doctor dials the first non-internal IPv4 behind a 0.0.0.0 bind (injectable interface lists keep tests deterministic; explicit SKIP on loopback-only hosts). 2 Copilot rounds, all fixed.
- Goal client surface CLOSED via PR #680 (squash 458089a): runs goal, runs goal-cancel (confirmed), runs create --goal; docs updated (status.md split, client.md, goals.md 13.6, design §6); goalSurface guard rewritten both-directions. 4 Copilot rounds, all fixed — round 2 caught the { goal } wrapper miss (untested 200 path), now covered by seeded-goal contract tests.
- Dispatcher bot design written directly to main (2b874b8): docs/dispatcher-bot-design.md (582 lines, status: design-only) + README index entry. CI green on main. Core decision: bot = loopback API client, never a new execution path; M0-B4 roadmap in §18.
- Dispatcher-bot decisions recorded on main (6dadbb8, rebased over two upstream review revisions ec035dd/ee2e398): hand-rolled cron DECIDED; observer scope DECIDED to ship in B2 — folded into upstream's revised §9 (observer is read-only, no cross-owner writes; escalation by dispatching own Runs) and §16/§19.
- Dispatcher-bot design self-review pass (c4f3e8d): verified my two decisions cohere with upstream's revised doc (brain in v1/B3, observer strictly read-only, UTC-default cron, B0 server-capability prerequisites); fixed one leftover "(new, small...)" label contradicting the honest sizing + B2 spacing.
- Atlas phases 5-6 (goal): 11 issues filed (#681-#692). Done+merged: A-0 #681->#693 (5e3e3d2), A5-5 #687->#694 (32ec6a9; row stays unverified, pi/omp absent), A5-1 #683->#695 (86320bd; 3 review rounds). A5-6 #688 blocked: Claude Code OAuth expired locally, stack verified end-to-end otherwise. A5-2 #684->#696 merged (73ff296, 5 review rounds). A5-3 #685->#697 MERGED dbfcde5 (4 review rounds + clean re-reviews: knowledge index CLI, index:/operator: key split, Atlas runless dedup asserted incl. host-b corroboration on hosts, §6.3 idempotency sentence corrected; gitTimeout guard forced runGit). A5-4 #686->#698 MERGED 9466899 (3 review rounds: harvestNative.ts added-paragraph import, distilled source, channel guards, base-side git error discipline, harvest log line, +6 tests mutation-checked). A6-1 #689->#699 MERGED cfb301f (atlas-v tag path + tarball smoke, three-product docs/tests, mutations checked). A6-2 #690->#700 MERGED 0bec85e (atlas.service+env+backup, systemd-analyze verified in container, restore+migrate round trip exercised). A6-3 #691->#701 MERGED fc3f83d (knowledge compose profile: init-atlas TLS one-shot + atlas service + host B stack; knowledge.test.ts two-host journey incl. K4 atlas-stop hold/drain; preflight testcontainers presence check; vacuity mutation observed). A6-4 #692->#702 MERGED 56d37fb (release notes with registry-driven unpublished preamble, changelog 0.1.0 entry, distribution/releasing/knowledge-base doc updates, five new Atlas registry guards in releaseDocs.test.ts; 8 Copilot rounds; atlas-v0.1.0 tag + npm publish remain the human bootstrap step). Remaining: #688 (A5-6) blocked on Claude auth.
- Final state: 0 open host-installer issues; all PRs merged; main = de83d6a.
- Final state: 0 open host-installer issues, 0 open PRs, main = 821b188, full suite green locally.

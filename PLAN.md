# PLAN — Host installer milestones

## M1 — Bootstrap skeleton — DONE ✅ (PR #629, commit ca287f9, issue #628)
## M2 — Harness probe — DONE ✅ (PR #631, commit 5baf3c2, issue #630)
## M3 — Configuration wizard — DONE ✅ (PR #633, commit 25fa7ce, issue #632)

## M4 — Service and verification — DONE ✅ (PR #635, commit 0c6c90d, issue #634)
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

## M5 — Lifecycle — DONE ✅ (PR #637, commit 7d5ef8c, issue #636)
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

## M6 — Release hardening — DONE ✅ (PR #639, commit b103368, issue #638)
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
- Atlas phases 5-6 (goal): 11 issues filed (#681-#692). Done+merged: A-0 #681->#693 (5e3e3d2), A5-5 #687->#694 (32ec6a9; row stays unverified, pi/omp absent), A5-1 #683->#695 (86320bd; 3 review rounds). A5-6 #688 blocked: Claude Code OAuth expired locally, stack verified end-to-end otherwise. A5-2 #684->#696 merged (73ff296, 5 review rounds). A5-3 #685->#697 MERGED dbfcde5 (4 review rounds + clean re-reviews: knowledge index CLI, index:/operator: key split, Atlas runless dedup asserted incl. host-b corroboration on hosts, §6.3 idempotency sentence corrected; gitTimeout guard forced runGit). A5-4 #686->#698 open (a8796bc: harvestNative.ts added-paragraph import, distilled source, channel guards, +6 tests mutation-checked; round-1 remarks addressed). Remaining: #698 merge round, #689-#692 (A6-1..A6-4).
- Final state: 0 open host-installer issues; all PRs merged; main = de83d6a.
- Final state: 0 open host-installer issues, 0 open PRs, main = 821b188, full suite green locally.

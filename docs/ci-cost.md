# CI cost control — GitHub Actions

**Status:** the repo is **public** (verified 2026-09-04: `private: false`), which is the change that
removes the bill. The config changes in [Reducing usage](#reducing-usage) are optional once the repo
is public, and remain the plan of record if it ever goes private again. Everything under
[Measured baseline](#measured-baseline) is measured from this repo's own workflow runs, not estimated.

## Why it stopped working

CI did not fail on code. All three jobs failed with:

> The job was not started because recent account payments have failed or your spending limit
> needs to be increased.

The jobs executed **zero steps** and died after ~2 seconds, so a red check told you nothing about the
code. Confirming that distinction is the first diagnostic, not an afterthought: check the job's
`started_at`/`completed_at` and its annotations before believing a red CI result.

The account was on the personal free plan with a **private** repository. Private repositories meter
Actions minutes against a monthly allowance; the allowance was exhausted and the spending limit was
then hit.

## Measured baseline

From 100 completed runs of this repo's own CI, using each job's `started_at`/`completed_at`
(billed minutes are the **sum across jobs**, not the run's wall-clock, so a 3-job run bills roughly
three times what the run page suggests):

| item | value |
| --- | --- |
| billed job-minutes per CI run | **11.2** (node 24.x ~4.9, node 23.6.0 ~5.1, uninstalled guard ~1.1) |
| CI runs in the sampled window | 79 (56 `pull_request` + 23 `push`) |
| Copilot code-review runs | 21, ~3.2 min each |
| total | **~950 min** against a 2,000 min/month private allowance |

Roughly a month's allowance was being consumed in a window of hours.

## The fix that matters: make the repository public

GitHub provides **unlimited free Linux runner minutes for public repositories**. This repo's CI uses
only `ubuntu-latest`, so going public takes the Actions bill to zero with no workflow change.

```bash
# Settings -> General -> Danger Zone -> Change repository visibility
# or verify the current state:
gh api repos/aywengo/mercury --jq '{private, visibility}'
```

**What still costs money on a public repository** — going public is not a blanket zero:

- **macOS and Windows runners** still bill, at a multiplier. Adding a macOS matrix leg to this CI would
  reintroduce a bill.
- **Artifact storage** is billed by size-month even for public repos. This CI uploads no artifacts, so
  it is at zero; keep it that way, or set `retention-days` on anything you add.
- **Larger runners** (bigger VM sizes) bill per minute.
- **Copilot code review** may consume Copilot premium requests, which is a separate meter from Actions
  minutes. Verify its billing rather than assuming the public-repo exemption covers it.

## Verify the fix actually took effect

A visibility change does not retroactively re-run failed checks, and the old failures stay red. Prove
CI executes rather than assuming it:

```bash
# Re-run the most recent failed run on main and watch it actually start.
gh run list --repo aywengo/mercury --limit 3
gh run rerun <RUN_ID> --repo aywengo/mercury
gh run watch <RUN_ID> --repo aywengo/mercury
```

**The signal that worked:** the run moved to `in_progress` and stayed there, instead of failing in ~2
seconds with zero steps. A job that starts and keeps running is the proof; a green check later is only
confirmation.

**Verified result (2026-09-04, run 33856646177, attempt 2, on `main`):**

| job | conclusion | minutes | steps executed |
| --- | --- | --- | --- |
| `uninstalled-checkout-fails-clearly` | success | 0.8 | 7 |
| `test (node 24.x)` | success | 1.2 | 9 |
| `test (node 23.6.0)` | success | 1.3 | 9 |

Step counts matter: a job that never started reports zero steps, so "success with 9 steps" is the
evidence that the runner really executed. This run billed 3.3 job-minutes rather than the 11.2 average,
because `setup-node`'s npm cache was already warm — the average is the planning number, not this run.

This also closed a real gap: PR #215 was merged while CI could not run, with that stated in its merge
note. This re-run is the first CI validation of that merge commit, and it passes.

## Reducing usage

Optional while public. Each item is ordered by saving, with the measured cost it removes.

### 1. Cut the Node matrix from two versions to one (~45% of CI cost)

`ci.yml` tests `23.6.0` and `24.x`. `23.6.0` is an **odd-numbered, non-LTS release that reached
end-of-life in June 2025**. The in-file justification — that `node:sqlite` only became usable around
23.6 — was correct when written, but if the project does not actually support 23.x, every run pays
~5 minutes to test a version nobody uses.

- If 24 LTS is the real floor: set `engines.node` to `>=24` in `package.json`, reduce the matrix to
  `['24.x']`, and update the `ci.yml` comment that explains the floor so it does not keep arguing for a
  version the file no longer tests.
- If you genuinely want the floor guard: keep it, but run it only on `main` so it costs nothing per PR:

  ```yaml
  jobs:
    test:
      if: github.event_name != 'pull_request' || matrix.node-version != '23.6.0'
  ```

### 2. Stop the duplicate run on merge (~29% of runs)

The workflow triggers on both `push: [main]` and `pull_request: [main]`, so every merge re-runs the
full matrix on code the PR already validated. In the sample, 23 of 79 CI runs were post-merge
duplicates.

```yaml
on:
  pull_request:
    branches: [main]
  schedule:
    - cron: '30 4 * * 1'   # weekly sanity pass on main, instead of every merge
```

Trade-off: `main` is no longer verified on every commit. If that matters more than the minutes, keep
`push` and drop the matrix to one version instead — do not do both.

### 3. Skip CI for documentation-only changes

This repo has many docs-only changes, and each one currently costs a full 11.2-minute run.

```yaml
on:
  pull_request:
    branches: [main]
    paths-ignore: ['**/*.md', 'docs/**']
```

**Caveat:** with `paths-ignore`, a docs-only PR produces no check on the head commit. That is fine while
checks are advisory, but if you ever enable branch protection with required checks, a docs-only PR will
have no check to satisfy and will not be mergeable. Either add a trivial always-run job as the required
check, or drop `paths-ignore` at that point.

### 4. Bound every job — the real tail risk

No job currently declares `timeout-minutes`, so a hung job can burn up to the 360-minute platform
maximum. The suite takes about 5 minutes.

```yaml
jobs:
  test:
    timeout-minutes: 15
```

This is the same rule `AGENTS.md` already states for shell commands: a hung command is indistinguishable
from a slow one, and an unbounded wait has cost more here than any actual bug in the repository.

### 5. Skip draft PRs

```yaml
jobs:
  test:
    if: github.event_name != 'pull_request' || github.event.pull_request.draft == false
```

### 6. Gate the Copilot code reviewer

21 runs in the sampled window. It fires on every PR. Consider requiring a label so it runs when asked
rather than always — and check whether it bills through Copilot premium requests rather than Actions
minutes, since the public-repo exemption does not obviously cover that.

## Alternative: a self-hosted runner

Linux self-hosted runners are free on **every** plan, including private repositories, so this is the
option if the repo must go private again. It buys minutes with your own hardware instead of money.

```bash
gh repo clone aywengo/mercury /opt/actions-runner -- --quiet 2>/dev/null || true
# Register through the UI (Settings -> Actions -> Runners -> New self-hosted runner), then:
cd /opt/actions-runner && ./run.sh
```

Run the job in a container so the runner environment stays reproducible, and treat these as hard
constraints:

- The runner holds repository secrets and runs with your credentials. It executes whatever is in a
  workflow. **Only ever use it on repositories you control**, and never on a repo that accepts
  forked-pull-request workflows — `pull_request_target` plus an untrusted PR plus a self-hosted runner
  is a credential-theft path.
- It only runs while the machine is up, so a stopped laptop silently means no CI.
- It competes for CPU with the work already on that machine.

## Not worth optimizing

- **`npm ci`.** Four dependencies, and `actions/setup-node` already caches them. The file's reason for
  using `npm ci` over `npm install` — failing loudly when `package.json` and the lockfile drift — is
  worth far more than the seconds it costs.
- **The `uninstalled-checkout-fails-clearly` job.** ~1.1 minutes, and it is the only thing that verifies
  a fresh clone behaves sanely. Its comment explains that if it ever goes red because `npm test`
  *passed*, the guard has gone vacuous. Cheap and load-bearing.

## Monitoring

```bash
# Minutes this account has consumed (needs a billing-scoped token, org/user endpoint differs).
gh api -H "Accept: application/vnd.github+json" /users/aywengo/packages 2>/dev/null | head -1

# Cheap proxy that always works: how much CI is running, and how long each run bills.
gh api 'repos/aywengo/mercury/actions/runs?per_page=30' \
  --jq '[.workflow_runs[] | select(.status=="completed") | {name, event, conclusion}] | group_by(.name) | map({name: .[0].name, runs: length})'
```

Set a spending limit to 0 in **Settings -> Billing -> Spending limit** if you want a hard stop rather
than a surprise. On a public repo with Linux-only CI this should never trip.

## Checklist

- [x] Repository is public — `gh api repos/aywengo/mercury --jq '.visibility'` returns `public`
- [x] A previously-failed run re-executes instead of dying in ~2 s with zero steps
- [ ] No macOS/Windows matrix legs added
- [ ] No artifacts uploaded, or `retention-days` set on anything added
- [ ] `timeout-minutes` set on every job
- [ ] Copilot reviewer billing model confirmed
- [ ] Node matrix decision made deliberately, and the `ci.yml` comment updated to match whatever is
  chosen (a comment arguing for a version the file no longer tests is a defect)

## Related

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — the workflow this document is about.
  Its comments carry the reasoning for each guard; read them before deleting anything.
- [`../AGENTS.md`](../AGENTS.md) *Bounded command execution* — the same principle applied to jobs.

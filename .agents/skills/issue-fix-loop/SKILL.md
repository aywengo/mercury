---
name: issue-fix-loop
version: 1.1.0
description: Fix a tracked issue through the proven per-issue loop — root-cause analysis, scoped fix with regression test, one PR, independent sub-agent review, merge. Use when fixing a GitHub issue or any bug tracked as a unit of work.
capabilities: [bugfix, issue, pull-request, review, workflow, regression]
---

# Issue Fix Loop

The unit of work is one issue. One issue gets one PR. Everything a review
surfaces that is not this fix becomes a new tracked issue, never scope
creep in the current PR.

Work issues in priority order (`priority: high` -> `medium` -> `low`;
security-tagged issues first within a tier).

Priority is a tie-breaker, not a schedule. Dependency order beats priority
order: a fix that other fixes depend on goes first even when it ranks lower
in severity or lacks a `security` tag. Before starting, check whether the
repo tracks a dependency/remediation issue and follow its order over
severity order; when a dependency is not recorded anywhere, add it to the
issue as a `blocked by` note rather than leaving it in prose.

## The loop

1. **Analyze** — confirm the root cause before touching code. Read the
   failing path end to end and state the mechanism, not the symptom.
   Identify an existing test to model the regression test on.
2. **Implement** — fix the root cause at the correct choke point (the
   single write/read path, not every caller). Add a regression test and
   verify it fails without the fix. Run typecheck, the focused suite,
   then the full suite; record the pass counts.
3. **Open a PR** — branch `fix/issue-<N>-<slug>`, description links the
   issue with `Fixes #N`. Keep the diff scoped to the issue.
4. **Independent review** — have a separate reviewer (sub-agent, Copilot,
   or second model) review the PR. Classify findings as blocking vs
   non-blocking.
5. **Address comments** — for each finding:
   - Fix it if feasible and worth fixing.
   - Waive it if risky, cosmetic, or unrelated — and say why.
   - File a new issue for anything that deserves tracking.
   - Repeat review until all comments are addressed.
6. **Merge** — merge, close the issue, record the closing PR/commit.

Then pick up the next open issue by priority, after the dependency check
above.

## Rules of thumb

- One issue -> one PR. Unrelated work -> new issue.
- Dependency order beats priority order. Confirm the base your fix relies on
  is already merged; a guard added on top of an unfixed prerequisite is
  unreliable even when it reads correct and passes its own test.
- A regression test must be proven: it fails on the base, passes on the fix.
- Fix at the single choke point so future callers cannot bypass it.
- Waived findings need a one-line reason; do not silently drop them.
- Review findings are an issue source: each accepted-but-deferred finding
  gets its own issue with priority and a short write-up.
- Keep a progress log: date, issue, step, outcome (including commit SHA
  and test counts) so the trail is auditable.
- Pre-existing flakes are identified as such (observed on base too) and
  not fixed inside a scoped PR.

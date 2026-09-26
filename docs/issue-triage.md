# Mercury — Issue Triage & Fix Methodology

> The proven triage and per-issue fix methodology, distilled from the
> August 2026 mercury triage (22 issues closed end-to-end). Canonical
> full version:
> [`.agents/skills/issue-fix-loop/SKILL.md`](../.agents/skills/issue-fix-loop/SKILL.md).

## Triage

Label every issue before fixing it:

| Label | Meaning |
|-------|---------|
| `priority: high` | Fix soon — blocks core behavior or is security-relevant |
| `priority: medium` | Should fix; ops/audit/security edge cases |
| `priority: low` | Nice to have; edge cases, docs, cleanup |
| `security` | Security-relevant (fail-closed, redaction, cross-owner) |
| `bug` / `enhancement` / `documentation` | Issue type |
| `good first issue` | Small, well-scoped, good for onboarding |

- Work issues in priority order — security first within a tier.
- Dependency order beats priority order: a fix that other fixes depend on
  goes first, and the base a fix relies on must already be merged.

## Nightly

The unattended nightly loop specified in
[`nightly-self-development.md`](nightly-self-development.md) — designed, not
running yet — defines five labels on top of the table above:

| Label | Meaning |
|-------|---------|
| `origin:e2e` | Filed by the nightly E2E harness from a real, reproduced failure |
| `nightly:ready` | Approved for an unattended agent to pick up |
| `nightly:in-progress` | A nightly agent is working on it right now |
| `nightly:blocked` | The agent needs input it cannot invent; the question is in a comment |
| `nightly:proposed` | Drafted by an agent; awaits an operator's relabel to `nightly:ready` |

**The trust rule** (§5 of `nightly-self-development.md`): a nightly agent
will consider
an issue only if

- it is authored by @aywengo, or
- it was filed by the nightly identity `mercury-nightly` from E2E — the issue's
  author is `mercury-nightly` (the identity documented in
  [`operations.md`](operations.md)) AND the current `origin:e2e` label was
  applied by that same identity (checked through the label timeline), or
- it was labeled `nightly:ready` by @aywengo.

The check reads the API's author field and label-event actor fields — never
the agent reading issue text, which is untrusted input. Enforcement lives in
the nightly selection helper (`.agents/skills/nightly/select.ts`, issue #738,
N1-1; the E2E authorship half is #764), which implements the rule as code
against the GitHub API. An issue that fails the check is invisible to the
ladder, whatever its text promises.

## Fix procedure (per issue)

1. **Analyze** — confirm the root cause before touching code. Read the
   failing path end to end and state the mechanism, not the symptom.
   Identify an existing test to model the regression test on.
2. **Implement** — fix the root cause at the single choke point (the one
   write/read path, not every caller). Add a regression test and prove it:
   it fails on the base, passes on the fix. Run typecheck, the focused
   suite, then the full suite; record the pass counts.
3. **Open a PR** — one PR per issue; branch `fix/issue-<N>-<slug>`,
   description links the issue with `Fixes #N`. Keep the diff scoped to
   the issue.
4. **Independent review** — a separate reviewer (sub-agent or second
   model) reviews the PR. Classify findings as blocking vs non-blocking.
5. **Address comments** — for each finding:
   - Fix it if feasible and worth fixing.
   - Waive it if risky or unrelated — with a one-line reason, never
     silently.
   - File a **new issue** for anything that deserves tracking.
   - Repeat review until all comments are addressed.
6. **Merge** — merge, close the issue, record the closing PR/commit.

Then pick up the next open issue in priority order.

## Rules of thumb

- One issue → one PR. If a review surfaces unrelated work, file a new
  issue instead of expanding the PR.
- Waived findings need a one-line reason; do not silently drop them.
- Review findings are an issue source: each accepted-but-deferred finding
  gets its own issue with priority and a short write-up.
- Pre-existing flakes are identified as such (observed on base too) and
  not fixed inside a scoped PR.
- Keep a progress log: date, issue, step, outcome (including commit SHA
  and test counts) so the trail is auditable.

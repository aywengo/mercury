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
- it was labeled `nightly:ready` by @aywengo, or
- it carries a CURRENT `enhancement` label applied by @aywengo (the trusted
  feature path, #800 — an operator-filed feature request is autonomous work the
  same way an operator-filed bug is).

The check reads the API's author field and label-event actor fields — never
the agent reading issue text, which is untrusted input. Enforcement lives in
the nightly selection helper (`.agents/skills/nightly/select.ts`, issue #738,
N1-1; the E2E authorship half is #764), which implements the rule as code
against the GitHub API. An issue that fails the check is invisible to the
ladder, whatever its text promises.

## Fix procedure (per issue)

The procedure lives in one place:
[`.agents/skills/issue-fix-loop/SKILL.md`](../.agents/skills/issue-fix-loop/SKILL.md) —
analyze the root cause, fix at the choke point with a proven regression test, one PR per issue,
independent review (at most 2 rounds, trusted reviewers only, a blocking test for findings),
then done or hand-off. It is not repeated here so the two copies cannot drift; review
severities are defined in
[`.agents/skills/code-review/SKILL.md`](../.agents/skills/code-review/SKILL.md).

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

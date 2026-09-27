---
name: code-review
version: 1.1.0
description: Review code changes for correctness, quality and adherence to conventions.
capabilities: [review, quality, refactoring]
---

# Code Review

Review the diff for:

- correctness and edge cases within the change's stated scope
- adherence to repository conventions
- dead code, duplication, obvious performance issues
- missing or broken tests

Do not rewrite the change unless asked.

## Severity scale (the one scale for every reviewer)

| Severity | Meaning | Blocks merge? |
| --- | --- | --- |
| `blocker` | Wrong behavior reachable within the change's scope, a security issue, or a failing test/typecheck | yes |
| `major` | Real defect outside the stated scope, or a missing test for changed behavior | no — fix or file an issue |
| `minor` | Style, naming, comments, docs wording, hypothetical edge cases | no — optional |

Mapping for other tools: "blocking" = `blocker`; "non-blocking" = `major`/`minor`.
Copilot severities are advisory: a Copilot "high" is a `blocker` only when it passes the
`blocker` definition above.

## Rules

- Review what the change touched. A finding on unchanged code is at most `major`, unless it is
  a `blocker` the change makes reachable.
- If the author listed assumptions (for example "the scheduler runs this once at a time"),
  judge the change against them. Disagreeing with an assumption is a question, not a
  `blocker`.
- Report at most 10 findings, most severe first. More `minor` items add noise, not safety.
- On a re-review, report only (a) findings the new commits introduced and (b) earlier
  `blocker`s that are still open. Do not re-audit unchanged code.
- Every finding names the file, the approximate location, what is wrong, and the smallest
  concrete fix.

## Report

```
verdict: approve | changes-required
1. [blocker|major|minor] path/to/file.ts:~120 — what is wrong. Fix: smallest concrete fix.
2. ...
checked: <what you read and ran>
```

`changes-required` only when at least one `blocker` is open. No blockers means `approve`, even
with `major`/`minor` findings listed.

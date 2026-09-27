# Copilot code review policy

These instructions govern Copilot's code reviews on this repository. They exist because PR #768
ran 49 review rounds (~13 h): every push triggered a fresh review that re-raised edge-case
findings, several of them non-deterministic. Reviews here are requested deliberately, not
continuous.

## Scope of a review

- Review what the change touches against the stated intent. Do not review the surrounding
  subsystem for hypothetical improvements.
- Findings must describe a realistic production failure, not a style preference. If a finding
  cannot name the input that breaks it, it is not a finding.

## Severity

Report only findings of these severities; everything else stays silent:

- **blocker** — would merge broken or unsafe behavior (correctness, security, data loss).
- **major** — a real defect or a documented-contract violation that a maintainer must decide on.
- **minor** — small, cheap, worth fixing in this PR; include at most two.

## Accepted tradeoffs (do not re-raise these)

- **Single-writer scheduling is guaranteed by Mercury.** Nightly/bot code does not defend
  against concurrent fires of the same bot task; `singleFlight` in the bot config is the
  mechanism. Do not ask for in-skill racing or locking.
- **Deadlines are the scheduler's job.** Code guarded by `constraints.notAfter` must not also
  implement its own time budget or deadline checks.
- **Threads with more than 1000 comments are out of scope.** Comment pagination reads page 1 and
  the `Link` last page by design.
- **Skill scripts (`\.agents/skills/**`) run inside the agent workspace** with the same trust
  level as the agent itself; they do not add a security boundary.
- **Preserved-for-compat shapes** (API response fields, event payload keys, migration history)
  are deliberately redundant; changing them breaks Fleet/Atlas consumers.

## Review behavior

- One review per request. Do not expect or trigger re-reviews on every push; a re-review covers
  only the commits added since the last review.
- Keep findings to at most 10, each tied to a file and line, each with the failing input.

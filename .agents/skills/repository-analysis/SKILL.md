---
name: repository-analysis
version: 1.1.0
description: Inspect a repository to understand structure, conventions and commands before changing it.
capabilities: [inspection, analysis, onboarding, understanding]
---

# Repository Analysis

Before changing code, determine:

- language/runtime and build system
- test command and how to run a focused subset
- lint/format commands
- where the relevant code lives for the task
- existing conventions (naming, structure, error handling)
- the repository's own agent rules (`AGENTS.md`, `CONTRIBUTING.md`) — they override generic
  skill guidance where the two differ

Record findings in `.mercury/scratch/REPO-NOTES.md` (create the directory). It is a working
note: never commit it. Do not assume technologies that are not present.

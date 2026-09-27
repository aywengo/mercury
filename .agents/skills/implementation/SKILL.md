---
name: implementation
version: 1.1.0
description: Make small, cohesive source changes that follow repository conventions.
capabilities: [implementation, coding, feature, fix]
---

# Implementation

- implement what the task's acceptance criteria ask for; do not add machinery for failure
  modes the task does not mention (write them down as open questions instead)
- prefer small cohesive changes over large rewrites
- follow existing conventions in the surrounding code; reuse existing helpers instead of
  copying them into a new file
- do not perform unrelated refactoring
- after each meaningful change, run the relevant tests

Report:

```
files: <changed paths>
commands: <what you ran>
tests: <pass>/<fail>/<skip>
assumptions: <one line each, or "none">
open questions: <one line each, or "none">
```

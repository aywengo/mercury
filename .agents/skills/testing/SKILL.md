---
name: testing
version: 1.0.0
description: Verify code changes using repository-appropriate tests.
capabilities: [testing, verification, regression, integration]
---

# Testing

Determine the smallest relevant test suite first.

Run focused tests before the complete suite.

When failures occur:

1. determine whether they are caused by the current change
2. investigate the root cause
3. fix regressions caused by the implementation
4. rerun affected tests

Before completion, report:

- commands executed
- tests passed
- tests failed
- tests skipped
- unresolved failures

Never claim tests passed unless they were actually executed.

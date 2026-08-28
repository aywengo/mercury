---
name: code-review
version: 1.0.0
description: Review code changes for correctness, quality and adherence to conventions.
capabilities: [review, quality, refactoring]
---

# Code Review

Review the diff for:

- correctness and edge cases
- adherence to repository conventions
- dead code, duplication, obvious performance issues
- missing or broken tests

Report findings as a prioritized list (blocking vs non-blocking). Do not
rewrite the change unless asked.

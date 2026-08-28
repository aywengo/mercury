---
name: security-review
version: 1.0.0
description: Check changes for common security issues before merge.
capabilities: [security, vulnerabilities, auth, secrets]
---

# Security Review

Check for:

- injection (SQL, command, template)
- secrets or credentials in code, logs or events
- missing authorization checks
- unsafe deserialization or path handling
- overly broad permissions

Report each finding with severity and a concrete fix. Never include real
credentials in reports.

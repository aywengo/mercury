---
name: documentation
version: 1.0.0
description: Write and update clear, accurate documentation for code, runbooks, and operational procedures.
capabilities: [documentation, writing, runbooks, README]
---

# Documentation

Documentation is part of the deliverable, not an afterthought.

Write for the reader who must operate or maintain the system without the author present.

For READMEs and guides:

1. state what the component does and why it exists
2. show the quickest working path first
3. document configuration with concrete examples
4. document failure modes and recovery steps
5. keep examples copy-paste runnable

For runbooks:

1. describe symptoms, not just causes
2. give ordered recovery steps with expected outcomes
3. include verification commands after each step
4. note escalation paths and owners

Rules:

- Never document behavior that is not implemented.
- Update related docs when behavior changes.
- Prefer short sentences and concrete verbs.
- Use diagrams (Mermaid) for architecture and flows.

Before completion, report:

- files written or updated
- what changed and why
- anything intentionally left undocumented

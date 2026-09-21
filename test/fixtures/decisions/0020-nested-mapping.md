---
id: 0020
title: An indented mapping is outside the subset
status: accepted
date: 2026-09-12
evidence:
  - commit: 7a546bc
    note: extra context a real YAML parser nests under the commit
---

## Decision

A mapping nested under a list entry is refused; a lenient read would silently drop its keys.

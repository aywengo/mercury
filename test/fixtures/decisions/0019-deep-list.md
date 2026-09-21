---
id: 0019
title: A nested list is outside the subset
status: accepted
date: 2026-09-12
evidence:
  - https://github.com/aywengo/mercury/issues/459
    - https://github.com/aywengo/mercury/issues/460
---

## Decision

An entry a real YAML parser would read as a nested list under the first item must be refused,
not flattened by a parser that does not know what it is reading.

---
id: 0007
title: Knowledge notes are claims, not history
status: accepted            # proposed | accepted | superseded | rejected
date: 2026-09-11
evidence:
  - https://github.com/aywengo/mercury/pull/487
  - commit: 7a546bc
  - https://github.com/aywengo/mercury/issues/459#comment-1
---

## Decision

Atlas stores claims with evidence pointers and never copies of the evidence, so a note stays
small and git stays the history.

## Context

Why this came up, what was tried, what the alternatives were.

## Consequences

What becomes easier, what becomes harder, what is now forbidden.

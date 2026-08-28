---
name: debugging
version: 1.0.0
description: Investigate and fix bugs by finding root causes rather than symptoms.
capabilities: [debugging, bugfix, root-cause, tracing]
---

# Debugging

1. reproduce the failure with the smallest input possible
2. find the root cause before changing code
3. fix the root cause, not the symptom
4. add a regression test if the repository supports it
5. rerun the relevant suite

Report the root cause and the fix. If the failure cannot be reproduced,
say so explicitly.

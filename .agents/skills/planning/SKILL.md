---
name: planning
version: 1.1.0
description: Break a task into a concrete, ordered implementation plan before coding.
capabilities: [planning, design, architecture, roadmap]
---

# Planning

Produce a short written plan before modifying code:

1. state the goal and success criteria
2. identify the files/areas likely affected
3. order the work into small steps
4. note risks and how to verify each step
5. list the assumptions the plan relies on (what the platform or caller already guarantees)

Keep the plan in the workspace as `.mercury/scratch/PLAN.md` (create the directory). It is a
working note: never commit it, and never write to a `PLAN.md` the repository already tracks.
Do not over-plan; stop when the next concrete action is obvious.

---
name: git-pr
version: 1.0.0
description: Commit changes and prepare a pull request following repository conventions.
capabilities: [git, commit, branch, pull-request]
---

# Git PR

1. create a branch from the base branch (the workspace is already on one)
2. commit logical milestones with clear messages
3. do not add AI/tool attribution trailers unless asked
4. push the branch and open a PR when credentials allow
5. report the commit hashes and PR URL

If pushing is not possible in the environment, report the branch name and
commits instead.

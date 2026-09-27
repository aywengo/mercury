---
name: git-pr
version: 1.1.0
description: Commit changes and prepare a pull request following repository conventions.
capabilities: [git, commit, branch, pull-request]
---

# Git PR

1. create a branch from the base branch (the workspace is already on one)
2. stage explicit paths (`git add <path>...`), never `git add -A` or `git add .`; never stage
   anything under `.mercury/`
3. commit logical milestones with clear messages
4. do not add AI/tool attribution trailers unless asked
5. push the branch and open a PR when credentials allow
6. report the commit hashes and PR URL

After a review, batch every fix for that round into one push. Do not push one commit per
review comment, and do not push while a review is still running — each push can trigger a new
review.

If pushing is not possible in the environment, report the branch name and commits instead.

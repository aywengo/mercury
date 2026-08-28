---
name: deployment
version: 1.0.0
description: Package, deploy, and verify services on Linux hosts with systemd, containers, and backup/restore procedures.
capabilities: [deployment, systemd, packaging, backup, operations]
---

# Deployment

Deployments must be repeatable, observable, and reversible.

Prefer declarative configuration over imperative steps.

For systemd services:

1. run as a dedicated unprivileged user
2. use EnvironmentFile for all configuration
3. set Restart=on-failure with a short backoff
4. enable hardening options (NoNewPrivileges, ProtectSystem, PrivateTmp)
5. separate long-running workers from the API process

For backups:

1. back up the database, not just the files
2. timestamp backups and keep a retention window
3. test restore procedures regularly
4. make backup scripts idempotent

For rollouts:

1. deploy to a staging environment first when possible
2. verify health endpoints after each step
3. keep the previous version available for rollback
4. document the rollback procedure before deploying

Before completion, report:

- units/files created
- commands to install and verify
- backup and restore procedure
- known limitations

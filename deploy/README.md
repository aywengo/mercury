# Mercury deployment

Systemd units, backup script and logrotate config for running Mercury as a service.

## Configuration file (required)

Both units declare `EnvironmentFile=/etc/mercury/mercury.env` **without a leading `-`**, so systemd
refuses to start the service if the file is missing. It is not optional, and it must exist before
the `systemctl enable --now` above.

```bash
# /etc/mercury/mercury.env
MERCURY_DB=/var/lib/mercury/mercury.db
MERCURY_WORKSPACE_BASE=/var/lib/mercury/workspaces
MERCURY_BIND_HOST=127.0.0.1
# plus auth: MERCURY_API_TOKENS=... and any session settings (see the root README)
```
```bash
sudo chown mercury:mercury /etc/mercury/mercury.env
sudo chmod 600 /etc/mercury/mercury.env   # it holds API tokens
sudo mkdir -p /var/lib/mercury/workspaces
sudo chown -R mercury:mercury /var/lib/mercury
# If the services were already started without this file, restart them so they pick it up:
sudo systemctl restart mercury mercury-worker
```

**Why these two lines are not optional extras.** The application defaults are *relative*:
`MERCURY_DB` defaults to `./mercury.db` and `MERCURY_WORKSPACE_BASE` to `./workspaces`
(`src/config.ts`). Both units set `WorkingDirectory=/opt/mercury`, so if you omit these settings the
app silently writes `/opt/mercury/mercury.db` -- while the backup cron below reads
`/var/lib/mercury/mercury.db`. The two then refer to different files, and the nightly job backs up
a path the application never writes to. Nothing in the app or the cron line reports that they
disagree.

If you choose a different location, it must be changed in **three** places that have to agree:
`mercury.env`, the backup cron line, and the restore commands below.

## Install

```bash
sudo useradd --system --home /opt/mercury --shell /usr/sbin/nologin mercury
sudo mkdir -p /opt/mercury /var/lib/mercury /etc/mercury
sudo cp -r /path/to/mercury/* /opt/mercury/
sudo cp mercury.service mercury-worker.service /etc/systemd/system/
sudo cp logrotate.conf /etc/logrotate.d/mercury
sudo systemctl daemon-reload

# Requires /etc/mercury/mercury.env (created in the previous section); the units fail closed without it.
sudo systemctl enable --now mercury mercury-worker
```

## Backup

```bash
# cron: nightly at 02:30
30 2 * * * MERCURY_DB=/var/lib/mercury/mercury.db BACKUP_DIR=/var/backups/mercury BACKUP_KEEP=7 /opt/mercury/deploy/backup.sh
```

## Restore

```bash
# stop services, replace the db file, start services
sudo systemctl stop mercury mercury-worker
sudo cp /var/backups/mercury/mercury-YYYYMMDD-HHMMSS.db /var/lib/mercury/mercury.db
sudo systemctl start mercury mercury-worker
```

## Notes

- The API server and worker are separate units; run both for production-style operation.
- `MERCURY_BIND_HOST` defaults to 127.0.0.1 — set it explicitly if you need LAN access (and use TLS or a reverse proxy).

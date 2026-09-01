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
# stop services, replace the db file, remove stale WAL sidecars, start services
sudo systemctl stop mercury mercury-worker
sudo cp /var/backups/mercury/mercury-YYYYMMDD-HHMMSS.db /var/lib/mercury/mercury.db
# `cp` runs as root, so without this the restored database is root-owned while both services run as
# User=mercury -- the API would start and then fail on its first write with SQLITE_CANTOPEN or a
# permissions error that points at SQLite rather than at ownership.
sudo chown mercury:mercury /var/lib/mercury/mercury.db
# Remove the sidecars (issue #69). A -wal file belongs to the database it was written beside: it
# contains frames keyed to that file's change counter. Replacing only the .db leaves a -wal from
# the OLD database next to a NEW one, and SQLite will replay those foreign frames into the
# restored file on first open -- which is how a restore turns into a corrupt database.
sudo rm -f /var/lib/mercury/mercury.db-wal /var/lib/mercury/mercury.db-shm
# Verify before starting, so a bad restore is caught here rather than by the first write.
sqlite3 /var/lib/mercury/mercury.db 'PRAGMA integrity_check;'   # must print exactly: ok
sudo systemctl start mercury mercury-worker
```

Backups are verified at creation time by `backup.sh` (`PRAGMA integrity_check`), and the script
refuses to run without `sqlite3` rather than falling back to `cp` -- see the comments in
`deploy/backup.sh` for why copying a WAL-mode database is not a backup.

## Notes

- The API server and worker are separate units; run both for production-style operation.
- `MERCURY_BIND_HOST` defaults to 127.0.0.1 — set it explicitly if you need LAN access (and use TLS or a reverse proxy).

# Mercury deployment

Systemd units, backup script and logrotate config for running Mercury as a service.

## Install

```bash
sudo useradd --system --home /opt/mercury --shell /usr/sbin/nologin mercury
sudo mkdir -p /opt/mercury /var/lib/mercury /etc/mercury
sudo cp -r /path/to/mercury/* /opt/mercury/
sudo cp mercury.service mercury-worker.service /etc/systemd/system/
sudo cp logrotate.conf /etc/logrotate.d/mercury
# create /etc/mercury/mercury.env with MERCURY_* variables (see README.md at repo root)
sudo systemctl daemon-reload
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

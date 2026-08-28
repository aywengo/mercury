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
# stop services, replace the db file, start services
sudo systemctl stop mercury mercury-worker
sudo cp /var/backups/mercury/mercury-YYYYMMDD-HHMMSS.db /var/lib/mercury/mercury.db
sudo systemctl start mercury mercury-worker
```

## Notes

- The API server and worker are separate units; run both for production-style operation.
- `MERCURY_BIND_HOST` defaults to 127.0.0.1 — set it explicitly if you need LAN access (and use TLS or a reverse proxy).

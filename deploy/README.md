# Mercury deployment

Systemd units and a backup script for running Mercury as a service. Logs go to journald;
there is no logrotate config because there is nothing on disk to rotate.

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

## Logs

Both units log JSON to stdout/stderr, which systemd captures in the journal:

```bash
journalctl -u mercury-worker -f
```

Rotation, retention and compression are journald's job, configured in `journald.conf`
(`SystemMaxUse`, `MaxRetentionSec`) -- not logrotate's. A `logrotate.conf` shipped here previously
rotated `/var/log/mercury/*.log`, a directory nothing ever wrote to, so it silently did nothing
(issue #73 L4). It has been removed rather than documented, because a config file that provably
cannot do anything is a maintenance liability, not a convenience.

If you redirect output to files instead, you take on rotation yourself; the units as shipped do not.

## Container sandbox under a hardened unit

`mercury-worker.service` sets `ProtectSystem=strict`, which mounts the filesystem read-only. That
is deliberate, and it is incompatible with the container sandbox: talking to the Docker daemon
means writing to `/var/run/docker.sock`, which a read-only root blocks. A run that asks for
isolation therefore fails closed rather than running unsandboxed -- the correct failure direction,
but not one you want to discover in production.

If you use `resourceLimits`/`allowedNetworks` (the sandbox), install the drop-in:

```bash
sudo mkdir -p /etc/systemd/system/mercury-worker.service.d
sudo cp mercury-worker-sandbox.conf /etc/systemd/system/mercury-worker.service.d/
sudo systemctl daemon-reload && sudo systemctl restart mercury-worker
```

It relaxes only what the docker socket requires and is NOT installed by default: the hardened
baseline is the right default for deployments that do not sandbox.

## Notes

- The API server and worker are separate units; run both for production-style operation.
- `MERCURY_BIND_HOST` defaults to 127.0.0.1 — set it explicitly if you need LAN access (and use TLS or a reverse proxy).

## Fleet (optional)

`fleet.service` runs the federation layer from `fleet/`, which manages several Mercury instances over their
HTTP APIs. It is optional: Mercury works with no Fleet at all, and a child must keep working with Fleet
deleted.

```bash
sudo useradd --system --home /var/lib/fleet --shell /usr/sbin/nologin fleet
sudo install -d -o fleet -g fleet -m 750 /var/lib/fleet
sudo install -d -o root -g fleet -m 750 /etc/fleet

# Child credentials: a separate 0600 file, NOT part of the unit environment.
sudo install -m 600 -o fleet -g fleet /dev/null /etc/fleet/credentials.json
sudo $EDITOR /etc/fleet/credentials.json      # {"mac-studio": "<that host's MERCURY_API_TOKENS value>"}

sudo install -m 640 -o root -g fleet deploy/fleet.env.example /etc/fleet/fleet.env
sudo $EDITOR /etc/fleet/fleet.env             # set tokens; FLEET_CREDENTIALS_FILE must point at the file above

sudo cp deploy/fleet.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now fleet
curl -s http://127.0.0.1:3100/healthz
```

Two things about this unit are load-bearing rather than stylistic:

- **`FLEET_CREDENTIALS_FILE` must be outside `$HOME`.** `ProtectHome=true` makes the home directory
  unreadable, so the `~/.fleet/credentials.json` default fails closed under systemd: the service starts, the
  registry loads, and every probe reports `auth-fail`. That is the intended failure, but it reads like a
  credential problem on the children rather than a path problem here.
- **`ReadWritePaths` covers `/var/lib/fleet` only.** The credential file is read once at startup and is not
  writable by the process holding every child token.

Fleet refuses to bind a non-loopback address without TLS, by design. Put it behind a reverse proxy if it
must be reachable beyond the host.

## CI (GitHub Actions)

`.github/workflows/ci.yml` runs on `ubuntu-latest` only, and the repository is public, so Linux runner
minutes are free. Keep it that way: **macOS and Windows legs still bill, as do artifact uploads and
larger runner sizes** -- none are used today, and adding one reintroduces a bill.

Measured cost, so this can be reasoned about without re-measuring: **~11.2 job-minutes per run** on the
two-Node matrix (each test leg ~5, the uninstalled-checkout guard ~1.1). Billed minutes are the sum
across jobs, so the run page's wall-clock understates it roughly threefold.

**Before debugging a red run, check that it ran.** When the account's Actions allowance was exhausted,
every job failed with "recent account payments have failed or your spending limit needs to be increased"
while executing ZERO steps and dying in about two seconds. A red check that ran nothing says nothing
about the code. No steps in `gh run view <id> --log`, or a job whose `started_at` and `completed_at` are
nearly equal, is that signature.

If the repository ever goes private again, minutes become metered and the remaining reductions to make --
in order of saving, each with its trade-off -- are recorded in issue #218. The two that were pending
there have since landed: `timeout-minutes` on every job, and draft PRs no longer triggering CI.

**Editing workflows from a machine whose token lacks the `workflow` scope.** GitHub refuses any write to
`.github/workflows/` from an OAuth token without that scope (`gh auth refresh -s workflow`), and it does
so for `git push` and API commits alike -- no transport workaround, and it blocks the whole branch ref
because the commit contains a workflow file. The scope governs writes made *by OAuth tokens*, not a
signed-in browser session, so **editing the file in the github.com web editor needs no token change at
all** and is the fastest path when the scope is missing.

The Node matrix follows `package.json` `engines` rather than leading it. `engines` once declared
`>=23.6` while the matrix tested `23.6.0` plus `24.x`: that spent CI on an end-of-life runtime (Node 23
lost support in June 2025) and excluded Node 22 LTS, which passes the whole suite from 22.18. Issue #222
corrected the floor to `>=22.18.0`; the matrix is expected to track it (`['22.x', '24.x']`), and
`test/nodeFloor.test.ts` fails if a leg ever falls below the declared floor. The `push: [main]` trigger
stays because the merge commit, not the PR head, is the real state of `main`.

Do not add `paths-ignore: ['**/*.md']` to skip CI on documentation changes. `test/deployDocs.test.ts`
and `test/backup.test.ts` assert on the CONTENT of this file, so ignoring markdown would let a
documentation change that breaks a doc test merge unverified.

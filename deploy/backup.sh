#!/usr/bin/env bash
# Mercury SQLite backup script.
# Usage: MERCURY_DB=/path/to/mercury.db BACKUP_DIR=/path/to/backups BACKUP_KEEP=7 ./backup.sh
set -euo pipefail

DB="${MERCURY_DB:-./mercury.db}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP:-7}"

if [ ! -f "$DB" ]; then
  echo "error: database not found at $DB" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S-%N)"
OUT="$BACKUP_DIR/mercury-${STAMP}.db"

# sqlite3 is REQUIRED (issue #69). The old fallback was `cp "$DB" "$OUT"`, and `cp` is not a
# database backup: it copies only the main file, while a WAL-mode database keeps recent commits in
# the adjacent -wal file. So `cp` of a live database silently produces a backup missing its newest
# transactions -- and, worse, it can catch the main file mid-write and produce one that is torn.
# Both failures are silent: the command exits 0 and the file looks fine.
#
# `.backup` uses SQLite's online-backup API, which takes the write lock and copies through the
# engine, so the result is a consistent snapshot including everything the WAL had committed.
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "error: sqlite3 is required for a safe backup." >&2
  echo "       The database is in WAL mode; copying the .db file alone would omit its WAL" >&2
  echo "       and can capture a torn page. Install sqlite3 rather than falling back to cp." >&2
  exit 1
fi

# Capture the status rather than letting `set -e` abort here. A failed .backup (disk full, EACCES,
# SQLITE_BUSY) leaves a PARTIAL $OUT on disk, and `set -e` exits without removing it -- so the
# retention glob below would keep a truncated file that is named exactly like a good backup. That is
# the same silent-failure class this whole script is about: you discover it only when restoring.
if ! sqlite3 "$DB" ".backup '$OUT'"; then
  echo "error: sqlite3 .backup failed; removing the partial file" >&2
  rm -f "$OUT"
  exit 1
fi

# Verify what we just wrote. Without this the script reports success for a backup that cannot be
# opened, which is the failure mode that matters most: a bad backup is indistinguishable from a good
# one until the night you need it. integrity_check returns a single row 'ok' on success and one row
# per problem otherwise; anything other than exactly 'ok' is treated as failure.
CHECK="$(sqlite3 "$OUT" 'PRAGMA integrity_check;' 2>&1 || true)"
if [ "$CHECK" != "ok" ]; then
  echo "error: backup failed integrity_check: $CHECK" >&2
  rm -f "$OUT"
  exit 1
fi

echo "backup written and verified: $OUT"

# Retention: keep the newest $KEEP backups, delete older ones.
ls -1t "$BACKUP_DIR"/mercury-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  echo "removed old backup: $old"
done

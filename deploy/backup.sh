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

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$OUT'"
else
  cp "$DB" "$OUT"
fi

echo "backup written: $OUT"

# Retention: keep the newest $KEEP backups, delete older ones.
ls -1t "$BACKUP_DIR"/mercury-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  echo "removed old backup: $old"
done

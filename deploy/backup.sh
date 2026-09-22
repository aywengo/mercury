#!/usr/bin/env bash
# Mercury + Atlas SQLite backup script.
# Usage: MERCURY_DB=/path/to/mercury.db [ATLAS_DB=/path/to/atlas.db] BACKUP_DIR=/path/to/backups BACKUP_KEEP=7 ./backup.sh
#
# Each database named on the invocation (mercury always; atlas when ATLAS_DB is set) gets its own
# verified snapshot: atlas-<stamp>.db next to mercury-<stamp>.db. One invocation backs both up so a
# cron entry cannot back one up and forget the other -- Atlas's notes outlive every Run and are the
# hardest data in the stack to reconstruct.
set -euo pipefail

DB="${MERCURY_DB:-./mercury.db}"
ATLAS_DB="${ATLAS_DB:-}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP:-7}"

if [ ! -f "$DB" ]; then
  echo "error: database not found at $DB" >&2
  exit 1
fi
if [ -n "$ATLAS_DB" ] && [ ! -f "$ATLAS_DB" ]; then
  echo "error: ATLAS_DB is set but the database is not found at $ATLAS_DB" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S-%N)"

# sqlite3 is REQUIRED (issue #69). The old fallback was `cp "$DB" "$OUT"`, and `cp` is not a
# database backup: it copies only the main file, while a WAL-mode database keeps recent commits in
# the adjacent -wal file. So `cp` of a live database silently produces a backup missing its newest
# transactions -- and, worse, it can catch the main file mid-write and produce one that is torn.
# Both failures are silent: the command exits 0 and the file looks fine.
#
# `.backup` uses SQLite's online-backup API, which takes the write lock and copies through the
# engine, so the result is a consistent snapshot including everything the WAL had committed.
# The WAL sidecar needs no separate handling here: .backup reads through the engine, so whatever
# the WAL held at snapshot time is inside the copy.
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "error: sqlite3 is required for a safe backup." >&2
  echo "       The database is in WAL mode; copying the .db file alone would omit its WAL" >&2
  echo "       and can capture a torn page. Install sqlite3 rather than falling back to cp." >&2
  exit 1
fi

# One verified snapshot per database, sharing the same timestamp. Capture the status rather than
# letting `set -e` abort: a failed .backup (disk full, EACCES, SQLITE_BUSY) leaves a PARTIAL $OUT
# on disk, and `set -e` exits without removing it -- so the retention glob below would keep a
# truncated file that is named exactly like a good backup. That is the same silent-failure class
# this whole script is about: you discover it only when restoring.
backup_one() {
  local src="$1" out="$2"
  if ! sqlite3 "$src" ".backup '$out'"; then
    echo "error: sqlite3 .backup failed for $src; removing the partial file" >&2
    rm -f "$out"
    exit 1
  fi

  # Verify what we just wrote. Without this the script reports success for a backup that cannot be
  # opened, which is the failure mode that matters most: a bad backup is indistinguishable from a
  # good one until the night you need it. integrity_check returns a single row 'ok' on success and
  # one row per problem otherwise; anything other than exactly 'ok' is treated as failure.
  local check
  check="$(sqlite3 "$out" 'PRAGMA integrity_check;' 2>&1 || true)"
  if [ "$check" != "ok" ]; then
    echo "error: backup of $src failed integrity_check: $check" >&2
    rm -f "$out"
    exit 1
  fi
  echo "backup written and verified: $out"
}

backup_one "$DB" "$BACKUP_DIR/mercury-${STAMP}.db"
if [ -n "$ATLAS_DB" ]; then
  backup_one "$ATLAS_DB" "$BACKUP_DIR/atlas-${STAMP}.db"
fi

# Retention: keep the newest $KEEP backups per product, delete older ones. Two globs, not one
# mercury-* glob: atlas snapshots must not count against mercury's retention or vice versa -- a
# product backed up more often would silently shorten the other's history.
ls -1t "$BACKUP_DIR"/mercury-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  echo "removed old backup: $old"
done
if [ -n "$ATLAS_DB" ]; then
  ls -1t "$BACKUP_DIR"/atlas-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
    echo "removed old backup: $old"
  done
fi

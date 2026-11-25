#!/bin/sh
# enforce-retention.sh — 35-day backup retention (NFR-24, INF-18).
#
# Runs from the postgres-backup-retention CronJob. Deletes base backups and
# archived WAL older than the retention window, with two fail-safes:
#   1. the window can never be configured BELOW 35 days (NFR-24 floor);
#   2. the NEWEST base backup is never deleted, even if it is older than
#      the window — an empty archive is worse than an over-retained one.
# WAL is pruned purely by age; a kept-but-old base simply restores to the
# oldest surviving WAL (documented in docs/ops/backup-restore.md).
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
DAYS=${BACKUP_RETENTION_DAYS:-35}
# NFR-24 floor: refuse any window shorter than 35 days.
[ "$DAYS" -ge 35 ] || { echo "retention floor is 35 days (NFR-24), got $DAYS" >&2; exit 1; }

BASE_DIR="$BACKUP_DIR/base"
WAL_DIR="$BACKUP_DIR/wal"
[ -d "$BASE_DIR" ] || { echo "no base backup directory $BASE_DIR" >&2; exit 1; }

# UTC name timestamps sort lexicographically (YYYYMMDDTHHMMSSZ).
NEWEST=$(ls -1 "$BASE_DIR" 2>/dev/null | grep -v '^\.tmp\.' | sort | tail -n 1 || true)
[ -n "$NEWEST" ] || { echo "no base backups present — nothing to prune" >&2; exit 1; }

CUTOFF=$(date -u -d "@$(( $(date -u +%s) - DAYS * 86400 ))" +%Y%m%dT%H%M%SZ)

pruned=0
for dir in "$BASE_DIR"/*/; do
    name=$(basename "$dir")
    case "$name" in .tmp.*) continue ;; esac
    if [ "$name" != "$NEWEST" ] && [ "$name" \< "$CUTOFF" ]; then
        rm -rf "$dir"
        echo "pruned base backup $name (older than $CUTOFF)"
        pruned=$((pruned + 1))
    fi
done

if [ -d "$WAL_DIR" ]; then
    find "$WAL_DIR" -type f -name '*.age' -mtime +"$DAYS" -exec rm -f {} +
    find "$WAL_DIR" -type f -name '*.age.sha256' -mtime +"$DAYS" -exec rm -f {} +
fi

echo "retention pass complete (window ${DAYS}d, cutoff $CUTOFF, $pruned base backup(s) pruned, newest kept: $NEWEST)"

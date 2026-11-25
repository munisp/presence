#!/bin/sh
# wal-archive.sh — Postgres archive_command target (INF-18 PITR, NFR-16 RPO).
#
# Encrypts every WAL segment with TWO sequential age recipients (SEC-11):
# the inner wrap needs the inner operator's key and the outer wrap the outer
# operator's key, so no single keyholder can ever read a backup alone —
# dual-authorisation is a property of the ciphertext, not of a process.
# Only the PUBLIC recipients exist on the platform (ConfigMap
# postgres-backup-config); both private keys live off-cluster with separate
# operators and enter a machine only for restore-rehearse.sh.
#
# archive_command contract: exit non-zero on ANY failure so Postgres keeps
# the segment and retries. Writes are tmp-then-rename so a crashed attempt
# never publishes a partial object; the .sha256 sidecar lands last and marks
# the object complete.
#
# Usage (set by deploy manifests): archive_command = 'wal-archive.sh %p %f'
set -eu

SRC=${1:?usage: wal-archive.sh <path> <name>}
NAME=${2:?usage: wal-archive.sh <path> <name>}
BACKUP_DIR=${BACKUP_DIR:-/backups}
INNER=${BACKUP_AGE_RECIPIENT_INNER:?BACKUP_AGE_RECIPIENT_INNER (public recipient) required}
OUTER=${BACKUP_AGE_RECIPIENT_OUTER:?BACKUP_AGE_RECIPIENT_OUTER (public recipient) required}

DEST_DIR="$BACKUP_DIR/wal"
DEST="$DEST_DIR/$NAME.age"
TMP_INNER="$DEST_DIR/.tmp-inner.$NAME.$$"
TMP_OUTER="$DEST_DIR/.tmp-outer.$NAME.$$"
mkdir -p "$DEST_DIR"
trap 'rm -f "$TMP_INNER" "$TMP_OUTER"' EXIT

# Sequential wraps via temp files (no pipes: a failing first stage must not
# leave a half-written second stage).
age -r "$INNER" -o "$TMP_INNER" "$SRC"
age -r "$OUTER" -o "$TMP_OUTER" "$TMP_INNER"
[ -s "$TMP_OUTER" ]
rm -f "$TMP_INNER"

mv "$TMP_OUTER" "$DEST"
sha256sum "$DEST" | awk '{print $1}' > "$DEST.sha256.tmp.$$"
mv "$DEST.sha256.tmp.$$" "$DEST.sha256"
trap - EXIT

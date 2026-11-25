#!/bin/sh
# wal-restore.sh — Postgres restore_command target used ONLY by
# restore-rehearse.sh inside the scratch instance (INF-18).
#
# Decrypts one archived WAL segment through both operator wraps (SEC-11):
# outer identity peels the outer wrap, inner identity peels the inner wrap.
# Both identity files must be present (restore-rehearse.sh enforces they are
# distinct before postgres ever starts).
#
# Usage (written into the scratch recovery config):
#   restore_command = '/usr/local/bin/presence-backup/wal-restore.sh %f %p'
set -eu

NAME=${1:?usage: wal-restore.sh <name> <dest>}
DEST=${2:?usage: wal-restore.sh <name> <dest>}
BACKUP_DIR=${BACKUP_DIR:-/backups}
INNER_FILE=${BACKUP_AGE_IDENTITY_INNER_FILE:?inner operator identity file required (SEC-11)}
OUTER_FILE=${BACKUP_AGE_IDENTITY_OUTER_FILE:?outer operator identity file required (SEC-11)}

SRC="$BACKUP_DIR/wal/$NAME.age"
[ -f "$SRC" ] || exit 1   # segment not archived: let postgres end replay

TMP="$DEST.rehearsal.$$"
trap 'rm -f "$TMP" "$TMP.inner"' EXIT
age -d -i "$OUTER_FILE" -o "$TMP.inner" "$SRC"
age -d -i "$INNER_FILE" -o "$TMP" "$TMP.inner"
rm -f "$TMP.inner"
mv "$TMP" "$DEST"
trap - EXIT

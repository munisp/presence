#!/bin/sh
# base-backup.sh — encrypted base backup + manifest (INF-18, NFR-24, SEC-11).
#
# Runs from the postgres-base-backup CronJob (k8s) or on demand in compose:
#   docker compose -f deploy/docker-compose.yml run --rm backup
#
# Takes a pg_basebackup over the network as the least-privilege
# presence_backup role (LOGIN REPLICATION BYPASSRLS, SELECT on exactly the
# four append-only integrity tables — provisioned by
# deploy/postgres/initdb/zz_backup_access.sh), wraps the tarball in the same
# dual-recipient age encryption as wal-archive.sh (SEC-11: no single
# keyholder can read it), and publishes a manifest.json the restore
# rehearsal later verifies against (hashes + append-only row counts).
set -eu

TS=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR=${BACKUP_DIR:-/backups}
PGHOST=${PGHOST:-postgres}
PGPORT=${PGPORT:-5432}
PGDATABASE=${PGDATABASE:-presence}
PGUSER=${PGUSER:-presence_backup}
export PGPASSWORD=${BACKUP_REPLICATION_PASSWORD:?BACKUP_REPLICATION_PASSWORD required}
INNER=${BACKUP_AGE_RECIPIENT_INNER:?BACKUP_AGE_RECIPIENT_INNER (public recipient) required}
OUTER=${BACKUP_AGE_RECIPIENT_OUTER:?BACKUP_AGE_RECIPIENT_OUTER (public recipient) required}

FINAL="$BACKUP_DIR/base/$TS"
TMP="$BACKUP_DIR/base/.tmp.$TS.$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

# Self-contained base (-X stream), gzipped tar, fast checkpoint.
pg_basebackup -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" \
    -X stream -c fast -z -Ft -D "$TMP/raw"
RAW="$TMP/raw/base.tar.gz"
[ -s "$RAW" ]

# SEC-11 dual wrap: inner operator first, outer operator second. Both
# intermediates are wiped before publish; only the doubly-wrapped artefact
# leaves the pod.
age -r "$INNER" -o "$TMP/base.tar.gz.age-inner" "$RAW"
age -r "$OUTER" -o "$TMP/base.tar.gz.age" "$TMP/base.tar.gz.age-inner"
[ -s "$TMP/base.tar.gz.age" ]
rm -rf "$TMP/raw" "$TMP/base.tar.gz.age-inner"

SHA=$(sha256sum "$TMP/base.tar.gz.age" | awk '{print $1}')
BYTES=$(wc -c < "$TMP/base.tar.gz.age" | tr -d ' ')

# Append-only integrity counts (verified by restore-rehearse.sh: replayed
# counts must be >= these — the tables never shrink).
count_rows() {
    psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Atc \
        "SELECT count(*) FROM $1"
}
C_CONSENT=$(count_rows consent_ledger)
C_AUDIT=$(count_rows admin_audit)
C_TRANSFERS=$(count_rows transfers)
C_TRANSFER_EVENTS=$(count_rows transfer_events)

cat > "$TMP/manifest.json" <<EOF
{
  "backup": "base/$TS/base.tar.gz.age",
  "createdUtc": "$TS",
  "encryption": "age dual-wrap inner+outer (SEC-11 dual-authorisation)",
  "sha256": "$SHA",
  "bytes": $BYTES,
  "postgresVersion": "$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Atc 'SHOW server_version')",
  "appendOnlyCounts": {
    "consent_ledger": $C_CONSENT,
    "admin_audit": $C_AUDIT,
    "transfers": $C_TRANSFERS,
    "transfer_events": $C_TRANSFER_EVENTS
  }
}
EOF

mv "$TMP" "$FINAL"
trap - EXIT
echo "base backup published: $FINAL ($BYTES bytes, sha256 $SHA)"

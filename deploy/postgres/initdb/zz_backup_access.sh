#!/bin/sh
# zz_backup_access.sh — backup access provisioning (SEC-11, INF-18, NFR-24).
#
# Runs at initdb (the zz_ prefix keeps it last, after every migration, so the
# integrity tables already exist). Mounted like the migrations:
#   compose: deploy/postgres/initdb/zz_backup_access.sh
#   k8s:     postgres-initdb ConfigMap (--from-file=zz_backup_access.sh=...)
#
# Creates the least-privilege backup role:
#   LOGIN REPLICATION            — pg_basebackup from the CronJob
#   BYPASSRLS                    — true counts over the RLS-guarded integrity
#                                  tables (a backup that sees a filtered subset
#                                  would pass rehearsal while losing rows)
#   SELECT on exactly the four append-only integrity tables
# and appends the replication pg_hba line. NetworkPolicy still gates which
# pods may reach postgres:5432 (postgres-backup only, besides the
# workloads).
#
# On a bare run without BACKUP_REPLICATION_PASSWORD the role is skipped with
# a loud warning (archiving still works — it is local); every deploy manifest
# sets the variable (pinned by tests/test_batch51.py).
set -eu

HBA_LINE="host replication presence_backup 0.0.0.0/0 scram-sha-256"

if [ -z "${BACKUP_REPLICATION_PASSWORD:-}" ]; then
    echo "zz_backup_access: BACKUP_REPLICATION_PASSWORD unset — skipping backup role; base backups disabled until provided" >&2
    exit 0
fi

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -v bp="$BACKUP_REPLICATION_PASSWORD" <<'SQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'presence_backup') THEN
        CREATE ROLE presence_backup LOGIN REPLICATION BYPASSRLS;
    END IF;
END
$$;
ALTER ROLE presence_backup PASSWORD :'bp';
GRANT SELECT ON consent_ledger, admin_audit, transfers, transfer_events TO presence_backup;
SQL

echo "$HBA_LINE" >> "$PGDATA/pg_hba.conf"
echo "zz_backup_access: presence_backup role + replication pg_hba line installed"

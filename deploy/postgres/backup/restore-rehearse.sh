#!/bin/sh
# restore-rehearse.sh — timed, dual-authorised restore drill
# (INF-18 quarterly timed restore; NFR-15 RTO <= 60 min evidence; NFR-16
# RPO verification; SEC-11 dual-authorisation restore).
#
# SEC-11: restore is impossible for one operator. The backup artefact is
# age-wrapped twice (inner then outer); this script refuses to run unless
# TWO DISTINCT identity files are supplied, one per operator, and logs both
# operator ids to the rehearsal evidence log.
#
# What it proves, each run:
#   1. the artefact decrypts through both wraps (both keys present, correct);
#   2. sha256 matches the backup manifest;
#   3. WAL replays to the requested point in time (or latest) — PITR works;
#   4. the four append-only integrity tables (consent_ledger, admin_audit,
#      transfers, transfer_events) replay to counts >= the backup manifest —
#      append-only tables never shrink, so a shortfall means corruption;
#   5. wall-clock elapsed stays inside the NFR-15 RTO budget of 3600 s.
#
# Usage:
#   restore-rehearse.sh [--base YYYYMMDDTHHMMSSZ] [--to "2026-11-25 12:00:00+00"] [--keep]
# Required env:
#   BACKUP_AGE_IDENTITY_INNER_FILE / BACKUP_AGE_IDENTITY_OUTER_FILE
#       paths to the two operators' age identity files (must differ)
#   BACKUP_REHEARSAL_OPERATOR_IDS   "name1,name2" — who authorised (logged)
#   REHEARSAL_SUPERUSER             restored cluster superuser (default: presence)
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
REHEARSAL_ROOT=${REHEARSAL_ROOT:-$BACKUP_DIR/rehearsal}
RTO_BUDGET_S=3600   # NFR-15: RTO <= 60 min
START_S=$(date -u +%s)

BASE=""
PITR_TO=""
KEEP=0
while [ $# -gt 0 ]; do
    case "$1" in
        --base) BASE=$2; shift 2 ;;
        --to)   PITR_TO=$2; shift 2 ;;
        --keep) KEEP=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

INNER_FILE=${BACKUP_AGE_IDENTITY_INNER_FILE:?inner operator identity file required (SEC-11)}
OUTER_FILE=${BACKUP_AGE_IDENTITY_OUTER_FILE:?outer operator identity file required (SEC-11)}
OPERATORS=${BACKUP_REHEARSAL_OPERATOR_IDS:?two operator ids required, e.g. BACKUP_REHEARSAL_OPERATOR_IDS=ops-a,ops-b}
SUPERUSER=${REHEARSAL_SUPERUSER:-presence}

# --- SEC-11 dual-authorisation gate --------------------------------------
[ -f "$INNER_FILE" ] || { echo "inner identity file missing: $INNER_FILE" >&2; exit 1; }
[ -f "$OUTER_FILE" ] || { echo "outer identity file missing: $OUTER_FILE" >&2; exit 1; }
if cmp -s "$INNER_FILE" "$OUTER_FILE"; then
    echo "SEC-11 violation: both identity files are identical — restore needs TWO distinct operators" >&2
    exit 1
fi
grep -q "AGE-SECRET-KEY-" "$INNER_FILE" || { echo "inner identity file is not an age identity" >&2; exit 1; }
grep -q "AGE-SECRET-KEY-" "$OUTER_FILE" || { echo "outer identity file is not an age identity" >&2; exit 1; }
OP_A=${OPERATORS%%,*}; OP_B=${OPERATORS#*,}
if [ "$OP_A" = "$OP_B" ] || [ -z "$OP_A" ] || [ "$OP_B" = "$OPERATORS" ]; then
    echo "SEC-11 violation: BACKUP_REHEARSAL_OPERATOR_IDS must name two distinct operators" >&2
    exit 1
fi

# --- select + decrypt the base backup -------------------------------------
[ -d "$BACKUP_DIR/base" ] || { echo "no base backups at $BACKUP_DIR/base" >&2; exit 1; }
if [ -z "$BASE" ]; then
    BASE=$(ls -1 "$BACKUP_DIR/base" | grep -v '^\.tmp\.' | sort | tail -n 1)
fi
ART="$BACKUP_DIR/base/$BASE/base.tar.gz.age"
MANIFEST="$BACKUP_DIR/base/$BASE/manifest.json"
[ -f "$ART" ] && [ -f "$MANIFEST" ] || { echo "base backup $BASE incomplete" >&2; exit 1; }

TS=$(date -u +%Y%m%dT%H%M%SZ)
WORK="$REHEARSAL_ROOT/$TS"
PGDATA_SCRATCH="$WORK/pgdata"
mkdir -p "$PGDATA_SCRATCH"
trap '[ $KEEP -eq 1 ] || rm -rf "$WORK"' EXIT

echo "restore rehearsal $TS: base=$BASE pitr_target=${PITR_TO:-latest} operators=$OP_A+$OP_B"

age -d -i "$OUTER_FILE" -o "$WORK/base.tar.gz.age-inner" "$ART"
age -d -i "$INNER_FILE" -o "$WORK/base.tar.gz" "$WORK/base.tar.gz.age-inner"
rm -f "$WORK/base.tar.gz.age-inner"

EXPECT_SHA=$(sed -n 's/.*"sha256": "\([0-9a-f]*\)".*/\1/p' "$MANIFEST")
ACTUAL_SHA=$(sha256sum "$WORK/base.tar.gz" | awk '{print $1}')
[ "$EXPECT_SHA" = "$ACTUAL_SHA" ] || { echo "sha256 mismatch: manifest $EXPECT_SHA vs artefact $ACTUAL_SHA" >&2; exit 1; }
echo "artefact verified: sha256 $ACTUAL_SHA"

tar -xzf "$WORK/base.tar.gz" -C "$PGDATA_SCRATCH"
rm -f "$WORK/base.tar.gz"

# --- PITR recovery config --------------------------------------------------
cat >> "$PGDATA_SCRATCH/postgresql.auto.conf" <<EOF
restore_command = '/usr/local/bin/presence-backup/wal-restore.sh %f %p'
recovery_target_action = 'promote'
EOF
if [ -n "$PITR_TO" ]; then
    echo "recovery_target_time = '$PITR_TO'" >> "$PGDATA_SCRATCH/postgresql.auto.conf"
fi
touch "$PGDATA_SCRATCH/recovery.signal"
chmod 700 "$PGDATA_SCRATCH"

# The scratch server must run as the postgres OS user (postgres refuses root).
if [ "$(id -u)" = "0" ]; then
    chown -R postgres:postgres "$WORK"
    as_pg() { su-exec postgres "$@"; }
else
    as_pg() { "$@"; }
fi

SOCKET="$WORK/socket"
mkdir -p "$SOCKET"
if [ "$(id -u)" = "0" ]; then chown postgres:postgres "$SOCKET"; fi
as_pg postgres -D "$PGDATA_SCRATCH" -k "$SOCKET" -c listen_addresses='' -p 5433 \
    > "$WORK/postgres.log" 2>&1 &
SRV=$!

waited=0
until pg_isready -h "$SOCKET" -p 5433 -q; do
    sleep 2; waited=$((waited + 2))
    kill -0 "$SRV" 2>/dev/null || { echo "scratch postgres died — see $WORK/postgres.log" >&2; exit 1; }
    [ "$waited" -lt 900 ] || { echo "recovery did not finish within 900 s wait cap" >&2; exit 1; }
done

# --- integrity: append-only counts must be >= the backup manifest ---------
verify_count() {
    expected=$(sed -n "s/.*\"$1\": \([0-9]*\).*/\1/p" "$MANIFEST")
    actual=$(psql -h "$SOCKET" -p 5433 -U "$SUPERUSER" -d presence -Atc \
        "SELECT count(*) FROM $1" 2>/dev/null || true)
    case "$actual" in
        ''|*[!0-9]*)
            echo "INTEGRITY FAILURE: $1 unreadable in the restored instance" >&2
            return 1 ;;
    esac
    if [ "$actual" -lt "$expected" ]; then
        echo "INTEGRITY FAILURE: $1 replayed to $actual rows, manifest says $expected" >&2
        return 1
    fi
    echo "integrity ok: $1 = $actual rows (manifest $expected)"
}
for t in consent_ledger admin_audit transfers transfer_events; do
    verify_count "$t"
done

ELAPSED=$(( $(date -u +%s) - START_S ))
echo "RESTORE COMPLETE elapsed=${ELAPSED}s rto_budget=${RTO_BUDGET_S}s (NFR-15)"

as_pg pg_ctl -D "$PGDATA_SCRATCH" -m fast stop > /dev/null 2>&1 || true

# --- evidence log (append-only, INF-18 quarterly drill trail) -------------
LOG_DIR="$BACKUP_DIR/rehearsal-log"
mkdir -p "$LOG_DIR"
echo "{\"ts\":\"$TS\",\"base\":\"$BASE\",\"pitrTarget\":\"${PITR_TO:-latest}\",\"operators\":\"$OP_A+$OP_B\",\"elapsedS\":$ELAPSED,\"rtoBudgetS\":$RTO_BUDGET_S,\"integrity\":\"ok\"}" \
    >> "$LOG_DIR/rehearsals.jsonl"

if [ "$ELAPSED" -gt "$RTO_BUDGET_S" ]; then
    echo "RTO BREACH: ${ELAPSED}s exceeds the ${RTO_BUDGET_S}s budget (NFR-15)" >&2
    exit 1
fi
echo "rehearsal logged to $LOG_DIR/rehearsals.jsonl"

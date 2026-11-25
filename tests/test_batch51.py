"""Batch 51 invariants — backup, PITR and restore-rehearsal layer: the
in-repo portion of NFR-15 (RTO <= 60 min), NFR-16 (RPO <= 5 min), NFR-24
(35-day retention), SEC-11 (encrypted backups, separate key,
dual-authorisation restore) and INF-18 (PITR 5-min granularity, quarterly
timed restore).

The five requirements stay external-evidence (the SEC-07/INF-01 pattern):
the mechanism ships in-repo, the evidence stays operational. The 306
requirement ledger counts are unchanged: 234/6/0, phase-gated 1,
external-evidence 29.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
K8S = ROOT / "deploy/k8s"
SCRIPTS = ROOT / "deploy/postgres/backup"

DOCKERFILE = (ROOT / "deploy/postgres/Dockerfile").read_text()
WAL_ARCHIVE = (SCRIPTS / "wal-archive.sh").read_text()
BASE_BACKUP = (ROOT / "deploy/postgres/backup/base-backup.sh").read_text()
RETENTION = (ROOT / "deploy/postgres/backup/enforce-retention.sh").read_text()
REHEARSE = (ROOT / "deploy/postgres/backup/restore-rehearse.sh").read_text()
WAL_RESTORE = (ROOT / "deploy/postgres/backup/wal-restore.sh").read_text()
INITDB = (ROOT / "deploy/postgres/initdb/zz_backup_access.sh").read_text()
PG_YAML = (K8S / "postgres.yaml").read_text()
BACKUP_YAML = (K8S / "backup.yaml").read_text()
NETPOL = (K8S / "networkpolicy.yaml").read_text()
EXT_SECRETS = (K8S / "external-secrets.yaml").read_text()
KUSTOMIZATION = (K8S / "kustomization.yaml").read_text()
K8S_README = (K8S / "README.md").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
RUNBOOK = (ROOT / "docs/ops/backup-restore.md").read_text()
TRACEABILITY = (ROOT / "docs/traceability.md").read_text()
GITIGNORE = (ROOT / ".gitignore").read_text()
ALL_K8S = "\n".join(p.read_text() for p in K8S.glob("*.yaml"))


def test_files_exist():
    for rel in (
        "deploy/postgres/backup/wal-archive.sh",
        "deploy/postgres/backup/base-backup.sh",
        "deploy/postgres/backup/enforce-retention.sh",
        "deploy/postgres/backup/restore-rehearse.sh",
        "deploy/postgres/backup/wal-restore.sh",
        "deploy/postgres/initdb/zz_backup_access.sh",
        "deploy/postgres/dev-keys/generate-dev-keys.sh",
        "deploy/postgres/dev-keys/README.md",
        "deploy/k8s/backup.yaml",
        "docs/ops/backup-restore.md",
    ):
        assert (ROOT / rel).exists(), rel


def test_image_bakes_age_and_the_scripts():
    assert "apk add --no-cache age" in DOCKERFILE
    assert "COPY backup/ /usr/local/bin/presence-backup/" in DOCKERFILE
    assert "chmod +x /usr/local/bin/presence-backup/*.sh" in DOCKERFILE


def test_wal_archive_dual_wraps_inner_then_outer_and_is_atomic():
    # SEC-11: two sequential recipients — decryption needs both operators.
    assert WAL_ARCHIVE.index('age -r "$INNER"') < WAL_ARCHIVE.index('age -r "$OUTER"')
    # archive_command contract: non-zero on failure, tmp-then-rename, the
    # sha256 sidecar lands last and marks the object complete.
    assert "exit non-zero on ANY failure" in WAL_ARCHIVE
    assert 'mv "$TMP_OUTER" "$DEST"' in WAL_ARCHIVE
    assert 'mv "$DEST.sha256.tmp.$$" "$DEST.sha256"' in WAL_ARCHIVE
    assert "trap 'rm -f" in WAL_ARCHIVE


def test_base_backup_role_encryption_manifest_and_intermediate_wipe():
    assert "presence_backup" in BASE_BACKUP
    assert "-X stream -c fast -z -Ft" in BASE_BACKUP
    assert BASE_BACKUP.index('age -r "$INNER"') < BASE_BACKUP.index('age -r "$OUTER"')
    # only the doubly-wrapped artefact survives publish
    assert 'rm -rf "$TMP/raw" "$TMP/base.tar.gz.age-inner"' in BASE_BACKUP
    for table in ("consent_ledger", "admin_audit", "transfers", "transfer_events"):
        assert f"count_rows {table}" in BASE_BACKUP
    assert '"sha256":' in BASE_BACKUP and '"appendOnlyCounts"' in BASE_BACKUP


def test_retention_floor_and_newest_chain_guard():
    # NFR-24: 35-day floor, refuses shorter windows, never empties the archive.
    assert "BACKUP_RETENTION_DAYS:-35" in RETENTION
    assert '[ "$DAYS" -ge 35 ]' in RETENTION
    assert "retention floor is 35 days (NFR-24)" in RETENTION
    assert 'sort | tail -n 1' in RETENTION
    assert '"$name" != "$NEWEST"' in RETENTION
    assert '-mtime +"$DAYS"' in RETENTION


def test_rehearse_dual_authorisation_gate():
    # SEC-11: two distinct identity files AND two distinct operator ids.
    assert 'cmp -s "$INNER_FILE" "$OUTER_FILE"' in REHEARSE
    assert "restore needs TWO distinct operators" in REHEARSE
    assert REHEARSE.count("AGE-SECRET-KEY-") >= 2
    assert "BACKUP_REHEARSAL_OPERATOR_IDS" in REHEARSE
    assert "must name two distinct operators" in REHEARSE


def test_rehearse_integrity_rto_and_evidence_log():
    # Append-only tables never shrink: replayed counts must be >= manifest.
    assert 'if [ "$actual" -lt "$expected" ]' in REHEARSE
    for table in ("consent_ledger", "admin_audit", "transfers", "transfer_events"):
        assert table in REHEARSE
    # NFR-15: timed against the 60-minute RTO budget, breach fails the drill.
    assert "RTO_BUDGET_S=3600" in REHEARSE
    assert "RTO BREACH" in REHEARSE
    # INF-18: PITR target support + promotion + append-only drill trail.
    assert "recovery_target_time" in REHEARSE
    assert "recovery_target_action = 'promote'" in REHEARSE
    assert "rehearsals.jsonl" in REHEARSE
    # restore_command delegates to the dual-key WAL restore helper.
    assert "wal-restore.sh %f %p" in REHEARSE
    assert 'age -d -i "$OUTER_FILE"' in WAL_RESTORE
    assert 'age -d -i "$INNER_FILE"' in WAL_RESTORE


def test_initdb_provisions_least_privilege_backup_role():
    assert "CREATE ROLE presence_backup LOGIN REPLICATION BYPASSRLS" in INITDB
    assert (
        "GRANT SELECT ON consent_ledger, admin_audit, transfers, transfer_events TO presence_backup"
        in INITDB
    )
    assert "host replication presence_backup 0.0.0.0/0 scram-sha-256" in INITDB
    # bare runs degrade with a loud warning instead of failing first boot
    assert "BACKUP_REPLICATION_PASSWORD unset" in INITDB


def test_k8s_primary_archives_at_five_minute_granularity():
    # INF-18/NFR-16: RPO <= 5 min via a forced WAL switch every 300 s.
    assert "- archive_mode=on" in PG_YAML
    assert "- archive_timeout=300" in PG_YAML
    assert "archive_command=/usr/local/bin/presence-backup/wal-archive.sh %p %f" in PG_YAML
    assert "configMapKeyRef: { name: postgres-backup-config, key: BACKUP_AGE_RECIPIENT_INNER }" in PG_YAML
    assert "configMapKeyRef: { name: postgres-backup-config, key: BACKUP_AGE_RECIPIENT_OUTER }" in PG_YAML
    assert "secretKeyRef: { name: presence-secrets, key: BACKUP_REPLICATION_PASSWORD }" in PG_YAML
    assert "mountPath: /backups" in PG_YAML
    assert "claimName: postgres-backups" in PG_YAML


def test_k8s_backup_manifest_cronjobs_and_secret_discipline():
    for kind in ("postgres-backup-config", "postgres-base-backup", "postgres-backup-retention"):
        assert f"name: {kind}" in BACKUP_YAML
    assert 'schedule: "17 2 * * *"' in BACKUP_YAML  # daily base backup
    assert 'schedule: "41 3 * * *"' in BACKUP_YAML  # daily retention pass
    assert BACKUP_YAML.count("concurrencyPolicy: Forbid") == 2
    assert BACKUP_YAML.count("automountServiceAccountToken: false") == 2
    # SEC-11: public recipients only — no private key material in the cluster.
    assert "AGE-SECRET-KEY" not in ALL_K8S
    assert "BACKUP_AGE_RECIPIENT_INNER" in BACKUP_YAML
    assert "secretKey: BACKUP_REPLICATION_PASSWORD" in EXT_SECRETS
    assert "- backup.yaml" in KUSTOMIZATION


def test_network_policy_admits_backup_pods_to_postgres_only():
    assert "- podSelector: { matchLabels: { app: postgres-backup } }   # pg_basebackup (INF-18)" in NETPOL
    assert "name: postgres-backup-egress" in NETPOL
    block = NETPOL.split("name: postgres-backup-egress", 1)[1]
    assert "to: [{ podSelector: { matchLabels: { app: postgres } } }]" in block.split("---")[0]
    assert "port: 5432" in block.split("---")[0]


def test_compose_mirrors_the_layer_with_dev_only_keys():
    assert "- archive_mode=on" in COMPOSE
    assert "- archive_timeout=300" in COMPOSE
    assert "archive_command=/usr/local/bin/presence-backup/wal-archive.sh %p %f" in COMPOSE
    assert "zz_backup_access.sh:/docker-entrypoint-initdb.d/zz_backup_access.sh:ro" in COMPOSE
    assert "pgbackups:/backups" in COMPOSE
    assert "profiles: [\"tools\"]" in COMPOSE
    assert 'user: "70"' in COMPOSE
    # dev recipients are present and clearly marked; dev identities are not committed
    assert "DEV-ONLY recipients" in COMPOSE
    assert "age1dzxr48zxrwvtr2zxvrqna235htq8ws2ze0det3a7th94kah49p9snscufh" in COMPOSE
    assert "deploy/postgres/dev-keys/*.agekey" in GITIGNORE
    assert not list((ROOT / "deploy/postgres/dev-keys").glob("*.agekey"))


def test_readme_mounts_and_documents_the_layer():
    assert "--from-file=zz_backup_access.sh=deploy/postgres/initdb/zz_backup_access.sh \\" in K8S_README
    assert "postgres-backup-config" in K8S_README
    assert "docs/ops/backup-restore.md" in K8S_README
    # the migration mount convention is untouched (0026 -> 28)
    assert "--from-file=28_dsar_transfers.sql=db/migrations/0026_dsar_transfers.sql \\" in K8S_README


def test_runbook_covers_all_five_requirements():
    for rid in ("NFR-15", "NFR-16", "NFR-24", "SEC-11", "INF-18"):
        assert rid in RUNBOOK
    assert "quarterly" in RUNBOOK
    assert "3600" in RUNBOOK
    assert "age-keygen" in RUNBOOK
    assert "dual-authorisation" in RUNBOOK


def test_traceability_artifacts_added_counts_unchanged():
    # the SEC-07/INF-01 pattern: artifacts attached, classification unchanged
    for rid in ("NFR-15", "NFR-16", "NFR-24", "SEC-11", "INF-18"):
        row = next(l for l in TRACEABILITY.splitlines() if l.startswith(f"| {rid} |"))
        assert "| external-evidence |" in row, rid
        assert "backup" in row or "backup-restore" in row, rid
    assert "| implemented | 234 |" in TRACEABILITY
    assert "| partial | 6 |" in TRACEABILITY
    assert "| gap-p0 | 0 |" in TRACEABILITY
    assert "| phase-gated | 1 |" in TRACEABILITY
    assert "| external-evidence | 29 |" in TRACEABILITY
    assert "Total requirements: **306**" in TRACEABILITY

# Backup, PITR and restore rehearsal (NFR-15/16/24, SEC-11, INF-18)

In-repo layer added in batch 51. The five driving requirements stay
classified **external-evidence**: the scripts and manifests here are the
mechanism, but the evidence (production backup cadence, key ceremony
records, drill timings) is produced by operations, not code. This runbook is
the operating procedure.

| Requirement | Mechanism | Evidence produced by |
|---|---|---|
| NFR-15 RTO ≤ 60 min (single-zone loss) | `restore-rehearse.sh` times every drill against a 3600 s budget and fails on breach | the quarterly drill log |
| NFR-16 RPO ≤ 5 min (consent ledger) | `archive_timeout=300` on the postgres args forces a WAL segment at least every 5 minutes; `wal-archive.sh` ships every segment encrypted | archive freshness checks in production |
| NFR-24 35-day retention | `enforce-retention.sh` CronJob (daily 03:41 UTC) with a hard 35-day floor | the retention CronJob history |
| SEC-11 encrypted backups, separate key, dual-authorisation restore | every artefact is age-wrapped twice (inner + outer recipients); only public keys exist in-cluster | the key ceremony + drill records |
| INF-18 PITR 5-min granularity, 35-day retention, quarterly timed restore | the whole layer; `--to` flag gives point-in-time recovery | the quarterly drill log |

## Layout

- `deploy/postgres/backup/wal-archive.sh` — `archive_command`; encrypts each
  WAL segment to `/backups/wal/<name>.age` (+ `.sha256`).
- `deploy/postgres/backup/base-backup.sh` — daily CronJob (02:17 UTC);
  `pg_basebackup` as the least-privilege `presence_backup` role, dual-wrapped,
  with a `manifest.json` (sha256, append-only table counts).
- `deploy/postgres/backup/enforce-retention.sh` — daily retention pass;
  refuses any window under 35 days and never deletes the newest restorable
  chain.
- `deploy/postgres/backup/restore-rehearse.sh` — the timed restore drill
  (below).
- `deploy/postgres/backup/wal-restore.sh` — `restore_command` used only
  inside the rehearsal's scratch instance.
- `deploy/postgres/initdb/zz_backup_access.sh` — initdb provisioning of the
  `presence_backup` role + its pg_hba replication line.

`presence_backup` is `LOGIN REPLICATION BYPASSRLS` with `SELECT` on exactly
`consent_ledger`, `admin_audit`, `transfers`, `transfer_events`. BYPASSRLS
exists so backup counts are true counts over the RLS-guarded tables — a
backup that silently saw a filtered subset would pass a rehearsal while
losing rows.

## Key ceremony (SEC-11)

1. Each of the two restore operators runs `age-keygen` **on their own
   machine**. The inner operator keeps the inner identity; the outer
   operator keeps the outer identity. Neither key is ever committed, mailed,
   or stored in the cluster or the platform secret store.
2. The two **public** recipients go into the `postgres-backup-config`
   ConfigMap (k8s) or the compose environment (dev).
3. Every backup artefact is then ciphertext that provably needs **both**
   operators to open: decryption peels the outer wrap with the outer key,
   then the inner wrap with the inner key. Losing either key makes the
   archive unreadable; either operator alone can do nothing.

Dev loop: `deploy/postgres/dev-keys/generate-dev-keys.sh` creates two
throwaway DEV-ONLY identities (gitignored) so the rehearsal runs locally.
The dev recipients are committed in `deploy/docker-compose.yml` as clearly
marked DEV-ONLY values.

## Restore procedure (RTO ≤ 60 min, NFR-15)

Single-zone loss, self-hosted install:

1. Provision the replacement node/cluster; apply the manifests
   (`kubectl apply -k deploy/k8s/` + the ConfigMap population step in
   `deploy/k8s/README.md`).
2. Both restore operators bring their identity files to the recovery
   workstation.
3. Run the rehearsal script against the backup volume — it *is* the restore
   path, so the drill and the real thing cannot drift apart:

   ```bash
   BACKUP_DIR=/backups \
   BACKUP_AGE_IDENTITY_INNER_FILE=/secure/inner.agekey \
   BACKUP_AGE_IDENTITY_OUTER_FILE=/secure/outer.agekey \
   BACKUP_REHEARSAL_OPERATOR_IDS="ops-a,ops-b" \
     restore-rehearse.sh --keep            # add --to "2026-11-25 12:00:00+00" for PITR
   ```

4. The script refuses to run without two distinct identities (SEC-11),
   verifies the artefact sha256 against the manifest, replays WAL to the
   target time, checks the four append-only tables against the manifest
   counts (replayed counts must be ≥ the manifest — append-only tables never
   shrink), and prints elapsed time against the 3600 s RTO budget.
5. With `--keep`, promote the scratch data directory into the replacement
   primary; otherwise the scratch instance is removed after verification.

## Quarterly timed restore drill (INF-18)

Once per quarter, on integration or staging (synthetic data):

1. Run step 3 above (without `--keep`).
2. Record the log line the script appends to
   `/backups/rehearsal-log/rehearsals.jsonl` — timestamp, base backup, PITR
   target, both operator ids, elapsed seconds, RTO budget, integrity status.
3. File the line with the quarter's compliance evidence. An elapsed time
   over 3600 s fails the drill and pages the infra owner.

## Retention (NFR-24)

`enforce-retention.sh` runs daily at 03:41 UTC. The window is 35 days and
cannot be set lower (`BACKUP_RETENTION_DAYS` below 35 is refused). The
newest base backup is never deleted even if it ages past the window — if
backups stall, the archive keeps its last restorable chain rather than
emptying itself. WAL segments are pruned by the same 35-day age rule; a
kept-but-old base restores up to the oldest surviving WAL.

## Production note

In production the managed Postgres equivalent provides PITR per INF-07; the
in-repo layer runs in integration/staging and self-hosted installs. The
quarterly drill is environment-independent and stays an ops duty either
way — run it against the managed restore path in production and against
this layer elsewhere.

## Automated drill (AMD-OPS-02)

`.github/workflows/restore-drill.yml` runs the round-trip weekly (Mondays
03:17 UTC) and on demand: it boots the database through the real compose
wiring — the same image build and the same `docker-entrypoint-initdb.d`
mounts, so the drill always covers the full migration set — dumps with
`pg_dump`, restores into a second database, and fails unless the restored
table count matches the source and the pinned platform fee wallet id
(`00000000-0000-0000-0000-00000000fee1`) survives. The quarterly human
drill remains: CI proves the archive restores, the human drill proves the
runbook is followable.

# Dev-only backup keys (SEC-11)

`generate-dev-keys.sh` creates two age identities (`inner.agekey`,
`outer.agekey`) so the local compose loop can exercise the dual-authorised
restore rehearsal. Both files are gitignored and marked DEV-ONLY — real
operator keys are generated per-operator and never enter git, CI, or the
cluster (see docs/ops/backup-restore.md).

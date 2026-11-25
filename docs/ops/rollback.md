# Rollback drill (ACC-06)

ACC-06: a production release can be reverted in ≤ 10 minutes. The mechanism is
`.github/workflows/rollback.yml`; this document is the drill contract.

## Mechanism

`kubectl rollout undo` returns edge and match to their previous ReplicaSets —
the digests that were live before the last promote. Because promotion only
ever moves cosign-verified digests (promote.yml, SEC-24), the previous
ReplicaSet is always a signed, previously-soaked artefact; the workflow
re-verifies both signatures after the undo and smoke-checks `/healthz`. The
job carries `timeout-minutes: 10` — an overrun fails the run, so a slow
rollback is a failed drill, not a slow success.

No data movement: rollback reverts artefacts only (INF-03). Database
migrations are expand-only, so a reverted release always runs against the
current schema — that invariant is why `rehearse_migrations.py` (INF-17)
forbids contract-breaking migrations.

## Drill procedure (per release train, and quarterly)

1. Note the current production digests:
   `kubectl -n presence get deploy edge match -o wide` (record the images).
2. Trigger the workflow: Actions → rollback → target=production,
   reason=drill-YYYY-Qn. Start a stopwatch at dispatch.
3. Watch the run: undo → rollout status → cosign re-verify → smoke. The run
   must go green within 10 minutes wall time.
4. Verify discovery works on the reverted release: one seeded scan through
   the public ingress returns 2xx.
5. Record the evidence: workflow run URL, dispatch→green wall time, the two
   digest pairs (from/to), and the operator names. Append to the drill log in
   the release record.
6. Roll forward by re-running promote.yml with the digests from step 1 —
   the soak gate accepts them because staging is untouched by a production
   rollback.

## Failure handling

- **Timeout / rollout status red:** escalate to platform incident; the
  deployment is between ReplicaSets and needs manual `rollout status` /
  `rollout restart` triage. The drill log records the failure and the
  follow-up (ACC-06 stays evidence-open until a green drill).
- **cosign re-verify red:** stop — the previous artefact no longer verifies
  (retired key or tampered registry). Do NOT force the revert; restore from
  the backup layer (docs/ops/backup-restore.md) is the wrong tool — instead
  promote the last known-good signed digest explicitly via promote.yml.

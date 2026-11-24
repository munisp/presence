# Environments and promotion (INF-02, INF-03)

Four environments exist. Two are code (`deploy/k8s` base + overlays), one is
a gate (promotion), one is a rule (synthetic-only data outside production).

## Matrix

| Environment | Where | Data policy | How it receives builds |
|---|---|---|---|
| local | `deploy/docker-compose.yml` | synthetic / developer fixtures | `docker compose up` |
| integration | `deploy/k8s/overlays/integration` | **synthetic-only** | automatic on every merge to main (`deploy.yml`, gated on `INTEGRATION_DEPLOY_ENABLED`) |
| staging | `deploy/k8s/overlays/staging` | **synthetic-only** | manual promotion (`promote.yml`, staging environment approval) |
| production | `deploy/k8s/overlays/production` | **production** — real user data lives here and nowhere else | manual promotion (`promote.yml`, production environment approval + staging soak gate) |

## The synthetic-only rule (INF-03)

Integration and staging run **synthetic data only**:

- their databases initialise from migrations alone; load and behaviour are
  produced by the synthetic generator (`presence/eval_harness.py`
  distributional generator, and the `scripts/rehearse_migrations.py`
  production-sized snapshot tooling for scale rehearsals);
- no production backup, export or replica is ever restored into a
  non-production environment. Data-shaped requests about real users go
  through the DSAR/deletion tooling, never through raw copies;
- the rule is machine-enforced: every non-production overlay labels its
  namespace `presence.dev/data-policy: synthetic-only` and
  `scripts/check_env_separation.py` fails CI if the labels, the DEPLOY_ENV
  pins, the kubeconfig isolation or the footprint caps drift.

## Promotion moves artefacts, never data

The only thing that travels between environments is a signed image digest:

1. **merge → integration** — `deploy.yml` builds reproducibly, attaches
   SBOM + SLSA provenance, signs the digest keyless with cosign (SEC-24),
   and rolls it into integration.
2. **integration → staging** — `promote.yml` re-verifies the cosign
   signature and pins the digest that integration is actually running (or
   an explicit digest) into the staging overlay.
3. **staging → production** — `promote.yml` requires explicit digests,
   enforces the **soak gate** (staging must already be running exactly
   those digests), re-verifies the signature, and rolls production.

GitHub environment protection on `staging` and `production` is the
approval step and the audit trail of who promoted what, when. Each
environment has its own cluster, its own `presence-secrets` materialised
from its own secret-store entries, and its own kubeconfig — the workflow
keeps them scoped (staging never touches the production kubeconfig; the
production job reads staging read-only for the soak gate).

## Footprint

Integration runs one replica per service (HPA capped at 4), staging two
(HPA capped at 8); production inherits the base (3 replicas, HPA to 20).
Non-production is deliberately never a silent second production.

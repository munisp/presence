# Kubernetes manifests (ARC-002 P0)

Target topology for integration/staging/production (INF-02/INF-04). Local
development stays on `deploy/docker-compose.yml`.

## Prerequisites

- **Linkerd** (TR-03, ADR-0010): install the control plane and CNI plugin
  before the first apply — the `presence` namespace carries
  `linkerd.io/inject: enabled` and the restricted Pod Security profile needs
  the CNI path (no NET_ADMIN init container):
  ```bash
  linkerd install-cni | kubectl apply -f -
  linkerd install --set cniEnabled=true | kubectl apply -f -
  linkerd check
  ```
- **External Secrets Operator** (SEC-28): production secrets are pulled from
  the managed store, never created by hand:
  ```bash
  helm install external-secrets external-secrets/external-secrets \
    -n external-secrets --create-namespace
  ```

## Apply

```bash
# 1. namespace + workloads + gateway + network policies
kubectl apply -k deploy/k8s/

# 2. populate the generated ConfigMaps (schema/seed/realms)
kubectl -n presence create configmap postgres-initdb \
  --from-file=00_keycloak.sql=deploy/keycloak/init.sql \
  --from-file=01_init.sql=db/migrations/0001_init.sql \
  --from-file=02_taxonomy.sql=db/seed/taxonomy.sql \
  --from-file=03_lifecycle.sql=db/migrations/0002_offer_lifecycle.sql \
  --from-file=04_account.sql=db/migrations/0003_account_deletion.sql \
  --from-file=05_safety.sql=db/migrations/0004_discovery_safety.sql \
  --from-file=06_floors.sql=db/migrations/0005_floors_checkin.sql \
  --from-file=07_profile_safety.sql=db/migrations/0006_profile_safety.sql \
  --from-file=08_group_surface.sql=db/migrations/0007_group_surface.sql \
  --from-file=09_moderation.sql=db/migrations/0008_moderation.sql \
  --from-file=10_rooms.sql=db/migrations/0009_rooms.sql \
  --from-file=11_devices.sql=db/migrations/0010_devices.sql \
  --from-file=12_linking.sql=db/migrations/0011_linking.sql \
  --from-file=13_taxonomy_embeddings.sql=db/seed/taxonomy_embeddings.sql \
  --from-file=14_taxonomy_cms.sql=db/migrations/0012_taxonomy_cms.sql \
  --from-file=15_telemetry.sql=db/migrations/0013_telemetry.sql \
  --from-file=16_markets.sql=db/migrations/0014_markets.sql \
  --from-file=17_recovery.sql=db/migrations/0015_recovery.sql \
  --from-file=18_age_assurance.sql=db/migrations/0016_age_assurance.sql \
  --from-file=19_geofence_review.sql=db/migrations/0017_geofence_review.sql \
  --from-file=20_analytics_publication.sql=db/migrations/0018_analytics_publication.sql \
  --from-file=21_reporting_compliance.sql=db/migrations/0019_reporting_compliance.sql \
  --from-file=22_venue_registry.sql=db/migrations/0020_venue_registry.sql \
  --from-file=23_attestation_push.sql=db/migrations/0021_attestation_push.sql \
  --from-file=24_jit_elevation.sql=db/migrations/0022_jit_elevation.sql \
  --from-file=25_geofence_qa.sql=db/migrations/0023_geofence_qa.sql \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n presence create configmap keycloak-realms \
  --from-file=deploy/keycloak/realm-consumer.json \
  --from-file=deploy/keycloak/realm-workforce.json \
  --from-file=deploy/keycloak/realm-partners.json \
  --dry-run=client -o yaml | kubectl apply -f -

# 3. secrets (SEC-28: managed secret store; nothing secret-shaped is committed)
#    Edit the ClusterSecretStore backend block in external-secrets.yaml for the
#    environment (AWS Secrets Manager or Vault), then:
kubectl apply -f deploy/k8s/external-secrets.yaml
#    The ExternalSecret materialises `presence-secrets` from the store; watch
#    `kubectl -n presence get externalsecret presence-secrets` for Ready.

# 4. progressive delivery (after Flagger + Prometheus are installed)
kubectl apply -f deploy/k8s/canary.yaml

# 5. alert set + scrape config (NFR-33/34; needs the Prometheus Operator CRDs)
kubectl apply -f deploy/k8s/prometheusrules.yaml
kubectl apply -f deploy/k8s/servicemonitor.yaml

# 6. observability stack (TECH-11: OTel Collector + Tempo + Grafana, monitoring ns)
kubectl apply -f deploy/k8s/observability.yaml
#    Grafana is internal-only: kubectl -n monitoring port-forward svc/grafana 3000:3000
```

## Environments and promotion (INF-02/INF-03)

This directory is the **base**; the three environments live in
`overlays/{integration,staging,production}` and only patch identity, data
policy, and (non-prod) footprint — never the base resources:

| Environment | Reached by | Replicas / HPA | Data policy |
|---|---|---|---|
| integration | every merge to `main` (deploy.yml) | 1 / max 4 | synthetic-only |
| staging | `promote.yml` → target `staging` | 2 / max 8 | synthetic-only |
| production | `promote.yml` → target `production` | base (3 / max 20) | production |

```bash
kubectl apply -k deploy/k8s/overlays/integration   # or staging / production
```

Promotion moves **artefacts, never data** (INF-03): `promote.yml` re-verifies
the cosign signature of the exact digests integration is running, pins them
into the target overlay with `kustomize edit set image`, and for production
enforces the staging soak gate (staging must already run those digests).
Integration and staging namespaces are labelled
`presence.dev/data-policy: synthetic-only`; real user data exists in
production only. `scripts/check_env_separation.py` runs in CI so the policy
cannot quietly rot; the full matrix is in `docs/ops/environments.md`.

## Requirement coverage

| Requirement | Where |
|---|---|
| TR-26 TLS 1.3 + HTTP/2, no downgrade | `apisix.yaml` (`ssl_protocols: TLSv1.3`, `enable_http2`) |
| INF-10 HPA p95>120 ms / 3 min, scale-in ≤1/10 min | `edge.yaml`, `match.yaml` (autoscaling/v2 `behavior`) |
| INF-11 TLS at edge, HSTS, CSP, OCSP stapling | `apisix.yaml` (TLS termination + `response-rewrite` headers + `ssl_stapling` directives); evidence collector `scripts/check_tls_posture.py`, runbook `docs/ops/tls.md` |
| INF-02 environment promotion | `overlays/{integration,staging,production}` + `.github/workflows/promote.yml` (cosign re-verify, staging soak gate) |
| INF-03 data separation | namespace `data-policy` labels in the overlays; `scripts/check_env_separation.py` CI gate; matrix in `docs/ops/environments.md` |
| INF-12 origin lockdown | `networkpolicy.yaml` (only APISIX reaches edge; only edge reaches match) |
| INF-14 egress allowlist | `networkpolicy.yaml` (default-deny + per-workload allowlists, DNS only otherwise) |
| INF-16 canary 5%/10 min + auto rollback | `canary.yaml` (Flagger on the APISIX provider) |
| TECH-21 APISIX sole public ingress | `apisix.yaml` LoadBalancer Service; everything else ClusterIP/headless |
| NFR-31 request ids | APISIX `request-id` plugin (generate + echo); service logs key on it |
| NFR-33 alert set | `prometheusrules.yaml` — SLO burn, error spike, presence-publish failure, match-rate collapse, moderation queue age, realtime delivery (NFR-07); series emitted by the services' `/metrics`, scraped via `servicemonitor.yaml` |
| NFR-34 runbook per alert | `docs/runbook.md` — every alert names an owner and first actions |
| TECH-07 Keycloak | `keycloak.yaml` + realm ConfigMap |
| TECH-11 observability stack | `observability.yaml` — OTel Collector → Tempo, Grafana datasources, monitoring namespace |
| TECH-12 health, logs, traces by default | `/healthz` + structured logs + OTel SDK in `services/*/src/tracing.ts`, started before the module graph loads |
| TR-03 east-west mutual auth | Linkerd mesh (ADR-0010) — namespace injection in `namespace.yaml`; NetworkPolicies remain the flow allowlist |
| SEC-06 TLS everywhere | Termination at APISIX; east-west encryption via the mesh (TR-03) |
| SEC-28 secrets in a managed store | `external-secrets.yaml` — ESO ClusterSecretStore + ExternalSecret; no Secret manifests committed |
| INF-17 migration rehearsal | `scripts/rehearse_migrations.py` + the migration-rehearsal CI job; checklist in `docs/ops/migrations.md` |

`scripts/validate_deploy.py` asserts the safety-critical invariants (TLS 1.3
only, HPA scale-in ceiling, default-deny policies, canary step size) and runs
in CI.

## Production deltas (documented, not built)

- Postgres/Valkey become the managed services sized per INF-06/INF-07; the
  StatefulSets here are for integration/staging.
- `presence_http_request_p95_ms` is exported by the APISIX prometheus plugin
  through prometheus-adapter; until then the CPU fallback metric keeps the
  HPAs functional.
- cert-manager issues `apisix-tls`; rotate per SEC-07.

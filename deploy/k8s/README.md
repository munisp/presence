# Kubernetes manifests (ARC-002 P0)

Target topology for integration/staging/production (INF-02/INF-04). Local
development stays on `deploy/docker-compose.yml`.

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
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n presence create configmap keycloak-realms \
  --from-file=deploy/keycloak/realm-consumer.json \
  --from-file=deploy/keycloak/realm-workforce.json \
  --from-file=deploy/keycloak/realm-partners.json \
  --dry-run=client -o yaml | kubectl apply -f -

# 3. secrets (SEC-28: managed secret store in production, never committed)
kubectl -n presence create secret generic presence-secrets \
  --from-literal=POSTGRES_USER=... --from-literal=POSTGRES_PASSWORD=... \
  --from-literal=EDGE_DATABASE_URL=... --from-literal=MATCH_DATABASE_URL=... \
  --from-literal=CENTRIFUGO_API_KEY=... --from-literal=CENTRIFUGO_TOKEN_HMAC_SECRET_KEY=... \
  --from-literal=KEYCLOAK_ADMIN=... --from-literal=KEYCLOAK_ADMIN_PASSWORD=...

# 4. progressive delivery (after Flagger + Prometheus are installed)
kubectl apply -f deploy/k8s/canary.yaml

# 5. alert set (NFR-33/34; needs the Prometheus Operator CRDs)
kubectl apply -f deploy/k8s/prometheusrules.yaml
```

## Requirement coverage

| Requirement | Where |
|---|---|
| TR-26 TLS 1.3 + HTTP/2, no downgrade | `apisix.yaml` (`ssl_protocols: TLSv1.3`, `enable_http2`) |
| INF-10 HPA p95>120 ms / 3 min, scale-in ≤1/10 min | `edge.yaml`, `match.yaml` (autoscaling/v2 `behavior`) |
| INF-11 TLS at edge, HSTS, CSP | `apisix.yaml` (TLS termination + `response-rewrite` headers); OCSP stapling delegated to the cert-manager issuance chain |
| INF-12 origin lockdown | `networkpolicy.yaml` (only APISIX reaches edge; only edge reaches match) |
| INF-14 egress allowlist | `networkpolicy.yaml` (default-deny + per-workload allowlists, DNS only otherwise) |
| INF-16 canary 5%/10 min + auto rollback | `canary.yaml` (Flagger on the APISIX provider) |
| TECH-21 APISIX sole public ingress | `apisix.yaml` LoadBalancer Service; everything else ClusterIP/headless |
| NFR-31 request ids | APISIX `request-id` plugin (generate + echo); service logs key on it |
| NFR-33 alert set | `prometheusrules.yaml` — SLO burn, error spike, presence-publish failure, match-rate collapse, moderation queue age |
| NFR-34 runbook per alert | `docs/runbook.md` — every alert names an owner and first actions |
| TECH-07 Keycloak | `keycloak.yaml` + realm ConfigMap |
| SEC-06 TLS everywhere | Termination at APISIX done; east-west encryption awaits the mesh decision (still partial) |

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

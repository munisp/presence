# Presence

Proximity-scoped interest matching. Presence shows you at most three people in
your venue who share something specific with you — with the reason why —
and keeps you anonymous until both sides choose to open a channel.

Built to **PRS-SRS-001 v1.0** and the enterprise architecture addendum
**PRS-ARC-002**. The P0 stack: React Native client, Fastify edge, stateless
match service, Valkey 8 presence, Postgres 17, Centrifugo for realtime
fan-out, and Keycloak with three realms (consumer / workforce / partners,
ARC-002 §8.2). Async work never touches the scan path.

## Repository layout

```
presence/               Python reference engine + evaluation pipeline
  graph.py              interest taxonomy: closure, decay, links (TR-04/17/19)
  matching.py           scoring contract §6.2, reasons (TR-05..TR-10)
  eval_harness.py       ACC-10 eval pack generator (answer key, rating pack)
  eval_score.py         rater scoring: Krippendorff alpha, precision@3, bands
services/match/         TypeScript match service (port of the reference engine)
  src/engine.ts         graph, corpus, scorer, icebreaker — parity-pinned
  src/scan.ts           adaptive threshold (FR-21), MMR (FR-22), bands (FR-25)
  src/store.ts          Postgres taxonomy/profiles + Valkey presence, TR-05 corpus
  test/golden.json      120-pair parity fixture exported from Python
services/edge/          Fastify edge API
  src/routes/           presence, scan, consent, content, messages
db/                     Postgres 17 schema + taxonomy seed
deploy/keycloak/        realm imports (consumer/workforce/partners) + KC db init
deploy/apisix/          gateway standalone config for the dev compose stack
deploy/k8s/             K8s manifests: workloads, APISIX gateway, HPA (INF-10),
                        NetworkPolicy (INF-12/14), Flagger canary (INF-16)
deploy/docker-compose.yml   the P0 stack (APISIX fronts :9080)
scripts/validate_deploy.py  asserts the deployment invariants (TR-26, INF-10..16)
docs/                   presence model, traceability, ADRs
tests/                  Python regression suite (TR-10, 60 key-pinned pairs)
eval/                   generated ACC-10 artifacts (key, pack, results)
```

## The matching engine in one paragraph

`sim(A,B) = Σ idf(n)·wA(n)·wB(n) / (‖vA‖·‖vB‖)`, where a profile's vector is
its weighted taxonomy closure — a declared interest contributes 1.0 to itself
and 0.55 per hop up to four hops up (TR-04), combining by max. Semantic links
(rivalry, neighbour, co-occurrence) contribute one hop at the authored weight
and never enter document frequency (TR-07). `idf(n) = sqrt(ln(1 + N/(1+df)))`
is square-root-compressed so one rare shared interest cannot dominate (TR-06).
An exact-overlap bonus of 5% per node declared by both profiles rewards
interest that needs no interpretation; scores cap at 1.0. Every match returns
an ordered reason list (same / related / sibling / ancestor) rendered
deterministically — no LLM (TR-08/09). The Python reference reproduces the
ACC-10 answer key 653/653 to four decimals; the TypeScript port is pinned to
the reference to 1e-9 on a 120-pair golden fixture.

## Quickstart

```bash
docker compose -f deploy/docker-compose.yml up --build
# edge on :4000, match on :4100, centrifugo on :8000, keycloak on :8080
# (admin / p0-dev-admin — dev only). The edge verifies consumer-realm RS256
# tokens via JWKS (KEYCLOAK_ISSUER); unset it to fall back to the HS256 dev secret.
# APISIX (sole public ingress, TECH-21) fronts the API on :9080 — prefer
# http://localhost:9080/v1/... over hitting the edge directly.

# Kubernetes (integration/staging/production): see deploy/k8s/README.md
kubectl apply -k deploy/k8s/
```

## Development

```bash
# Python engine + regression suite (81 tests)
python3 -m pytest tests/test_matching.py -q

# ACC-10 evaluation pipeline (self-test)
python3 -m presence.eval_harness            # writes eval/key.csv, rating-pack.xlsx
python3 -m presence.eval_score --simulate   # pipeline self-test (not a result)

# TypeScript services (Node 22 LTS, TECH-03)
cd services/match && npm install && npm test
cd services/edge  && npm install && npm test

# Taxonomy seed from the graph module
PYTHONPATH=. python3 scripts/export_taxonomy_sql.py > db/seed/taxonomy.sql
```

## Verification status

| Check | Result |
|---|---|
| Answer-key reproduction (653 scored pairs) | 653/653 exact to 4 dp |
| Python regression suite (TR-10) | 81 passed |
| TS ↔ Python parity (120 golden pairs, scores + reasons) | agree to 1e-9 |
| Match service unit tests (FR-20/21/22/25) | 7 passed |
| Edge unit tests (TR-12/14/15, FR-23) | 3 passed |
| Eval pipeline self-test | alpha 0.832, precision@3 0.389 vs 0.33 target — PASS |

Known divergence, documented honestly: on mathematically tied reason
candidates (identical contribution), the harness's historical tie-break is not
recoverable from the answer key (67 of 1390 rendered strings differ on ties;
the preference relation cycles, so no static ordering reproduces it). Scores
are unaffected. The engine uses the spec-compliant deterministic ordering
`(-contribution, node id)` (TR-09/10).

See `docs/traceability.md` for the requirement → code map and `docs/adr/` for
the architecture decisions from PRS-ARC-002.

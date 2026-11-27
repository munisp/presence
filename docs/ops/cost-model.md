# Cost model at 100k MAU (INF-19)

INF-19: steady-state platform cost ≤ EUR 1 500 / month at 100 000 MAU. This is
the model; actuals come from Kubecost (P1) once the runtime stack lands, with
a monthly review against this budget. Prices are public on-demand EU-region
list prices as of the model date — re-baseline at each review.

## Monthly estimate

| Line | Shape (from INF-05..08) | EUR/mo |
|---|---|---|
| Compute (edge, match, apisix, centrifugo, keycloak, observability) | 6 × 4 vCPU/16 GB nodes | 420 |
| Postgres | 4 vCPU/16 GB managed + 500 GB SSD (INF-07) | 260 |
| Valkey | 1 primary + 1 replica, 4 GB (INF-06) | 90 |
| Load balancer + egress | single LB (TECH-21), ~4 TB egress | 260 |
| Backups | 500 GB encrypted, 35-day retention (NFR-24) | 70 |
| Observability retention | metrics/traces 30 d | 120 |
| Keycloak + APISIX overhead | shared nodes above | — |
| **Subtotal** | | **1 220** |
| Headroom (25%) | spot/interruptible mix buys this back | 180 |
| **Total** | | **1 400** |

Total EUR 1 400 ≤ the EUR 1 500 budget with headroom intact.

## Levers if actuals breach

1. Spot/interruptible nodes for the stateless tier (edge/match are HPA-driven
   and tolerate churn; the stateful set stays on-demand).
2. Egress is the swing item: cells-not-coordinates (TR-15) already minimises
   payload size; the TR-44 static-tile tier (AMD-MAP-06) now serves map
   imagery as immutable year-cached static assets — a CDN in front of
   tiles.presence.example is a config change, not a code change.
3. Observability retention tiering (traces 7 d hot / 30 d cold).

## Standing duty

Monthly: pull the Kubecost report, compare against the table, file the delta
in the ops review. A breach two months running triggers the levers above in
order. The model is reviewed on any pricing change by the cloud provider.

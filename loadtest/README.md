# Load & evidence harness (ACC-04)

k6 scenarios that measure the latency, capacity and availability requirements
against a production-equivalent environment. `targets.js` is the single source
of truth for the requirement numbers — every scenario imports from it, so a
scenario can never quietly drift from the requirement text.

| Scenario | Measures | Duration |
|---|---|---|
| `scan-latency.js` | NFR-01 scan p95 ≤ 150 ms, NFR-02 p99 ≤ 400 ms, NFR-03 publish ack p95 ≤ 120 ms, NFR-06 tap-to-results server legs p95 ≤ 900 ms | 10 min |
| `capacity.js` | NFR-09 600 scans/s peak, NFR-08 25 000 concurrent presences, NFR-10 60 000 single-venue burst per 10 min; NFR-11 via `PEAK_MULTIPLIER=2` | ~40 min |
| `soak.js` | ACC-04 soak: 2 h at 60% of peak with the same thresholds | 2 h |
| `ratelimit-probe.js` | INF-13: the gateway per-IP limit sheds a flood with 429 while allowed traffic keeps p99 ≤ 400 ms | 2 min |
| `escrow-concurrency.js` | AMD-ESC: 200 release-vs-dispute races; exactly one terminal outcome per escrow (completed XOR disputed) and zero reconciliation balance mismatches afterwards | ~5 min |

## Environment contract

- **Production-equivalent sizing** (ACC-04): the INF-05/INF-06/INF-07 shapes —
  edge + match at 3× 2 vCPU/4 GB, Valkey 1+1, Postgres 4 vCPU/16 GB, Centrifugo
  2× 2 vCPU. Measuring on smaller hardware measures the hardware, not the
  system.
- **Seeded users**: the edge enforces per-user rate limits (6 scans/min), so
  every scenario draws tokens from `TOKEN_FILE` (one token per seeded
  load-test account, round-robin by VU). Create the accounts in the load-test
  realm of the environment under test; never run against production accounts.
- **Source IPs**: APISIX enforces a per-IP limit-count window on `/v1/*`
  (INF-13). Load generators must run from enough source IPs, or the window is
  raised for the generator IPs in the load environment only — never in
  production. `ratelimit-probe.js` is the exception: it *wants* to trip the
  limit, from one source, against the unauthenticated `/v1/client/config`.
- **NFR-06 caveat**: the harness measures the server legs of tap-to-results
  (publish + scan). The device render leg is client-side evidence — the
  device-profiling runs (`scripts/profile_device_budgets.py`) complement this.
- **Escrow pairs**: `escrow-concurrency.js` draws payer/payee token pairs
  from `PAIRS_FILE` (see its header); every payer wallet must be pre-funded
  for both milestones, and `MOD_TOKEN` (a moderator token) is required for
  the post-race reconciliation conservation check.

## Running

```bash
k6 run -e BASE_URL=https://api.presence.example \
       -e TOKEN_FILE=./tokens.loadtest.json \
       --out json=evidence/scan-latency-$(date -u +%Y%m%dT%H%M%SZ).json \
       loadtest/scan-latency.js
```

k6 exits non-zero when any threshold is breached — the run itself is the
gate. NFR-11 scale-out evidence: re-run `capacity.js` with
`-e PEAK_MULTIPLIER=2` and record the HPA pod counts doubling
(`kubectl -n presence get hpa -w`).

## Evidence capture

Each run's JSON output plus the matching Grafana dashboard export (latency,
error rate, pod counts, Postgres/Valkey health) is one evidence record. Store
records under the release they measured; the acceptance gate (ACC-01) is the
pilot sign-off that these records exist and pass. NFR-13 availability is a
30-day measurement — the `ScanAvailabilityBurn` alert in
`deploy/k8s/prometheusrules.yaml` carries the 99.9% budget between load runs.

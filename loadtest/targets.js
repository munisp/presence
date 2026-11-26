// Presence load-test targets — the SINGLE source of truth for the numbers the
// scenarios assert. Every value is copied from the requirement text; a scenario
// that drifts from the requirement is a failed measurement, not a failed run.
//
//   NFR-01  scan server latency p95 <= 150 ms
//   NFR-02  scan server latency p99 <= 400 ms
//   NFR-03  presence publish ack p95 <= 120 ms
//   NFR-06  tap-to-results p95 <= 900 ms (server legs measured here; the
//           device render leg is client-side evidence — see README)
//   NFR-08  25 000 concurrent presences per city cluster
//   NFR-09  600 scans/s at p95 peak
//   NFR-10  60 000 single-venue burst per 10 min
//   NFR-11  linear 2x scale-out without schema/client change (mechanism: the
//           edge/match HPAs in deploy/k8s; observed during capacity runs)
//   NFR-13  99.9% scan-path availability over 30 d (alert in
//           deploy/k8s/prometheusrules.yaml; the load runs must show
//           failed-request rate under the 0.1% error budget)
//   ACC-04  load + soak profile on production-equivalent infrastructure
//           (soak.js — 2 h at 60% of the NFR-09 peak)
//   INF-13  edge DDoS mitigation (ratelimit-probe.js — the gateway per-IP
//           limit-count must reject flood traffic with 429)

export const SCAN_P95_MS = 150;            // NFR-01
export const SCAN_P99_MS = 400;            // NFR-02
export const PUBLISH_ACK_P95_MS = 120;     // NFR-03
export const TAP_TO_RESULTS_P95_MS = 900;  // NFR-06 (server legs)
export const SCANS_PER_SECOND_PEAK = 600;  // NFR-09
export const CONCURRENT_PRESENCES = 25000; // NFR-08
export const VENUE_BURST_PER_10MIN = 60000;// NFR-10
export const SOAK_DURATION = "2h";         // ACC-04
export const SOAK_RATE_RATIO = 0.6;        // ACC-04: 60% of the NFR-09 peak
export const ERROR_BUDGET = 0.001;         // NFR-13: 99.9% availability

// Heartbeat cadence: presence TTL is 900 s (FR-14); the reduced-power mode
// republishes every 600 s (FR-85) — the slowest legal cadence, used here so
// the capacity run measures the floor, not a friendlier clock.
export const HEARTBEAT_S = 600;

// Per-user budgets the harness must respect: the edge enforces 6 scans/min
// per user (in-process rate limit) — one virtual user may scan at most once
// per 10 s. High-rate scenarios therefore need seeded users, not retries.
export const SCAN_PERIOD_S_PER_USER = 10;

// AMD-ESC (batch 58): escrow concurrency profile (escrow-concurrency.js).
// Each pair races payer releases against a payee dispute on one escrow; the
// platform invariant under test is exactly-one-terminal-outcome (completed
// XOR disputed) plus wallet-ledger conservation afterwards. The milestone
// amount stays under the AMD-ESC-01 four-eyes threshold so the race itself
// never needs a second moderator.
export const ESCROW_RACE_PAIRS = 200;
export const ESCROW_RACE_MILESTONE_MINOR = 400000; // NGN 4,000.00 x 2
export const ESCROW_TERMINAL_CONSISTENCY = 1.0;    // XOR must hold for all

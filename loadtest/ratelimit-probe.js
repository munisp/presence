// INF-13: gateway rate-limit probe — the pre-launch DDoS-mitigation test.
// Hits GET /v1/client/config (unauthenticated bootstrap, TR-33) from one
// source identity at a rate far above the APISIX per-IP limit-count window
// (apisix.yaml: 1200 req/60 s on /v1/*) and asserts the gateway sheds the
// flood with 429 while allowed traffic keeps normal latency. Runs WITHOUT
// tokens; safe against any environment with the gateway limit deployed.
//
// A PASS means: some requests were rejected with 429 AND allowed requests
// stayed under the NFR-02 p99 budget — the limiter sheds load instead of
// queueing it.

import http from "k6/http";
import { Trend, Counter } from "k6/metrics";
import { check } from "k6";
import { SCAN_P99_MS } from "./targets.js";

const allowed = new Trend("ratelimit_allowed_latency", true);
const rejected = new Counter("ratelimit_rejected_429");

export const options = {
  scenarios: {
    flood: {
      executor: "constant-arrival-rate",
      rate: 1500, // 1500/min-equivalent burst — above the 1200/60 s gateway window
      timeUnit: "1s",
      duration: "2m",
      preAllocatedVUs: 100,
      maxVUs: 500,
    },
  },
  thresholds: {
    ratelimit_rejected_429: ["count>0"], // the limiter MUST fire
    ratelimit_allowed_latency: [`p(99)<${SCAN_P99_MS}`],
  },
};

export default function () {
  const r = http.get(`${__ENV.BASE_URL}/v1/client/config`);
  if (r.status === 429) {
    rejected.add(1);
  } else {
    check(r, { "allowed 200": (x) => x.status === 200 });
    allowed.add(r.timings.duration);
  }
}

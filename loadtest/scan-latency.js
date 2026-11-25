// NFR-01 / NFR-02 / NFR-03 / NFR-06: latency thresholds on the three
// user-facing server calls. A run PASSES only if every threshold holds;
// k6 exits non-zero on breach, so the CI-of-record is the run itself.
//
//   k6 run -e BASE_URL=https://api.presence.example \
//          -e TOKEN_FILE=./tokens.loadtest.json loadtest/scan-latency.js
//
// Tokens: one per seeded load-test user (see README — the edge enforces
// per-user rate limits, so looping one token is a measurement error).

import http from "k6/http";
import { Trend } from "k6/metrics";
import { check, sleep } from "k6";
import {
  SCAN_P95_MS,
  SCAN_P99_MS,
  PUBLISH_ACK_P95_MS,
  TAP_TO_RESULTS_P95_MS,
  SCAN_PERIOD_S_PER_USER,
  ERROR_BUDGET,
} from "./targets.js";

const scanLatency = new Trend("scan_latency", true);          // NFR-01/02
const publishAck = new Trend("publish_ack_latency", true);    // NFR-03
const tapToResults = new Trend("tap_to_results", true);       // NFR-06 server legs

export const options = {
  scenarios: {
    latency: {
      executor: "constant-vus",
      vus: 50,
      duration: "10m",
    },
  },
  thresholds: {
    scan_latency: [`p(95)<${SCAN_P95_MS}`, `p(99)<${SCAN_P99_MS}`],
    publish_ack_latency: [`p(95)<${PUBLISH_ACK_P95_MS}`],
    tap_to_results: [`p(95)<${TAP_TO_RESULTS_P95_MS}`],
    http_req_failed: ["rate<" + ERROR_BUDGET], // NFR-13 error budget
  },
};

const tokens = JSON.parse(open(__ENV.TOKEN_FILE || "./tokens.loadtest.json"));

function token() {
  return tokens[__VU % tokens.length];
}

function headers() {
  return {
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      "X-Api-Version": "1", // TR-27 contract header
    },
  };
}

// One iteration = one full tap-to-results cycle for one user:
// publish (NFR-03) → scan (NFR-01/02). The composite trend covers the server
// legs of NFR-06; the device render leg is measured on the client.
export default function () {
  const base = __ENV.BASE_URL;
  const cell = `872e4d6${(__VU % 16).toString(16)}ffffff`; // fixed Lagos test cells

  const t0 = Date.now();
  const pub = http.post(`${base}/v1/presence`, JSON.stringify({ cell }), headers());
  check(pub, { "publish 2xx": (r) => r.status >= 200 && r.status < 300 });
  publishAck.add(pub.timings.duration);

  const scan = http.post(`${base}/v1/scan`, JSON.stringify({}), headers());
  check(scan, { "scan 2xx": (r) => r.status >= 200 && r.status < 300 });
  scanLatency.add(scan.timings.duration);

  tapToResults.add(Date.now() - t0);

  // One user may scan at most once per 10 s (6/min in-process limit).
  sleep(SCAN_PERIOD_S_PER_USER);
}

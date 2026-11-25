// ACC-04: soak profile — 2 h at 60% of the NFR-09 peak scan rate with a
// realistic mix (publishes on the reduced-power cadence underneath). The soak
// is the leak/fragmentation detector: thresholds are the same as the latency
// run, so a degrading system fails the run, and the k6 summary is attached to
// the ACC-04 evidence record with the cluster's memory/CPU dashboards.

import http from "k6/http";
import { Trend } from "k6/metrics";
import { check, sleep } from "k6";
import {
  SCAN_P95_MS,
  SCAN_P99_MS,
  PUBLISH_ACK_P95_MS,
  SCANS_PER_SECOND_PEAK,
  SOAK_DURATION,
  SOAK_RATE_RATIO,
  SCAN_PERIOD_S_PER_USER,
  ERROR_BUDGET,
} from "./targets.js";

const scanLatency = new Trend("scan_latency", true);
const publishAck = new Trend("publish_ack_latency", true);

export const options = {
  scenarios: {
    soak: {
      executor: "constant-arrival-rate",
      rate: Math.floor(SCANS_PER_SECOND_PEAK * SOAK_RATE_RATIO), // 360 it/s
      timeUnit: "1s",
      duration: SOAK_DURATION, // ACC-04: 2h
      preAllocatedVUs: 400,
      maxVUs: 4000,
    },
  },
  thresholds: {
    scan_latency: [`p(95)<${SCAN_P95_MS}`, `p(99)<${SCAN_P99_MS}`],
    publish_ack_latency: [`p(95)<${PUBLISH_ACK_P95_MS}`],
    http_req_failed: ["rate<" + ERROR_BUDGET],
    dropped_iterations: ["count==0"],
  },
};

const tokens = JSON.parse(open(__ENV.TOKEN_FILE || "./tokens.loadtest.json"));

function headers(vu) {
  return {
    headers: {
      Authorization: `Bearer ${tokens[vu % tokens.length]}`,
      "Content-Type": "application/json",
      "X-Api-Version": "1",
    },
  };
}

export default function () {
  const vu = __VU;
  const cell = `872e4d6${(vu % 16).toString(16)}ffffff`;
  const pub = http.post(`${__ENV.BASE_URL}/v1/presence`, JSON.stringify({ cell }), headers(vu));
  check(pub, { "publish 2xx": (r) => r.status >= 200 && r.status < 300 });
  publishAck.add(pub.timings.duration);
  const scan = http.post(`${__ENV.BASE_URL}/v1/scan`, JSON.stringify({}), headers(vu));
  check(scan, { "scan 2xx": (r) => r.status >= 200 && r.status < 300 });
  scanLatency.add(scan.timings.duration);
  sleep(SCAN_PERIOD_S_PER_USER);
}

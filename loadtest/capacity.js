// NFR-08 / NFR-09 / NFR-10 / NFR-11: capacity scenarios on a
// production-equivalent cluster (ACC-04 env). Three stages run in sequence:
//
//   peak_scans     NFR-09 — 600 scans/s for 10 min while latency thresholds
//                  hold (the peak hour shape).
//   concurrent     NFR-08 — 25 000 VUs hold a published presence and
//                  heartbeat on the FR-85 reduced-power cadence (600 s), the
//                  slowest legal clock — the presence-set floor.
//   venue_burst    NFR-10 — 100 publishes/s into ONE venue cell for 10 min
//                  (60 000 per 10 min — a stadium gate opening).
//
// NFR-11 (linear 2x scale-out): re-run peak_scans at 2x rate
// (-e PEAK_MULTIPLIER=2) and confirm the HPAs (deploy/k8s/edge.yaml,
// match.yaml) double the pod count with no schema or client change; the
// thresholds in targets.js must still hold.

import http from "k6/http";
import { Trend } from "k6/metrics";
import { check, sleep } from "k6";
import {
  SCAN_P95_MS,
  SCAN_P99_MS,
  PUBLISH_ACK_P95_MS,
  SCANS_PER_SECOND_PEAK,
  CONCURRENT_PRESENCES,
  VENUE_BURST_PER_10MIN,
  HEARTBEAT_S,
  ERROR_BUDGET,
} from "./targets.js";

const scanLatency = new Trend("scan_latency", true);
const publishAck = new Trend("publish_ack_latency", true);

const PEAK_MULTIPLIER = Number(__ENV.PEAK_MULTIPLIER || "1"); // NFR-11: run at 2x

export const options = {
  scenarios: {
    peak_scans: {
      executor: "constant-arrival-rate",
      rate: SCANS_PER_SECOND_PEAK * PEAK_MULTIPLIER, // NFR-09
      timeUnit: "1s",
      duration: "10m",
      preAllocatedVUs: 600,
      maxVUs: 5000,
      exec: "scanOnly",
      startTime: "0s",
    },
    concurrent: {
      executor: "constant-vus",
      vus: CONCURRENT_PRESENCES, // NFR-08
      duration: "20m",
      exec: "holdPresence",
      startTime: "10m",
      gracefulStop: "30s",
    },
    venue_burst: {
      executor: "constant-arrival-rate",
      rate: VENUE_BURST_PER_10MIN / 600, // NFR-10: 60 000 per 600 s = 100/s
      timeUnit: "1s",
      duration: "10m",
      preAllocatedVUs: 200,
      maxVUs: 2000,
      exec: "venueBurst",
      startTime: "30m",
    },
  },
  thresholds: {
    scan_latency: [`p(95)<${SCAN_P95_MS}`, `p(99)<${SCAN_P99_MS}`],
    publish_ack_latency: [`p(95)<${PUBLISH_ACK_P95_MS}`],
    http_req_failed: ["rate<" + ERROR_BUDGET], // NFR-13 error budget
    dropped_iterations: ["count==0"],
  },
};

const tokens = JSON.parse(open(__ENV.TOKEN_FILE || "./tokens.loadtest.json"));
const VENUE_CELL = "872e4d687ffffff"; // the seeded stadium venue cell

function headers(vu) {
  return {
    headers: {
      Authorization: `Bearer ${tokens[vu % tokens.length]}`,
      "Content-Type": "application/json",
      "X-Api-Version": "1",
    },
  };
}

function cell(vu) {
  return `872e4d6${(vu % 16).toString(16)}ffffff`;
}

export function scanOnly() {
  const r = http.post(`${__ENV.BASE_URL}/v1/scan`, JSON.stringify({}), headers(__VU));
  check(r, { "scan 2xx": (x) => x.status >= 200 && x.status < 300 });
  scanLatency.add(r.timings.duration);
}

export function holdPresence() {
  // Publish once, then heartbeat on the reduced-power cadence for the
  // duration — 25 000 concurrent live presences (NFR-08).
  const pub = http.post(
    `${__ENV.BASE_URL}/v1/presence`,
    JSON.stringify({ cell: cell(__VU) }),
    headers(__VU),
  );
  check(pub, { "publish 2xx": (x) => x.status >= 200 && x.status < 300 });
  publishAck.add(pub.timings.duration);
  for (;;) {
    sleep(HEARTBEAT_S);
    const hb = http.post(
      `${__ENV.BASE_URL}/v1/presence`,
      JSON.stringify({ cell: cell(__VU) }),
      headers(__VU),
    );
    check(hb, { "heartbeat 2xx": (x) => x.status >= 200 && x.status < 300 });
    publishAck.add(hb.timings.duration);
  }
}

export function venueBurst() {
  const r = http.post(
    `${__ENV.BASE_URL}/v1/presence`,
    JSON.stringify({ cell: VENUE_CELL }),
    headers(__VU),
  );
  check(r, { "burst publish 2xx": (x) => x.status >= 200 && x.status < 300 });
  publishAck.add(r.timings.duration);
}

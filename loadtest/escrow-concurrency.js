// AMD-ESC (batch 58): escrow concurrency race — release vs dispute fired in
// parallel against the same escrow. Asserts the platform's escrow integrity
// invariant under contention:
//
//   * exactly one terminal outcome per escrow — 'completed' (every milestone
//     released) XOR 'disputed' (the dispute won the row lock); the losing
//     calls are refused, never applied, and
//   * the wallet ledger conserves value afterwards — the moderator
//     reconciliation reports zero balance mismatches.
//
// Each pair needs a funded payer wallet covering both milestones
// (ESCROW_RACE_MILESTONE_MINOR x 2). Run:
//
//   k6 run -e BASE_URL=https://edge.example -e MOD_TOKEN=<moderator> \
//          -e PAIRS_FILE=./escrow-pairs.loadtest.json \
//          loadtest/escrow-concurrency.js
//
// PAIRS_FILE: [{"payerToken": "...", "payeeToken": "...", "payeeId": "..."}]
// with at least ESCROW_RACE_PAIRS entries. A PASS requires BOTH terminal
// outcomes to be observed across the fleet — a run where one side always
// wins proves nothing about the race.

import http from "k6/http";
import { Counter } from "k6/metrics";
import exec from "k6/execution";
import { check } from "k6";
import {
  ESCROW_RACE_MILESTONE_MINOR,
  ESCROW_RACE_PAIRS,
} from "./targets.js";

const releaseAccepted = new Counter("escrow_race_release_accepted");
const disputeAccepted = new Counter("escrow_race_dispute_accepted");
const raceRejected = new Counter("escrow_race_rejected");
const terminalCompleted = new Counter("escrow_terminal_completed");
const terminalDisputed = new Counter("escrow_terminal_disputed");
const terminalConsistent = new Counter("escrow_terminal_consistent");
const terminalInconsistent = new Counter("escrow_terminal_inconsistent");
const conservationViolations = new Counter("escrow_conservation_violations");

export const options = {
  scenarios: {
    race: {
      executor: "shared-iterations",
      iterations: ESCROW_RACE_PAIRS,
      vus: Math.min(ESCROW_RACE_PAIRS, 50),
      maxDuration: "10m",
    },
  },
  thresholds: {
    // The invariant: no escrow may ever end in an impossible state.
    escrow_terminal_inconsistent: ["count==0"],
    escrow_terminal_consistent: [`count==${ESCROW_RACE_PAIRS}`],
    escrow_conservation_violations: ["count==0"],
    // The race must be real: both outcomes observed somewhere in the fleet.
    escrow_terminal_completed: ["count>0"],
    escrow_terminal_disputed: ["count>0"],
  },
};

const pairs = JSON.parse(
  open(__ENV.PAIRS_FILE || "./escrow-pairs.loadtest.json"),
);
if (pairs.length < ESCROW_RACE_PAIRS) {
  throw new Error(
    `PAIRS_FILE has ${pairs.length} pairs; ESCROW_RACE_PAIRS=${ESCROW_RACE_PAIRS}`,
  );
}

const auth = (token) => ({
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
});

export function setup() {
  const escrows = [];
  for (let i = 0; i < ESCROW_RACE_PAIRS; i += 1) {
    const pair = pairs[i];
    const res = http.post(
      `${__ENV.BASE_URL}/v1/escrows`,
      JSON.stringify({
        payee: pair.payeeId,
        milestones: [ESCROW_RACE_MILESTONE_MINOR, ESCROW_RACE_MILESTONE_MINOR],
      }),
      auth(pair.payerToken),
    );
    check(res, { "escrow created": (r) => r.status === 201 });
    escrows.push({
      escrowId: res.json("escrowId"),
      payerToken: pair.payerToken,
      payeeToken: pair.payeeToken,
    });
  }
  return { escrows };
}

export default function (data) {
  const e = data.escrows[exec.scenario.iterationInTest];
  const base = __ENV.BASE_URL;

  // The race: payer releases both milestones while the payee disputes — all
  // three calls in flight at once; the escrow row lock serializes them.
  const [r1, r2, rd] = http.batch([
    ["POST", `${base}/v1/escrows/${e.escrowId}/milestones/1/release`, "{}", auth(e.payerToken)],
    ["POST", `${base}/v1/escrows/${e.escrowId}/milestones/2/release`, "{}", auth(e.payerToken)],
    ["POST", `${base}/v1/escrows/${e.escrowId}/dispute`, "{}", auth(e.payeeToken)],
  ]);
  for (const r of [r1, r2]) {
    if (r.status === 200) releaseAccepted.add(1); else raceRejected.add(1);
  }
  if (rd.status === 200) disputeAccepted.add(1); else raceRejected.add(1);

  // Terminal-state verification for THIS escrow (its race has settled —
  // batch() returned every response).
  const view = http.get(`${base}/v1/escrows`, auth(e.payerToken));
  const escrows = view.json("escrows") || [];
  const milestones = view.json("milestones") || [];
  const row = escrows.find((x) => x.escrowId === e.escrowId);
  const ms = milestones.filter((x) => x.escrowId === e.escrowId);
  const allReleased = ms.length === 2 && ms.every((x) => x.state === "released");
  const completed = row && row.state === "completed" && allReleased;
  const disputed = row && row.state === "disputed" && !allReleased;

  if (completed) terminalCompleted.add(1);
  if (disputed) terminalDisputed.add(1);
  if (completed !== disputed && row) {
    terminalConsistent.add(1); // exactly one terminal outcome — XOR holds
  } else {
    terminalInconsistent.add(1);
    console.error(
      `escrow ${e.escrowId} inconsistent: state=${row && row.state} ` +
        `milestones=${JSON.stringify(ms)} ` +
        `r1=${r1.status} r2=${r2.status} rd=${rd.status}`,
    );
  }
}

export function teardown() {
  // Wallet-ledger conservation after the whole fleet: the moderator
  // reconciliation recomputes every balance from the ledger (AMD-ESC-02).
  const rec = http.get(
    `${__ENV.BASE_URL}/v1/moderation/wallets/reconciliation`,
    auth(__ENV.MOD_TOKEN),
  );
  const mismatches =
    rec.status === 200 ? (rec.json("balanceMismatches") || []).length : -1;
  if (mismatches !== 0) {
    conservationViolations.add(1);
    console.error(
      `conservation violated: reconciliation status=${rec.status} ` +
        `balanceMismatches=${rec.body}`,
    );
  }
}

/** AMD-KYC-06..10: OpenKYC verification — client contract tests. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ACCEPT_MIN,
  ACTION_WINDOW_MS,
  CHALLENGE_ACTIONS,
  CHALLENGE_COUNT,
  CREDENTIAL_KINDS,
  REVIEW_FLOOR,
  SESSION_STATES,
  SESSION_TTL_SECONDS,
  capturePlan,
  parseSessionIssue,
  parseSessionStatus,
  sessionAction,
} from "../src/presence/kycCapture.js";

const MIGRATION = readFileSync("../db/migrations/0038_openkyc.sql", "utf8");
const EDGE_MODULE = readFileSync("../services/edge/src/kycVerification.ts", "utf8");
const PY_LIVENESS = readFileSync("../services/openkyc/openkyc/liveness.py", "utf8");
const PY_PIPELINE = readFileSync("../services/openkyc/openkyc/pipeline.py", "utf8");
const COPY = readFileSync("src/presence/copyRegistry.ts", "utf8");

test("AMD-KYC-07: the challenge vocabulary agrees across all four mirrors", () => {
  assert.deepEqual(
    [...CHALLENGE_ACTIONS],
    ["blink", "turn_left", "turn_right", "smile", "nod"],
  );
  assert.equal(CHALLENGE_COUNT, 3);
  assert.equal(ACTION_WINDOW_MS, 4000);
  assert.equal(SESSION_TTL_SECONDS, 600);
  assert.ok(PY_LIVENESS.includes('("blink", "turn_left", "turn_right", "smile", "nod")'));
  assert.ok(PY_LIVENESS.includes("ACTION_WINDOW_MS = 4000"));
  assert.ok(PY_LIVENESS.includes("SESSION_TTL_SECONDS = 600"));
  assert.ok(EDGE_MODULE.includes('"blink", "turn_left", "turn_right", "smile", "nod"'));
  assert.ok(EDGE_MODULE.includes("ACTION_WINDOW_MS = 4000"));
});

test("AMD-KYC-08: the session states and credential kinds mirror the SQL", () => {
  assert.deepEqual([...SESSION_STATES], ["issued", "review", "verified", "rejected", "expired"]);
  assert.ok(MIGRATION.includes("CHECK (state IN ('issued', 'review', 'verified',"));
  assert.deepEqual([...CREDENTIAL_KINDS], ["id_card", "driving_permit", "travel_document"]);
  for (const kind of CREDENTIAL_KINDS) assert.ok(MIGRATION.includes(`'${kind}'`), kind);
  assert.equal(ACCEPT_MIN, 0.8);
  assert.equal(REVIEW_FLOOR, 0.5);
  assert.ok(PY_PIPELINE.includes("ACCEPT_MIN = 0.80"));
  assert.ok(PY_PIPELINE.includes("REVIEW_FLOOR = 0.50"));
  assert.ok(EDGE_MODULE.includes("ACCEPT_MIN = 0.8"));
});

test("AMD-KYC-07: the capture plan walks the issued challenge in order", () => {
  const challenge = [
    { action: "nod", windowMs: 4000 },
    { action: "blink", windowMs: 4000 },
    { action: "smile", windowMs: 4000 },
  ] as const;
  const plan = capturePlan([...challenge]);
  assert.deepEqual(plan.map((s) => s.action), ["nod", "blink", "smile"]);
  for (const step of plan) {
    assert.equal(step.windowMs, 4000);
    assert.ok(COPY.includes(`"${step.copyKey}"`), step.copyKey);
  }
});

test("AMD-KYC-08: the issue parser fails closed", () => {
  const good = {
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    challenge: [
      { action: "blink", windowMs: 4000 },
      { action: "nod", windowMs: 4000 },
      { action: "smile", windowMs: 4000 },
    ],
    challengeToken: "a".repeat(64),
    expiresAt: 1764000600,
    uploadUrl: "/openkyc/v1/captures",
  };
  assert.ok(parseSessionIssue(good) !== null);
  assert.equal(parseSessionIssue(null), null);
  assert.equal(parseSessionIssue({ ...good, sessionId: "nope" }), null);
  assert.equal(parseSessionIssue({ ...good, challenge: good.challenge.slice(0, 2) }), null);
  const dup = { ...good, challenge: [good.challenge[0], good.challenge[0], good.challenge[0]] };
  assert.equal(parseSessionIssue(dup), null);
  assert.equal(parseSessionIssue({ ...good, challengeToken: "zz" }), null);
  assert.equal(parseSessionIssue({ ...good, expiresAt: "soon" }), null);
});

test("AMD-KYC-08: the status parser fails closed and never leaks scores", () => {
  const good = {
    session: {
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      state: "review",
      issuedAt: "2026-11-27T10:00:00Z",
      expiresAt: "2026-11-27T10:10:00Z",
      decidedAt: null,
    },
  };
  const parsed = parseSessionStatus(good);
  assert.ok(parsed !== null);
  assert.equal(parsed.state, "review");
  assert.equal(parseSessionStatus({ session: { ...good.session, state: "limbo" } }), null);
  assert.equal(parseSessionStatus({ session: { ...good.session, decidedAt: 42 } }), null);
  assert.equal(parseSessionStatus({}), null);
  // The wire carries no score keys — the parser has no field for them.
  assert.ok(!("livenessScore" in parsed));
});

test("AMD-KYC-09: the state gates map every session state", () => {
  assert.equal(sessionAction("issued"), "start-capture");
  assert.equal(sessionAction("review"), "under-review");
  assert.equal(sessionAction("verified"), "none");
  assert.equal(sessionAction("rejected"), "retry");
  assert.equal(sessionAction("expired"), "retry");
});

test("AMD-KYC-07: every challenge action has copy", () => {
  for (const action of CHALLENGE_ACTIONS) {
    assert.ok(COPY.includes(`"ui.kycCapture.action.${action}"`), action);
  }
  for (const key of ["ui.kycCapture.verified", "ui.kycCapture.rejected", "ui.kycCapture.review"]) {
    assert.ok(COPY.includes(`"${key}"`), key);
  }
});

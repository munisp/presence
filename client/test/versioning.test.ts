/**
 * TR-27: unsupported-version detection — verdicts for both channels and
 * the fail-open rule for malformed signals.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_PROTOCOL_VERSION,
  evaluateBootstrapVersion,
  evaluateDiagramSpec,
  evaluateResponseVersion,
  SUPPORTED_DIAGRAM_SPEC_VERSIONS,
  UPDATE_PROMPT,
} from "../src/presence/versioning.js";

test("bootstrap: a floor above this build requires an update", () => {
  const v = evaluateBootstrapVersion({ version: 1, minClientVersion: CLIENT_PROTOCOL_VERSION + 1 });
  assert.equal(v.status, "update-required");
  assert.equal(v.status === "update-required" && v.reason, "below-minimum");
});

test("bootstrap: an equal floor and equal API version is supported", () => {
  const v = evaluateBootstrapVersion({ version: 1, minClientVersion: CLIENT_PROTOCOL_VERSION });
  assert.deepEqual(v, { status: "supported" });
});

test("bootstrap: a newer server API major requires an update", () => {
  const v = evaluateBootstrapVersion({ version: CLIENT_PROTOCOL_VERSION + 1, minClientVersion: 1 });
  assert.equal(v.status, "update-required");
  assert.equal(v.status === "update-required" && v.reason, "api-too-new");
});

test("bootstrap: malformed floors fail open — a server bug must not brick installs", () => {
  for (const minClientVersion of [0, -1, 1.5, Number.NaN] as number[]) {
    const v = evaluateBootstrapVersion({ version: 1, minClientVersion });
    assert.equal(v.status, "supported", `floor ${minClientVersion} must not condemn the build`);
  }
});

test("in-band: 426 is an explicit refusal", () => {
  const v = evaluateResponseVersion(426, "1");
  assert.equal(v.status, "update-required");
  assert.equal(v.status === "update-required" && v.reason, "server-refused");
});

test("in-band: a newer x-api-version header requires an update; same/missing/garbage do not", () => {
  assert.equal(evaluateResponseVersion(200, String(CLIENT_PROTOCOL_VERSION + 1)).status, "update-required");
  assert.deepEqual(evaluateResponseVersion(200, String(CLIENT_PROTOCOL_VERSION)), { status: "supported" });
  assert.deepEqual(evaluateResponseVersion(200, null), { status: "supported" });
  assert.deepEqual(evaluateResponseVersion(200, "garbage"), { status: "supported" });
});

test("TR-35 folded in: an unknown diagram spec is an unsupported-version signal", () => {
  for (const spec of SUPPORTED_DIAGRAM_SPEC_VERSIONS) {
    assert.deepEqual(evaluateDiagramSpec(spec), { status: "supported" });
  }
  const v = evaluateDiagramSpec(999);
  assert.equal(v.status, "update-required");
  assert.equal(v.status === "update-required" && v.reason, "diagram-spec");
});

test("the update prompt is an explicit path, never a silent gap (TR-27)", () => {
  assert.ok(UPDATE_PROMPT.title.length > 0);
  assert.ok(UPDATE_PROMPT.body.includes("no longer supported"));
  assert.ok(UPDATE_PROMPT.action.length > 0);
});

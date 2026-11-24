/** FR-86 + SEC-35: opt-in, off-by-default, one-action-disable, contentless. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AMBIENT_FORBIDDEN_FIELDS,
  AMBIENT_PAYLOAD_KEYS,
  AMBIENT_PREFS_KEY,
  AMBIENT_SURFACES,
  ambientHonoursSec35,
  ambientPayloadViolations,
  ambientSurfaceDescriptor,
  ambientSurfaceViolations,
  buildAmbientPayload,
  defaultAmbientPreferences,
  parseAmbientPreferences,
  planDisable,
  setAmbientPreference,
} from "../src/presence/ambientSurfaces.js";
import { LOCAL_STATE_ALLOWLIST } from "../src/presence/localState.js";

test("the three surfaces and the persistence key are pinned (FR-86)", () => {
  assert.deepEqual(AMBIENT_SURFACES, ["lockScreenIndicator", "liveActivity", "homeScreenWidget"]);
  assert.equal(AMBIENT_PREFS_KEY, "presence.ambient.prefs");
  assert.ok(LOCAL_STATE_ALLOWLIST.includes(AMBIENT_PREFS_KEY));
  assert.equal(LOCAL_STATE_ALLOWLIST.length, 7);
});

test("every surface is off by default (FR-86)", () => {
  const defaults = defaultAmbientPreferences();
  for (const surface of AMBIENT_SURFACES) {
    assert.equal(defaults[surface], false, `${surface} defaults off`);
  }
  const second = defaultAmbientPreferences();
  assert.notEqual(defaults, second, "each call returns a fresh object");
  assert.deepEqual(defaults, second);
});

test("opt-in is individual — flipping one surface touches no other", () => {
  const enabled = setAmbientPreference(defaultAmbientPreferences(), "liveActivity", true);
  assert.deepEqual(enabled, {
    lockScreenIndicator: false,
    liveActivity: true,
    homeScreenWidget: false,
  });
  const alsoWidget = setAmbientPreference(enabled, "homeScreenWidget", true);
  assert.deepEqual(alsoWidget, {
    lockScreenIndicator: false,
    liveActivity: true,
    homeScreenWidget: true,
  });
  assert.equal(enabled.liveActivity, true, "no mutation of the input");
  assert.equal(
    Object.keys(enabled).length,
    AMBIENT_SURFACES.length,
    "no surface appears from nowhere",
  );
});

test("disable is one action with no confirmation step (FR-86)", () => {
  for (const surface of AMBIENT_SURFACES) {
    const plan = planDisable(surface);
    assert.deepEqual(plan.actions, ["toggle-off"]);
    assert.equal(plan.actions.length, 1, "exactly one action");
    assert.equal(plan.confirmation, null, "no confirmation step");
  }
});

test("parsing fails closed — malformed or smuggled prefs read as all-off", () => {
  const off = defaultAmbientPreferences();
  assert.deepEqual(parseAmbientPreferences(null), off);
  assert.deepEqual(parseAmbientPreferences("not json"), off);
  assert.deepEqual(parseAmbientPreferences("42"), off);
  assert.deepEqual(parseAmbientPreferences('"liveActivity"'), off);
  assert.deepEqual(parseAmbientPreferences("{}"), off);
  assert.deepEqual(
    parseAmbientPreferences('{"lockScreenIndicator": "true"}'),
    off,
    "a string is not an opt-in",
  );
  assert.deepEqual(
    parseAmbientPreferences('{"unknownSurface": true, "liveActivity": 1}'),
    off,
    "unknown keys and non-booleans are dropped",
  );
  assert.deepEqual(
    parseAmbientPreferences('{"liveActivity": true, "lockScreenIndicator": true}'),
    { lockScreenIndicator: true, liveActivity: true, homeScreenWidget: false },
  );
});

test("the ambient payload carries exactly {kind, active} (SEC-35)", () => {
  assert.deepEqual(buildAmbientPayload(true), { kind: "presence-ambient", active: true });
  assert.deepEqual(buildAmbientPayload(false), { kind: "presence-ambient", active: false });
  assert.deepEqual(
    Object.keys(buildAmbientPayload(true)).sort(),
    [...AMBIENT_PAYLOAD_KEYS].sort(),
  );
  assert.ok(ambientHonoursSec35(buildAmbientPayload(true)));
});

test("smuggled content is caught by the payload audit", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ kind: "presence-ambient", active: true, displayName: "Ada" }, "displayName"],
    [{ kind: "presence-ambient", active: true, reasonText: "both like chess" }, "reasonText"],
    [{ kind: "presence-ambient", active: true, participantCount: 3 }, "participantCount"],
    [{ kind: "presence-ambient", active: true, cell: "891f1d4" }, "cell"],
    [{ kind: "presence-ambient", active: true, map: true }, "map"],
  ];
  for (const [payload, field] of cases) {
    const violations = ambientPayloadViolations(payload);
    assert.ok(violations.includes(field), `${field} caught`);
    assert.ok(!ambientHonoursSec35(payload));
  }
  assert.deepEqual(ambientPayloadViolations(null), ["payload-shape"]);
  assert.deepEqual(ambientPayloadViolations("presence"), ["payload-shape"]);
  assert.ok(ambientPayloadViolations({ kind: "ambient", active: true }).includes("kind"));
  assert.ok(
    ambientPayloadViolations({ kind: "presence-ambient", active: "yes" }).includes("active"),
  );
  for (const forbidden of AMBIENT_FORBIDDEN_FIELDS) {
    assert.ok(
      ambientPayloadViolations({ kind: "presence-ambient", active: true, [forbidden]: 1 }).length > 0,
      `${forbidden} is forbidden`,
    );
  }
});

test("surface descriptors are registry-clean (FR-87/FR-77)", () => {
  const prefs = setAmbientPreference(defaultAmbientPreferences(), "liveActivity", true);
  const descriptor = ambientSurfaceDescriptor("liveActivity", prefs);
  assert.equal(descriptor.kind, "ambient-liveActivity");
  assert.deepEqual(descriptor.affordances, ["opt-in", "disable"]);
  assert.deepEqual(Object.keys(descriptor.fields), ["enabled"]);
  assert.equal(descriptor.fields.enabled, true);
  assert.deepEqual(ambientSurfaceViolations("liveActivity", prefs), []);
});

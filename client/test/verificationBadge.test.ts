/** FR-70: verification status rides every identity reveal, forged labels refuse. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  IDENTITY_REVEAL_SURFACES,
  VERIFICATION_LABELS,
  VERIFICATION_STATES,
  buildIdentityReveal,
  identityRevealViolations,
  revealHonoursFr70,
} from "../src/presence/verificationBadge.js";

test("the registry is exactly the three SRS surfaces, and settings is not one (FR-70)", () => {
  assert.deepEqual(IDENTITY_REVEAL_SURFACES, ["offer", "table-roster", "booked-slot"]);
  assert.ok(revealHonoursFr70());
  assert.ok(!(IDENTITY_REVEAL_SURFACES as readonly string[]).includes("account-settings"));
});

test("the two states and their labels are pinned (FR-51 data)", () => {
  assert.deepEqual(VERIFICATION_STATES, ["verified", "unverified"]);
  assert.equal(VERIFICATION_LABELS.verified, "Verified");
  assert.equal(VERIFICATION_LABELS.unverified, "Not verified");
});

test("every reveal surface builds a badge from the state alone", () => {
  for (const surface of IDENTITY_REVEAL_SURFACES) {
    const reveal = buildIdentityReveal(surface, "Ada", "verified");
    assert.ok(reveal !== null);
    assert.equal(reveal.surface, surface);
    assert.equal(reveal.displayName, "Ada");
    assert.deepEqual(reveal.verification, { state: "verified", label: "Verified" });
  }
});

test("an unverified account reveals with the unverified badge, not silence", () => {
  const reveal = buildIdentityReveal("offer", "Ada", "unverified");
  assert.ok(reveal !== null);
  assert.deepEqual(reveal.verification, { state: "unverified", label: "Not verified" });
});

test("identity cannot be revealed on an unregistered surface", () => {
  assert.equal(buildIdentityReveal("account-settings", "Ada", "verified"), null);
  assert.equal(buildIdentityReveal("profile-page", "Ada", "verified"), null);
  assert.equal(buildIdentityReveal("", "Ada", "verified"), null);
});

test("an empty or blank display name refuses to render", () => {
  assert.equal(buildIdentityReveal("offer", "", "verified"), null);
  assert.equal(buildIdentityReveal("offer", "   ", "verified"), null);
});

test("a garbage verification state fails closed", () => {
  assert.equal(buildIdentityReveal("offer", "Ada", "probably"), null);
  assert.equal(buildIdentityReveal("offer", "Ada", ""), null);
});

test("the audit accepts an honest badge and flags a forged label", () => {
  const honest = buildIdentityReveal("table-roster", "Ada", "verified");
  assert.ok(honest !== null);
  assert.deepEqual(identityRevealViolations(honest), []);

  const forged = {
    ...honest,
    verification: { state: "unverified" as const, label: "Verified" },
  };
  assert.deepEqual(identityRevealViolations(forged), ["verification-label"]);
});

test("the audit flags an unknown surface, blank name and unknown state", () => {
  assert.deepEqual(
    identityRevealViolations({
      surface: "profile-page" as never,
      displayName: "",
      verification: { state: "maybe" as never, label: "?" },
    }),
    ["surface", "display-name", "verification-state"],
  );
});

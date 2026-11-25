/** SRS Addendum 001 (b48): edge identity-assurance validators — AMD-KYC / AMD-AVT. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AVATAR_CHANGE_COOLDOWN_MS,
  AVATAR_KEY_PATTERN,
  AVATAR_REGISTRY,
  KYC_STATES,
  KYC_TRANSITIONS,
  isKnownAvatarKey,
  isKycState,
  isLegalKycTransition,
  parseAvatarChoice,
  parseKycDecision,
} from "../src/identity.js";

test("AMD-KYC-03: the four states and the five legal transitions are pinned", () => {
  assert.deepEqual(KYC_STATES, ["pending", "verified", "rejected", "suspended"]);
  assert.equal(KYC_TRANSITIONS.length, 5);
  for (const [from, to] of KYC_TRANSITIONS) {
    assert.ok(isKycState(from) && isKycState(to));
    assert.ok(isLegalKycTransition(from, to), `${from} → ${to}`);
  }
  // The illegal moves the table must refuse.
  assert.equal(isLegalKycTransition("verified", "pending"), false);
  assert.equal(isLegalKycTransition("verified", "rejected"), false);
  assert.equal(isLegalKycTransition("rejected", "verified"), false);
  assert.equal(isLegalKycTransition("suspended", "pending"), false);
  assert.equal(isLegalKycTransition("pending", "suspended"), false);
  assert.equal(isLegalKycTransition("garbage", "verified"), false);
  assert.equal(isLegalKycTransition("pending", "verifiedd"), false);
});

test("AMD-AVT-01: the registry is twelve unique well-formed symbols", () => {
  assert.equal(AVATAR_REGISTRY.length, 12);
  const keys = new Set(AVATAR_REGISTRY.map((entry) => entry.key));
  assert.equal(keys.size, 12);
  for (const entry of AVATAR_REGISTRY) {
    assert.ok(AVATAR_KEY_PATTERN.test(entry.key), entry.key);
    assert.ok(entry.label.trim().length > 0 && entry.glyph.length > 0, entry.key);
  }
  assert.ok(isKnownAvatarKey("ember-fox"));
  assert.ok(!isKnownAvatarKey("ember-fox2"));
  assert.ok(!isKnownAvatarKey("Ember-Fox"));
  assert.ok(!isKnownAvatarKey(""));
});

test("AMD-AVT-03: the cooldown is exactly 24 hours", () => {
  assert.equal(AVATAR_CHANGE_COOLDOWN_MS, 86_400_000);
});

test("TR-23: avatar choice bodies are strict — {avatarKey} only, registry members only", () => {
  assert.deepEqual(parseAvatarChoice({ avatarKey: "cedar-crane" }), {
    avatarKey: "cedar-crane",
  });
  // Unknown fields refuse, even alongside a valid key.
  assert.equal(parseAvatarChoice({ avatarKey: "cedar-crane", extra: true }), null);
  assert.equal(parseAvatarChoice({}), null);
  assert.equal(parseAvatarChoice({ avatarKey: "not-a-symbol" }), null);
  assert.equal(parseAvatarChoice({ avatarKey: 42 }), null);
  assert.equal(parseAvatarChoice(null), null);
  assert.equal(parseAvatarChoice("cedar-crane"), null);
  assert.equal(parseAvatarChoice(["cedar-crane"]), null);
});

test("AMD-KYC-03: decision bodies are strict — {decision} only, known states only", () => {
  assert.deepEqual(parseKycDecision({ decision: "verified" }), { decision: "verified" });
  assert.deepEqual(parseKycDecision({ decision: "suspended" }), { decision: "suspended" });
  assert.equal(parseKycDecision({ decision: "approved" }), null);
  assert.equal(parseKycDecision({ decision: "verified", note: "x" }), null);
  assert.equal(parseKycDecision({}), null);
  assert.equal(parseKycDecision(null), null);
  assert.equal(parseKycDecision("verified"), null);
});

/** SRS Addendum 001 (b48): the identity-assurance contract — AMD-KYC / AMD-AVT. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CLIENT_PALETTE } from "../src/presence/accessibility.js";
import {
  AVATAR_CHANGE_COOLDOWN_MS,
  AVATAR_KEY_PATTERN,
  AVATAR_REGISTRY,
  KYC_STATES,
  KYC_TRANSITIONS,
  buildRecognitionAnchor,
  canEnterDiscovery,
  identityAssuranceHonoursAmendment,
  isKnownAvatarKey,
  isKycState,
  isLegalKycTransition,
  planAvatarChange,
  resolveAvatar,
} from "../src/presence/identityAssurance.js";

// ------------------------------------------------------------- AMD-KYC ---

test("the KYC states and the legal-transition table are pinned (AMD-KYC-03)", () => {
  assert.deepEqual(KYC_STATES, ["pending", "verified", "rejected", "suspended"]);
  assert.deepEqual(KYC_TRANSITIONS, [
    ["pending", "verified"],
    ["pending", "rejected"],
    ["verified", "suspended"],
    ["suspended", "verified"],
    ["rejected", "pending"],
  ]);
});

test("every legal transition passes; anything else fails closed", () => {
  for (const [from, to] of KYC_TRANSITIONS) {
    assert.ok(isLegalKycTransition(from, to), `${from} → ${to}`);
  }
  // Illegal pairs — including reversals the table does not name.
  assert.equal(isLegalKycTransition("verified", "pending"), false);
  assert.equal(isLegalKycTransition("verified", "rejected"), false);
  assert.equal(isLegalKycTransition("suspended", "pending"), false);
  assert.equal(isLegalKycTransition("rejected", "verified"), false);
  assert.equal(isLegalKycTransition("pending", "suspended"), false);
  assert.equal(isLegalKycTransition("pending", "pending"), false);
  // Garbage fails closed.
  assert.equal(isLegalKycTransition("verified", "garbage"), false);
  assert.equal(isLegalKycTransition(null, "verified"), false);
  assert.equal(isLegalKycTransition("pending", 42), false);
  assert.equal(isKycState("verified"), true);
  assert.equal(isKycState("Verified"), false);
});

test("discovery is attested AND kyc-verified, fail closed (AMD-KYC-01)", () => {
  assert.equal(canEnterDiscovery({ attested: true, kycState: "verified" }), true);
  assert.equal(canEnterDiscovery({ attested: true, kycState: "pending" }), false);
  assert.equal(canEnterDiscovery({ attested: true, kycState: "rejected" }), false);
  assert.equal(canEnterDiscovery({ attested: true, kycState: "suspended" }), false);
  assert.equal(canEnterDiscovery({ attested: false, kycState: "verified" }), false);
  // Garbage fails closed — an unreadable record is not eligible.
  assert.equal(
    canEnterDiscovery({ attested: "yes", kycState: "verified" } as never),
    false,
  );
  assert.equal(canEnterDiscovery(null as never), false);
  assert.equal(canEnterDiscovery(undefined as never), false);
});

// ------------------------------------------------------------- AMD-AVT ---

test("the registry is twelve unique, well-formed, palette-covered symbols (AMD-AVT-01/04)", () => {
  assert.equal(AVATAR_REGISTRY.length, 12);
  const keys = new Set(AVATAR_REGISTRY.map((entry) => entry.key));
  assert.equal(keys.size, 12);
  const paletteRoles = new Set(CLIENT_PALETTE.map((entry) => entry.role));
  for (const entry of AVATAR_REGISTRY) {
    assert.ok(AVATAR_KEY_PATTERN.test(entry.key), entry.key);
    assert.ok(entry.label.trim().length > 0, entry.key);
    assert.ok(entry.glyph.length > 0, entry.key);
    assert.ok(paletteRoles.has(entry.paletteRole), `${entry.key}:${entry.paletteRole}`);
  }
});

test("a symbol resolves by key; unknown keys fail closed", () => {
  const fox = resolveAvatar("ember-fox");
  assert.ok(fox !== null);
  assert.equal(fox.label, "Ember Fox");
  assert.equal(fox.glyph, "◆");
  assert.equal(resolveAvatar("Ember-Fox"), null); // case-sensitive, fail closed
  assert.equal(resolveAvatar("ember-fox2"), null);
  assert.equal(resolveAvatar("not-a-symbol"), null);
  assert.equal(resolveAvatar(""), null);
  assert.equal(resolveAvatar(null), null);
  assert.ok(isKnownAvatarKey("aurora-wolf"));
  assert.ok(!isKnownAvatarKey("aurora-wolf "));
});

test("an avatar change is planned with exactly one refusal reason (AMD-AVT-03)", () => {
  const base = {
    currentKey: null,
    nextKey: "ember-fox",
    avatarSetAtMs: null,
    nowMs: 1_800_000_000_000,
    hasOpenConversation: false,
  } as const;
  // First choice is always allowed.
  assert.deepEqual(planAvatarChange({ ...base }), { allowed: true });
  // Unknown symbol.
  assert.deepEqual(planAvatarChange({ ...base, nextKey: "nope" }), {
    allowed: false,
    reason: "unknown-avatar",
  });
  // Same symbol.
  assert.deepEqual(planAvatarChange({ ...base, currentKey: "ember-fox" }), {
    allowed: false,
    reason: "same-avatar",
  });
  // A conversation is open — the symbol is a disguise risk, so it locks.
  assert.deepEqual(
    planAvatarChange({ ...base, currentKey: "ember-fox", nextKey: "night-heron", hasOpenConversation: true }),
    { allowed: false, reason: "open-conversation" },
  );
  // Inside the 24-hour cooldown.
  const setAt = 1_800_000_000_000 - 60_000;
  assert.deepEqual(
    planAvatarChange({ ...base, currentKey: "ember-fox", nextKey: "night-heron", avatarSetAtMs: setAt }),
    { allowed: false, reason: "cooldown" },
  );
  // Exactly at the cooldown boundary the change is allowed again.
  assert.deepEqual(
    planAvatarChange({
      ...base,
      currentKey: "ember-fox",
      nextKey: "night-heron",
      avatarSetAtMs: 1_800_000_000_000 - AVATAR_CHANGE_COOLDOWN_MS,
    }),
    { allowed: true },
  );
  // Garbage fails closed with invalid-input.
  assert.deepEqual(planAvatarChange(null as never), { allowed: false, reason: "invalid-input" });
  assert.deepEqual(planAvatarChange({ ...base, nowMs: Number.NaN }), {
    allowed: false,
    reason: "invalid-input",
  });
  assert.deepEqual(
    planAvatarChange({ ...base, hasOpenConversation: "yes" } as never),
    { allowed: false, reason: "invalid-input" },
  );
});

test("the recognition anchor is the symbol pre-OPEN, name only at OPEN (AMD-AVT-02, FR-30/FR-87)", () => {
  // Pre-OPEN: the symbol alone — no name, and no photo field exists.
  const pre = buildRecognitionAnchor("ember-fox", "pre-open", "Ada");
  assert.ok(pre !== null);
  assert.equal(pre.avatar.key, "ember-fox");
  assert.equal(pre.displayName, null);
  assert.ok(!("photo" in pre) && !("photoUrl" in pre));
  // At OPEN: the name joins the anchor; the photo still cannot.
  const open = buildRecognitionAnchor("ember-fox", "open", "Ada");
  assert.ok(open !== null);
  assert.equal(open.displayName, "Ada");
  assert.ok(!("photo" in open) && !("photoUrl" in open));
  // An empty name at OPEN refuses the anchor, not a partial render.
  assert.equal(buildRecognitionAnchor("ember-fox", "open", "  "), null);
  // Unknown symbol or unknown reveal state fails closed.
  assert.equal(buildRecognitionAnchor("nope", "pre-open", null), null);
  assert.equal(buildRecognitionAnchor("ember-fox", "half-open", null), null);
});

test("the master guard holds and is not vacuous", () => {
  assert.ok(identityAssuranceHonoursAmendment());
});

/** FR-38/SEC-21 first-message screening tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SCREENING_EXPLANATION,
  screenEnvelope,
  screeningErrorMessage,
  screenText,
} from "../src/screening.js";

function categories(text: string): string[] {
  return screenText(text).map((f) => f.category);
}

test("FR-38: links are caught in all three forms", () => {
  assert.deepEqual(categories("check https://evil.example/x"), ["link"]);
  assert.deepEqual(categories("visit www.evil.example"), ["link"]);
  assert.ok(categories("go to evil-site.com now").includes("link"));
});

test("FR-38: e-mail addresses and phone numbers are caught", () => {
  assert.deepEqual(categories("write me at ada@example.com"), ["email"]);
  assert.ok(categories("call +234 801 234 5678").includes("phone"));
  assert.ok(categories("my number: 08012345678").includes("phone"));
});

test("SEC-21: platform-bypass and scam phrases are caught", () => {
  assert.ok(categories("whatsapp me instead").includes("bypass"));
  assert.ok(categories("add me on telegram").includes("bypass"));
  assert.ok(categories("can you send money for my ticket").includes("scam"));
  assert.ok(categories("i need a gift card urgently").includes("scam"));
});

test("FR-38: ordinary first messages pass", () => {
  assert.deepEqual(categories("hey — loved your take on afrobeats at the listening party"), []);
  assert.deepEqual(categories("that panel on fintech in 2026 was great"), []);
});

test("FR-38: findings carry categories only, never matched text", () => {
  for (const f of screenText("mail ada@example.com or see https://x.io")) {
    assert.deepEqual(Object.keys(f), ["category"]);
  }
  const msg = screeningErrorMessage(screenText("call +234 801 234 5678"));
  assert.ok(!msg.includes("234"));
  assert.ok(msg.includes(SCREENING_EXPLANATION.phone));
});

test("SEC-10 boundary: undecodable envelopes are not screenable server-side", () => {
  assert.equal(screenEnvelope(Buffer.from([0xff, 0xfe, 0x00, 0x80])), null);
  assert.deepEqual(screenEnvelope(Buffer.from("see https://evil.io", "utf8")), [{ category: "link" }]);
});

/** FR-52–55/57 moderation vocabulary and quiet-window unit tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPEAL_DECISIONS,
  MODERATION_REASON_CODES,
  NUDGE_DAILY_MAX,
  parseAppealBody,
  parseAppealDecision,
  parseReasonCode,
  parseReportOutcome,
  parseResolveAppealBody,
  parseResolveReportBody,
  parseSuspensionDimension,
  REPORT_OUTCOMES,
  SUSPENSION_DIMENSIONS,
} from "../src/moderation.js";
import {
  applyPrefsPatch,
  getQuietWindow,
  inQuietWindow,
  mergePrefs,
  parseQuietWindow,
} from "../src/notifications.js";

test("the reason-code vocabulary is the governed set", () => {
  assert.deepEqual([...MODERATION_REASON_CODES], [
    "spam",
    "harassment",
    "scam",
    "underage",
    "impersonation",
    "sexual_content",
    "hate",
    "other_policy",
  ]);
  assert.equal(parseReasonCode("harassment"), "harassment");
  assert.equal(parseReasonCode("rude"), null);
  assert.equal(parseReasonCode(42), null);
});

test("suspension dimensions are exactly the FR-55 three", () => {
  assert.deepEqual([...SUSPENSION_DIMENSIONS], ["attestation_key", "handle", "payment_instrument"]);
  assert.equal(parseSuspensionDimension("handle"), "handle");
  assert.equal(parseSuspensionDimension("account"), null);
});

test("report outcomes and appeal decisions are closed vocabularies", () => {
  assert.deepEqual([...REPORT_OUTCOMES], ["actioned", "dismissed"]);
  assert.deepEqual([...APPEAL_DECISIONS], ["upheld", "overturned"]);
  assert.equal(parseReportOutcome("actioned"), "actioned");
  assert.equal(parseReportOutcome("banned"), null);
  assert.equal(parseAppealDecision("overturned"), "overturned");
  assert.equal(parseAppealDecision("maybe"), null);
});

test("nudges are capped at three per day (FR-57)", () => {
  assert.equal(NUDGE_DAILY_MAX, 3);
});

test("resolve-report body requires outcome and reasonCode", () => {
  assert.equal(parseResolveReportBody(null).ok, false);
  assert.equal(parseResolveReportBody({ outcome: "actioned" }).ok, false);
  assert.equal(parseResolveReportBody({ reasonCode: "spam" }).ok, false);
  const out = parseResolveReportBody({ outcome: "actioned", reasonCode: "spam" });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.value.outcome, "actioned");
    assert.equal(out.value.suspension, undefined);
    assert.equal(out.value.investigationRemove, undefined);
  }
});

test("resolve-report body validates the optional suspension", () => {
  assert.equal(
    parseResolveReportBody({ outcome: "actioned", reasonCode: "spam", suspension: { dimension: "account" } }).ok,
    false,
  );
  const out = parseResolveReportBody({
    outcome: "actioned",
    reasonCode: "spam",
    suspension: { dimension: "attestation_key" },
    investigationRemove: true,
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.value.suspension?.dimension, "attestation_key");
    assert.equal(out.value.investigationRemove, true);
  }
});

test("appeal bodies are bounded and trimmed (FR-53)", () => {
  assert.equal(parseAppealBody({ body: "too short" }).ok, false);
  assert.equal(parseAppealBody({ body: "x".repeat(2001) }).ok, false);
  assert.equal(parseAppealBody({ body: 42 }).ok, false);
  const out = parseAppealBody({ body: "  I believe this action was taken in error.  " });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.value.body, "I believe this action was taken in error.");
});

test("resolve-appeal body requires decision and reasonCode", () => {
  assert.equal(parseResolveAppealBody({ decision: "upheld" }).ok, false);
  const out = parseResolveAppealBody({ decision: "overturned", reasonCode: "other_policy", note: "reviewed" });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.value.decision, "overturned");
    assert.equal(out.value.note, "reviewed");
  }
});

// ----------------------------------------------------------- quiet window —

test("quiet window parses HH:MM UTC only", () => {
  assert.deepEqual(parseQuietWindow({ start: "22:00", end: "07:00" }), { start: "22:00", end: "07:00" });
  assert.equal(parseQuietWindow({ start: "24:00", end: "07:00" }), "invalid");
  assert.equal(parseQuietWindow({ start: "9:00", end: "07:00" }), "invalid");
  assert.equal(parseQuietWindow("22:00"), "invalid");
  assert.equal(parseQuietWindow(null), null);
  assert.equal(parseQuietWindow(undefined), null);
});

test("getQuietWindow reads the stored jsonb key", () => {
  assert.deepEqual(getQuietWindow({ quiet: { start: "22:00", end: "07:00" } }), {
    start: "22:00",
    end: "07:00",
  });
  assert.equal(getQuietWindow({ matches: false }), null);
  assert.equal(getQuietWindow(null), null);
  assert.equal(getQuietWindow({ quiet: "garbage" }), null);
});

test("inQuietWindow handles same-day, overnight and disabled windows", () => {
  const at = (h: number, m: number) => new Date(Date.UTC(2026, 10, 24, h, m));
  // Same-day window 09:00–17:00.
  assert.equal(inQuietWindow({ start: "09:00", end: "17:00" }, at(12, 0)), true);
  assert.equal(inQuietWindow({ start: "09:00", end: "17:00" }, at(9, 0)), true);
  assert.equal(inQuietWindow({ start: "09:00", end: "17:00" }, at(17, 0)), false);
  assert.equal(inQuietWindow({ start: "09:00", end: "17:00" }, at(20, 0)), false);
  // Overnight window 22:00–07:00 wraps midnight.
  assert.equal(inQuietWindow({ start: "22:00", end: "07:00" }, at(23, 30)), true);
  assert.equal(inQuietWindow({ start: "22:00", end: "07:00" }, at(3, 0)), true);
  assert.equal(inQuietWindow({ start: "22:00", end: "07:00" }, at(12, 0)), false);
  // Equal start/end disables the window; null is never quiet.
  assert.equal(inQuietWindow({ start: "00:00", end: "00:00" }, at(12, 0)), false);
  assert.equal(inQuietWindow(null, at(12, 0)), false);
});

test("applyPrefsPatch accepts a quiet window and null clears it", () => {
  const set = applyPrefsPatch(null, { quiet: { start: "22:00", end: "07:00" } });
  assert.equal(set.ok, true);
  if (set.ok) assert.deepEqual(set.prefs.quiet, { start: "22:00", end: "07:00" });

  const cleared = applyPrefsPatch({ quiet: { start: "22:00", end: "07:00" } }, { quiet: null });
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.equal(cleared.prefs.quiet, undefined);

  // A stored window survives an unrelated category patch.
  const kept = applyPrefsPatch(
    { quiet: { start: "22:00", end: "07:00" }, matches: true },
    { matches: false },
  );
  assert.equal(kept.ok, true);
  if (kept.ok) {
    assert.equal(kept.prefs.matches, false);
    assert.deepEqual(kept.prefs.quiet, { start: "22:00", end: "07:00" });
  }

  assert.equal(applyPrefsPatch(null, { quiet: { start: "25:00", end: "07:00" } }).ok, false);
  assert.equal(applyPrefsPatch(null, { quiet: "always" }).ok, false);
});

test("mergePrefs still ignores the quiet key (categories only)", () => {
  const prefs = mergePrefs({ quiet: { start: "22:00", end: "07:00" }, nudges: false });
  assert.equal(prefs.nudges, false);
  assert.equal("quiet" in prefs, false);
});

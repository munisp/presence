/** Announcement tests: FR-93..97 publish rules and FR-94/SEC-38 masking. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_MAX_TTL_MINUTES,
  ANNOUNCEMENT_MIN_ACCOUNT_AGE_H,
  ANNOUNCEMENT_PUBLISH_COOLDOWN_H,
  canPublishCategory,
  effectiveTtlMinutes,
  isTrustedPublisher,
  publicResponse,
  RESPONSES_SHOWN_MAX,
} from "../src/announcements.js";

test("FR-96: the category set is fixed", () => {
  assert.deepEqual([...ANNOUNCEMENT_CATEGORIES].sort(), ["lost_found", "notice", "social", "work"]);
});

test("FR-93: the TTL cap is four hours, default when unspecified", () => {
  assert.equal(ANNOUNCEMENT_MAX_TTL_MINUTES, 240);
  assert.equal(effectiveTtlMinutes(undefined), 240);
});

test("FR-93: requested TTLs are clamped into (0, 240]", () => {
  assert.equal(effectiveTtlMinutes(30), 30);
  assert.equal(effectiveTtlMinutes(1), 1);
  assert.equal(effectiveTtlMinutes(240), 240);
  assert.equal(effectiveTtlMinutes(10_000), 240);
  assert.equal(effectiveTtlMinutes(0), 1);
  assert.equal(effectiveTtlMinutes(-30), 1);
  assert.equal(effectiveTtlMinutes(90.7), 90);
});

test("FR-93: the trust floor is 24 hours on a declared, unblocked account", () => {
  assert.equal(ANNOUNCEMENT_MIN_ACCOUNT_AGE_H, 24);
  assert.equal(ANNOUNCEMENT_PUBLISH_COOLDOWN_H, 24);
  const now = new Date("2026-11-23T12:00:00Z");
  const trusted = {
    createdAt: new Date("2026-11-20T12:00:00Z"),
    ageDeclaredAt: new Date("2026-11-20T12:05:00Z"),
    ageBlocked: false,
    deletedAt: null,
  };
  assert.equal(isTrustedPublisher(trusted, now), true);
  // exactly at the floor passes
  assert.equal(
    isTrustedPublisher({ ...trusted, createdAt: new Date("2026-11-22T12:00:00Z") }, now),
    true,
  );
  // one minute under the floor fails
  assert.equal(
    isTrustedPublisher({ ...trusted, createdAt: new Date("2026-11-22T12:01:00Z") }, now),
    false,
  );
  // blocked, deleted and undeclared accounts never publish
  assert.equal(isTrustedPublisher({ ...trusted, ageBlocked: true }, now), false);
  assert.equal(isTrustedPublisher({ ...trusted, deletedAt: now }, now), false);
  assert.equal(isTrustedPublisher({ ...trusted, ageDeclaredAt: null }, now), false);
});

test("FR-97: the work category requires a verified organisation", () => {
  assert.equal(canPublishCategory("work", true), true);
  assert.equal(canPublishCategory("work", false), false);
  assert.equal(canPublishCategory("social", false), true);
  assert.equal(canPublishCategory("lost_found", false), true);
  assert.equal(canPublishCategory("notice", false), true);
  assert.equal(canPublishCategory("jobs", true), false); // unknown category
});

test("FR-95/SEC-38: at most five responses are shown", () => {
  assert.equal(RESPONSES_SHOWN_MAX, 5);
});

test("FR-94: the responder id is masked until acceptance", () => {
  const pending = publicResponse({
    responseId: "r1",
    body: "hello",
    createdAt: "2026-11-23T10:00:00Z",
    acceptedAt: null,
    responder: "user-123",
  });
  assert.equal(pending.responder, null);
  assert.equal(pending.accepted, false);
  assert.equal(pending.body, "hello");

  const accepted = publicResponse({
    responseId: "r1",
    body: "hello",
    createdAt: "2026-11-23T10:00:00Z",
    acceptedAt: "2026-11-23T10:05:00Z",
    responder: "user-123",
  });
  assert.equal(accepted.responder, "user-123");
  assert.equal(accepted.accepted, true);
});

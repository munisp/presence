/** FR-17/FR-71 intent and recurrence unit tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bumpRecurrence,
  dayOrdinal,
  INTENT_TTL_S,
  INTENT_VOCABULARY,
  parseIntent,
  parseRecurrence,
  recurrenceKey,
} from "../src/intents.js";

test("the intent vocabulary is the governed set (FR-17)", () => {
  assert.deepEqual([...INTENT_VOCABULARY], [
    "coffee",
    "food",
    "chat",
    "walk",
    "dance",
    "network",
    "explore",
    "quiet",
  ]);
});

test("intents are capped at sixty minutes (FR-17)", () => {
  assert.equal(INTENT_TTL_S, 3600);
});

test("parseIntent accepts only vocabulary members", () => {
  assert.equal(parseIntent(null).ok, false);
  assert.equal(parseIntent({}).ok, false);
  assert.equal(parseIntent({ intent: "romance" }).ok, false);
  assert.equal(parseIntent({ intent: 42 }).ok, false);
  const out = parseIntent({ intent: "coffee" });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.intent, "coffee");
});

test("the day ordinal is a day count, never a timestamp (FR-71)", () => {
  const d = new Date(Date.UTC(2026, 10, 24, 13, 30));
  const ordinal = dayOrdinal(d);
  assert.equal(ordinal, Math.floor(Date.UTC(2026, 10, 24, 13, 30) / 86_400_000));
  assert.equal(dayOrdinal(new Date(Date.UTC(2026, 10, 24, 0, 0))), ordinal, "same day → same ordinal");
  assert.equal(dayOrdinal(new Date(Date.UTC(2026, 10, 25, 0, 0))), ordinal + 1);
});

test("recurrence keys are hashed and name nobody (FR-71)", () => {
  const k = recurrenceKey("aaaa", "bbbb");
  assert.match(k, /^recur:[0-9a-f]{24}$/);
  assert.equal(k.includes("aaaa"), false);
  assert.equal(k, recurrenceKey("aaaa", "bbbb"), "deterministic");
});

test("the counter bumps at most once per day (FR-71)", () => {
  const first = bumpRecurrence(null, 100);
  assert.deepEqual(first, { next: { days: 1, lastDay: 100 }, bumped: true });
  const sameDay = bumpRecurrence(first.next, 100);
  assert.deepEqual(sameDay, { next: { days: 1, lastDay: 100 }, bumped: false });
  const nextDay = bumpRecurrence(first.next, 101);
  assert.deepEqual(nextDay, { next: { days: 2, lastDay: 101 }, bumped: true });
});

test("stored recurrence parses defensively", () => {
  assert.equal(parseRecurrence(null), null);
  assert.equal(parseRecurrence("garbage"), null);
  assert.equal(parseRecurrence('{"days":"two"}'), null);
  assert.deepEqual(parseRecurrence('{"days":3,"lastDay":100}'), { days: 3, lastDay: 100 });
});

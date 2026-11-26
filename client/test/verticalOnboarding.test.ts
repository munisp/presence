/** AMD-VERT-01..05: vertical onboarding — catalogue, toggles, patch builder. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  LOCKED_VERTICAL,
  VERTICALS,
  VERTICAL_CATALOGUE,
  buildVerticalsPatch,
  parseVerticalsResponse,
  verticalToggleItems,
  type VerticalFlagState,
} from "../src/presence/verticalOnboarding.js";

test("AMD-VERT-01: the catalogue mirrors the SQL seed and the edge mirror", () => {
  // Cross-pinned: the SQL seed is the source of truth; the edge mirrors it.
  // The batch-59 nine seed in 0034; batch 61's services row rides 0036.
  const migration = readFileSync("../db/migrations/0034_vertical_flags.sql", "utf8")
    + readFileSync("../db/migrations/0036_service_bookings.sql", "utf8");
  const edge = readFileSync("../services/edge/src/verticals.ts", "utf8");
  assert.deepEqual([...VERTICALS], [
    "discovery", "venues", "groups", "dating", "marketplace",
    "services", "payments", "trust", "introductions", "serendipity",
  ]);
  for (const v of VERTICALS) {
    assert.ok(migration.includes(`('${v}',`), `seed: ${v}`);
    assert.ok(edge.includes(`"${v}"`), `edge: ${v}`);
  }
  assert.equal(LOCKED_VERTICAL, "discovery");
  assert.equal(VERTICAL_CATALOGUE.length, 10);
  assert.equal(VERTICAL_CATALOGUE[0].vertical, "discovery");
  assert.equal(VERTICAL_CATALOGUE[0].locked, true);
  // Sort order is strictly increasing and matches the seed.
  for (let i = 1; i < VERTICAL_CATALOGUE.length; i++) {
    assert.ok(VERTICAL_CATALOGUE[i].sortOrder > VERTICAL_CATALOGUE[i - 1].sortOrder);
  }
  // Every vertical ships default-on; dating alone gates on adult status.
  for (const e of VERTICAL_CATALOGUE) {
    assert.equal(e.defaultEnabled, true, e.vertical);
  }
  assert.equal(
    VERTICAL_CATALOGUE.filter((e) => e.requiresAdult).map((e) => e.vertical).join(","),
    "dating",
  );
  assert.equal(
    VERTICAL_CATALOGUE.filter((e) => e.requiresKyc).map((e) => e.vertical).join(","),
    "groups,dating,marketplace,services,payments,trust,introductions",
  );
});

const ROWS: VerticalFlagState[] = [
  { vertical: "discovery", locked: true, eligible: true, reason: null, enabled: true, explicitChoice: false, source: null },
  { vertical: "venues", locked: false, eligible: true, reason: null, enabled: true, explicitChoice: false, source: null },
  { vertical: "dating", locked: false, eligible: false, reason: "kyc_required", enabled: true, explicitChoice: false, source: null },
  { vertical: "serendipity", locked: false, eligible: true, reason: null, enabled: false, explicitChoice: true, source: "settings" },
];

test("AMD-VERT-04: toggle items render locked, ineligible and live rows", () => {
  const items = verticalToggleItems(ROWS);
  assert.equal(items.length, 10); // the full catalogue, always
  const discovery = items[0];
  assert.equal(discovery.vertical, "discovery");
  assert.equal(discovery.toggleable, false);
  assert.equal(discovery.on, true);
  assert.equal(discovery.disabledReason, "locked");
  assert.equal(discovery.disabledCopyKey, "ui.verticals.locked");
  const venues = items.find((i) => i.vertical === "venues")!;
  assert.deepEqual(
    [venues.toggleable, venues.on, venues.disabledReason, venues.disabledCopyKey],
    [true, true, null, null],
  );
  const dating = items.find((i) => i.vertical === "dating")!;
  assert.deepEqual(
    [dating.toggleable, dating.on, dating.disabledReason, dating.disabledCopyKey],
    [false, true, "kyc_required", "ui.verticals.ineligible.kyc_required"],
  );
  const serendipity = items.find((i) => i.vertical === "serendipity")!;
  assert.equal(serendipity.on, false); // an explicit off row shows off
  // Rows absent from the read model fall back to the catalogue default.
  const groups = items.find((i) => i.vertical === "groups")!;
  assert.equal(groups.on, true);
});

test("AMD-VERT-04: the read-model parser is strict and fails closed", () => {
  const good = {
    verticals: [{
      vertical: "venues", locked: false, eligible: true,
      enabled: false, explicitChoice: true, source: "onboarding",
      reason: "underage",
    }],
  };
  const parsed = parseVerticalsResponse(good);
  assert.equal(parsed!.length, 1);
  assert.deepEqual(parsed![0], {
    vertical: "venues", locked: false, eligible: true, reason: "underage",
    enabled: false, explicitChoice: true, source: "onboarding",
  });
  assert.equal(parseVerticalsResponse({ verticals: [{ ...good.verticals[0], vertical: "bogus" }] }), null);
  assert.equal(parseVerticalsResponse({ verticals: [{ ...good.verticals[0], enabled: "yes" }] }), null);
  assert.equal(parseVerticalsResponse({ verticals: [{ ...good.verticals[0], reason: "nope" }] }), null);
  assert.equal(parseVerticalsResponse({ verticals: [{ ...good.verticals[0], source: "elsewhere" }] }), null);
  assert.equal(parseVerticalsResponse({}), null);
  assert.equal(parseVerticalsResponse(null), null);
  assert.equal(parseVerticalsResponse({ verticals: [{}] }), null);
});

test("AMD-VERT-05: the patch builder mirrors the edge and the definer", () => {
  assert.deepEqual(
    buildVerticalsPatch({ dating: false }, "onboarding"),
    { ok: true, patch: { dating: false }, source: "onboarding" },
  );
  assert.deepEqual(
    buildVerticalsPatch({ venues: true, trust: false }, "settings"),
    { ok: true, patch: { venues: true, trust: false }, source: "settings" },
  );
  // Affirming the locked core is a no-op that never hits the wire.
  assert.deepEqual(
    buildVerticalsPatch({ discovery: true, dating: false }, "settings"),
    { ok: true, patch: { dating: false }, source: "settings" },
  );
  // Narrowing the locked core refuses.
  const locked = buildVerticalsPatch({ discovery: false }, "settings");
  assert.equal(locked.ok, false);
  assert.ok(!locked.ok && locked.errors.includes("locked_narrowed"));
  // Every other refusal mode.
  for (const [toggles, source, err] of [
    [{}, "settings", "empty_patch"],
    [{ bogus: true }, "settings", "unknown_vertical"],
    [{ dating: "yes" }, "settings", "non_boolean"],
    [{ dating: true }, "ops", "source_unknown"],
  ] as const) {
    const r = buildVerticalsPatch(toggles, source);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.errors.includes(err as never), String(err));
  }
  // An all-no-op patch (core affirmation alone) has nothing to send.
  const noop = buildVerticalsPatch({ discovery: true }, "onboarding");
  assert.equal(noop.ok, false);
});

test("AMD-VERT: every copy key the module references exists in the registry", () => {
  const copy = readFileSync("../client/src/presence/copyRegistry.ts", "utf8");
  const module_ = readFileSync("../client/src/presence/verticalOnboarding.ts", "utf8");
  for (const e of VERTICAL_CATALOGUE) {
    assert.ok(copy.includes(`"${e.labelKey}"`), e.labelKey);
    assert.ok(copy.includes(`"${e.summaryKey}"`), e.summaryKey);
  }
  for (const key of ["ui.verticals.locked", "ui.verticals.ineligible."]) {
    assert.ok(module_.includes(key), key);
  }
  for (const key of ["ui.verticals.locked", "ui.verticals.ineligible.kyc_required",
                     "ui.verticals.ineligible.underage"]) {
    assert.ok(copy.includes(`"${key}"`), key);
  }
});

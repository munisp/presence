/**
 * Screen descriptor tests (b47): every screen is an audited tree —
 * skeleton regions in order, the safety tray everywhere, affordances
 * exactly the pinned lists, and the audits catch broken trees.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DISCOVERY_MODES, SKELETON_REGIONS } from "../src/presence/discoverySkeleton.js";
import { planIndoorPresence } from "../src/presence/indoorPresence.js";
import { MATCH_SURFACE_AFFORDANCES, buildMatchSurface } from "../src/presence/matchSurface.js";
import { THREAD_AFFORDANCES } from "../src/presence/conversationThread.js";
import { haloFromCount } from "../src/presence/presenceHalo.js";
import { SAFETY_ACTIONS, SAFETY_TRAY_ENTRY } from "../src/presence/reportFlow.js";
import {
  SAFETY_ACTION_COPY,
  auditUiScreen,
  buildCheckinScreen,
  buildConversationScreen,
  buildDiscoveryScreen,
  buildMatchScreen,
  buildSafetyTrayActions,
  buildSettingsScreen,
  collectActions,
  collectAffordances,
  uiHonoursContracts,
  type UiNode,
} from "../src/presence/ui/screens.js";

test("the discovery screen renders exactly the pinned skeleton regions", () => {
  const screen = buildDiscoveryScreen("rooms", haloFromCount(5));
  assert.ok(screen !== null);
  assert.deepEqual(
    screen.children?.map((region) => region.id),
    [...SKELETON_REGIONS],
  );
  // One tab action per mode, in the pinned order.
  const tabs = collectActions(screen).filter((a) => a.id.startsWith("mode-"));
  assert.deepEqual(
    tabs.map((a) => a.id),
    DISCOVERY_MODES.map((m) => `mode-${m}`),
  );
});

test("every screen carries the safety-tray entry (BR-07)", () => {
  const plan = planIndoorPresence({ insidePartnerVenue: true, checkinCode: "c1" });
  assert.ok(plan !== null);
  const screens = [
    buildDiscoveryScreen("pairs", haloFromCount(0)),
    buildMatchScreen(
      buildMatchSurface({ specVersion: 1, anchors: ["you", "them"] as const, nodes: [], edges: [] }),
    ),
    buildConversationScreen("pair-0"),
    buildCheckinScreen(plan),
    buildSettingsScreen(),
  ];
  for (const screen of screens) {
    assert.ok(screen !== null);
    assert.ok(collectAffordances(screen).includes(SAFETY_TRAY_ENTRY), screen.id);
    assert.deepEqual(auditUiScreen(screen), [], screen.id);
  }
});

test("the match screen interacts only via hold-to-wave and the tray", () => {
  const screen = buildMatchScreen(
    buildMatchSurface({ specVersion: 1, anchors: ["you", "them"] as const, nodes: [], edges: [] }),
  );
  assert.ok(screen !== null);
  assert.deepEqual(
    collectAffordances(screen).sort(),
    [...MATCH_SURFACE_AFFORDANCES, SAFETY_TRAY_ENTRY].sort(),
  );
});

test("the conversation affordances are the pinned thread list + tray", () => {
  const screen = buildConversationScreen("pair-9");
  assert.ok(screen !== null);
  assert.deepEqual(
    collectAffordances(screen).sort(),
    [...THREAD_AFFORDANCES, SAFETY_TRAY_ENTRY].sort(),
  );
  // A blank pair id fails closed.
  assert.equal(buildConversationScreen("  "), null);
});

test("FR-89 on screen: check-in is the first action; the fallback notice renders", () => {
  const plan = planIndoorPresence({ insidePartnerVenue: true, checkinCode: "c1" });
  assert.ok(plan !== null);
  const screen = buildCheckinScreen(plan);
  assert.ok(screen !== null);
  assert.equal(collectActions(screen)[0]?.id, "checkin");
  const texts: string[] = [];
  const walk = (n: UiNode): void => {
    if (n.text !== undefined) texts.push(n.text);
    for (const c of n.children ?? []) walk(c);
  };
  walk(screen);
  assert.ok(texts.some((t) => t.includes("fallback indoors")));
  // A non-check-in primary is not this screen's plan.
  assert.equal(
    buildCheckinScreen({ primary: "cell", fallback: null, fallbackNotice: null, checkin: null }),
    null,
  );
});

test("the audit catches a missing tray, blank text and duplicate focus", () => {
  const noTray: UiNode = {
    kind: "screen",
    id: "settings",
    children: [{ kind: "region", id: "header", children: [] }],
  };
  assert.ok(auditUiScreen(noTray).includes("safety-entry"));

  const blank: UiNode = {
    kind: "screen",
    id: "settings",
    children: [
      { kind: "text", id: "t", text: "   " },
      { kind: "action", id: "a", label: "Safety", role: "button", focusOrder: 0, affordance: "safety-entry" },
    ],
  };
  assert.ok(auditUiScreen(blank).includes("t:blank-text"));

  const dupFocus: UiNode = {
    kind: "screen",
    id: "settings",
    children: [
      { kind: "action", id: "a", label: "Safety", role: "button", focusOrder: 0, affordance: "safety-entry" },
      { kind: "action", id: "b", label: "Other", role: "button", focusOrder: 0 },
    ],
  };
  assert.ok(auditUiScreen(dupFocus).includes("b:focus-order-duplicate"));
});

test("the tray contents cover the five safety actions from every host", () => {
  for (const host of ["discovery", "conversation-thread", "venue-checkin", "settings", "match"] as const) {
    const tray = buildSafetyTrayActions(host);
    assert.ok(tray !== null, host);
    assert.equal(tray.length, SAFETY_ACTIONS.length);
    assert.deepEqual(
      tray.map((n) => n.affordance),
      [...SAFETY_ACTIONS],
    );
  }
});

test("every safety action has a copy key registered", () => {
  for (const action of SAFETY_ACTIONS) {
    assert.ok(SAFETY_ACTION_COPY[action].length > 0, action);
  }
});

test("master guard: uiHonoursContracts", () => {
  assert.equal(uiHonoursContracts(), true);
});

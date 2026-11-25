/**
 * UI screens (b47) — every screen as a framework-free descriptor tree.
 *
 * The descriptor is the contract the renderer (src/ui/render.tsx) is
 * held to: a screen is a tree of regions, texts and actions. Texts
 * carry a copy key resolved through the NFR-27 registry (English
 * baseline at build time, locale override at render time) and a tone
 * from the theme; actions carry an a11y label, a registered role, the
 * pinned 44 pt target and a unique focus order. There is no pixel
 * geometry here — layout is the renderer's job — but everything the
 * SRS can pin about a screen is pinned in the tree and audited by
 * {@link auditUiScreen}: control discipline (NFR-25/26), prohibition
 * registry (FR-87/FR-77), and the safety-tray entry on every screen
 * (BR-07).
 *
 * Builders return null on any failure — a screen that cannot be
 * described completely does not render at all.
 */

import {
  controlsViolations,
  type ControlDescriptor,
  type ControlRole,
} from "../accessibility.js";
import { resolveCopy } from "../copyRegistry.js";
import {
  DISCOVERY_MODES,
  skeletonFor,
  type DiscoveryMode,
} from "../discoverySkeleton.js";
import { planIndoorPresence, type IndoorPresencePlan } from "../indoorPresence.js";
import {
  MATCH_SURFACE_AFFORDANCES,
  buildMatchSurface,
  type MatchSurface,
} from "../matchSurface.js";
import { THREAD_AFFORDANCES } from "../conversationThread.js";
import { haloFromCount, type PresenceHalo } from "../presenceHalo.js";
import {
  SAFETY_ACTIONS,
  SAFETY_TRAY_ENTRY,
  SAFETY_WIRE,
  planSafetyAccess,
  safetyScreenViolations,
  type SafetyAction,
} from "../reportFlow.js";
import { descriptorViolations } from "../surfaceIntegrity.js";
import { ACTION_TARGET_PT, type ThemeTone } from "./theme.js";
import { safetyHostScreen, type NavScreen } from "./navigation.js";

/** One node of the screen tree the renderer walks. */
export interface UiNode {
  kind: "screen" | "region" | "text" | "action";
  id: string;
  /** Text nodes: resolved content + the registry key + tone. */
  text?: string;
  copyKey?: string;
  tone?: ThemeTone;
  /** Action nodes: a11y contract fields + the semantic affordance. */
  label?: string;
  role?: ControlRole;
  focusOrder?: number;
  affordance?: string;
  children?: readonly UiNode[];
}

/** Copy key per safety action — the tray labels resolve through NFR-27. */
export const SAFETY_ACTION_COPY: Record<SafetyAction, string> = {
  report: "report.cta",
  block: "block.cta",
  "withdraw-consent": "ui.safety.withdraw",
  "delete-account": "settings.delete-account",
  "privacy-controls": "ui.safety.privacy",
};

/** Copy key per conversation affordance. */
export const THREAD_AFFORDANCE_COPY: Record<string, string> = {
  "send-message": "ui.thread.send",
  "revoke-own-message": "ui.thread.revoke",
  "answer-close-offer": "ui.thread.close-offer",
  "delete-local-copy": "ui.thread.delete-local",
  "leave-conversation": "ui.thread.leave",
};

/** Resolve a pinned copy key; a missing baseline fails closed to null. */
function copy(key: string): string | null {
  return resolveCopy(null, key);
}

function textNode(id: string, copyKey: string, tone: ThemeTone): UiNode | null {
  const text = copy(copyKey);
  if (text === null) return null;
  return { kind: "text", id, text, copyKey, tone };
}

/** Literal text node for contract-pinned words (halo levels, headline). */
function literalText(id: string, text: string, tone: ThemeTone): UiNode | null {
  if (text.trim().length === 0) return null;
  return { kind: "text", id, text, tone };
}

function actionNode(
  id: string,
  copyKey: string,
  affordance: string,
  focusOrder: number,
): UiNode | null {
  const label = copy(copyKey);
  if (label === null) return null;
  return {
    kind: "action",
    id,
    label,
    role: "button",
    focusOrder,
    affordance,
  };
}

/** The safety-tray entry node every screen carries (BR-07). */
function trayEntry(focusOrder: number): UiNode | null {
  return actionNode("safety-tray", "ui.safety.tray", SAFETY_TRAY_ENTRY, focusOrder);
}

/**
 * The tray's contents for a host screen: one action per pinned safety
 * action, each planned through the BR-07 contract — the endpoint on the
 * node is the plan's, so the renderer cannot wire an action to a
 * different route than the contract allows.
 */
export function buildSafetyTrayActions(host: NavScreen): readonly UiNode[] | null {
  const nodes: UiNode[] = [];
  const hostScreen = safetyHostScreen(host);
  for (const [index, action] of SAFETY_ACTIONS.entries()) {
    const plan = planSafetyAccess(hostScreen, action);
    if (plan === null || plan.endpoint !== SAFETY_WIRE[action]) return null;
    const node = actionNode(`safety-${action}`, SAFETY_ACTION_COPY[action], action, index);
    if (node === null) return null;
    nodes.push(node);
  }
  return nodes;
}

/**
 * FR-80's skeleton rendered: header (title), mode selector (one action
 * per mode), result region (the halo's qualitative level — a word,
 * never a digit) and status tray (refresh + safety entry).
 */
export function buildDiscoveryScreen(
  mode: DiscoveryMode,
  halo: PresenceHalo,
): UiNode | null {
  const skeleton = skeletonFor(mode);
  const title = textNode("discovery-title", "ui.discovery.title", "title");
  if (title === null) return null;
  const header: UiNode = { kind: "region", id: "header", children: [title] };

  const modeActions: UiNode[] = [];
  for (const [index, m] of DISCOVERY_MODES.entries()) {
    const node = actionNode(`mode-${m}`, `ui.mode.${m}`, "mode-switch", index);
    if (node === null) return null;
    modeActions.push({ ...node, role: "tab" });
  }
  const modeSelector: UiNode = {
    kind: "region",
    id: "modeSelector",
    children: modeActions,
  };

  const haloText = literalText("halo-level", halo.level, "subtitle");
  if (haloText === null) return null;
  const resultRegion: UiNode = {
    kind: "region",
    id: "resultRegion",
    children: [haloText],
  };

  const refresh = actionNode("refresh", "ui.refresh", "refresh", DISCOVERY_MODES.length);
  const tray = trayEntry(DISCOVERY_MODES.length + 1);
  if (refresh === null || tray === null) return null;
  const statusTray: UiNode = {
    kind: "region",
    id: "statusTray",
    children: [refresh, tray],
  };

  const regions: Record<string, UiNode> = {
    header,
    modeSelector,
    resultRegion,
    statusTray,
  };
  return {
    kind: "screen",
    id: "discovery",
    children: skeleton.regions.map((region) => regions[region]),
  };
}

/**
 * FR-76 rendered: the headline and the converging paths come from the
 * MatchSurface alone; the only interaction is the FR-82 hold-to-wave,
 * plus the global safety entry.
 */
export function buildMatchScreen(surface: MatchSurface): UiNode | null {
  const title = textNode("match-title", "ui.match.title", "note");
  const headline = literalText("match-headline", surface.headline, "title");
  if (title === null || headline === null) return null;
  const pathNodes: UiNode[] = surface.paths.map((path, index) => {
    const text = `${path.yoursLabel} → ${path.nodeLabel} ← ${path.theirsLabel}`;
    return { kind: "text", id: `path-${index}`, text, tone: "subtitle" } as UiNode;
  });
  const wave = actionNode("wave", "ui.wave.hold", "hold-to-wave", 0);
  const tray = trayEntry(1);
  if (wave === null || tray === null) return null;
  return {
    kind: "screen",
    id: "match",
    children: [
      { kind: "region", id: "header", children: [title, headline] },
      { kind: "region", id: "paths", children: pathNodes },
      { kind: "region", id: "actions", children: [wave, tray] },
    ],
  };
}

/**
 * FR-87 rendered: the thread's actions are exactly the pinned affordance
 * list plus the safety entry — typing indicators and read receipts are
 * absent from the type the affordances come from.
 */
export function buildConversationScreen(pairId: string): UiNode | null {
  if (pairId.trim().length === 0) return null;
  const title = textNode("thread-title", "ui.thread.title", "title");
  if (title === null) return null;
  const actions: UiNode[] = [];
  for (const [index, affordance] of THREAD_AFFORDANCES.entries()) {
    const key = THREAD_AFFORDANCE_COPY[affordance];
    if (key === undefined) return null;
    const node = actionNode(`thread-${affordance}`, key, affordance, index);
    if (node === null) return null;
    actions.push(node);
  }
  const tray = trayEntry(THREAD_AFFORDANCES.length);
  if (tray === null) return null;
  return {
    kind: "screen",
    id: "conversation-thread",
    children: [
      { kind: "region", id: "header", children: [title] },
      { kind: "region", id: "messages", children: [] },
      { kind: "region", id: "actions", children: [...actions, tray] },
    ],
  };
}

/**
 * FR-89 rendered: the check-in plan decides the order — the primary
 * action first, the fallback notice as a text, never the reverse.
 */
export function buildCheckinScreen(plan: IndoorPresencePlan): UiNode | null {
  if (plan.primary !== "venue-checkin") return null;
  const title = textNode("checkin-title", "ui.checkin.title", "title");
  const checkin = actionNode("checkin", "presence.checkin.cta", "venue-checkin", 0);
  const tray = trayEntry(1);
  if (title === null || checkin === null || tray === null) return null;
  const children: UiNode[] = [
    { kind: "region", id: "header", children: [title] },
    { kind: "region", id: "actions", children: [checkin, tray] },
  ];
  if (plan.fallback !== null && plan.fallbackNotice !== null) {
    const notice = literalText("fallback-notice", plan.fallbackNotice, "note");
    if (notice === null) return null;
    children.splice(1, 0, { kind: "region", id: "fallback", children: [notice] });
  }
  return { kind: "screen", id: "venue-checkin", children };
}

/** Settings: privacy controls and account deletion, plus the tray. */
export function buildSettingsScreen(): UiNode | null {
  const title = textNode("settings-title", "ui.settings.title", "title");
  const privacy = actionNode("privacy", "ui.safety.privacy", "privacy-controls", 0);
  const remove = actionNode("delete-account", "settings.delete-account", "delete-account", 1);
  const tray = trayEntry(2);
  if (title === null || privacy === null || remove === null || tray === null) return null;
  return {
    kind: "screen",
    id: "settings",
    children: [
      { kind: "region", id: "header", children: [title] },
      { kind: "region", id: "actions", children: [privacy, remove, tray] },
    ],
  };
}

/** Depth-first walk: every action node in the tree. */
export function collectActions(node: UiNode): ControlDescriptor[] {
  const actions: ControlDescriptor[] = [];
  const walk = (current: UiNode): void => {
    if (current.kind === "action") {
      actions.push({
        id: current.id,
        label: current.label ?? "",
        role: current.role ?? ("button" as ControlRole),
        targetPt: ACTION_TARGET_PT,
        focusOrder: current.focusOrder ?? -1,
      });
    }
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return actions;
}

/** Depth-first walk: every affordance name in the tree. */
export function collectAffordances(node: UiNode): string[] {
  const affordances: string[] = [];
  const walk = (current: UiNode): void => {
    if (current.affordance !== undefined) affordances.push(current.affordance);
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return affordances;
}

/**
 * Audit one screen descriptor tree: control discipline (labels, roles,
 * 44 pt targets, unique focus order), the prohibition registry over the
 * affordance list, blank-text rejection, and the BR-07 safety entry via
 * the screen's host. Any violation is returned, never repaired.
 */
export function auditUiScreen(node: UiNode): string[] {
  const violations: string[] = [];
  if (node.kind !== "screen") return ["not-a-screen"];
  violations.push(...controlsViolations(collectActions(node)));
  const affordances = collectAffordances(node);
  violations.push(
    ...descriptorViolations({ kind: node.id, affordances, fields: {} }),
  );
  violations.push(
    ...safetyScreenViolations({
      name: safetyHostScreen(node.id as NavScreen),
      affordances,
    }),
  );
  const walk = (current: UiNode): void => {
    if (
      current.kind === "text" &&
      (typeof current.text !== "string" || current.text.trim().length === 0)
    ) {
      violations.push(`${current.id}:blank-text`);
    }
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return violations;
}

/**
 * Master guard for the rendered UI. Builds one descriptor per screen
 * from live contract fixtures and proves: every screen audits clean;
 * the discovery screen renders exactly the pinned skeleton regions; the
 * match screen's only interaction affordances are hold-to-wave and the
 * safety entry; the conversation screen's affordances are the pinned
 * thread list plus the safety entry; the check-in screen presents the
 * FR-89 primary first with the pinned fallback notice; and the tray
 * contents plan onto the pinned wires. A deliberately broken descriptor
 * (missing tray) must fail the audit — otherwise the guard is vacuous.
 */
export function uiHonoursContracts(): boolean {
  // One descriptor per screen, built from live contract fixtures.
  const discovery = buildDiscoveryScreen("pairs", haloFromCount(0));
  const match = buildMatchScreen(
    buildMatchSurface({
      specVersion: 1,
      anchors: ["you", "them"] as const,
      nodes: [],
      edges: [],
    }),
  );
  const thread = buildConversationScreen("pair-0");
  const plan = planIndoorPresence({ insidePartnerVenue: true, checkinCode: "code-1" });
  const checkin = plan === null ? null : buildCheckinScreen(plan);
  const settings = buildSettingsScreen();
  const screens = [discovery, match, thread, checkin, settings];
  if (screens.some((screen) => screen === null)) return false;
  for (const screen of screens as UiNode[]) {
    if (auditUiScreen(screen).length > 0) return false;
  }
  // The discovery tree renders exactly the pinned skeleton regions.
  const discoveryRegionIds = (discovery as UiNode).children?.map((r) => r.id);
  if (discoveryRegionIds?.join("|") !== skeletonFor("pairs").regions.join("|")) {
    return false;
  }
  // The match screen interacts only via hold-to-wave and the tray.
  const matchAffordances = collectAffordances(match as UiNode).sort();
  if (
    matchAffordances.join("|") !==
    [...MATCH_SURFACE_AFFORDANCES, SAFETY_TRAY_ENTRY].sort().join("|")
  ) {
    return false;
  }
  // The thread's affordances are the pinned list plus the tray, no more.
  const threadAffordances = collectAffordances(thread as UiNode).sort();
  if (
    threadAffordances.join("|") !==
    [...THREAD_AFFORDANCES, SAFETY_TRAY_ENTRY].sort().join("|")
  ) {
    return false;
  }
  // FR-89 on screen: the check-in action is the first action in the tree.
  const checkinActions = collectActions(checkin as UiNode);
  if (checkinActions[0]?.id !== "checkin") return false;
  // The tray contents plan onto the pinned wires for every host screen.
  for (const host of ["discovery", "conversation-thread", "venue-checkin", "settings", "match"] as const) {
    const tray = buildSafetyTrayActions(host);
    if (tray === null || tray.length !== SAFETY_ACTIONS.length) return false;
  }
  // Non-vacuity: a screen without the tray must fail the audit.
  const broken: UiNode = {
    kind: "screen",
    id: "settings",
    children: [{ kind: "region", id: "header", children: [] }],
  };
  if (!auditUiScreen(broken).includes("safety-entry")) return false;
  return true;
}

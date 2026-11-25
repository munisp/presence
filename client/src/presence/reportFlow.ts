/**
 * BR-07: monetisation MUST NOT gate safety features, and reporting,
 * blocking, consent withdrawal, account deletion and privacy controls
 * MUST be free and reachable in at most two taps from any screen.
 *
 * The server half is already law: the report, block, consent-withdrawal
 * and account-deletion endpoints exist and are ungated — no payment
 * system sits in front of them (P3 payments are deferred, and when they
 * arrive this contract is what stops a paywall from ever landing on a
 * safety action). This module is the client half, as three contracts:
 *
 *   1. The action registry — {@link SAFETY_ACTIONS} is exactly the five
 *      actions the SRS names, each with its pinned wire endpoint (or, for
 *      privacy controls, the consent surface it opens). Unknown actions
 *      refuse; the set is not open.
 *   2. Two taps from anywhere — every top-level screen
 *      ({@link APP_SCREENS}) carries the pinned safety-tray entry
 *      affordance, and {@link planSafetyAccess} resolves any screen ×
 *      action pair to exactly two taps: open the tray, pick the action.
 *      The FR-03 account-deletion journey's own three taps start AFTER
 *      the entry — BR-07 budgets reachability, FR-03 budgets the flow.
 *   3. Free by construction — {@link SafetyPlan} has no price field and
 *      {@link safetyPlanViolations} flags any descriptor that smuggles
 *      one in ({@link MONETISATION_FIELDS}), so a paywall on a safety
 *      action fails an audit instead of shipping.
 *
 * Framework-free by design: pure TypeScript, so the unit tests run
 * under plain node --test.
 */

import { ACCOUNT_DELETE_ENDPOINT } from "./journeyContracts.js";

/** BR-07: the five safety actions the SRS names. */
export const SAFETY_ACTIONS = [
  "report",
  "block",
  "withdraw-consent",
  "delete-account",
  "privacy-controls",
] as const;

export type SafetyAction = (typeof SAFETY_ACTIONS)[number];

/** BR-07: reachability is budgeted in at most two taps from any screen. */
export const MAX_SAFETY_TAPS = 2;

/**
 * BR-07: the pinned wire each action travels on. Privacy controls are a
 * client surface that reads the account's current consents; the other
 * four are the ungated server endpoints. Account deletion is
 * cross-pinned to the FR-03 journey contract, not re-declared.
 */
export const SAFETY_WIRE: Record<SafetyAction, string> = {
  report: "POST /v1/reports",
  block: "POST /v1/blocks",
  "withdraw-consent": "DELETE /v1/account/consents/{purpose}",
  "delete-account": ACCOUNT_DELETE_ENDPOINT,
  "privacy-controls": "GET /v1/account/consents",
};

/**
 * BR-07: "from any screen" as a pinned registry. The three discovery
 * modes share one skeleton, so the discovery entry covers all of them;
 * the conversation thread, the venue check-in surface and settings each
 * carry the same safety-tray entry.
 */
export const APP_SCREENS = [
  "discovery",
  "conversation-thread",
  "venue-checkin",
  "settings",
] as const;

export type AppScreen = (typeof APP_SCREENS)[number];

/** BR-07: the affordance every screen carries into the safety tray. */
export const SAFETY_TRAY_ENTRY = "safety-entry" as const;

/**
 * BR-07: fields a safety plan must never carry. Any of them on a safety
 * descriptor is monetisation gating safety — a violation, not a variant.
 */
export const MONETISATION_FIELDS = [
  "price",
  "paywall",
  "premium",
  "subscription",
  "upsell",
] as const;

/** The plan a surface executes: open the tray, then the action. */
export interface SafetyPlan {
  screen: AppScreen;
  action: SafetyAction;
  path: readonly [typeof SAFETY_TRAY_ENTRY, SafetyAction];
  taps: number;
  free: true;
  endpoint: string;
}

function isSafetyAction(action: string): action is SafetyAction {
  return (SAFETY_ACTIONS as readonly string[]).includes(action);
}

function isAppScreen(screen: string): screen is AppScreen {
  return (APP_SCREENS as readonly string[]).includes(screen);
}

/**
 * Plan reaching a safety action from a screen. Every registered screen
 * reaches every registered action in exactly two taps — open the safety
 * tray, pick the action — and the plan is free by construction: the type
 * has no room for a price. An unknown screen or action returns null —
 * a surface that cannot place the action must not improvise a path.
 */
export function planSafetyAccess(screen: string, action: string): SafetyPlan | null {
  if (!isAppScreen(screen)) return null;
  if (!isSafetyAction(action)) return null;
  return {
    screen,
    action,
    path: [SAFETY_TRAY_ENTRY, action],
    taps: MAX_SAFETY_TAPS,
    free: true,
    endpoint: SAFETY_WIRE[action],
  };
}

/**
 * Audit a screen descriptor: it must carry the safety-tray entry
 * affordance, and none of its fields may be a monetisation field.
 */
export function safetyScreenViolations(screen: {
  name: string;
  affordances: readonly string[];
  fields?: Record<string, unknown>;
}): string[] {
  const violations: string[] = [];
  if (!isAppScreen(screen.name)) violations.push("screen");
  if (!screen.affordances.includes(SAFETY_TRAY_ENTRY)) {
    violations.push("safety-entry");
  }
  for (const field of MONETISATION_FIELDS) {
    if (screen.fields !== undefined && field in screen.fields) {
      violations.push(`monetisation:${field}`);
    }
  }
  return violations;
}

/**
 * Audit a safety plan descriptor: known screen and action, within the
 * two-tap budget, free, on the pinned wire — and no monetisation field
 * anywhere on it. The descriptor is structurally a SafetyPlan, so the
 * monetisation check audits for fields smuggled past the type.
 */
export function safetyPlanViolations(plan: SafetyPlan): string[] {
  const violations: string[] = [];
  if (!isAppScreen(plan.screen)) violations.push("screen");
  if (!isSafetyAction(plan.action)) violations.push("action");
  if (!Number.isFinite(plan.taps) || plan.taps > MAX_SAFETY_TAPS) {
    violations.push("taps");
  }
  if (plan.free !== true) violations.push("free");
  if (isSafetyAction(plan.action) && plan.endpoint !== SAFETY_WIRE[plan.action]) {
    violations.push("endpoint");
  }
  const record = plan as unknown as Record<string, unknown>;
  for (const field of MONETISATION_FIELDS) {
    if (field in record) violations.push(`monetisation:${field}`);
  }
  return violations;
}

/**
 * The BR-07 guard: exactly the five SRS-named actions, every screen
 * reaches every action within the two-tap budget, every plan is free,
 * account deletion travels on the FR-03-pinned endpoint, and the
 * monetisation-field registry is load-bearing — a descriptor carrying a
 * price is flagged, proving the audit is not vacuous.
 */
export function safetyAccessHonoursBr07(): boolean {
  if (SAFETY_ACTIONS.length !== 5) return false;
  for (const screen of APP_SCREENS) {
    for (const action of SAFETY_ACTIONS) {
      const plan = planSafetyAccess(screen, action);
      if (plan === null) return false;
      if (plan.taps > MAX_SAFETY_TAPS || plan.free !== true) return false;
      if (safetyPlanViolations(plan).length !== 0) return false;
    }
  }
  if (SAFETY_WIRE["delete-account"] !== "DELETE /v1/account") return false;
  const smuggled = {
    ...planSafetyAccess("settings", "report"),
    price: 0,
  } as unknown as SafetyPlan;
  return safetyPlanViolations(smuggled).includes("monetisation:price");
}

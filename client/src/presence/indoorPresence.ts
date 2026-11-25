/**
 * FR-89: inside a partner venue, the primary presence path MUST be
 * venue check-in against a signed code displayed at the venue; the
 * cell-derived path MUST be the fallback indoors, never the default —
 * satellite positioning does not resolve indoors and network positioning
 * can be wrong by more than a cell. FR-89 raises FR-48 from optional to
 * mandatory.
 *
 * The server half is already law: the venue mints signed per-floor
 * check-in tokens (FR-99/FR-100) and POST /v1/presence/checkin
 * attributes presence to (venueId, floorId) with a confidence the cell
 * cannot match (FR-48's pinned ordering, journeyContracts). This module
 * is the client half — the indoor UX contract, as three rules:
 *
 *   1. Check-in is the primary path — {@link planIndoorPresence}
 *      resolves the primary action to venue check-in whenever the
 *      device is inside a partner venue and a signed code is on display.
 *      The cell path is not offered as the default indoors; it appears
 *      only as the explicit fallback.
 *   2. The fallback is real, not decorative — when the code is not
 *      available (not yet displayed, unreadable, refused) the cell path
 *      remains, carrying the pinned {@link INDOOR_FALLBACK_NOTICE} so
 *      the user knows check-in is the stronger path. Indoors without
 *      any code the cell is the fallback by construction, never the
 *      headline.
 *   3. Fail closed — a garbage venue context produces null, and an
 *      empty code still refuses at {@link planVenueCheckin} (FR-48);
 *      this planner never turns a bad code into a request.
 *
 * Framework-free by design: pure TypeScript, so the unit tests run
 * under plain node --test.
 */

import {
  PRESENCE_SOURCE_CONFIDENCE,
  preferredPresenceSource,
  planVenueCheckin,
  type PresenceSource,
  type VenueCheckinPlan,
} from "./journeyContracts.js";

/**
 * FR-89: the notice the fallback carries indoors — check-in is the
 * primary path; the cell is standing in for it.
 */
export const INDOOR_FALLBACK_NOTICE =
  "Check in with the venue's code for exact presence — the map estimate is the fallback indoors." as const;

/** The plan the indoor presence surface executes. */
export interface IndoorPresencePlan {
  /** The primary action the surface presents first. */
  primary: PresenceSource;
  /** The fallback, present whenever the primary is venue check-in. */
  fallback: PresenceSource | null;
  /** The notice the fallback carries; null when there is no fallback. */
  fallbackNotice: string | null;
  /** The check-in plan, when the primary is venue check-in. */
  checkin: VenueCheckinPlan | null;
}

/**
 * FR-89: plan the indoor presence path. Inside a partner venue the
 * primary is venue check-in and the cell is the fallback with the
 * pinned notice; the ranking itself is delegated to the FR-48-pinned
 * confidence ordering, so the primary can never come out as the cell
 * while a check-in code is available. An empty code yields a plan whose
 * check-in half refuses — the surface still presents check-in first
 * (the code is on display; the user scans it), and the refusal keeps a
 * bad code off the wire. Outside a partner venue this module does not
 * apply: the caller uses the outdoor path and gets null here.
 */
export function planIndoorPresence(context: {
  insidePartnerVenue: boolean;
  checkinCode: string;
}): IndoorPresencePlan | null {
  if (typeof context.insidePartnerVenue !== "boolean") return null;
  if (typeof context.checkinCode !== "string") return null;
  if (!context.insidePartnerVenue) return null;
  const checkin = planVenueCheckin(context.checkinCode);
  const primary = preferredPresenceSource(["venue-checkin", "cell"]);
  if (primary !== "venue-checkin") return null; // the FR-48 ordering broke
  return {
    primary,
    fallback: "cell",
    fallbackNotice: INDOOR_FALLBACK_NOTICE,
    checkin,
  };
}

/**
 * The FR-89 guard: indoors the primary is the check-in and the cell is
 * the fallback with the pinned notice; the confidence ordering still
 * ranks venue check-in strictly above the cell; an empty code refuses
 * at the wire; and a garbage context fails closed to null.
 */
export function indoorPresenceHonoursFr89(): boolean {
  const plan = planIndoorPresence({
    insidePartnerVenue: true,
    checkinCode: "signed-code",
  });
  if (plan === null) return false;
  if (plan.primary !== "venue-checkin" || plan.fallback !== "cell") return false;
  if (plan.fallbackNotice !== INDOOR_FALLBACK_NOTICE) return false;
  if (plan.checkin === null || plan.checkin.action !== "checkin") return false;
  const emptyCode = planIndoorPresence({
    insidePartnerVenue: true,
    checkinCode: "  ",
  });
  if (
    emptyCode === null ||
    emptyCode.checkin === null ||
    emptyCode.checkin.action !== "refuse"
  ) {
    return false;
  }
  if (planIndoorPresence({ insidePartnerVenue: false, checkinCode: "x" }) !== null) {
    return false;
  }
  return (
    PRESENCE_SOURCE_CONFIDENCE["venue-checkin"] > PRESENCE_SOURCE_CONFIDENCE.cell
  );
}

/**
 * Presence — consumer client (TECH-01).
 *
 * React Native + Expo custom dev client. Expo Go is prohibited: BLE
 * presence (TR-31) needs native modules, so development and distribution
 * both run through the dev client (see client/README.md).
 *
 * The product surfaces land in the surface batches; the foundation here
 * is the privacy contract the surfaces are held to: cells are computed on
 * device (TR-29), local state is allowlisted and wiped on logout (TR-30),
 * BLE codes rotate and carry no stable identifier (TR-31), denied
 * permissions degrade without dead ends (TR-32), and TLS pinning is
 * remotely removable (TR-33). Compatibility and surface contracts:
 * unsupported versions prompt instead of failing silently (TR-27),
 * external links stay plain text behind a confirmation interstitial
 * (SEC-34), and the match surface renders from the versioned diagram
 * spec alone (TR-35). The publish lifecycle is disciplined end to end:
 * the accuracy grant gates every publish (FR-88), the published cell is
 * stabilised over a five-minute window (FR-92), reduced power caps the
 * cadence at ten minutes (FR-85), and backgrounding withdraws presence
 * within 60 seconds (FR-19). Sign-in is passkey-only (FR-01): the
 * ceremony runs in the system browser against the consumer realm over
 * Authorization Code + PKCE (S256), the session refreshes ahead of the
 * five-minute SEC-02 token expiry, and logout withdraws presence before
 * it ends the IdP session and wipes local state (TR-30). The interaction
 * surfaces are disciplined too: the constellation picker reaches three
 * interests inside four interactions (FR-81), waving needs a sustained
 * 400 ms press with a haptic ramp and can never fire on a tap (FR-82),
 * every consent transition has a distinct haptic plus an audio/spoken
 * channel (FR-83), the co-location close offer asks once and declining
 * changes nothing (FR-84), and ambient surfaces are individually
 * opt-in, off by default, and contentless (FR-86, SEC-35). The journey
 * contracts hold end to end: account deletion is three taps inside the
 * app with no support contact (FR-03), presence refuses to publish with
 * fewer than three interests and offers the picker (FR-08), own
 * messages are revocable for 24 hours and conversations delete locally
 * (FR-41), and venue check-in outranks cell matching indoors (FR-48,
 * FR-89). The conversation surfaces inherit the same discipline: the
 * thread has no typing indicator or read receipt by construction
 * (FR-87), the RoomBoard renders k-suppressed notes with no authors
 * (FR-45/46), and the TableCard shows time, place, head count and one
 * generated prompt behind a six-seat join (FR-66/67, SEC-33). The
 * budget contracts bound the device behaviour: cold and warm starts
 * follow the pinned phase ledger (NFR-04/05), the foreground duty
 * cycle fits 2 %/h in both power modes and background presence off
 * means no background work (NFR-29/30), the match surface renders
 * inside one 60 fps frame and ambient widgets refresh at most once a
 * minute without waking the radio (NFR-35/36), and dependencies pass
 * the 45 MB / licence / maintenance budget (TECH-16). Identity reveals
 * always carry the pinned verification badge — on the offer, the table
 * roster and the booked slot, not only in settings (FR-70) — and the
 * shell holds WCAG 2.2 AA: palette contrast audited (the note colour
 * moved when the audit caught it), 200 % dynamic type, reduced motion
 * honoured, 44 pt targets, and the primary action in the lower 40
 * percent of the display (NFR-25/26/37).
 */

import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";

import { BLE_ROTATION_PERIOD_S } from "./src/presence/bleCodes.js";
import { PRESENCE_H3_RESOLUTION } from "./src/presence/cell.js";
import { LOCAL_STATE_ALLOWLIST } from "./src/presence/localState.js";
import { REDUCED_PUBLISH_INTERVAL_S } from "./src/presence/powerMode.js";
import { BACKGROUND_WITHDRAWAL_DEADLINE_S } from "./src/presence/presenceLifecycle.js";
import { STABILISATION_WINDOW_MS } from "./src/presence/cellStabiliser.js";
import { ACCURACY_REFUSAL_ALTERNATIVE } from "./src/presence/publishGate.js";
import { PKCE_CHALLENGE_METHOD } from "./src/presence/authFlow.js";
import { ACCESS_TOKEN_LIFESPAN_S, REFRESH_MARGIN_S } from "./src/presence/session.js";
import { skeletonSharedAcrossModes, skeletonFor, DISCOVERY_MODES } from "./src/presence/discoverySkeleton.js";
import { showsCommonalityNotIdentity, buildMatchSurface } from "./src/presence/matchSurface.js";
import { DEFAULT_EXPIRY_PRESENTATION } from "./src/presence/offerWindow.js";
import { haloHonoursFr77, haloFromCount } from "./src/presence/presenceHalo.js";
import { honoursSurfaceProhibitions } from "./src/presence/surfaceIntegrity.js";
import { pickerHonoursFr81, buildConstellationPicker } from "./src/presence/constellationPicker.js";
import { tapCannotWave, WAVE_PRESS_MIN_MS } from "./src/presence/holdToWave.js";
import { everyTransitionHasFeedback } from "./src/presence/haptics.js";
import { declineLeavesIntact, applyCloseOfferDecision, COLOCATION_CLOSE_OFFER_MIN_MS } from "./src/presence/closeOffer.js";
import {
  ambientHonoursSec35,
  buildAmbientPayload,
  defaultAmbientPreferences,
  AMBIENT_SURFACES,
} from "./src/presence/ambientSurfaces.js";
import {
  checkinHonoursFr48,
  planAccountDelete,
  presenceReadiness,
} from "./src/presence/journeyContracts.js";
import { threadHonoursFr87 } from "./src/presence/conversationThread.js";
import { renderCrowd, roomBoardHonoursFr87 } from "./src/presence/roomBoard.js";
import { planJoin, tableCardHonoursFr87 } from "./src/presence/tableCard.js";
import { startupBudgetHonoursNfr04Nfr05 } from "./src/presence/startupBudget.js";
import { powerBudgetHonoursNfr29, backgroundParityHonoursNfr30 } from "./src/presence/powerBudget.js";
import { frameBudgetHonoursNfr35, ambientRefreshHonoursNfr36 } from "./src/presence/frameBudget.js";
import { dependencyBudgetHonoursTech16, BUNDLE_CAP_BYTES } from "./src/presence/dependencyBudget.js";
import { buildIdentityReveal, revealHonoursFr70 } from "./src/presence/verificationBadge.js";
import {
  REACH_REFERENCE_DEVICE,
  TOUCH_TARGET_MIN_PT,
  accessibilityHonoursNfr25Nfr26Nfr37,
  primaryActionInReachZone,
} from "./src/presence/accessibility.js";
import { CLIENT_PROTOCOL_VERSION } from "./src/presence/versioning.js";

const SURFACE_CHECKS = [
  // FR-80: pairs and rooms share the one discovery skeleton.
  skeletonSharedAcrossModes(skeletonFor("pairs"), skeletonFor("rooms")),
  // FR-76: the match surface shows commonality, never identity.
  showsCommonalityNotIdentity(
    buildMatchSurface({ specVersion: 1, anchors: ["you", "them"] as const, nodes: [], edges: [] }),
  ),
  // FR-77/FR-78: the halo is a density field with no positional component.
  haloHonoursFr77(haloFromCount(0)),
  // FR-87: the skeleton descriptor carries no banned affordance.
  honoursSurfaceProhibitions({ kind: "discovery-skeleton", affordances: [], fields: {} }),
  // FR-81: the picker offers both modes inside the interaction budget.
  pickerHonoursFr81(buildConstellationPicker("constellation", [])),
  // FR-82: no tap duration below the threshold can wave.
  tapCannotWave(50) && tapCannotWave(WAVE_PRESS_MIN_MS - 1),
  // FR-83: every consent transition has distinct haptic + audio feedback.
  everyTransitionHasFeedback(),
  // FR-84: declining the close offer leaves the conversation intact.
  declineLeavesIntact(
    { conversationOpen: true, notificationsEnabled: true },
    applyCloseOfferDecision("dismiss", { conversationOpen: true, notificationsEnabled: true }),
  ),
  // FR-86/SEC-35: ambient surfaces default off and the payload is contentless.
  AMBIENT_SURFACES.every((surface) => defaultAmbientPreferences()[surface] === false) &&
    ambientHonoursSec35(buildAmbientPayload(true)),
  // FR-03: account deletion fits the three-tap budget, no support contact.
  planAccountDelete().withinBudget && planAccountDelete().needsNoSupport,
  // FR-08: two declared interests block the publish; check-in outranks cell (FR-48).
  !presenceReadiness(2).publish && presenceReadiness(3).publish && checkinHonoursFr48(),
  // FR-87: the conversation thread carries no typing indicator or read receipt.
  threadHonoursFr87({
    pairId: "pair-0",
    messages: [],
    sentCount: 0,
    closeOffer: { conversationOpen: true, coLocatedMs: 0, offerState: "not-due" },
    snapshot: { conversationOpen: true, notificationsEnabled: true },
  }),
  // FR-45: the RoomBoard renders a k-suppressed crowd with no authors.
  roomBoardHonoursFr87({ topic: "", members: null, suppressed: true, k: 11, notes: [] }) &&
    renderCrowd({ topic: "", members: null, suppressed: true, k: 11, notes: [] }) === null,
  // FR-66/SEC-33: the TableCard joins while open and refuses the seventh seat.
  planJoin(true, 5).action === "join" && planJoin(true, 6).action === "refuse" &&
    tableCardHonoursFr87({
      tableId: "t0",
      time: "",
      place: "",
      headCount: 0,
      prompt: { nodeId: "n", label: "", memberCount: 2, members: ["a", "b"], generated: true },
    }),
  // NFR-04/05: the startup ledger fits both budgets with deferred work off the critical path.
  startupBudgetHonoursNfr04Nfr05(),
  // NFR-29/30: both power modes fit 2 %/h; background presence off means no background work.
  powerBudgetHonoursNfr29() && backgroundParityHonoursNfr30(),
  // NFR-35/36: the render ledger fits the frame; ambient refresh is minute-gated, never polls.
  frameBudgetHonoursNfr35() && ambientRefreshHonoursNfr36(),
  // TECH-16: the dependency ledger fits the 45 MB bundle cap.
  dependencyBudgetHonoursTech16(),
  // FR-70: verification status rides every identity reveal on the three surfaces.
  revealHonoursFr70() && buildIdentityReveal("offer", "Ada", "verified") !== null,
  // NFR-25/26/37: AA palette, 44 pt targets, primary action in the lower 40 %.
  accessibilityHonoursNfr25Nfr26Nfr37() &&
    primaryActionInReachZone(
      REACH_REFERENCE_DEVICE.logicalHeightPt * 0.75,
      REACH_REFERENCE_DEVICE.logicalHeightPt,
    ),
] as const;
const SURFACES_OK = SURFACE_CHECKS.every(Boolean);

export default function App() {
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <Text style={styles.title}>Presence</Text>
      <Text style={styles.subtitle}>Be where your people are.</Text>
      <Text style={styles.note}>
        On-device cells (H3 r{PRESENCE_H3_RESOLUTION}) · {LOCAL_STATE_ALLOWLIST.length} local keys, wiped
        on logout · BLE codes rotate every {BLE_ROTATION_PERIOD_S / 60} min · protocol v{CLIENT_PROTOCOL_VERSION}
        {"\n"}cells settle over {STABILISATION_WINDOW_MS / 60000} min · reduced power publishes every{" "}
        {REDUCED_PUBLISH_INTERVAL_S / 60} min · background exit withdraws in {BACKGROUND_WITHDRAWAL_DEADLINE_S}s ·
        approximate location → {ACCURACY_REFUSAL_ALTERNATIVE}
        {"\n"}passkey-only sign-in · PKCE {PKCE_CHALLENGE_METHOD} · {ACCESS_TOKEN_LIFESPAN_S / 60} min tokens,
        refreshed {REFRESH_MARGIN_S}s early · logout withdraws presence first
        {"\n"}{DISCOVERY_MODES.length} discovery modes, one shared skeleton · expiry closes as a{" "}
        {DEFAULT_EXPIRY_PRESENTATION} · surface guards {SURFACES_OK ? "green" : "BROKEN"}
        {"\n"}wave needs {WAVE_PRESS_MIN_MS} ms held · close offer after{" "}
        {COLOCATION_CLOSE_OFFER_MIN_MS / 60000} min co-located · ambient surfaces opt-in, contentless
        {"\n"}delete account in 3 taps · &lt;3 interests blocks publish · revoke own messages 24 h ·
        venue check-in &gt; cell indoors
        {"\n"}thread: no typing indicator, no read receipts · room notes k-suppressed, authorless ·
        tables seat six
        {"\n"}budgets: cold start 1.8 s · warm 600 ms · battery &le;2 %/h · background off = no work ·
        bundle &le;{Math.round(BUNDLE_CAP_BYTES / 1024 / 1024)} MB
        {"\n"}verification badge on every reveal · AA contrast · {TOUCH_TARGET_MIN_PT} pt targets ·
        primary action in the lower 40 %
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0B0F14",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  title: { color: "#F2F5F7", fontSize: 34, fontWeight: "700" },
  subtitle: { color: "#9FB0BC", fontSize: 16, marginTop: 8 },
  note: { color: "#74879B", fontSize: 12, marginTop: 24, textAlign: "center" },
});

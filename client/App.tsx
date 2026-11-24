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
 * it ends the IdP session and wipes local state (TR-30).
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
  note: { color: "#5C6B77", fontSize: 12, marginTop: 24, textAlign: "center" },
});

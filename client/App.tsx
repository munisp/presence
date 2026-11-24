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
 * within 60 seconds (FR-19).
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
import { CLIENT_PROTOCOL_VERSION } from "./src/presence/versioning.js";

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

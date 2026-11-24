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
 * spec alone (TR-35).
 */

import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";

import { BLE_ROTATION_PERIOD_S } from "./src/presence/bleCodes.js";
import { PRESENCE_H3_RESOLUTION } from "./src/presence/cell.js";
import { LOCAL_STATE_ALLOWLIST } from "./src/presence/localState.js";
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

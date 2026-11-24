/**
 * Presence — consumer client (TECH-01).
 *
 * React Native + Expo custom dev client. Expo Go is prohibited: BLE
 * presence (TR-31) needs native modules, so development and distribution
 * both run through the dev client (see client/README.md).
 *
 * The product surfaces land in the surface batches; the foundation here
 * is the privacy contract the surfaces are held to: cells are computed on
 * device (TR-29) and local state is allowlisted and wiped on logout
 * (TR-30).
 */

import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";

import { PRESENCE_H3_RESOLUTION } from "./src/presence/cell.js";
import { LOCAL_STATE_ALLOWLIST } from "./src/presence/localState.js";

export default function App() {
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <Text style={styles.title}>Presence</Text>
      <Text style={styles.subtitle}>Be where your people are.</Text>
      <Text style={styles.note}>
        On-device cells (H3 r{PRESENCE_H3_RESOLUTION}) · {LOCAL_STATE_ALLOWLIST.length} local keys, wiped
        on logout
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

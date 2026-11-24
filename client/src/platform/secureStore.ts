/**
 * TR-30 platform adapter: Expo SecureStore as the KV backend.
 *
 * Secrets (the session refresh token) belong in the platform keystore,
 * not AsyncStorage. This adapter is the only native dependency of the
 * local-state module; the policy itself (allowlist, wipe) is pure and
 * lives in src/presence/localState.ts.
 */

import * as SecureStore from "expo-secure-store";

import type { KeyValueBackend } from "../presence/localState.js";

export function createSecureStoreBackend(): KeyValueBackend {
  return {
    getItem: (key) => SecureStore.getItemAsync(key),
    setItem: async (key, value) => {
      await SecureStore.setItemAsync(key, value);
    },
    deleteItem: async (key) => {
      await SecureStore.deleteItemAsync(key);
    },
  };
}

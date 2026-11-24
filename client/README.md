# Presence client (TECH-01)

React Native + Expo **custom dev client**. Expo Go is prohibited: BLE
presence (TR-31) requires native modules that Expo Go does not ship, so
every build — development included — is a dev client build.

## Layout

| Path | What it is |
|---|---|
| `App.tsx` | Root component; surfaces land in the surface batches |
| `src/presence/` | Framework-free modules — the privacy contract in pure TS |
| `src/presence/cell.ts` | TR-29: on-device H3 cell computation; the publish payload carries a cell id, never coordinates (FR-15 server mirror rejects coordinate-shaped fields) |
| `src/presence/localState.ts` | TR-30: allowlisted local state; logout/uninstall wipes every allowlisted key by construction |
| `src/presence/bleCodes.ts` | TR-31: BLE rotating derived codes — HMAC of the presence session id per 900 s window (≤ the 15-minute SRS cap); the advertisement carries only the derived code, never a stable identifier |
| `src/presence/permissions.ts` | TR-32: clean degradation — denied Bluetooth/location/push maps to a degraded-but-never-dead profile (manual check-in and in-app realtime are unconditional floors) |
| `src/presence/certPinning.ts` | TR-33: certificate-pinning policy resolved from remote config (`GET /v1/client/config`); removable by server-side configuration without an app update; fails open to OS trust |
| `src/presence/versioning.ts` | TR-27: unsupported-version detection — bootstrap config + `x-api-version` + 426 all converge on the pinned update prompt; malformed signals fail open, never brick |
| `src/presence/linkInterstitial.ts` | SEC-34: external links render as plain text with previews forbidden; the only path to opening runs through the pinned confirmation interstitial; the allowlist mirrors the server's governed list |
| `src/presence/matchDiagram.ts` | TR-35: the versioned match-surface diagram — built from the scan payload alone (no round trip); an unknown `diagramSpec` refuses and routes to the TR-27 update prompt |
| `src/presence/sha256.ts` | Pure-TS SHA-256/HMAC for TR-31 (Hermes ships no crypto) — RFC 4231-pinned, zero added dependencies |
| `src/platform/` | Native adapters (SecureStore for TR-30 secrets) |
| `test/` | `node --test` suites over the pure modules |

## Developing

```bash
cd client
npm ci
npm run typecheck   # full TS check incl. the RN surface
npm test            # pure-module unit tests (node --test)
npm run prebuild    # generate ios/ and android/ native projects
npm start           # expo start --dev-client
```

Platform floors (NFR-28): iOS deployment target 16.0, Android
`minSdkVersion` 29 (Android 10) with graceful BLE-floor degradation.
BLE and location permissions are declared in `app.json`;
`ACCESS_BACKGROUND_LOCATION` is explicitly blocked — background presence
is opt-in and off by default (FR-19/NFR-30).

## Dependency discipline

Every dependency is on the SEC-18 allowlist
(`docs/security/sdk-allowlist.json`) with justification, data-access
class and approver; the `sdk-allowlist` CI job fails closed on anything
else. The bundle budget is 45 MB (TECH-16) — new dependencies are
scrutinised against it at review.

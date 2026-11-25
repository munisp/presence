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
| `src/presence/surfaceIntegrity.ts` | FR-87/FR-77: the single prohibition registry — engagement mechanics (infinite scroll, typing indicators, read receipts, streaks, like/view counts, photo-at-match) and proximity elements (map, direction, distance, radius, heat-map) — every surface descriptor is audited against |
| `src/presence/matchSurface.ts` | FR-76: the match surface — built only from the TR-35 diagram; one converging path per shared node, a commonality headline, and a fixed `{headline, paths}` field set no photo, name, or handle can occupy |
| `src/presence/presenceHalo.ts` | FR-78: density as an undirected field — a 0..1 intensity over the aggregate count and a qualitative level that cannot carry digits; invalid counts fail closed to calm; no positional component exists in the type |
| `src/presence/offerWindow.ts` | FR-79: expiry as a closing perimeter — a 0..1 fraction over the FR-33 window; the numeric form exists only behind an explicit preference and the default render never computes seconds |
| `src/presence/discoverySkeleton.ts` | FR-80: one pinned skeleton for pairs/rooms/tables (only the result region differs), a one-sentence mode explanation shown once per user, and mode changes deferred while a conversation is open |
| `src/presence/constellationPicker.ts` | FR-81: spatial picker alongside text search — every node directly selectable, so three declarations always fit the four-interaction budget; k-anonymised popularity renders only at or above the k floor |
| `src/presence/holdToWave.ts` | FR-82: waving needs a sustained 400 ms press — a clamped 0..1 progress ramp with quartered haptic stages; early release or moving off the control cancels; no tap can ever wave |
| `src/presence/haptics.ts` | FR-83: one distinct haptic signature per FR-29 consent transition (pairwise-distinct proof included), plus a named audio cue and spoken announcement so every state change survives haptics-off and eyes-free |
| `src/presence/closeOffer.ts` | FR-84: after 15 minutes co-located, one close offer on the pinned "you have met" basis; accepting closes thread + notifications, declining changes nothing and is never re-asked |
| `src/presence/ambientSurfaces.ts` | FR-86/SEC-35: lock-screen indicator, Live Activity and home-screen widget are individually opt-in, off by default, one-action disable — and the ambient payload is `{kind, active}` only, contentless by construction and audited per payload |
| `src/presence/journeyContracts.ts` | FR-03/FR-08/FR-41/FR-48: account deletion in three taps inside the app with no support contact; presence refuses to publish below three declared interests and offers the picker; own messages are revocable for 24 hours (mirroring the server window and 410) and conversations delete locally only; venue check-in outranks cell matching and is the FR-88 refusal's pinned alternative |
| `src/presence/conversationThread.ts` | FR-41/FR-84/FR-87: the chat thread — typing indicators and read receipts absent from the affordance list by construction and audited against the registry; revocation planned per message with the server's 410 sentence past the window; the first message is marked for screening; the close offer is delegated, never reimplemented |
| `src/presence/roomBoard.ts` | FR-45/FR-46: the RoomBoard inside the shared skeleton's result region — the crowd count is k-suppressed (null below the threshold, never a small number), notes render only above it and carry no author field, and the one-note-per-five-minutes cadence is mirrored client-side |
| `src/presence/tableCard.ts` | FR-66/FR-67: the TableCard — exactly time, place, head count and ONE generated prompt (mirroring buildCards: shared-minimum members, sorted, `generated: true`); self-serve join while open with snapshot refresh, the seventh seat refused (SEC-33), and the pre-join probe reveals only venue and headcount (FR-75) |
| `src/presence/startupBudget.ts` | NFR-04/NFR-05: the pinned phase ledger every cold start (1800 ms) and warm start (600 ms) must fit — warm pays nothing for the resident native runtime or JS bundle, and deferred work (BLE start, prefetch, flush) is banned from the critical path by audit |
| `src/presence/powerBudget.ts` | NFR-29/NFR-30: the duty-cycle ledger — fixed consumers plus publish/cell activations computed from the FR-85 cadence, both modes inside 2 %/h; the background work registry is EMPTY when background presence is off (parity by doing nothing), exactly the BLE central wake when on |
| `src/presence/frameBudget.ts` | NFR-35/NFR-36: the match-surface render ledger fits the 60 fps frame AND the 30 fps floor; ambient refresh is gated to one per minute with push/app-active as the only legal triggers (never polls, never fetches), carrying the SEC-35 contentless payload |
| `src/presence/dependencyBudget.ts` | TECH-16: the 45 MB bundle cap with one size allocation per runtime dependency; the licence allowlist mirrors the SEC-25 CI set behind a prohibited-marker screen (GPL/AGPL/LGPL/SSPL/Commons Clause refuse), and the admission gate refuses in pinned order |
| `src/presence/verificationBadge.ts` | FR-70: the identity-reveal registry — exactly the offer, the table roster and the booked slot; every reveal carries a verification badge built from the FR-51 state alone with pinned labels a surface cannot forge, and unregistered surfaces or blank names refuse |
| `src/presence/identityAssurance.ts` | SRS Addendum 001 (AMD-KYC/AMD-AVT): the identity-assurance contract — discovery is attested AND kyc-verified fail-closed (mirroring the `discovery_eligible` view), the pinned five-move KYC transition table mirrors the `record_kyc_decision` definer, the twelve-symbol curated avatar registry is byte-identical to the edge copy with every paletteRole drawn from the audited CLIENT_PALETTE (NFR-25), avatar changes refuse with exactly one reason (unknown/same/open-conversation/cooldown), and the recognition anchor is the symbol alone pre-OPEN with no photo field by construction (FR-30/FR-87) |
| `src/presence/accessibility.ts` | NFR-25/NFR-26/NFR-37: WCAG 2.2 AA as code — the pinned shell palette audited against the 4.5/3.0 contrast floors (the note colour moved when the audit caught it), 200 % dynamic type, reduced-motion fallback, 44 pt target and label/role/focus-order audit per control, and the primary action pinned to the lower 40 percent of the display |
| `src/presence/copyRegistry.ts` | NFR-27: localisation without code changes — every shell string resolves through one registry keyed off the English baseline; a locale is pure data (tag + string map) with the English floor under every missing key, unknown keys fail closed to null, and launch readiness means full coverage of the baseline |
| `src/presence/bleFloor.ts` | NFR-28: the iOS 16 / Android API 29 floors pinned in code (cross-checked against app.json in CI) and the BLE capability ladder — advertise+scan → witness-only → off — where every supported combination is proven dead-end-free against the TR-32 resolver and garbage readings fail closed to the least radio |
| `src/presence/e2eCrypto.ts` | TECH-08: the messaging-crypto contract — provider registry exactly OpenMLS/vodozemac with libsignal refused by name AND by AGPL marker, keys pinned to the device keystore with a single-field key-package upload and a refill floor, the per-pair MLS epoch machine (forms at OPEN, seals at close, refuses out-of-order), the ciphertext-only wire payload with plaintext-field violations, and the screen-before-encrypt compose path for FR-38 |
| `src/presence/reportFlow.ts` | BR-07: safety is free and two taps away — the five SRS-named actions (report, block, withdraw-consent, delete-account, privacy-controls) on their pinned ungated wires, every screen carries the safety-tray entry, any screen × action resolves in two taps, and monetisation fields on a screen or plan are audit violations |
| `src/presence/indoorPresence.ts` | FR-89: indoors, check-in is the primary presence path and the cell the explicit fallback — the ranking delegates to the FR-48 confidence ordering, an empty code still presents check-in first while refusing at the wire, and garbage venue context fails closed to null |
| `src/presence/ui/theme.ts` | Rendered UI: the theme is DERIVED from the audited palette — no colour literal exists in the module, dynamic type clamps through NFR-25, reduced motion zeroes every duration, spacing is the 4 pt grid |
| `src/presence/ui/navigation.ts` | Rendered UI: the screen stack as a pure state machine — unknown destinations and back-from-root fail closed to the unchanged state, and the BR-07 two-tap safety budget is proven from every reachable screen (the match overlay is hosted on discovery) |
| `src/presence/ui/screens.ts` | Rendered UI: every screen as a framework-free descriptor tree — texts resolve through the NFR-27 copy registry, actions carry the NFR-25/26 control contract (label, role, 44 pt target, unique focus order), and auditUiScreen enforces the prohibition registry plus the BR-07 tray entry on every screen |
| `src/ui/render.tsx` | Rendered UI: the thin React Native half — walks a UiNode tree onto View/Text/Pressable with the a11y fields set; typechecked only, never executed under node |
| `src/presence/publishGate.ts` | FR-88: the platform accuracy grant is read before any publish — approximate-only (or unparseable) refuses with the pinned one-sentence reason and the venue check-in offer; the fix-accuracy gate stays in `cell.ts` |
| `src/presence/authFlow.ts` | FR-01: passkey sign-in — Authorization Code + PKCE (S256) in the system browser against the passkey-only consumer realm; callback parse and bootstrap resolution fail closed; the S256 challenge reuses `sha256.ts`; randomness is injected |
| `src/presence/session.ts` | FR-01: the token lifecycle — refresh 30 s before the 300 s SEC-02 expiry, exactly one refresh-retry per 401, every authed call carries the FR-05 `x-device-id`, and logout is pinned to withdraw-first → RP-initiated IdP logout → TR-30 wipe |
| `src/presence/cellStabiliser.ts` | FR-92: the published cell is the modal cell of a five-minute window; movement beyond one cell publishes fresh immediately, and unmeasurable distance counts as movement, never as "same place" |
| `src/presence/powerMode.ts` | FR-85: reduced-power mode — publish cadence capped at once per ten minutes (both cadences stay below the FR-14 900 s session TTL), with the pinned less-timely notice; the selection persists under `presence.powerMode` and wipes on logout |
| `src/presence/presenceLifecycle.ts` | FR-19: backgrounding withdraws presence within 60 seconds via DELETE /v1/presence unless the user enabled background presence; foreground return cancels a pending withdrawal |
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

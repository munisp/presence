# Localisation and BLE-floor degradation — reach contracts

NFR-27 and NFR-28 close the same way the earlier client batches did:
everything the code can guarantee lands as framework-free contracts in
`client/src/presence/`, audited fail-closed in CI. NFR-27 is a
capability guarantee — the client is localisable without code changes;
NFR-28 is a degradation guarantee — hard OS floors, and below the BLE
attestation floor features degrade instead of failing.

## Component map

| SRS item | Governing | Contract module | What it guarantees |
| --- | --- | --- | --- |
| localisable without code changes | NFR-27 | `copyRegistry.ts` | Every user-facing shell string resolves through ONE registry keyed off the English launch baseline. A locale is pure data — a BCP-47-lite tag plus a string map — so adding one is constructing data and calling `resolveCopy`; the master guard proves it by registering a synthetic locale at runtime and observing its override resolve. Missing keys fall back to the English floor (a partial locale degrades to English, never to a raw key or a blank), unknown keys fail closed to null, and malformed tags or bundles are treated as English. `localeCoverage` reports exactly which keys a pack is missing and `localeIsLaunchReady` requires full coverage — the bar the two post-launch locales (committed within three months, constants pinned) must clear. The shell renders its title and subtitle through the registry today, with `ACTIVE_LOCALE = null` as the English launch state. |
| OS floors | NFR-28 | `bleFloor.ts` + `app.json` | iOS 16 and Android 10 (API 29) are hard floors: pinned in `app.json` (deploymentTarget / minSdkVersion) where the stores enforce them, and pinned again in code (`IOS_FLOOR_MAJOR` / `ANDROID_FLOOR_API`) with a CI invariant cross-checking the two so they cannot drift. The boundary is exact: the floor itself is supported, one below refuses with the pinned upgrade notice, and non-finite or negative versions fail closed to unsupported. |
| BLE-floor degradation | NFR-28 | `bleFloor.ts` | The BLE attestation floor is soft: the capability ladder is exactly `advertise+scan → scan-only → none`. Full capability plans two-way attestation (TR-31); scan-only degrades to witness-only with the pinned notice (the device corroborates others but cannot be witnessed; venue check-in keeps it discoverable); none turns BLE attestation off with the pinned notice while GPS cells and venue check-in carry presence. Graceful means no dead ends: the master guard runs every supported OS/capability combination through the TR-32 resolver and asserts the core journey survives — with location and push denied on top. Garbage capability readings fail closed to the least radio: the plan may under-claim hardware, never over-claim it. |

## What is deliberately NOT here

On-device radio validation — a physical pass over the chipsets and OS
builds that actually lose advertising or scanning — is not expressible
as a contract and stays out of scope; what this module pins is the
degradation shape every such device will experience. The two
post-launch locale packs themselves are the ops half of NFR-27
(scheduled inside the pinned three-month window); the code half — the
registry, the fallback floor, the readiness bar — is what lands here.
TECH-08 (OpenMLS/vodozemac E2E crypto) remains the one client-gated
requirement and is the next batch's scope.

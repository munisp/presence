# Messaging crypto — the E2E contract

TECH-08 closes the way the earlier client batches did: everything the
code can guarantee lands as a framework-free contract in
`client/src/presence/e2eCrypto.ts`, audited fail-closed in CI. The
server half is already law: the messages table is one opaque
`envelope bytea` with "never plaintext" pinned in the schema comment,
and RLS gates reads to pair members after OPEN. This module pins the
client half — provider choice, key custody, group lifecycle, wire
shape, and the compose path.

## Component map

| SRS item | Governing | Contract module | What it guarantees |
| --- | --- | --- | --- |
| provider choice | TECH-08 | `e2eCrypto.ts` | The provider registry is exactly the two the SRS names — OpenMLS (MIT/Apache-2.0) and vodozemac (MIT) — with licences pinned per entry. `cryptoProviderAllowed` refuses libsignal twice over: by name (case-insensitive substring, so `libsignal-client` and "LibSignal fork" refuse too) and by its AGPL marker through the TECH-16 licence screen, with the SRS's reason pinned verbatim ("AGPL-3.0 conflicts with a closed client"). An unknown provider refuses even with a clean licence — the SRS names the set, it is not open. |
| keys on device | FR-36 | `e2eCrypto.ts` + `secureStore.ts` | Private keys are pinned to the platform keystore (`PRIVATE_KEY_STORAGE = "secure-store"`, the TR-30 adapter). The only key material that leaves the device is the public key package, and `buildKeyPackageUpload` carries exactly that one field by construction — the type has no room for private material. The relay pool refills below a pinned floor of 10, and garbage counts fail closed toward refilling: a client that cannot count its packages assumes it has none. |
| group lifecycle | FR-36 | `e2eCrypto.ts` | One MLS group per pair: pending at epoch zero, formed when the pair opens, advancing on every message and membership change, sealed when the pair closes. Out-of-order events — a message before the group exists, anything after close, an unknown event — refuse null. An unsendable message is never sent; a sealed group never reopens. |
| ciphertext-only wire | FR-36 | `e2eCrypto.ts` | `buildOutboundPayload` emits exactly `{ envelope }` (base64), mirroring the server's `envelope bytea` column. `payloadViolations` flags any plaintext-carrying field (body, text, plaintext, preview, snippet, attachment), any unknown field, and a missing or blank envelope — so a "preview" can never ride along and give the server something to read. |
| compose path | FR-38 | `e2eCrypto.ts` + `conversationThread.ts` | With MLS the server can no longer screen message text, so the FR-38 first-message classifier moves into the client compose path. `COMPOSE_PIPELINE` pins screen → encrypt → send — once a message is encrypted there is nothing left to screen, so the order must never invert — and `planCompose` makes screening mandatory exactly when FR-38 requires it (the sender's first message to the pair), cross-pinned to `composeRequiresScreening`. |

## What is deliberately NOT here

The native binding itself — linking the Rust OpenMLS or vodozemac
crate into the Expo dev client — is a build-time integration decision,
not a contract; what this module pins is everything that constrains
that integration: which providers are admissible, where keys live,
what crosses the wire, and in what order a message is screened,
encrypted and sent. Interop test vectors against a second MLS
implementation are external evidence, not code.

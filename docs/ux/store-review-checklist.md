# Store review readiness (ACC-08)

ACC-08: App Store + Play review acceptance. Both stores review the same
surfaces; this checklist maps each known rejection cause to the in-repo
mechanism that answers it. Submission itself needs the signed client build.

## Account & data

| Store requirement | Presence mechanism |
|---|---|
| In-app account deletion, no email-a-human | 3-tap delete → `DELETE /v1/account` (FR-03, journeyContracts) |
| Privacy nutrition labels / data-safety form | Precise location never leaves the device (TR-15: cell only); no advertising, no tracking, no data sale; KYC state is provider-ref only (AMD-KYC) — declare identity verification, not documents |
| Sign-in demo account for review | Seeded reviewer account in the staging realm + a recorded core-journey video (TR-32: the journey is always satisfiable, so the reviewer cannot hit a dead end) |
| Age rating | 18+ (BR-03) — year-only declaration gates every discovery surface |

## Platform capabilities

| Store requirement | Presence mechanism |
|---|---|
| Background mode justification (BLE) | `bleFloor.ts` capability ladder — BLE advertise/scan is declared and justified for proximity codes (TR-31); background presence is opt-in with the 60 s withdrawal contract (FR-19) |
| App Attest / Play Integrity | Device attestation flow (FR-51/SEC-19); review note: attestation gates discovery, never sign-in |
| Push notification permission timing | Requested only after the first mutual open, never at install (notification copy carries `{type, ref}` only — FR-56) |

## Content & safety

| Store requirement | Presence mechanism |
|---|---|
| UGC moderation | Report/block/withdraw ungated and ≤ 2 taps (BR-07); moderation SLA alert (NFR-33); content screening (SEC-37 idiom) on free text |
| Objectionable-content filtering | k-suppression, sensitive-taxonomy exclusion (TR-22), no photos pre-OPEN (FR-87) |
| Payments clarification | P2P transfers (AMD-PAY) move money between verified users for in-person settlement — physical-world settlement, not digital goods, so IAP does not apply; note filed with legal before submission (TECH-23 gate must lift first) |

## Submission order

1. ACC-06 rollback drill green on the release candidate.
2. This checklist signed per item with evidence links.
3. Submit iOS first (longer review), Play in parallel; both listings use the
   store copy from the positioning review (BR-02).
4. Reviewer questions route to the on-call list; any rejection categorised
   against this table and re-submitted within 48 h.

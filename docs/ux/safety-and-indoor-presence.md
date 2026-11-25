# Safety reachability and the indoor presence path

Two close-out contracts: BR-07's safety features — free and within two
taps from any screen — and FR-89's check-in-primary indoor presence path.
Both land the way the earlier client batches did: everything the code
can guarantee is a framework-free contract in `client/src/presence/`,
audited fail-closed in CI.

## Component map

| SRS item | Governing | Contract module | What it guarantees |
| --- | --- | --- | --- |
| the five safety actions | BR-07 | `reportFlow.ts` | `SAFETY_ACTIONS` is exactly reporting, blocking, consent withdrawal, account deletion and privacy controls — the set the SRS names, no more. Each carries its pinned, ungated wire: `POST /v1/reports`, `POST /v1/blocks`, `DELETE /v1/account/consents/{purpose}`, `DELETE /v1/account` (cross-pinned to the FR-03 journey contract, never re-declared), and the consent surface for privacy controls. Unknown actions refuse; the registry is not open. |
| two taps from any screen | BR-07 | `reportFlow.ts` | Every top-level screen — discovery (all three modes share the skeleton), the conversation thread, the venue check-in surface, settings — carries the pinned `safety-entry` affordance into the safety tray. `planSafetyAccess` resolves any screen × action pair to exactly two taps: open the tray, pick the action. A screen descriptor missing the entry is an audit violation. The FR-03 deletion journey's own three taps start after the entry: BR-07 budgets reachability, FR-03 budgets the flow. |
| monetisation never gates safety | BR-07 | `reportFlow.ts` | The plan type has no price field — safety is free by construction. `MONETISATION_FIELDS` (price, paywall, premium, subscription, upsell) is screened on both screen descriptors and plans, so a paywall smuggled past the type is flagged as a violation instead of shipping. The master guard proves the audit is not vacuous by flagging a deliberately priced descriptor. |
| check-in is the indoor primary | FR-89 | `indoorPresence.ts` | Inside a partner venue, `planIndoorPresence` resolves the primary action to venue check-in against the signed code on display — the ranking is delegated to the FR-48-pinned confidence ordering (`preferredPresenceSource`), so the primary can never come out as the cell while a code is available. Outside a partner venue the module does not apply and returns null. |
| the cell is the fallback indoors | FR-89 | `indoorPresence.ts` | The cell path is present indoors only as the explicit fallback, carrying the pinned notice that check-in is the stronger path. An empty or whitespace code still presents check-in first (the code is on display; the user scans it) while `planVenueCheckin` refuses the bad code at the wire — FR-48's fail-closed half. Garbage venue context fails closed to null. |

## What is deliberately not here

- **The tray's visual layout.** The contract pins reachability (the entry
  affordance on every screen, two taps to any action), not pixels; the
  NFR-25/26/37 accessibility contracts govern the rendering.
- **Payment surfaces.** P3 monetisation is deferred (gated on BR-06); the
  BR-07 contract exists so that when payments arrive, no safety action
  can be gated without failing CI.
- **Indoor positioning engines.** FR-89 settles the ordering — check-in
  first, cell as fallback — not a new positioning technology; the cell
  pipeline stays as built (TR-29/FR-92).
- **Physical-device evidence.** The five measurable partials
  (NFR-04/05/29/30/35) stay partial: their budgets are pinned in the
  b42 contracts and `scripts/profile_device_budgets.py` is the harness
  that validates a physical-device profiling report against them,
  fail-closed. The numbers themselves come from hardware, not CI.

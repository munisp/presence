# Dating mode and marketplace — component map (SRS Addendum 001, AMD-DATE-01..05, AMD-MKT-01..05)

Batch 57 ships two amendments analysed after batch 56 and authorised
together: an opt-in **dating mode** and a **marketplace listing
primitive**. Both extend the platform without touching its two hardest
invariants — no photos (FR-87) and no free text (FR-96/SEC-37). Dating
differentiates on verified identity and the avatar layer, not appearance;
commerce differentiates on escrowed payment and KYC-verified
counterparties, not storefront glamour.

## The contract at a glance

| Layer | Piece | What it guarantees |
| --- | --- | --- |
| Database | `dating_genders` + `dating_goals` | AMD-DATE-02: pinned, seeded vocabularies; the application role reads but never writes — a vocabulary change is a migration. |
| Database | `dating_profiles` + guard trigger | AMD-DATE-01/05: the structured attribute set (gender, seeking 1–3, goal, age range 18–99) and nothing else — no column could hold a photo or free text. Identity columns immutable; the application role can never delete; pause/resume only through the definer. |
| Database | `set_dating_preferences` / `set_dating_state` definers | AMD-DATE-01 + AMD-DATE-05: KYC-verified AND adult proved at write; resuming re-proves both — a KYC suspension or age block can land while paused. |
| Database | `dating_compatible` / `dating_counterpart` definers | AMD-DATE-03/04: mutual compatibility as a server-side boolean (both active, both KYC-verified adults, mutual seeking, mutual age range, same goal, no block); the counterpart reveal requires compatibility AND a pair at NUDGED or later, and carries ranges — never birth years. |
| Database | `dating_filter_candidates` definer | AMD-DATE-03: the scan pipeline intersects matcher candidates with compatibility before any pair surfaces. Inert for callers without an active dating profile; narrows, never widens. |
| Database | `marketplace_listings` + guard trigger | AMD-MKT-01: kind, taxonomy category, price, currency, market, state — no description, no photo. Terms immutable; `draft → listed → held → sold`, `draft \| listed → removed`, `held → listed` on refund. |
| Database | `marketplace_orders` + guard trigger | AMD-MKT-03: the order names its single-milestone AMD-INN-03 escrow; the order state mirrors the escrow exactly; one open order per listing. |
| Database | `marketplace_events` + guard trigger | AMD-MKT-02: every listing and order transition, append-only for every path. |
| Database | `create_listing` / `list_listing` / `delist_listing` definers | AMD-MKT-01 + AMD-MKT-04: KYC-verified seller, non-sensitive category (TR-22), configured market, price ≤ 5,000,000 minor (the AMD-PAY-05 ceiling), ≤ 12 live listings per seller. |
| Database | `purchase_listing` / `confirm_purchase` / `dispute_purchase` / `resolve_purchase` definers | AMD-MKT-03: one atomic transaction per step, all through the batch-56 escrow definers inside the AMD-PAY-15 settlement gate. Refund relists; release completes the sale. |
| Database | `moderate_listing` definer | AMD-MKT-05: governed-reason takedown, audited; a held listing is never removed out from under an escrow. |
| Edge | `routes/dating.ts` | 5 routes: preferences set, own profile, pause/resume, compatibility boolean, counterpart reveal. No value moves — `withRls` throughout; every POST rate-limited. |
| Edge | `routes/marketplace.ts` | 11 routes: create, browse (no seller identity in the projection), mine, list, remove, purchase, orders, confirm, dispute, moderated remove, moderated resolve. Value moves only inside `withSettlement`. |
| Edge | `routes/scan.ts` hook | AMD-DATE-03: one extra query per scan, before any pair is recorded DETECTED. |
| Client | `presence/datingPreferences.ts` | Vocabulary mirrors + on-device validation; a bad preference set never becomes a request. |
| Client | `presence/listingCard.ts` | Deterministic ₦ price formatting (no locale APIs), state badges, and the buy/confirm/dispute action rules mirroring the state machines. |

## Journeys

**Opting into dating (AMD-DATE-01/02).** A KYC-verified adult sets a
dating profile: their gender, who they seek, what they want, and the age
range they will consider. Five fields, all enumerated — there is nowhere
to type a bio and nowhere to upload a photo. The profile activates
immediately; pausing hides it from the filter; resuming re-proves the
gates.

**Dating discovery (AMD-DATE-03).** With dating mode active, a scan
surfaces only mutually compatible people: both seeking each other's
gender, both inside each other's age range, the same goal, no blocks.
The match score, the consent machine, the ≤2-tap safety surface — all
unchanged. Dating mode narrows the caller's own discovery; it never
widens anyone's.

**The dating reveal (AMD-DATE-04).** Once a pair stands at NUDGED or
later and is mutually compatible, each side can read the other's dating
attributes — gender, seeking, goal, age range. Birth years never leave
the database; the avatar stays the recognition anchor until OPEN, exactly
as before.

**Listing (AMD-MKT-01/04).** A verified seller creates a listing: item or
service, a category from the governed taxonomy, a price, a market.
Twelve live listings at most. To change the price, remove and relist —
terms are immutable, so a listing can never be repriced under a buyer
mid-escrow.

**Buying (AMD-MKT-03).** The buyer taps purchase: the price is escrowed
in one transaction (a single-milestone AMD-INN-03 escrow), the listing
moves to held. On handover — optionally backed by a verified-met receipt
— the buyer confirms; the escrow releases to the seller and the listing
sells. Anything wrong: either party disputes, the value stays held, and
moderation resolves — refund relists the listing, release completes the
sale.

**Moderation (AMD-MKT-05).** A draft or listed listing can be taken down
with a governed reason code, audited. A held listing is never removed out
from under an escrow: the dispute resolves first, then the relisted
listing can be removed.

## What deliberately did not ship

- **Photos and free text, in both features.** FR-87 and FR-96/SEC-37 are
  deliberate; reversing them is a further amendment, not a feature add.
- **A dating browse directory.** There is no list of dating profiles —
  discovery stays presence-driven, filtered, never searchable.
- **New value machinery for purchases.** The marketplace composes the
  batch-56 escrow definers; one ledger, one settlement gate, one
  reconciliation story.
- **Swipe queues, boosts, subscriptions.** Monetisation and UX patterns
  from consumer dating apps need their own amendments; the consent-first
  surface is the product.

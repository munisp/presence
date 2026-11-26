# Service bookings — component map (SRS Addendum 001, AMD-SVC-01..05)

Batch 61 ships the services amendment: **bookable local services and
errands** as the tenth catalogue vertical. A member books a vetted
provider off a service-kind marketplace listing — cleaning, repairs,
errands, lessons — and the agreed value is committed up-front as milestone
escrow, released step by step as the customer confirms work. Services
extend the platform without touching its two hardest invariants — no
photos (FR-87) and no free text (FR-96/SEC-37) — and introduce no new
value machinery: every kobo moves through the AMD-INN-03 milestone escrow
definers inside the AMD-PAY-15 settlement gate. Service bookings gate
under their own `services` vertical, added to the AMD-VERT-01 catalogue
at sort order 45.

## The contract at a glance

| Layer | Piece | What it guarantees |
| --- | --- | --- |
| Database | `service_bookings` + guard trigger | AMD-SVC-01: listing, customer, provider, agreed total, milestone count, escrow, state — no description, no scheduling free text, no address column exists. Terms immutable; same-state writes are no-ops only; `accepted → in_progress \| cancelled \| disputed`, `in_progress → completed \| disputed`, `disputed → completed \| cancelled` enforced by the database. |
| Database | `service_events` + guard trigger | AMD-SVC-05: every booking transition and every milestone confirmation, append-only for every path — the AMD-PAY-07 ledger discipline. |
| Database | `book_service` definer | AMD-SVC-02: the customer's escrow hold IS the booking — `create_escrow` composes exactly like a marketplace purchase, except the listing stays `listed` (a service offer is repeatable). Even milestone split, the last part absorbing the remainder; total ≤ 5,000,000 minor (the AMD-PAY-05 ceiling); both sides KYC-verified at booking time; a block in either direction refuses. |
| Database | `start_service` definer | AMD-SVC-02: provider-only, from `accepted`; no value moves — starting stops the 168 h ghosting clock. |
| Database | `confirm_service_milestone` definer | AMD-SVC-02: customer-only, from `in_progress`; delegates to the escrow release definer (payer-only, settlement-gated); the last release completes the escrow and the booking atomically. |
| Database | `dispute_service` definer | AMD-SVC-03: either party, live bookings only; delegates to the escrow dispute definer — no settlement gate, a dispute is always available. |
| Database | `resolve_service` definer + `resolve_escrow` propagation | AMD-SVC-03: moderation alone, from `disputed`; the AMD-ESC-01 four-eyes gate applies unchanged above 1,000,000 minor of remaining value, and the escrow resolver propagates the outcome to the booking row, so the direct and the approved paths resolve identically. Audited. |
| Database | `expire_stale_services` definer | AMD-SVC-04: an `accepted` booking the provider never starts auto-refunds after 168 h (the escrow walks its legal active → disputed → refunded path, the hold voids, the booking cancels); an `in_progress` booking escalates to `disputed` after 30 days. Raises if the settlement gate is off. |
| Database | vertical catalogue row | AMD-SVC-01: `services` at sort 45 — KYC-gated, no adult gate, default-on, never locked. The catalogue grows to ten verticals; every mirror (edge, client, Go, Rust, Python) is pinned to the same ten keys. |
| Edge | `services.ts` + `routes/services.ts` | 8 routes: book, mine, read one (with the event stream), start, confirm milestone, dispute, moderation queue, moderation resolve. Value moves only inside `withSettlement`; every POST rate-limited; strict parsers with exact key counts; `approval_required` answers 202. |
| Edge | `verticals.ts` gate | `/v1/services/*` templates map to the `services` vertical — a caller who narrowed services off gets the same neutral 403 (AMD-VERT-03). Moderation surfaces stay ungated. |
| Client | `presence/serviceBooking.ts` | Constant and transition-table mirrors, fail-closed wire parsers (an extra field — a "note", an address — refuses the row), the milestone schedule helper byte-identical to the definer split, deterministic ₦ formatting (no locale APIs), state badges, the next-milestone derivation from the event stream, and the start/confirm/dispute action rules mirroring the state machine. |
| Parity | Go / Rust / Python mirrors | The `/v1/services` → services mapping and the tenth catalogue row are pinned in all three parity mirrors and their tests. |

## Journeys

**Booking a service (AMD-SVC-02).** A KYC-verified member opens a service
listing — a structured card: category, price guidance, market — picks an
agreed total and a milestone count, and books. Three fields, all
structured — there is nowhere to type instructions and nowhere to share
an address. The whole total leaves the available balance immediately:
held in escrow, not spent. The listing stays live for the next customer.

**Doing the work (AMD-SVC-02).** The provider's card shows *Booked —
waiting for the provider* with one action: **Start work**. Starting costs
nothing and proves the booking is real — it stops the seven-day clock.
The customer's card now shows the milestone schedule: confirm each part
as it completes. Each confirmation pays that milestone to the provider;
the last confirmation completes everything at once.

**The ghosting clock (AMD-SVC-04).** A provider who never starts never
gets paid: after 168 hours the booking un-winds itself — the hold voids,
the escrow refunds, the booking cancels, and the customer's money simply
comes back. Work that stalls mid-way does not sit silently: after thirty
days the booking escalates to disputed, where moderation sees it
oldest-first.

**When it goes wrong (AMD-SVC-03).** Either party can dispute a live
booking — the remaining value stays frozen. Moderation resolves:
*refund* returns the remaining milestones to the customer and cancels
the booking; *release* pays them to the provider and completes it. Above
₦10,000 of remaining value, one moderator's decision is recorded but
moves nothing — a second moderator must approve, and the booking resolves
identically whichever path the decision took. Every resolution is
audited.

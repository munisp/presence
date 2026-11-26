# Barter swaps — component map (SRS Addendum 001, AMD-SWP-01..05)

Batch 60 ships the barter amendment: **trade-by-barter** as a marketplace
mode. Two members exchange goods for goods — a have for a want — with an
optional cash balancer when the values differ and an optional pinned
₦1,000 bond when either side wants skin in the game. Swaps extend the
platform without touching its two hardest invariants — no photos (FR-87)
and no free text (FR-96/SEC-37) — and introduce no new value machinery:
every kobo moves through the AMD-PAY-12 wallet-hold definers inside the
AMD-PAY-15 settlement gate. A swap listing gates under the existing
`marketplace` vertical; the vertical catalogue is unchanged.

## The contract at a glance

| Layer | Piece | What it guarantees |
| --- | --- | --- |
| Database | `swap_listings` + guard trigger | AMD-SWP-01: have category, want set (1–3 distinct), value estimate, market, state — no description, no photo, no free-text column exists. Terms immutable; `listed → held \| removed`, `held → listed \| swapped` enforced by the database. |
| Database | `swap_agreements` + guard trigger | AMD-SWP-03: two listings, a balancer, a bond flag, set-once confirmations. `proposed → accepted \| cancelled`, `accepted → completed \| disputed`, `disputed → completed \| cancelled` (moderation only). One open agreement per listing, enforced by partial unique indexes. |
| Database | `swap_bonds` + guard trigger | AMD-SWP-04: one active bond per party per agreement, pinned at 100,000 minor (₦1,000 — the presence_bonds amount), hold-backed; `active → released \| forfeited`. |
| Database | `swap_events` + guard trigger | AMD-SWP-03: every listing and agreement transition, append-only for every path — the AMD-PAY-07 ledger discipline. |
| Database | `swap_category_covers` / `swap_compatible` / `swap_candidates` definers | AMD-SWP-02: coverage rides the TR-18 materialized taxonomy closure (a want covers its node and descendants); candidates are reciprocal, same-market, KYC-gated, block-aware both directions, callable only by a caller holding a listed swap, pinned to 50 rows, with no owner in the projection (FR-30). |
| Database | `create_swap_listing` / `delist_swap_listing` definers | AMD-SWP-01: KYC-verified owner, non-sensitive category (TR-22), configured market, value ≤ 5,000,000 minor (the AMD-PAY-05 ceiling), ≤ 12 live swap listings per owner. |
| Database | `propose_swap` / `respond_swap` / `cancel_swap` definers | AMD-SWP-03: the balancer is reserved as a wallet hold at propose time; acceptance re-proves both sides' KYC and refuses until both required bonds are active; rejection and cancellation unwind everything — hold voids, bonds release, listings relist. |
| Database | `stake_swap_bond` definer | AMD-SWP-04: the pinned bond, reserved from the staker's own wallet as a hold, inside the settlement gate. |
| Database | `confirm_swap_exchange` definer | AMD-SWP-03: set-once confirmations; the second confirmation settles atomically — balancer posts to the counterparty, bonds release, agreement completes, both listings move to `swapped`. |
| Database | `dispute_swap` / `resolve_swap` definers | AMD-SWP-05: either party disputes from `accepted`; moderation alone resolves from `disputed` — `refund` unwinds and relists, `release` settles and completes; an optional bond forfeits TO THE COUNTERPARTY, never the platform. Audited. |
| Database | `expire_stale_swaps` definer | AMD-SWP-03: unanswered proposals unwind after 72 h; accepted agreements without a completed exchange escalate to `disputed` after 168 h — a stalled exchange is seen, never silently stuck. Raises if the settlement gate is off. |
| Edge | `barter.ts` + `routes/barter.ts` | 14 routes: create, mine, candidates, remove, propose, respond, cancel, stake-bond, confirm, dispute, agreements list/read, moderation queue, moderation resolve. Value moves only inside `withSettlement`; every POST rate-limited; strict parsers with exact key counts. |
| Edge | `verticals.ts` gate | `/v1/swaps/*` templates map to the `marketplace` vertical — a caller who narrowed marketplace off gets the same neutral 403 (AMD-VERT-03). |
| Client | `presence/swapBoard.ts` | Constant and transition-table mirrors, fail-closed wire parsers (an extra field — a "note", anything — refuses the row), deterministic ₦ formatting (no locale APIs), state badges, and the propose/respond/cancel/confirm/dispute/stake action rules mirroring the state machines. |
| Parity | Go / Rust / Python mirrors | The `/v1/swaps` → marketplace mapping is pinned in all three parity mirrors and their tests. |

## Journeys

**Offering a swap (AMD-SWP-01).** A KYC-verified member declares: I have
*electronics.phones*, I want *electronics.laptops* (and up to two more
categories), my phone is worth about ₦2,500.00, in Lagos. Five fields,
all structured — there is nowhere to type a description and nowhere to
upload a photo. The listing goes live immediately; twelve live swaps is
the cap.

**Finding a counterparty (AMD-SWP-02).** The candidate board answers a
single question: who wants what I have AND has what I want? Coverage
rides the taxonomy closure, so a want for *electronics* matches a have of
*electronics.phones*. The board shows listings, never owners — the member
learns who they swapped with through their own agreement row, exactly
like a transfer.

**Proposing and agreeing (AMD-SWP-03/04).** The proposer picks their own
listed swap and a candidate, names a balancer (₦500.00 to even the
values, or zero for a pure goods swap) and whether bonds are required.
The balancer leaves their available balance immediately — held, not
spent. The counterparty answers: accept (both sides re-prove KYC; with
the bond flag set, acceptance waits until both ₦1,000 bonds are staked)
or decline (everything unwinds — hold voids, listings relist). The
proposer can withdraw an unanswered proposal; unanswered proposals
unwind themselves after 72 hours.

**The exchange (AMD-SWP-03).** Both parties meet; each confirms once on
their own card. The second confirmation settles everything in one
transaction: the balancer posts to the counterparty, the bonds release,
the agreement completes, both listings show *Swapped*.

**When it goes wrong (AMD-SWP-05).** Either party can dispute an accepted
agreement — the balancer and the bonds stay frozen. Moderation sees the
queue oldest-first and resolves: *refund* sends the balancer back and
relists both listings; *release* pays the counterparty and completes the
swap. A no-show's bond can forfeit — to the wronged party, never to the
platform. An accepted agreement that stalls for a week escalates to
disputed on its own, so it is seen rather than silently stuck.

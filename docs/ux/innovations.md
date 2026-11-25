# Innovations — component map (SRS Addendum 001, AMD-INN-01..10)

Batch 56 adds ten core-platform innovations. Seven are database-backed
(migration 0030) with edge routes; two — duress mode and the on-device
match preview — are client-only by design: their privacy guarantees come
from the server seeing nothing. The verification passport straddles both:
the database proves claims, the edge signs them, verification is an
unauthenticated oracle.

## The contract at a glance

| Layer | Piece | What it guarantees |
| --- | --- | --- |
| Database | `presence_bonds` + guard trigger | AMD-INN-01: one pinned bond (100,000 minor) per user, hold-backed, `active → released \| forfeited`; forfeiture requires a report against the owner and moves value user → platform as fee entries, audited. |
| Database | `met_receipts` + guard trigger | AMD-INN-02: reciprocal co-attestation inside a pinned 900 s window; one pending window per pair; pair + two timestamps only — no location, no device data, no free text. |
| Database | `escrow_agreements` + `escrow_milestones` + guards | AMD-INN-03: milestone escrow between KYC-verified users; the total is one AMD-PAY-12 hold; payer-only milestone release; either party disputes; a moderator resolves to refund or release, audited. |
| Database | `group_stakes` + guard trigger | AMD-INN-04: a pinned stake (50,000 minor) per group-table seat, six-seat cap; refund only after FR-100 check-in verification; the 24 h moderator sweep forfeits no-shows. |
| Database | `disclosure_grants` + guard trigger | AMD-INN-06: single-use, 900 s TTL claims (`over_18`, `kyc_verified`); the secret is returned once and stored as a digest; redemption answers the claim and nothing else. |
| Database | `serendipity_windows` + guard trigger | AMD-INN-08: at most four active windows per account; pause/resume only, never deleted; overlap is a server-side boolean that reveals no schedule. |
| Database | `introductions` + guard trigger | AMD-INN-10: host-proposed double opt-in; blocks refuse absolutely; the second accept walks the pair to MUTUAL through the FR-29 consent ledger — the machine is never bypassed. |
| Database | `passport_claims` definer | AMD-INN-09: the database answers which claims the caller may carry (`kyc_verified`, `over_18`) — the edge signs them, the DB stores nothing. |
| Edge | `routes/innovations.ts` | 21 routes: bond place/release/forfeit, met receipts, escrow create/list/release/dispute/resolve, group stake/refund, the moderator sweep, disclosure issue/verify, serendipity windows + overlap, passport mint, introductions propose/list/answer. Every POST is rate-limited (AMD-OPS-03); value moves only inside `withSettlement`. |
| Edge | `registerAttestationVerifyRoute` | AMD-INN-09: `POST /v1/attestation/verify` outside the authed scope (wire name "attestation" — the SEC-17 document-vocabulary guard) — valid \| expired \| invalid, claims on valid, never identity; every verdict counted in `presence_attestation_verify_results_total`. |
| Client | `presence/duressMode.ts` | AMD-INN-05: the pinned pipeline `withdraw-presence → wipe-local-state → neutral-screen`, best-effort per step, importing only the TR-30 allowlist wipe. |
| Client | `presence/matchPreview.ts` | AMD-INN-07: a local estimate — server score plus one 0.05 bonus per shared declared interest, capped at 1.0; verdicts at 0.36 / 0.12. No request is ever made. |

## Journeys

**Bonded presence (AMD-INN-01).** A user planning to go out places the
bond; showing up costs nothing (release), a platform-upheld no-show report
forfeits it. The amount is pinned so the bond is a signal, never a price.

**Verified-met (AMD-INN-02).** After a real meeting both clients submit
within the window; the receipt feeds trust. Nothing about where or when
beyond two timestamps exists to leak.

**Escrow (AMD-INN-03).** A payer funds the whole agreement up front;
milestones release on delivery; a dispute freezes the remainder until
moderation resolves it. Neither party can be rugged mid-agreement.

**Group stakes (AMD-INN-04).** Six seats, six stakes. Check in at the
venue and the stake returns; the sweep forfeits no-shows after 24 h. The
refund can only follow a verified check-in token — the edge proves
presence before value moves back.

**Duress (AMD-INN-05).** One gesture: presence withdrawn, local state
wiped, a neutral screen up. The server learns nothing — that is the
feature.

**Disclosure (AMD-INN-06).** At a door: the user shows a grant, the venue
redeems it, and learns exactly "over_18" — not a name, not a birthdate.

**Passport (AMD-INN-09).** (On the wire: `/v1/attestation`.) The user carries a one-hour signed attestation;
any verifier checks it without an account and without ever learning who
the holder is.

**Introductions (AMD-INN-10).** A host both parties know proposes the
pair; each answers privately; on a double yes the pair appears at MUTUAL,
indistinguishable from any organic match.

# P2P transfers — component map (SRS Addendum 001, AMD-PAY-01..09)

The owner's premise: every user of the platform is KYC and vetted, so two
verified people who share an open conversation may move money between
themselves — through a structured transfer card, with dual consent, small
caps, and a full ledger. Batch 49 delivers the contracts; batch 50 adds
DSAR inclusion (AMD-PAY-09). It moves no money: the settlement rail stays
behind the TECH-23 gate (AMD-PAY-08).

## The contract at a glance

| Layer | Piece | What it guarantees |
| --- | --- | --- |
| Database | `transfers` + `transfer_events` (migration 0025) | AMD-PAY-03: a transfer is amount, currency, fee, state — no free-text field exists. AMD-PAY-07: the ledger is append-only (no UPDATE/DELETE grant + a trigger that raises). |
| Database | `propose_transfer` definer | AMD-PAY-05/06: per-transfer cap NGN 50,000.00, rolling 24 h sender cap NGN 150,000.00, 100 bps fee computed and stored, both parties KYC-verified, no `payment_instrument` suspension, an OPEN conversation required. The sender claim must be the caller (`app_user()`), because a SECURITY DEFINER bypasses RLS. |
| Database | `record_transfer_event` definer | AMD-PAY-04: the eight legal transitions enforced in the database, with roles — the recipient answers, the sender cancels, either party disputes, moderation alone resolves, the rail alone settles. AMD-PAY-06: acceptance re-proves KYC and the OPEN pair. AMD-PAY-08: `settled` requires the transaction-local `app.transfer_settlement` setting no P0 component sets. |
| Database | `expire_stale_transfers` definer | AMD-PAY-06: no proposal outlives its one-hour window; the list read expires lazily. |
| Database | `dsar_export` definer (migration 0026) | AMD-PAY-09: DSAR export of transfers — the FR-62 document includes the subject's transfer rows with their event ledgers inline, exported even where the pair itself is masked (a transfer is a financial record, not a conversation artefact). Transfer rows survive account deletion tied to the anonymous tombstone; the append-only discipline has no erasure exception. |
| Database | wallet ledger (migration 0027) | AMD-PAY-10..14: settlement lands in wallets — sender debited amount + fee, recipient credited the amount, the platform fee wallet credited the fee, atomically with the `settled` transition under the same rail gate. The wallet ledger is append-only, hold-aware and DSAR-exported. See `docs/ux/wallets.md`. |
| Edge | `src/transfers.ts` | The validators and pinned constants: `TRANSFER_TRANSITIONS`, the caps, `computeFeeMinor`, the closed `DISPUTE_REASONS` vocabulary, strict TR-23 body parsers. |
| Edge | `src/routes/transfers.ts` | Seven wires: `POST/GET /v1/transfers`, `accept`, `decline`, `cancel`, `dispute`, and `POST /v1/moderation/transfers/:transferId/resolve`. Every route maps a definer outcome; none decides anything. |
| Client | `src/presence/transferCard.ts` | The mirror: byte-identical transition table, dispute vocabulary and constants; `buildTransferCard` accepts exactly the four pinned fields and refuses a wire fee that disagrees with the amendment formula; `planTransfer` mirrors the definer's refusals with exactly one reason; deterministic naira formatting. |
| Client | copy registry | `ui.transfer.*` keys for every state and action (NFR-27). |

## The dual-consent flow

1. Sender proposes inside an open conversation → `proposed` (fee pinned,
   one-hour expiry).
2. Recipient answers → `accepted` (eligibility re-proved) or `declined`.
   The sender may retract → `cancelled`; the clock may end it → `expired`.
3. An accepted transfer settles only when the future rail calls back with
   the `app.transfer_settlement` setting — unreachable in P0
   (AMD-PAY-08). Until then the record is a fully-audited agreement.
4. Either party may dispute an accepted or settled transfer with a closed
   category (`not-received`, `wrong-amount`, `unauthorised`) — never free
   text. Moderation resolves `upheld` or `rejected`; the resolution lands
   in both the ledger and the admin audit log.

## What is deliberately NOT here

- **Settlement rails (Mojaloop / TigerBeetle)**: the TECH-23 deployment
  gate stands until a payments compliance programme is approved —
  organisational evidence, not code (AMD-PAY-02/08). The `settled` branch
  exists so the rail integration lands as configuration, not redesign.
- **Free-text memos**: refused by construction at every layer
  (AMD-PAY-03). FR-96/SEC-37 screening is unchanged and has nothing to
  screen on the transfer surface.
- **Non-NGN currencies**: the launch currency is NGN, stated once per
  layer. A second currency is a further amendment with its own caps.
- **Chargebacks and refunds**: a rail concern. The dispute path records
  and resolves; it does not reverse money it never moved.

*Verification anchors: `tests/test_batch49.py` pins the migration, the
definers, the routes, the client contract, the cross-layer constants and
this document; `tests/test_batch50.py` pins the DSAR inclusion and the
no-erasure discipline; `services/edge/test/transfers.test.ts` and
`client/test/transferCard.test.ts` cover the validators.*

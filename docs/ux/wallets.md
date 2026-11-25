# Wallets — component map (SRS Addendum 001, AMD-PAY-10..14)

Batch 53 delivers the wallet contract layer: ledger accounts, an
append-only value ledger, two-phase holds, atomic settlement with the fee
split, moderation freezing, and DSAR inclusion — end to end from the
schema to the client surface. It moves no money: every value-moving
definer stays behind the AMD-PAY-08 rail gate, extended over the whole
wallet surface by AMD-PAY-13.

## The contract at a glance

| Layer | Piece | What it guarantees |
| --- | --- | --- |
| Database | `wallets` (migration 0027) | AMD-PAY-10: one wallet per user per currency (unique index), NGN at launch, status `active \| frozen \| closed`. The platform fee wallet rides a pinned well-known id (`00000000-0000-0000-0000-00000000fee1`), owner NULL — invisible to every application-scoped read. No free-text column exists. |
| Database | `wallet_entries` + append-only trigger | AMD-PAY-11: the value ledger — six signed kinds (`fund`, `withdrawal`, `transfer_out`, `transfer_in`, `fee_charge`, `fee_revenue`), no INSERT/UPDATE/DELETE grant to the app role, a trigger that raises on UPDATE or DELETE, and `balance_after >= 0` as a CHECK: solvency is enforced by the database, not by convention. |
| Database | `wallet_holds` + guard trigger | AMD-PAY-12: two-phase reservations, `pending → posted \| voided` only; the wallet, amount and transfer terms are immutable once placed; DELETE is banned outright. |
| Database | `wallet_balances` view | AMD-PAY-11: balance, held and available derived from the ledger and pending holds; `security_invoker` keeps the reader's RLS in force through the view. |
| Database | `create_wallet` definer | AMD-PAY-10: self-serve, KYC-verified only, idempotent (`exists` answers with the wallet id). The owner claim must be the caller (`app_user()`), because a SECURITY DEFINER bypasses RLS. |
| Database | `wallet_move` definer | AMD-PAY-13: rail-only fund-in (`fund`) and fund-out (`withdrawal`). A withdrawal may not spend reserved funds. Refuses unless `app.transfer_settlement` is `on` for the transaction. |
| Database | `place_wallet_hold` / `void_wallet_hold` definers | AMD-PAY-12/13: rail-only reservation and release; placement proves the spendable balance covers the amount. |
| Database | `settle_transfer_funds` definer | AMD-PAY-13: atomic settlement — sender debited amount + fee, recipient credited the amount, the platform fee wallet credited the fee, a pending hold naming the transfer posted (it must cover amount + fee exactly), and the transfer moved to `settled` in the same transaction, so value and state can never diverge. Idempotent (ledger rows for the transfer answer `already_settled`); suspensions re-proved at this third moment; the three wallets locked in id order (deadlock discipline). |
| Database | `set_wallet_status` definer | Moderation freezes and unfreezes user wallets (AMD-KYC-05 composability); the platform wallet is untouchable; every change lands in the admin audit log. |
| Database | `dsar_export` definer (migration 0027) | AMD-PAY-14: DSAR export of wallets — the FR-62 document includes the subject's wallets with the entry ledger and hold history inline. Wallet rows survive account deletion tied to the anonymous tombstone; the append-only discipline has no erasure exception. |
| Edge | `src/wallets.ts` | The validators and pinned constants: statuses, entry kinds, hold states, the platform wallet id, the strictly-empty creation body parser (TR-23). |
| Edge | `src/routes/wallets.ts` | Five wires: `POST/GET /v1/wallets`, `GET /v1/wallets/:walletId/entries`, and `POST /v1/moderation/wallets/:walletId/freeze` + `/unfreeze`. Every route maps a definer outcome; none decides anything — and no route reaches a value-moving definer. |
| Client | `src/presence/walletView.ts` | The mirror: byte-identical vocabularies and platform wallet id; `buildWalletSummary` accepts exactly the six pinned fields and refuses a wire whose arithmetic disagrees (available = balance − held); `planWalletCreation` mirrors the definer's refusals with exactly one reason; naira rendering delegates to the transfer card's pinned formatter so the two surfaces never disagree. |
| Client | copy registry | `ui.wallet.*` keys for every status, entry kind and hold state (NFR-27). |

## The settlement flow (when the rail lands)

1. A transfer is proposed and accepted under the transfer contract
   (AMD-PAY-03..06). Both parties hold wallets; the sender has funded
   theirs — funding itself arrives over the rail.
2. The settlement component (Mojaloop interop, TigerBeetle-class ledger
   semantics) opens a transaction with `app.transfer_settlement = on`,
   optionally places a hold covering amount + fee, and calls
   `settle_transfer_funds`.
3. One transaction posts the four entries, posts the hold, and moves the
   transfer to `settled`. A failure anywhere rolls everything back —
   there is no intermediate state in which value moved but the transfer
   did not, or vice versa.
4. Disputes and moderation proceed under the transfer contract; the
   ledger they arbitrate against is append-only and exportable
   (AMD-PAY-11/14).

## What is deliberately NOT here

- **Settlement rails (Mojaloop / TigerBeetle)**: the TECH-23 deployment
  gate stands until a payments compliance programme is approved —
  organisational evidence, not code (AMD-PAY-02/08/13). The rail-gated
  definers exist so the integration lands as configuration, not redesign.
- **Fund-in / fund-out wires**: `wallet_move` is reachable only through
  the rail flag; no P0 route calls it. Bank and mobile-money pushes are
  the rail's business.
- **Free-text fields of any kind**: refused by construction at every
  layer (AMD-PAY-10) — a wallet is an identifier, a currency, a status
  and amounts.
- **Non-NGN currencies**: the launch currency is NGN, stated once per
  layer. A second currency is a further amendment with its own caps.
- **Interest, overdrafts, credit**: balances cannot go negative (CHECK),
  and nothing here pays yield. Credit belongs to a further amendment.

*Verification anchors: `tests/test_batch53.py` pins the migration, the
definers, the rail gate, the routes, the client contract, the cross-layer
constants, the DSAR inclusion and this document;
`services/edge/test/wallets.test.ts` and `client/test/walletView.test.ts`
cover the validators.*

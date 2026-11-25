# Wallets — component map (SRS Addendum 001, AMD-PAY-10..20)

Batch 53 delivered the wallet contract layer; batch 54 switches the
internal NGN rail on. The wallet is a live account: value funds in over
an authenticated rail (HMAC-signed provider callback or an audited
moderation credit), withdrawals are two-phase and hold-backed, transfer
acceptance settles atomically, and a reconciliation definer proves the
ledger — all behind the `WALLET_RAIL` operational kill switch, with the
AMD-PAY-13 database gate (`app.transfer_settlement`) retained as defence
in depth. The external settlement rails stay TECH-23-gated exactly as
AMD-PAY-02 requires.

## The contract at a glance

| Layer | Piece | What it guarantees |
| --- | --- | --- |
| Database | `wallets` (migration 0027) | AMD-PAY-10: one wallet per user per currency (unique index), NGN at launch, status `active \| frozen \| closed`. The platform fee wallet rides a pinned well-known id (`00000000-0000-0000-0000-00000000fee1`), owner NULL — invisible to every application-scoped read. No free-text column exists. |
| Database | `wallet_entries` + append-only trigger | AMD-PAY-11: the value ledger — six signed kinds (`fund`, `withdrawal`, `transfer_out`, `transfer_in`, `fee_charge`, `fee_revenue`), no INSERT/UPDATE/DELETE grant to the app role, a trigger that raises on UPDATE or DELETE, and `balance_after >= 0` as a CHECK: solvency is enforced by the database, not by convention. |
| Database | `wallet_holds` + guard trigger | AMD-PAY-12: two-phase reservations, `pending → posted \| voided` only; the wallet, amount and transfer terms are immutable once placed; DELETE is banned outright. |
| Database | `wallet_balances` view | AMD-PAY-11: balance, held and available derived from the ledger and pending holds; `security_invoker` keeps the reader's RLS in force through the view. |
| Database | `wallet_rail_events` (migration 0028) | AMD-PAY-16/17: every funding and payout callback recorded by provider reference — idempotency is a primary key, and a duplicate answers the recorded outcome without moving value twice. Definer-only: no application role reads or writes it. |
| Database | `withdrawal_requests` + guard trigger (migration 0028) | AMD-PAY-17: the withdrawal lifecycle, `requested → processing → paid \| failed` and `requested → cancelled`; terms immutable once requested, DELETE banned, illegal transitions raise (the FR-29 trigger discipline). |
| Database | `create_wallet` definer | AMD-PAY-10: self-serve, KYC-verified only, idempotent (`exists` answers with the wallet id). The owner claim must be the caller (`app_user()`), because a SECURITY DEFINER bypasses RLS. |
| Database | `fund_wallet` definer | AMD-PAY-16: rail-only fund-in through the settlement gate plus the funding-callback GUC (or a moderator): capped per event, idempotent by provider reference, recorded in `wallet_rail_events`. |
| Database | `request_withdrawal` / `cancel_withdrawal` definers | AMD-PAY-17: owner-only (`app_user()` proof), hold-backed — the amount is reserved at request and the hold voids in the same transaction on cancel. Caps mirror AMD-PAY-05: 5,000,000 minor per withdrawal, 15,000,000 minor rolling 24-hour over requested, processing and paid. |
| Database | `decide_withdrawal` / `complete_withdrawal` / `fail_withdrawal` definers | AMD-PAY-17: moderation approves or rejects (audited in the admin audit log); the payout callback completes (ledger entry first, hold posted after — value and state can never diverge) or fails (hold voided) the request, idempotent by provider reference. |
| Database | `accept_transfer_and_settle` definer | AMD-PAY-18: acceptance is one atomic operation — eligibility and funds re-proved, the hold placed, settlement posted, in a single transaction. An acceptance the sender cannot fund refuses cleanly and the transfer stays `proposed`. |
| Database | `wallet_move` definer | AMD-PAY-13: the rail-only posting primitive underneath funding and payout completion (`fund` / `withdrawal`). A withdrawal may not spend reserved funds. Refuses unless `app.transfer_settlement` is `on` for the transaction. |
| Database | `place_wallet_hold` / `void_wallet_hold` definers | AMD-PAY-12/13: rail-only reservation and release; placement proves the spendable balance covers the amount. |
| Database | `settle_transfer_funds` definer | AMD-PAY-13: atomic settlement — sender debited amount + fee, recipient credited the amount, the platform fee wallet credited the fee, a pending hold naming the transfer posted (it must cover amount + fee exactly), and the transfer moved to `settled` in the same transaction, so value and state can never diverge. Idempotent (ledger rows for the transfer answer `already_settled`); suspensions re-proved at this third moment; the three wallets locked in id order (deadlock discipline). |
| Database | `set_wallet_status` definer | Moderation freezes and unfreezes user wallets (AMD-KYC-05 composability); the platform wallet is untouchable; every change lands in the admin audit log. |
| Database | `wallet_reconciliation` definer | AMD-PAY-19: moderator-only proof of the ledger — balances re-derived and compared against the stored running balance, the platform fee delta, holds pending longer than 24 hours, and open withdrawals. It reads and reports; it moves nothing. |
| Database | `dsar_export` definer (migrations 0027/0028) | AMD-PAY-14/20: DSAR export of wallets — the FR-62 document includes the subject's wallets with the entry ledger, hold history and withdrawal requests inline. Wallet and withdrawal rows survive account deletion tied to the anonymous tombstone; the append-only discipline has no erasure exception. |
| Edge | `src/wallets.ts` | The validators and pinned constants: statuses, entry kinds, hold states, withdrawal states and caps, the platform wallet id, and the strict parsers — creation (TR-23), withdrawal request, funding/payout callbacks, moderation decision — plus the canonical signature payloads. |
| Edge | `src/auth.ts` | `withSettlement` / `withRailCallback` are the ONLY writers of `app.transfer_settlement`, set transaction-locally inside the caller's transaction, behind the `WALLET_RAIL` kill switch (`off` → 503). |
| Edge | `src/routes/wallets.ts` | `POST/GET /v1/wallets`, `GET /v1/wallets/:walletId/entries`, wallet withdrawals (request / list / cancel), moderation credit / decide / reconciliation, and freeze + unfreeze. Every route maps a definer outcome; none decides anything. |
| Edge | `src/routes/walletRail.ts` | The provider webhooks (`/v1/webhooks/wallet-funding`, `/v1/webhooks/wallet-payout`): HMAC-SHA256 over the canonical field string in the `x-wallet-signature` header, timing-safe comparison, outside the authed scope on purpose. Unset secrets answer 503. |
| Edge | `src/routes/transfers.ts` | Acceptance routes through `accept_transfer_and_settle` under the settlement helper; there is no standalone settle route. |
| Client | `src/presence/walletView.ts` | The mirror: byte-identical vocabularies, caps and platform wallet id; `buildWalletSummary` accepts exactly the six pinned fields and refuses a wire whose arithmetic disagrees (available = balance − held); `planWalletCreation` and `planWithdrawal` mirror the definers' refusals with exactly one reason; naira rendering delegates to the transfer card's pinned formatter so the two surfaces never disagree. |
| Client | copy registry | `ui.wallet.*` keys for every status, entry kind, hold state, withdrawal state and rail action (NFR-27). |

## The settlement flow (live rail)

1. Value enters over an authenticated rail: a provider webhook signed
   with the funding secret calls `fund_wallet`, or a moderator issues an
   audited credit. The event is recorded; a duplicate reference answers
   the recorded outcome and moves nothing twice.
2. A transfer is proposed and accepted under the transfer contract
   (AMD-PAY-03..06). Acceptance is the settlement: one transaction
   re-proves the sender's funds, places the hold, and posts the four
   entries — there is no intermediate state in which value moved but
   the transfer did not, or vice versa.
3. Withdrawals run two-phase: the owner requests (hold placed), a
   moderator approves, the payout rail completes or fails against the
   hold. The owner can cancel while `requested`; the hold voids in the
   same transaction.
4. Disputes and moderation proceed under the transfer contract; the
   ledger they arbitrate against is append-only, reconcilable and
   exportable (AMD-PAY-11/14/19/20).
5. Flipping `WALLET_RAIL=off` refuses every value-moving wire with 503;
   the definers' gate refuses anything that somehow still reaches them.
   The external Mojaloop / TigerBeetle rails land as configuration, not
   redesign, once TECH-23's organisational gate lifts.

## What is deliberately NOT here

- **Settlement rails (Mojaloop / TigerBeetle)**: the TECH-23 deployment
  gate stands until a payments compliance programme is approved —
  organisational evidence, not code (AMD-PAY-02/15). The rail-gated
  definers exist so the integration lands as configuration, not redesign.
- **Raw bank details of any kind**: the withdrawal destination is an
  opaque provider-side payout reference (AMD-PAY-17) — the AMD-KYC-03
  minimisation discipline applied to payouts. The platform never holds
  account numbers.
- **Free-text fields of any kind**: refused by construction at every
  layer (AMD-PAY-10) — a wallet is an identifier, a currency, a status
  and amounts.
- **Non-NGN currencies**: the launch currency is NGN, stated once per
  layer. A second currency is a further amendment with its own caps.
- **Interest, overdrafts, credit**: balances cannot go negative (CHECK),
  and nothing here pays yield. Credit belongs to a further amendment.

*Verification anchors: `tests/test_batch53.py` pins the migration, the
definers, the rail gate, the routes, the client contract, the cross-layer
constants, the DSAR inclusion and this document; `tests/test_batch54.py`
pins the rail activation, the withdrawal lifecycle, the webhooks, the
kill switch, the reconciliation definer and this document;
`services/edge/test/wallets.test.ts` and `client/test/walletView.test.ts`
cover the validators.*

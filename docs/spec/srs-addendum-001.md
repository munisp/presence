# SRS Addendum 001 — Identity assurance: universal KYC, avatar identity layer, payments path

Status: **accepted** · 2026-11-25 · Amends PRS-SRS-001 v1.0
Requested by: product owner (munisp) — *"proceed to implement both with safety and privacy first. Every user of the platform is KYC and vetted."*

This addendum records three amendments. The original 306-requirement ledger is unchanged; addendum requirements carry AMD- identifiers and are tracked separately. Where an amendment touches an original requirement, the original text is amended **in place by reference** below.

---

## AMD-KYC — Universal identity verification (KYC)

**AMD-KYC-01 (amends FR-51/SEC-19 gate).** Every account MUST complete identity verification through the designated KYC provider before it is discovery-eligible. Discovery eligibility becomes: attested device (FR-51) **AND** KYC state `verified`. Before this amendment the gate was attestation alone. The gate fails closed: legacy and new accounts start `pending` and are invisible to discovery until verified.

**AMD-KYC-02 (data minimisation).** The platform MUST NOT store identity documents, legal names, dates of birth, or any provider payload. The platform stores exactly: an opaque provider reference, the KYC state, the verification timestamp, and the reviewing actor for manual decisions. Document custody remains with the provider. DSAR erasure (FR-02/FR-04) deletes the provider reference and state; the provider deletion webhook is out of band and organisational.

**AMD-KYC-03 (state machine).** KYC state MUST follow `pending → verified | rejected`, `verified → suspended`, `suspended → verified`, `rejected → pending` (resubmission). Any other transition MUST be rejected by the database, not by endpoint logic — mirroring the FR-29 trigger discipline.

**AMD-KYC-04 (inter-user privacy unchanged).** KYC is platform-side assurance. FR-30 is **not** relaxed: no display name, handle, photo, profile content — and now additionally no KYC attribute — may be disclosed to another user before OPEN. The only inter-user signal is the FR-70 verification badge at the moment of reveal, whose `verified` meaning tightens to "attested AND KYC-verified."

**AMD-KYC-05 (moderation).** KYC suspension MUST be composable with FR-55 suspensions (device key, handle, payment instrument) and MUST be audited in the append-only admin audit log.

## AMD-AVT — Avatar identity layer

**AMD-AVT-01 (amends FR-06).** The profile gains an optional **avatar**: a non-photographic symbol chosen from the curated, pinned registry. An avatar is never derived from the user's photo, never user-uploaded in this release (uploads require a moderation pipeline and a further amendment), and never carries free text.

**AMD-AVT-02 (recognition anchor).** The avatar is the pseudonymous recognition anchor visible **before** OPEN on the match surface and offer — this is what FR-76's convergence surface and the hold-to-wave flow use to keep two concurrent matches distinguishable. FR-87's prohibition is unchanged: no *photo* at the point of match. The avatar is not profile content under FR-30 because it identifies nothing outside the platform; it is a symbol from a shared registry.

**AMD-AVT-03 (stability under consent).** An avatar MUST NOT change while the account has an offer in EXPRESSED, MUTUAL or OPEN, and at most once per 24 hours otherwise — a recognition anchor that shifts mid-negotiation is a confusion and evasion vector.

**AMD-AVT-04 (accessibility by construction).** Every registry entry MUST reference a palette role from the WCAG-audited client palette (NFR-25), so avatar colour contrast is covered by the palette audit rather than re-audited per avatar.

## AMD-PAY — Peer-to-peer payments path (gate revision)

**AMD-PAY-01 (initiates BR-06 revision).** Peer-to-peer transfers are permitted **only** between KYC-verified accounts, through the structured transfer surface (no payment links or amounts in free text — FR-96/SEC-37 screening is unchanged), behind the dual-consent transfer contract delivered in batch 49. This revises BR-06 to admit a sixth revenue line: transfer fees.

**AMD-PAY-02 (TECH-23 unchanged).** Mojaloop and TigerBeetle MUST NOT be deployed until the payments compliance programme is approved. That approval is organisational evidence, not code; batch 49 delivers the in-repo contracts, and the deployment gate stands until the programme exists.

**AMD-PAY-03 (structured transfer object).** A transfer is a structured record and nothing else: an amount in minor units (bigint), a currency, a fee computed by the database, and a state. There is no memo, note, or message field — by construction, not by policy. Free-text payment solicitation stays impossible: FR-96/SEC-37 screening is unchanged and the transfer object gives it nothing to screen.

**AMD-PAY-04 (dual-consent state machine).** A transfer moves only through: `proposed → accepted | declined | cancelled | expired`, `accepted → settled | disputed`, `settled → disputed`, `disputed → resolved`. The recipient alone accepts or declines; the sender alone cancels; either party disputes; moderation alone resolves; the settlement rail alone settles. Legality MUST be enforced by the database (the `record_transfer_event` definer), mirroring the FR-29 trigger discipline — endpoint logic cannot excuse an illegal transition. Every transition lands in the append-only ledger (AMD-PAY-07).

**AMD-PAY-05 (caps and fee).** Safety-first caps are platform constants, not user settings: a per-transfer maximum of 5,000,000 minor units (NGN 50,000.00) and a rolling 24-hour sender cap of 15,000,000 minor units (NGN 150,000.00) over money in motion (proposed, accepted, settled, disputed). The transfer fee is 100 basis points (1.0%), computed by the database at proposal and stored on the row — this is the sixth revenue line admitted by AMD-PAY-01. Loosening any cap requires a further amendment.

**AMD-PAY-06 (eligibility, proved twice).** Both parties MUST be KYC-verified (`kyc_verified_accounts`) and share an OPEN conversation at proposal, with no active `payment_instrument` suspension (FR-55 composability, AMD-KYC-05). Acceptance re-proves KYC for both parties and the OPEN pair — verification at both moments, because a state can move between proposal and acceptance. A proposal expires one hour after creation if not accepted.

**AMD-PAY-07 (append-only ledger).** Every transfer transition MUST be recorded in `transfer_events`, which is append-only for every application path: the application role holds no UPDATE/DELETE grant and a trigger raises on either. Dispute resolutions additionally enter the admin audit log (FR-60). The ledger stores amounts, states and actors — never free text (AMD-PAY-03).

**AMD-PAY-08 (settlement gate made tangible).** The `settled` state is reachable only through the `record_transfer_event` branch gated by the transaction-local `app.transfer_settlement` setting, which no P0 component sets — the branch exists for the future Mojaloop/TigerBeetle callback and is unreachable until TECH-23's organisational gate lifts. P0 therefore records dual-consent transfer agreements with full audit; it moves no money.

**AMD-PAY-09 (DSAR inclusion).** The FR-62 export document MUST include the subject's transfer history: every transfer where the subject is sender or recipient, with the subject's role, the counterparty, the amount, fee, currency, state and timestamps, and the transfer's event ledger inline. Masking discipline is unchanged — a counterpart's decline still reads as `expired` (FR-32) and blocked pairs stay out of the pair list (FR-34) — but a transfer is a financial record, not a conversation artefact: it is exported even where the pair itself is masked, consistent with the party-scoped transfer list. Transfer rows survive account deletion (FR-03) tied to the anonymous tombstone, exactly like the consent ledger: they are the record of money movement, they contain no free text (AMD-PAY-03), and they identify nobody once the account is tombstoned. Deletion tooling MUST NOT erase or rewrite transfer or transfer_event rows — the AMD-PAY-07 append-only discipline has no erasure exception.

**AMD-PAY-10 (wallet object).** Every KYC-verified user MAY hold exactly **one wallet per currency**; NGN is the launch currency (loosening requires a further amendment). A single platform fee wallet per currency receives the AMD-PAY-05 fee revenue under a pinned, well-known identifier. Wallet creation is self-serve and idempotent for verified users; an unfunded wallet is inert by construction — it records value movements, it cannot originate them. A wallet is a structured record and nothing else: an identifier, a currency, a status (`active | frozen | closed`), and derived amounts. There is no user-facing free-text field — by construction, not by policy.

**AMD-PAY-11 (append-only value ledger).** Every movement of value MUST be recorded in `wallet_entries`, which is append-only for every application path: the application role holds no INSERT/UPDATE/DELETE grant and a trigger raises on UPDATE or DELETE. Each entry carries the running balance, written under the wallet row lock, and the database MUST reject any entry that would leave a wallet negative — solvency is a CHECK, not a convention. Balances are derived (`wallet_balances`): the ledger sum, the pending-hold total, and the spendable remainder. Kinds are signed by name: `fund`, `transfer_in` and `fee_revenue` credit; `withdrawal`, `transfer_out` and `fee_charge` debit.

**AMD-PAY-12 (two-phase holds).** Reservations follow `pending → posted | voided` and nothing else. A hold's terms — wallet, amount, transfer — MUST be immutable once placed; the database enforces the transition table and the immutability, mirroring the FR-29 trigger discipline. A pending hold reduces the spendable balance without moving value; posting consumes the reservation, voiding releases it. Holds are rail-only operations (AMD-PAY-13).

**AMD-PAY-13 (atomic settlement; the AMD-PAY-08 gate extended).** Settlement of an accepted transfer MUST be one atomic operation: the sender's wallet debited amount + fee, the recipient's credited the amount, the platform fee wallet credited the fee, any pending hold naming the transfer posted (it must cover amount + fee exactly), and the transfer moved to `settled` — all in a single transaction, so value and state can never diverge. Settlement is idempotent: a transfer with ledger rows MUST NOT settle twice. Eligibility is re-proved at this third moment: no active `payment_instrument` suspension on either party, all three wallets active. **Every value-moving wallet definer** — funding, withdrawal, hold placement, hold release, settlement — MUST refuse unless the transaction-local `app.transfer_settlement` setting is `on`: the AMD-PAY-08 gate extended over the whole wallet surface. No P0 component sets it; no route reaches these definers. P0 therefore ships the complete wallet contract — accounts, ledger, holds, moderation, export — and moves no money. Wallet freezing and unfreezing are moderation operations (AMD-KYC-05 composability), audited in the admin audit log; the platform wallet is untouchable by moderation.

**AMD-PAY-14 (DSAR inclusion of the wallet ledger).** The FR-62 export document MUST include the subject's wallets: per wallet the currency, status and creation timestamp, with the entry ledger (kind, amount, running balance, linked transfer, timestamp) and the hold history inline. Wallet rows survive account deletion (FR-03) tied to the anonymous tombstone, exactly like transfer rows: they are the record of value, they contain no free text (AMD-PAY-10), and they identify nobody once the account is tombstoned. Deletion tooling MUST NOT erase or rewrite wallet, wallet_entry or wallet_hold rows — the AMD-PAY-11 append-only discipline has no erasure exception.

---

*Addendum authored 2026-11-25 alongside batch 48; AMD-PAY-03..08 added alongside batch 49; AMD-PAY-09 added alongside batch 50; AMD-PAY-10..14 added alongside batch 53. Verification anchors: `tests/test_batch48.py` pins the migration, the discovery gate, the avatar registry, and this document's amendments; `tests/test_batch49.py` pins the transfer contracts; `tests/test_batch50.py` pins the DSAR inclusion and the no-erasure discipline; `tests/test_batch53.py` pins the wallet contracts, the rail gate and the wallet-ledger export.*

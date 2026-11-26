#!/usr/bin/env python3
"""AMD-ESC-03: full-chain migration rehearsal.

Applies every migration in db/migrations/ in lexical order against a scratch
PostgreSQL instance (pgserver), then exercises the escrow lifecycle end to
end — creation, milestone release, dispute, four-eyes resolution — plus the
marketplace composition, the dating filters, the vertical-flag lifecycle
(AMD-VERT-02..05), and the wallet conservation invariant.

The scratch cluster ships no contrib modules (the deploy image provides the
real ones; see deploy/postgres). The extension-provided surface is stubbed
before the chain is applied — the stubs, named here as the addendum requires:

  * CREATE EXTENSION lines are stripped (h3, postgis, pgcrypto, vector).
  * check_function_bodies is switched off for the apply phase (pg_dump
    style) so SQL-language definers over stubbed types still create.
  * geography(...) / geography / geometry / vector(N) / vector -> text.
  * The taxonomy embedding HNSW index degrades to plain btree.
  * CREATE DOMAIN h3index AS text; h3_cell_to_parent(cell,n) = cell;
    h3_get_resolution(cell) = 9 (matches the Lagos seed row).
  * digest(v, 'sha256') = core sha256(v::bytea); gen_random_bytes(n) is a
    sha256 stream (pgcrypto replacements; encode() is core).
  * ST_* over text: ST_IsValid = true, ST_NPoints = 100, ST_Area = 0,
    ST_Segmentize = identity, ST_Intersection = identity,
    ST_Intersects = false.

None of the stubs weaken the escrow checks: the rehearsal asserts outcomes,
states, holds, balances, and the four-eyes gate, none of which touch
extension behaviour.

Usage:  python3.11 scripts/rehearse_full_chain.py
Prints: rehearse_full_chain: N/N checks PASS
"""
from __future__ import annotations

import re
import sys
import tempfile
import traceback
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION_DIR = ROOT / "db" / "migrations"

FOUR_EYES_THRESHOLD = 1_000_000  # AMD-ESC-01: remaining minor above this gates

STUB_SQL = [
    "SET check_function_bodies = off",
    "CREATE DOMAIN h3index AS text",
    """CREATE FUNCTION h3_cell_to_parent(h3index, integer) RETURNS h3index
       LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$""",
    """CREATE FUNCTION h3_get_resolution(h3index) RETURNS integer
       LANGUAGE sql IMMUTABLE AS $$ SELECT 9 $$""",
    """CREATE FUNCTION digest(text, text) RETURNS bytea
       LANGUAGE sql IMMUTABLE AS $$ SELECT sha256($1::bytea) $$""",
    """CREATE FUNCTION gen_random_bytes(integer) RETURNS bytea
       LANGUAGE sql VOLATILE AS $$
       SELECT substr(sha256(random()::text::bytea)
                   || sha256(clock_timestamp()::text::bytea), 1, $1) $$""",
    """CREATE FUNCTION ST_IsValid(text) RETURNS boolean
       LANGUAGE sql IMMUTABLE AS $$ SELECT true $$""",
    """CREATE FUNCTION ST_NPoints(text) RETURNS integer
       LANGUAGE sql IMMUTABLE AS $$ SELECT 100 $$""",
    """CREATE FUNCTION ST_Area(text) RETURNS double precision
       LANGUAGE sql IMMUTABLE AS $$ SELECT 0::double precision $$""",
    """CREATE FUNCTION ST_Segmentize(text, double precision) RETURNS text
       LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$""",
    """CREATE FUNCTION ST_Intersection(text, text) RETURNS text
       LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$""",
    """CREATE FUNCTION ST_Intersects(text, text) RETURNS boolean
       LANGUAGE sql IMMUTABLE AS $$ SELECT false $$""",
]


def transform(sql: str) -> str:
    """Strip extension loads and degrade extension types to text."""
    lines = [ln for ln in sql.splitlines()
             if not re.match(r"\s*CREATE EXTENSION", ln, re.IGNORECASE)]
    sql = "\n".join(lines)
    sql = re.sub(r"geography\([^)]*\)", "text", sql)
    sql = re.sub(r"\bgeography\b", "text", sql)
    sql = re.sub(r"\bgeometry\b", "text", sql)
    sql = re.sub(r"vector\(\s*\d+\s*\)", "text", sql)
    sql = re.sub(r"\bvector\b", "text", sql)
    sql = sql.replace("USING hnsw (embedding vector_cosine_ops)",
                      "USING btree (embedding)")
    return sql


class Rehearsal:
    def __init__(self) -> None:
        self.passed: list[str] = []
        self.total = 0

    def check(self, name: str, cond: bool, detail: str = "") -> None:
        self.total += 1
        if not cond:
            raise AssertionError(f"check failed: {name} {detail}")
        self.passed.append(name)


def main() -> int:
    import pgserver  # noqa: PLC0415
    import psycopg  # noqa: PLC0415
    from psycopg import pq  # noqa: PLC0415

    r = Rehearsal()
    tmp = tempfile.mkdtemp(prefix="presence-rehearsal-")
    srv = pgserver.get_server(tmp)
    conn = psycopg.connect(srv.get_uri(), autocommit=True)

    GUC = {
        "user": "app.user_id",
        "moderator": "app.moderator",
        "settlement": "app.transfer_settlement",
        "funding": "app.funding_callback",
    }

    def q(sql, params=(), **gucs):
        """Run one statement in a transaction with the given GUCs set."""
        with conn.transaction():
            for key, val in gucs.items():
                conn.execute("SELECT set_config(%s, %s, true)",
                             (GUC[key], str(val)))
            cur = conn.execute(sql, params)
            if cur.pgresult.status == pq.ExecStatus.TUPLES_OK:
                return cur.fetchall()
            return []

    def scalar(sql, params=(), **gucs):
        rows = q(sql, params, **gucs)
        return rows[0][0] if rows else None

    # ------------------------------------------------ phase 1: full chain --
    for stmt in STUB_SQL:
        conn.execute(stmt)
    files = sorted(MIGRATION_DIR.glob("*.sql"))
    for path in files:
        res = conn.pgconn.exec_(transform(path.read_text()).encode())
        if res.status not in (pq.ExecStatus.COMMAND_OK, pq.ExecStatus.TUPLES_OK):
            raise RuntimeError(
                f"migration {path.name} failed: {res.error_message.decode()}")
    r.check("chain_applied",
            len(files) == len(list(MIGRATION_DIR.glob('*.sql'))) > 0,
            f"{len(files)} migrations")
    r.check("batch58_tables",
            scalar("SELECT count(*) FROM pg_tables WHERE schemaname='public'"
                   " AND tablename IN ('escrow_resolve_approvals',"
                   " 'marketplace_listings', 'dating_profiles')") == 3)

    # ------------------------------------------------- phase 2: fixtures ---
    def mkuser(birth_year=1990):
        uid = str(uuid.uuid4())
        q("INSERT INTO users (user_id, birth_year, kyc_state)"
          " VALUES (%s, %s, 'verified')", (uid, birth_year))
        return uid

    payer, payee = mkuser(), mkuser()
    mod1, mod2 = mkuser(), mkuser()
    seller, buyer = mkuser(), mkuser()
    d1, d2, d3 = mkuser(), mkuser(), mkuser(1970)

    def wallet_of(owner):
        rows = q("SELECT outcome, wallet_id FROM create_wallet(%s)",
                 (owner,), user=owner)
        r.check("create_wallet", rows[0][0] == "created", str(rows))
        return str(rows[0][1])

    def balance(wallet):
        return scalar(
            "SELECT COALESCE((SELECT balance_after FROM wallet_entries"
            " WHERE wallet_id = %s ORDER BY entry_id DESC LIMIT 1), 0)",
            (wallet,))

    def fund(wallet, amount, ref):
        out = scalar("SELECT outcome FROM fund_wallet(%s, %s, %s)",
                     (wallet, amount, ref), funding="on", settlement="on")
        r.check("fund_wallet", out == "funded", f"{ref} -> {out}")

    wallets = {u: wallet_of(u) for u in (payer, payee, seller, buyer)}
    FUNDED = {payer: 8_000_000, payee: 0, seller: 0, buyer: 3_000_000}
    fund(wallets[payer], FUNDED[payer], "rehearsal-fund-payer-01")
    fund(wallets[buyer], FUNDED[buyer], "rehearsal-fund-buyer-01")

    # --------------------------------- phase 3: small escrow (no gate) -----
    rows = q("SELECT outcome, escrow_id FROM create_escrow(%s, %s::bigint[])",
             (payee, [200_000, 300_000]), user=payer, settlement="on")
    r.check("small_escrow_created", rows[0][0] == "created", str(rows))
    esc_small = str(rows[0][1])
    r.check("small_escrow_milestones",
            scalar("SELECT count(*) FROM escrow_milestones"
                   " WHERE escrow_id = %s AND state = 'pending'",
                   (esc_small,)) == 2)
    r.check("small_escrow_hold",
            scalar("SELECT h.state FROM wallet_holds h"
                   " JOIN escrow_agreements e ON e.hold_id = h.hold_id"
                   " WHERE e.escrow_id = %s", (esc_small,)) == "pending")
    out = scalar("SELECT release_escrow_milestone(%s, %s::smallint)",
                 (esc_small, 1), user=payer, settlement="on")
    r.check("milestone_one_released", out == "released", out)
    r.check("payee_partial_balance",
            balance(wallets[payee]) == 200_000,
            str(balance(wallets[payee])))
    out = scalar("SELECT release_escrow_milestone(%s, %s::smallint)",
                 (esc_small, 2), user=payer, settlement="on")
    r.check("small_escrow_completed", out == "completed", out)
    r.check("small_escrow_state",
            scalar("SELECT state FROM escrow_agreements WHERE escrow_id = %s",
                   (esc_small,)) == "completed")
    r.check("small_escrow_conservation",
            balance(wallets[payer]) == FUNDED[payer] - 500_000
            and balance(wallets[payee]) == 500_000)

    # --------------------- phase 4: big escrow — four-eyes refund ----------
    rows = q("SELECT outcome, escrow_id FROM create_escrow(%s, %s::bigint[])",
             (payee, [1_500_000]), user=payer, settlement="on")
    esc_big = str(rows[0][1])
    r.check("big_escrow_created", rows[0][0] == "created", str(rows))
    out = scalar("SELECT dispute_escrow(%s)", (esc_big,),
                 user=payee, settlement="on")
    r.check("big_escrow_disputed", out == "disputed", out)
    r.check("disputed_at_stamped",
            scalar("SELECT disputed_at IS NOT NULL FROM escrow_agreements"
                   " WHERE escrow_id = %s", (esc_big,)) is True)
    out = scalar("SELECT resolve_escrow(%s, 'refund')", (esc_big,),
                 user=mod1, moderator="on", settlement="on")
    r.check("four_eyes_gate", out == "approval_required", out)
    appr = scalar("SELECT approval_id FROM escrow_resolve_approvals"
                  " WHERE escrow_id = %s AND state = 'pending'",
                  (esc_big,))
    r.check("approval_row_terms",
            appr is not None
            and scalar("SELECT remaining_minor FROM escrow_resolve_approvals"
                       " WHERE approval_id = %s", (appr,)) == 1_500_000
            and str(scalar("SELECT proposed_by FROM escrow_resolve_approvals"
                           " WHERE approval_id = %s", (appr,))) == mod1)
    r.check("no_value_moved_on_gate",
            scalar("SELECT state FROM escrow_agreements WHERE escrow_id = %s",
                   (esc_big,)) == "disputed"
            and scalar("SELECT count(*) FROM escrow_milestones"
                       " WHERE escrow_id = %s AND state = 'pending'",
                       (esc_big,)) == 1
            and balance(wallets[payer]) == FUNDED[payer] - 500_000)
            # ^ a pending hold parks funds without writing an entry
    out = scalar("SELECT approve_escrow_resolution(%s)", (appr,),
                 user=mod1, moderator="on", settlement="on")
    r.check("self_approval_refused", out == "self_approval", out)
    out = scalar("SELECT reject_escrow_resolution(%s)", (appr,),
                 user=mod2, moderator="on")
    r.check("reject_recorded",
            out == "rejected"
            and scalar("SELECT state FROM escrow_resolve_approvals"
                       " WHERE approval_id = %s", (appr,)) == "rejected"
            and str(scalar("SELECT decided_by FROM escrow_resolve_approvals"
                           " WHERE approval_id = %s", (appr,))) == mod2, out)
    r.check("escrow_still_disputed_after_reject",
            scalar("SELECT state FROM escrow_agreements WHERE escrow_id = %s",
                   (esc_big,)) == "disputed")
    out = scalar("SELECT resolve_escrow(%s, 'refund')", (esc_big,),
                 user=mod2, moderator="on", settlement="on")
    r.check("reproposal_after_reject", out == "approval_required", out)
    appr2 = scalar("SELECT approval_id FROM escrow_resolve_approvals"
                   " WHERE escrow_id = %s AND state = 'pending'", (esc_big,))
    out = scalar("SELECT approve_escrow_resolution(%s)", (appr2,),
                 user=mod1, moderator="on", settlement="on")
    r.check("second_pair_resolves", out == "resolved", out)
    r.check("refund_conservation",
            scalar("SELECT state FROM escrow_agreements WHERE escrow_id = %s",
                   (esc_big,)) == "refunded"
            and scalar("SELECT count(*) FROM escrow_milestones"
                       " WHERE escrow_id = %s AND state = 'refunded'",
                       (esc_big,)) == 1
            and scalar("SELECT h.state FROM wallet_holds h"
                       " JOIN escrow_agreements e ON e.hold_id = h.hold_id"
                       " WHERE e.escrow_id = %s", (esc_big,)) == "voided"
            and balance(wallets[payer]) == FUNDED[payer] - 500_000
            and balance(wallets[payee]) == 500_000)

    # ---------- phase 5: four-eyes release + per-decision approval match ---
    rows = q("SELECT outcome, escrow_id FROM create_escrow(%s, %s::bigint[])",
             (payee, [2_000_000]), user=payer, settlement="on")
    esc_rel = str(rows[0][1])
    scalar("SELECT dispute_escrow(%s)", (esc_rel,), user=payer,
           settlement="on")
    out = scalar("SELECT resolve_escrow(%s, 'refund')", (esc_rel,),
                 user=mod1, moderator="on", settlement="on")
    r.check("release_dispute_gated", out == "approval_required", out)
    # A release proposal while a refund approval pends must NOT match it.
    out = scalar("SELECT resolve_escrow(%s, 'release')", (esc_rel,),
                 user=mod2, moderator="on", settlement="on")
    r.check("approval_matches_decision", out == "approval_required", out)
    r.check("one_pending_per_escrow",
            scalar("SELECT count(*) FROM escrow_resolve_approvals"
                   " WHERE escrow_id = %s AND state = 'pending'",
                   (esc_rel,)) == 1)
    scalar("SELECT reject_escrow_resolution(approval_id)"
           " FROM escrow_resolve_approvals"
           " WHERE escrow_id = %s AND state = 'pending'",
           (esc_rel,), user=mod2, moderator="on")
    out = scalar("SELECT resolve_escrow(%s, 'release')", (esc_rel,),
                 user=mod2, moderator="on", settlement="on")
    r.check("release_reproposal_gated", out == "approval_required", out)
    appr3 = scalar("SELECT approval_id FROM escrow_resolve_approvals"
                   " WHERE escrow_id = %s AND state = 'pending'", (esc_rel,))
    out = scalar("SELECT approve_escrow_resolution(%s)", (appr3,),
                 user=mod1, moderator="on", settlement="on")
    r.check("release_approved_resolves", out == "resolved", out)
    r.check("release_conservation",
            scalar("SELECT state FROM escrow_agreements WHERE escrow_id = %s",
                   (esc_rel,)) == "completed"
            and balance(wallets[payee]) == 500_000 + 2_000_000
            and balance(wallets[payer]) == FUNDED[payer] - 500_000 - 2_000_000)

    # ------------- phase 6: below-threshold dispute stays single-moderator -
    rows = q("SELECT outcome, escrow_id FROM create_escrow(%s, %s::bigint[])",
             (payee, [600_000]), user=payer, settlement="on")
    esc_low = str(rows[0][1])
    scalar("SELECT dispute_escrow(%s)", (esc_low,), user=payee,
           settlement="on")
    out = scalar("SELECT resolve_escrow(%s, 'refund')", (esc_low,),
                 user=mod1, moderator="on", settlement="on")
    r.check("below_threshold_ungated", out == "resolved", out)
    r.check("below_threshold_no_approval_row",
            scalar("SELECT count(*) FROM escrow_resolve_approvals"
                   " WHERE escrow_id = %s", (esc_low,)) == 0)
    r.check("below_threshold_refunded",
            scalar("SELECT state FROM escrow_agreements WHERE escrow_id = %s",
                   (esc_low,)) == "refunded")

    # ---------------------------------- phase 7: marketplace composition ---
    q("INSERT INTO taxonomy_nodes (node_id, label, kind, sensitive, depth)"
      " VALUES ('goods.electronics', 'Electronics', 'category', false, 1)")
    r.check("lagos_market_seeded",
            scalar("SELECT count(*) FROM market_config"
                   " WHERE market_id = 'lagos' AND active") == 1)
    rows = q("SELECT outcome, listing_id FROM create_listing"
             " ('item', 'goods.electronics', %s, 'lagos')",
             (300_000,), user=seller)
    r.check("listing_created", rows[0][0] == "created", str(rows))
    lst_small = str(rows[0][1])
    out = scalar("SELECT list_listing(%s)", (lst_small,), user=seller)
    r.check("listing_listed", out == "listed", out)
    rows = q("SELECT outcome, order_id FROM purchase_listing(%s)",
             (lst_small,), user=buyer, settlement="on")
    r.check("purchase_created", rows[0][0] == "purchased", str(rows))
    ord_small = str(rows[0][1])
    r.check("purchase_escrow_composed",
            scalar("SELECT e.state FROM escrow_agreements e"
                   " JOIN marketplace_orders o ON o.escrow_id = e.escrow_id"
                   " WHERE o.order_id = %s", (ord_small,)) == "active")
    out = scalar("SELECT confirm_purchase(%s)", (ord_small,),
                 user=buyer, settlement="on")
    r.check("purchase_confirmed", out == "completed", out)
    r.check("purchase_settled",
            scalar("SELECT state FROM marketplace_orders WHERE order_id = %s",
                   (ord_small,)) == "completed"
            and scalar("SELECT state FROM marketplace_listings"
                       " WHERE listing_id = %s", (lst_small,)) == "sold"
            and balance(wallets[seller]) >= 300_000)
    seller_after_sale = balance(wallets[seller])

    rows = q("SELECT outcome, listing_id FROM create_listing"
             " ('item', 'goods.electronics', %s, 'lagos')",
             (2_000_000,), user=seller)
    lst_big = str(rows[0][1])
    scalar("SELECT list_listing(%s)", (lst_big,), user=seller)
    rows = q("SELECT outcome, order_id FROM purchase_listing(%s)",
             (lst_big,), user=buyer, settlement="on")
    ord_big = str(rows[0][1])
    out = scalar("SELECT dispute_purchase(%s)",
                 (ord_big,), user=buyer, settlement="on")
    r.check("purchase_disputed", out == "disputed", out)
    out = scalar("SELECT resolve_purchase(%s, 'refund')", (ord_big,),
                 user=mod1, moderator="on", settlement="on")
    r.check("marketplace_four_eyes_passthrough",
            out == "approval_required", out)
    appr4 = scalar("SELECT a.approval_id FROM escrow_resolve_approvals a"
                   " JOIN marketplace_orders o ON o.escrow_id = a.escrow_id"
                   " WHERE o.order_id = %s AND a.state = 'pending'",
                   (ord_big,))
    out = scalar("SELECT approve_escrow_resolution(%s)", (appr4,),
                 user=mod2, moderator="on", settlement="on")
    r.check("marketplace_approved_resolves", out == "resolved", out)
    order_state = scalar("SELECT state FROM marketplace_orders"
                         " WHERE order_id = %s", (ord_big,))
    listing_state = scalar("SELECT state FROM marketplace_listings"
                           " WHERE listing_id = %s", (lst_big,))
    buyer_bal = balance(wallets[buyer])
    seller_bal = balance(wallets[seller])
    r.check("marketplace_refund_conservation",
            order_state == "refunded"
            and listing_state == "listed"
            and buyer_bal == FUNDED[buyer] - 300_000
            and seller_bal == seller_after_sale,
            f"order={order_state} listing={listing_state}"
            f" buyer={buyer_bal} seller={seller_bal}"
            f" seller_after_sale={seller_after_sale}")

    # ----------------------------------------- phase 8: dating smoke -------
    out = scalar("SELECT set_dating_preferences('female', ARRAY['male'],"
                 " 'long_term', 25::smallint, 40::smallint)", (), user=d1)
    r.check("dating_prefs_recorded", out == "recorded", out)
    out = scalar("SELECT set_dating_preferences('male', ARRAY['female'],"
                 " 'long_term', 25::smallint, 40::smallint)", (), user=d2)
    r.check("dating_prefs_second", out == "recorded", out)
    out = scalar("SELECT set_dating_preferences('male', ARRAY['female'],"
                 " 'long_term', 25::smallint, 40::smallint)", (), user=d3)
    r.check("dating_compatible_match",
            scalar("SELECT dating_compatible(%s)", (d2,), user=d1) is True)
    r.check("dating_compatible_age_out",
            scalar("SELECT dating_compatible(%s)", (d3,), user=d1) is False)
    rows = q("SELECT peer FROM dating_filter_candidates(%s::uuid[])",
             ([d2, d3],), user=d1)
    r.check("dating_filter_candidates",
            [str(x[0]) for x in rows] == [d2], str(rows))
    rows = q("SELECT peer FROM dating_filter_candidates(%s::uuid[])",
             ([d2],), user=buyer)  # buyer has no dating profile
    r.check("dating_filter_inert_without_profile",
            [str(x[0]) for x in rows] == [d2], str(rows))

    # -------------------------------------- phase 8b: vertical flags -----
    # AMD-VERT-01..05: default-on, definer-only writes, locked core,
    # eligibility re-proof, all-or-nothing batch validation.
    out = scalar("SELECT set_user_verticals(%s::jsonb, %s)",
                 ('{"dating": false}', "onboarding"), user=d1)
    r.check("verticals_disable", out == "updated", out)
    r.check("verticals_disabled_narrows",
            scalar("SELECT vertical_enabled(%s)", ("dating",), user=d1)
            is False)
    out = scalar("SELECT set_user_verticals(%s::jsonb, %s)",
                 ('{"dating": true}', "settings"), user=d1)
    r.check("verticals_enable", out == "updated", out)
    r.check("verticals_enabled_restores",
            scalar("SELECT vertical_enabled(%s)", ("dating",), user=d1)
            is True)
    # The locked core refuses narrowing; affirming it is accepted.
    out = scalar("SELECT set_user_verticals(%s::jsonb, %s)",
                 ('{"discovery": false}', "settings"), user=d1)
    r.check("verticals_locked_core", out == "locked", out)
    out = scalar("SELECT set_user_verticals(%s::jsonb, %s)",
                 ('{"discovery": true}', "settings"), user=d1)
    r.check("verticals_locked_affirm", out == "updated", out)
    r.check("verticals_locked_still_on",
            scalar("SELECT vertical_enabled(%s)", ("discovery",), user=d1)
            is True)
    # Unknown keys, non-boolean values and empty patches refuse the batch.
    out = scalar("SELECT set_user_verticals(%s::jsonb, %s)",
                 ('{"bogus": true}', "settings"), user=d1)
    r.check("verticals_unknown_refused", out == "unknown_vertical", out)
    out = scalar("SELECT set_user_verticals(%s::jsonb, %s)",
                 ('{"dating": "yes"}', "settings"), user=d1)
    r.check("verticals_non_boolean_refused", out == "invalid_patch", out)
    out = scalar("SELECT set_user_verticals(%s::jsonb, %s)",
                 ("{}", "settings"), user=d1)
    r.check("verticals_empty_refused", out == "invalid_patch", out)
    # Eligibility: a non-KYC caller can always narrow but cannot re-enable
    # a gated vertical.
    unv = str(uuid.uuid4())
    q("INSERT INTO users (user_id, birth_year, kyc_state)"
      " VALUES (%s, 1990, 'pending')", (unv,))
    out = scalar("SELECT set_user_verticals(%s::jsonb, %s)",
                 ('{"dating": false}', "onboarding"), user=unv)
    r.check("verticals_narrow_never_gated", out == "updated", out)
    out = scalar("SELECT set_user_verticals(%s::jsonb, %s)",
                 ('{"dating": true}', "settings"), user=unv)
    r.check("verticals_enable_requires_kyc", out == "kyc_required", out)
    # The read model: nine rows in catalogue order with effective state.
    rows = q("SELECT vertical, locked, eligible, enabled, explicit_choice"
             " FROM list_my_verticals()", (), user=d1)
    r.check("verticals_read_model_shape",
            len(rows) == 9
            and rows[0][0] == "discovery" and rows[0][1] is True
            and [str(x[0]) for x in rows] == [
                "discovery", "venues", "groups", "dating", "marketplace",
                "payments", "trust", "introductions", "serendipity"],
            str(rows[:2]))

    # ------------------------- phase 9: reconciliation + guards + ledger ---
    rec = scalar("SELECT wallet_reconciliation()", (),
                 user=mod1, moderator="on")
    r.check("reconciliation_keys",
            rec is not None and all(k in rec for k in (
                "walletsChecked", "balanceMismatches", "platformFeeDelta",
                "stuckHolds", "openWithdrawals", "openRiskSignals",
                "pendingCreditApprovals", "openEscrowDisputes",
                "oldestEscrowDisputeSeconds", "pendingEscrowResolveApprovals",
                "stuckEscrows")),
            str(rec))
    rec2 = scalar("SELECT wallet_reconciliation()", (), user=payer)
    r.check("reconciliation_moderator_only",
            rec2 == {"error": "forbidden"}, str(rec2))
    r.check("reconciliation_balances_clean",
            rec["balanceMismatches"] == [] and rec["stuckHolds"] == 0,
            str(rec))
    try:
        q("DELETE FROM escrow_resolve_approvals")
        r.check("approvals_guard_blocks_delete", False, "no exception")
    except Exception as exc:  # noqa: BLE001 — the guard MUST raise
        r.check("approvals_guard_blocks_delete", "AMD-ESC-01" in str(exc),
                str(exc)[:200])

    total_in = sum(FUNDED.values())
    parked = scalar("SELECT COALESCE(sum(balance_after), 0) FROM ("
                    " SELECT DISTINCT ON (wallet_id) balance_after"
                    " FROM wallet_entries ORDER BY wallet_id, entry_id DESC"
                    " ) latest") or 0
    held = scalar("SELECT COALESCE(sum(amount_minor), 0) FROM wallet_holds"
                  " WHERE state = 'pending'") or 0
    r.check("global_conservation", parked + held == total_in,
            f"{parked} + {held} != {total_in}")

    print(f"rehearse_full_chain: {len(r.passed)}/{r.total} checks PASS")
    for name in r.passed:
        print(f"  ok  {name}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)

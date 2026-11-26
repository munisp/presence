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

import json
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
        "venue_ops": "app.venue_ops",
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

    sw1, sw2 = mkuser(), mkuser()
    wallets = {u: wallet_of(u) for u in (payer, payee, seller, buyer,
                                         sw1, sw2)}
    FUNDED = {payer: 8_000_000, payee: 0, seller: 0, buyer: 3_000_000,
              sw1: 2_000_000, sw2: 2_000_000}
    fund(wallets[payer], FUNDED[payer], "rehearsal-fund-payer-01")
    fund(wallets[buyer], FUNDED[buyer], "rehearsal-fund-buyer-01")
    fund(wallets[sw1], FUNDED[sw1], "rehearsal-fund-sw1-01")
    fund(wallets[sw2], FUNDED[sw2], "rehearsal-fund-sw2-01")

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
    # The read model: ten rows in catalogue order with effective state.
    rows = q("SELECT vertical, locked, eligible, enabled, explicit_choice"
             " FROM list_my_verticals()", (), user=d1)
    r.check("verticals_read_model_shape",
            len(rows) == 10
            and rows[0][0] == "discovery" and rows[0][1] is True
            and [str(x[0]) for x in rows] == [
                "discovery", "venues", "groups", "dating", "marketplace",
                "services", "payments", "trust", "introductions",
                "serendipity"],
            str(rows[:2]))

    # -------------------------------------- phase 8c: barter swaps -------
    # AMD-SWP-01..05: category-cover matching over the TR-18 closure,
    # hold-at-propose, bond-backed confirmation, dispute -> moderated
    # release/refund with optional forfeiture, and the expiry clocks.
    q("INSERT INTO taxonomy_nodes (node_id, label, kind, sensitive, depth)"
      " VALUES ('goods', 'Goods', 'category', false, 0),"
      "        ('goods.vehicles', 'Vehicles', 'category', false, 1)")
    q("INSERT INTO taxonomy_closure (node_id, ancestor_id, hops, decay)"
      " VALUES ('goods.vehicles', 'goods', 1, 0.8)")
    r.check("swap_covers_closure_path",
            scalar("SELECT swap_category_covers('goods', 'goods.vehicles')")
            is True)
    r.check("swap_covers_self_not_descendant",
            scalar("SELECT swap_category_covers('goods.vehicles', 'goods')")
            is False)

    def mk_swap(user, have, wants, value, name):
        rows = q("SELECT outcome, swap_listing_id FROM create_swap_listing"
                 " (%s, %s::text[], %s, 'lagos')",
                 (have, wants, value), user=user)
        r.check(name, rows[0][0] == "created", str(rows))
        return str(rows[0][1])

    l1 = mk_swap(sw1, "goods.vehicles", ["goods.electronics"], 400_000,
                 "swap_listing_one_created")
    l2 = mk_swap(sw2, "goods.electronics", ["goods"], 400_000,
                 "swap_listing_two_created")
    r.check("swap_compatible_pair",
            scalar("SELECT swap_compatible(%s, %s)", (l1, l2)) is True)
    r.check("swap_compatible_self_refused",
            scalar("SELECT swap_compatible(%s, %s)", (l1, l1)) is False)
    rows = q("SELECT swap_listing_id FROM swap_candidates()", (), user=sw2)
    r.check("swap_candidates_reciprocal",
            [str(x[0]) for x in rows] == [l1], str(rows))
    rows = q("SELECT swap_listing_id FROM swap_candidates()", (), user=buyer)
    r.check("swap_candidates_require_own_listing", rows == [], str(rows))

    # Flow 1: propose with a balancer + bond, accept, dual confirm settles.
    sw1_start = balance(wallets[sw1])
    sw2_start = balance(wallets[sw2])
    rows = q("SELECT outcome, agreement_id FROM propose_swap"
             " (%s, %s, %s, true)", (l1, l2, 100_000),
             user=sw1, settlement="on")
    r.check("swap_proposed", rows[0][0] == "proposed", str(rows))
    agr1 = str(rows[0][1])
    r.check("swap_hold_at_propose",
            scalar("SELECT h.state FROM wallet_holds h"
                   " JOIN swap_agreements a ON a.balance_hold_id = h.hold_id"
                   " WHERE a.agreement_id = %s", (agr1,)) == "pending"
            and scalar("SELECT count(*) FROM swap_listings"
                       " WHERE swap_listing_id IN (%s, %s)"
                       " AND state = 'held'", (l1, l2)) == 2)
    out = scalar("SELECT respond_swap(%s, true)", (agr1,),
                 user=sw2, settlement="on")
    r.check("swap_respond_requires_bond", out == "bond_required", out)
    rows = q("SELECT outcome, swap_bond_id FROM stake_swap_bond(%s)",
             (agr1,), user=sw1, settlement="on")
    r.check("swap_bond_one_staked", rows[0][0] == "staked", str(rows))
    rows = q("SELECT outcome, swap_bond_id FROM stake_swap_bond(%s)",
             (agr1,), user=sw2, settlement="on")
    r.check("swap_bond_two_staked", rows[0][0] == "staked", str(rows))
    out = scalar("SELECT respond_swap(%s, true)", (agr1,),
                 user=sw2, settlement="on")
    r.check("swap_accepted", out == "accepted", out)
    out = scalar("SELECT confirm_swap_exchange(%s)", (agr1,),
                 user=sw1, settlement="on")
    r.check("swap_first_confirm", out == "confirmed", out)
    out = scalar("SELECT confirm_swap_exchange(%s)", (agr1,),
                 user=sw2, settlement="on")
    r.check("swap_completed", out == "completed", out)
    r.check("swap_settlement_conservation",
            balance(wallets[sw1]) == sw1_start - 100_000
            and balance(wallets[sw2]) == sw2_start + 100_000
            and scalar("SELECT count(*) FROM swap_bonds"
                       " WHERE agreement_id = %s AND state = 'released'",
                       (agr1,)) == 2
            and scalar("SELECT count(*) FROM swap_listings"
                       " WHERE swap_listing_id IN (%s, %s)"
                       " AND state = 'swapped'", (l1, l2)) == 2
            and scalar("SELECT count(*) FROM swap_events"
                       " WHERE agreement_id = %s AND to_state = 'completed'",
                       (agr1,)) == 1)

    # Flow 2: the proposer cancels an unanswered proposal; the unwind voids
    # the balancer hold and relists both listings.
    l3 = mk_swap(sw1, "goods.vehicles", ["goods.electronics"], 300_000,
                 "swap_listing_three_created")
    l4 = mk_swap(sw2, "goods.electronics", ["goods"], 300_000,
                 "swap_listing_four_created")
    rows = q("SELECT outcome, agreement_id FROM propose_swap"
             " (%s, %s, %s, false)", (l3, l4, 50_000),
             user=sw1, settlement="on")
    agr2 = str(rows[0][1])
    out = scalar("SELECT cancel_swap(%s)", (agr2,), user=sw1, settlement="on")
    r.check("swap_cancelled_by_proposer", out == "cancelled", out)
    r.check("swap_cancel_unwinds",
            scalar("SELECT h.state FROM wallet_holds h"
                   " JOIN swap_agreements a ON a.balance_hold_id = h.hold_id"
                   " WHERE a.agreement_id = %s", (agr2,)) == "voided"
            and scalar("SELECT count(*) FROM swap_listings"
                       " WHERE swap_listing_id IN (%s, %s)"
                       " AND state = 'listed'", (l3, l4)) == 2)

    # Flow 3: dispute an accepted swap; a moderated refund voids the
    # balancer and relists.
    l5 = mk_swap(sw1, "goods.vehicles", ["goods.electronics"], 300_000,
                 "swap_listing_five_created")
    l6 = mk_swap(sw2, "goods.electronics", ["goods"], 300_000,
                 "swap_listing_six_created")
    rows = q("SELECT outcome, agreement_id FROM propose_swap"
             " (%s, %s, %s, false)", (l5, l6, 50_000),
             user=sw1, settlement="on")
    agr3 = str(rows[0][1])
    out = scalar("SELECT respond_swap(%s, true)", (agr3,),
                 user=sw2, settlement="on")
    r.check("swap_three_accepted", out == "accepted", out)
    out = scalar("SELECT dispute_swap(%s)", (agr3,), user=sw2)
    r.check("swap_disputed", out == "disputed", out)
    out = scalar("SELECT resolve_swap(%s, 'refund')", (agr3,),
                 user=mod1, moderator="on", settlement="on")
    r.check("swap_refund_resolved", out == "resolved", out)
    r.check("swap_refund_unwinds",
            scalar("SELECT state FROM swap_agreements"
                   " WHERE agreement_id = %s", (agr3,)) == "cancelled"
            and scalar("SELECT count(*) FROM swap_listings"
                       " WHERE swap_listing_id IN (%s, %s)"
                       " AND state = 'listed'", (l5, l6)) == 2
            and scalar("SELECT h.state FROM wallet_holds h"
                       " JOIN swap_agreements a"
                       "   ON a.balance_hold_id = h.hold_id"
                       " WHERE a.agreement_id = %s", (agr3,)) == "voided")

    # Flow 4: moderated release with a bond forfeiture — the wronged party
    # is paid, never the platform (AMD-SWP-04).
    l7 = mk_swap(sw1, "goods.vehicles", ["goods.electronics"], 300_000,
                 "swap_listing_seven_created")
    l8 = mk_swap(sw2, "goods.electronics", ["goods"], 300_000,
                 "swap_listing_eight_created")
    rows = q("SELECT outcome, agreement_id FROM propose_swap"
             " (%s, %s, %s, true)", (l7, l8, 50_000),
             user=sw1, settlement="on")
    agr4 = str(rows[0][1])
    rows = q("SELECT outcome, swap_bond_id FROM stake_swap_bond(%s)",
             (agr4,), user=sw1, settlement="on")
    r.check("swap_four_bond_one", rows[0][0] == "staked", str(rows))
    rows = q("SELECT outcome, swap_bond_id FROM stake_swap_bond(%s)",
             (agr4,), user=sw2, settlement="on")
    r.check("swap_four_bond_two", rows[0][0] == "staked", str(rows))
    bond_sw2 = str(rows[0][1])
    out = scalar("SELECT respond_swap(%s, true)", (agr4,),
                 user=sw2, settlement="on")
    r.check("swap_four_accepted", out == "accepted", out)
    out = scalar("SELECT dispute_swap(%s)", (agr4,), user=sw1)
    r.check("swap_four_disputed", out == "disputed", out)
    sw1_mid = balance(wallets[sw1])
    sw2_mid = balance(wallets[sw2])
    out = scalar("SELECT resolve_swap(%s, 'release', %s::uuid)",
                 (agr4, bond_sw2), user=mod1, moderator="on",
                 settlement="on")
    r.check("swap_release_resolved", out == "resolved", out)
    r.check("swap_forfeit_pays_counterparty",
            balance(wallets[sw1]) == sw1_mid + 50_000
            and balance(wallets[sw2]) == sw2_mid - 50_000
            and scalar("SELECT state FROM swap_bonds"
                       " WHERE swap_bond_id = %s",
                       (bond_sw2,)) == "forfeited"
            and scalar("SELECT state FROM swap_agreements"
                       " WHERE agreement_id = %s", (agr4,)) == "completed")

    # Flow 5: an unanswered proposal expires at 72 h — cancelled, unwound,
    # relisted. Aging bypasses the row guards via the replica role.
    l9 = mk_swap(sw1, "goods.vehicles", ["goods.electronics"], 300_000,
                 "swap_listing_nine_created")
    l10 = mk_swap(sw2, "goods.electronics", ["goods"], 300_000,
                  "swap_listing_ten_created")
    rows = q("SELECT outcome, agreement_id FROM propose_swap"
             " (%s, %s, %s, false)", (l9, l10, 50_000),
             user=sw1, settlement="on")
    agr5 = str(rows[0][1])
    conn.execute("SET session_replication_role = replica")
    conn.execute("UPDATE swap_agreements"
                 "   SET created_at = now() - interval '73 hours'"
                 " WHERE agreement_id = %s", (agr5,))
    conn.execute("SET session_replication_role = DEFAULT")
    n = scalar("SELECT expire_stale_swaps()", (), settlement="on")
    r.check("swap_proposal_expired", n == 1, str(n))
    r.check("swap_expiry_unwinds",
            scalar("SELECT state FROM swap_agreements"
                   " WHERE agreement_id = %s", (agr5,)) == "cancelled"
            and scalar("SELECT count(*) FROM swap_listings"
                       " WHERE swap_listing_id IN (%s, %s)"
                       " AND state = 'listed'", (l9, l10)) == 2)

    # Flow 6: an accepted swap with no completed exchange escalates to
    # disputed at 168 h (keyed on decided_at), then moderation refunds it.
    l11 = mk_swap(sw1, "goods.vehicles", ["goods.electronics"], 300_000,
                  "swap_listing_eleven_created")
    l12 = mk_swap(sw2, "goods.electronics", ["goods"], 300_000,
                  "swap_listing_twelve_created")
    rows = q("SELECT outcome, agreement_id FROM propose_swap"
             " (%s, %s, %s, false)", (l11, l12, 0),
             user=sw1, settlement="on")
    agr6 = str(rows[0][1])
    out = scalar("SELECT respond_swap(%s, true)", (agr6,),
                 user=sw2, settlement="on")
    r.check("swap_six_accepted", out == "accepted", out)
    conn.execute("SET session_replication_role = replica")
    conn.execute("UPDATE swap_agreements"
                 "   SET created_at = now() - interval '169 hours',"
                 "       decided_at = now() - interval '169 hours'"
                 " WHERE agreement_id = %s", (agr6,))
    conn.execute("SET session_replication_role = DEFAULT")
    n = scalar("SELECT expire_stale_swaps()", (), settlement="on")
    r.check("swap_accepted_escalates", n == 1, str(n))
    r.check("swap_escalated_to_dispute",
            scalar("SELECT state FROM swap_agreements"
                   " WHERE agreement_id = %s", (agr6,)) == "disputed")
    out = scalar("SELECT resolve_swap(%s, 'refund')", (agr6,),
                 user=mod1, moderator="on", settlement="on")
    r.check("swap_escalation_refunded", out == "resolved", out)

    # The expirer refuses to run with the settlement rail off (value moves
    # on the unwind path), and the event log is append-only.
    try:
        scalar("SELECT expire_stale_swaps()")
        r.check("swap_expire_requires_settlement", False, "no exception")
    except Exception as exc:  # noqa: BLE001 — the expirer MUST raise
        r.check("swap_expire_requires_settlement",
                "AMD-SWP-03" in str(exc), str(exc)[:200])
    try:
        q("DELETE FROM swap_events")
        r.check("swap_events_guard_blocks_delete", False, "no exception")
    except Exception as exc:  # noqa: BLE001 — the guard MUST raise
        r.check("swap_events_guard_blocks_delete",
                "AMD-SWP-05" in str(exc), str(exc)[:200])

    # AMD-SWP-05: the swap surface joins the DSAR export and the swap
    # dispute queue joins reconciliation.
    exp = scalar("SELECT dsar_export(%s)", (sw1,), user=sw1)
    r.check("swap_dsar_export",
            exp is not None and "swaps" in exp
            and len(exp["swaps"]["listings"]) >= 1
            and len(exp["swaps"]["agreements"]) >= 4,
            str(exp)[:200])
    rec_swap = scalar("SELECT wallet_reconciliation()", (),
                      user=mod1, moderator="on")
    r.check("swap_reconciliation_keys",
            rec_swap is not None
            and all(k in rec_swap for k in (
                "openSwapDisputes", "oldestSwapDisputeSeconds",
                "stuckSwaps"))
            and rec_swap["openSwapDisputes"] == 0,
            str(rec_swap)[:200])

    # ------------------------- phase 8d: service bookings ----------------
    # AMD-SVC-01..05: escrow-composed bookings on service-kind listings —
    # the listing stays listed, the provider start stops the ghosting
    # clock, milestone confirmation delegates to the escrow release, and
    # moderation inherits the AMD-ESC-01 four-eyes gate with the booking
    # resolved identically on the direct and the approved paths.
    svc1, svc2, svc3 = mkuser(), mkuser(), mkuser()
    wallets[svc1] = wallet_of(svc1)
    wallets[svc2] = wallet_of(svc2)
    wallets[svc3] = wallet_of(svc3)
    FUNDED[svc1] = 4_000_000
    fund(wallets[svc1], FUNDED[svc1], "rehearsal-fund-svc1-01")

    rows = q("SELECT outcome, listing_id FROM create_listing"
             " ('service', 'goods.electronics', %s, 'lagos')",
             (500_000,), user=svc2)
    r.check("svc_listing_created", rows[0][0] == "created", str(rows))
    lst_svc = str(rows[0][1])
    out = scalar("SELECT list_listing(%s)", (lst_svc,), user=svc2)
    r.check("svc_listing_listed", out == "listed", out)
    rows = q("SELECT outcome, listing_id FROM create_listing"
             " ('item', 'goods.electronics', %s, 'lagos')",
             (100_000,), user=seller)
    lst_item = str(rows[0][1])
    out = scalar("SELECT list_listing(%s)", (lst_item,), user=seller)
    r.check("svc_item_listing_listed", out == "listed", out)

    # Refusals the definer owns: gate off, wrong kind, self, bad milestone
    # count, insufficient funds.
    rows = q("SELECT outcome FROM book_service(%s, %s, %s::smallint)",
             (lst_svc, 100_000, 1), user=svc1)
    r.check("svc_book_gate_off", rows[0][0] == "forbidden", str(rows))
    rows = q("SELECT outcome FROM book_service(%s, %s, %s::smallint)",
             (lst_item, 100_000, 1), user=svc1, settlement="on")
    r.check("svc_book_not_a_service", rows[0][0] == "not_a_service", str(rows))
    rows = q("SELECT outcome FROM book_service(%s, %s, %s::smallint)",
             (lst_svc, 100_000, 1), user=svc2, settlement="on")
    r.check("svc_book_self_refused", rows[0][0] == "self", str(rows))
    rows = q("SELECT outcome FROM book_service(%s, %s, %s::smallint)",
             (lst_svc, 100_000, 13), user=svc1, settlement="on")
    r.check("svc_book_milestones_bound",
            rows[0][0] == "invalid_milestones", str(rows))
    rows = q("SELECT outcome FROM book_service(%s, %s, %s::smallint)",
             (lst_svc, 100_000, 1), user=svc3, settlement="on")
    r.check("svc_book_insufficient_funds",
            rows[0][0] == "insufficient_funds", str(rows))

    # Flow A: the happy path — book 600k in 2 milestones, start, confirm
    # both; the last release completes escrow and booking together.
    rows = q("SELECT outcome, booking_id FROM book_service(%s, %s, %s::smallint)",
             (lst_svc, 600_000, 2), user=svc1, settlement="on")
    r.check("svc_booked", rows[0][0] == "booked", str(rows))
    bk_a = str(rows[0][1])
    r.check("svc_booking_composed",
            scalar("SELECT b.state FROM service_bookings b"
                   " WHERE b.booking_id = %s", (bk_a,)) == "accepted"
            and scalar("SELECT e.state FROM escrow_agreements e"
                       " JOIN service_bookings b ON b.escrow_id = e.escrow_id"
                       " WHERE b.booking_id = %s", (bk_a,)) == "active"
            and scalar("SELECT state FROM marketplace_listings"
                       " WHERE listing_id = %s", (lst_svc,)) == "listed")
    r.check("svc_milestone_even_split",
            scalar("SELECT array_agg(amount_minor ORDER BY seq)"
                   " FROM escrow_milestones m"
                   " JOIN service_bookings b ON b.escrow_id = m.escrow_id"
                   " WHERE b.booking_id = %s", (bk_a,)) == [300_000, 300_000])
    out = scalar("SELECT start_service(%s)", (bk_a,), user=svc1)
    r.check("svc_start_provider_only", out == "forbidden", out)
    out = scalar("SELECT start_service(%s)", (bk_a,), user=svc2)
    r.check("svc_started", out == "started", out)
    out = scalar("SELECT confirm_service_milestone(%s, 1::smallint)",
                 (bk_a,), user=svc2, settlement="on")
    r.check("svc_confirm_customer_only", out == "forbidden", out)
    out = scalar("SELECT confirm_service_milestone(%s, 1::smallint)",
                 (bk_a,), user=svc1, settlement="on")
    r.check("svc_milestone_one_confirmed", out == "confirmed", out)
    out = scalar("SELECT confirm_service_milestone(%s, 2::smallint)",
                 (bk_a,), user=svc1, settlement="on")
    r.check("svc_last_milestone_completes", out == "completed", out)
    r.check("svc_completion_conservation",
            balance(wallets[svc2]) == 600_000
            and scalar("SELECT state FROM service_bookings"
                       " WHERE booking_id = %s", (bk_a,)) == "completed"
            and scalar("SELECT count(*) FROM service_events"
                       " WHERE booking_id = %s"
                       " AND to_state = 'milestone_confirmed'", (bk_a,)) == 1
            and scalar("SELECT count(*) FROM service_events"
                       " WHERE booking_id = %s AND to_state = 'completed'",
                       (bk_a,)) == 1)

    # Flow B: dispute mid-progress; a moderated refund returns the
    # remaining milestone and cancels the booking (below the four-eyes
    # threshold — resolves directly).
    rows = q("SELECT outcome, booking_id FROM book_service(%s, %s, %s::smallint)",
             (lst_svc, 400_000, 2), user=svc1, settlement="on")
    bk_b = str(rows[0][1])
    out = scalar("SELECT start_service(%s)", (bk_b,), user=svc2)
    r.check("svc_b_started", out == "started", out)
    out = scalar("SELECT confirm_service_milestone(%s, 1::smallint)",
                 (bk_b,), user=svc1, settlement="on")
    r.check("svc_b_milestone_one", out == "confirmed", out)
    out = scalar("SELECT dispute_service(%s)", (bk_b,), user=svc1)
    r.check("svc_b_disputed", out == "disputed", out)
    out = scalar("SELECT resolve_service(%s, 'refund')", (bk_b,),
                 user=mod1, moderator="on", settlement="on")
    r.check("svc_b_refund_resolved", out == "resolved", out)
    r.check("svc_b_refund_conservation",
            balance(wallets[svc2]) == 800_000
            and scalar("SELECT state FROM service_bookings"
                       " WHERE booking_id = %s", (bk_b,)) == "cancelled")

    # Flow C: above the four-eyes floor — the release request is recorded,
    # no value moves, the booking stays disputed; the second moderator's
    # approval resolves the booking identically (the b58 lesson).
    rows = q("SELECT outcome, booking_id FROM book_service(%s, %s, %s::smallint)",
             (lst_svc, 1_500_000, 1), user=svc1, settlement="on")
    bk_c = str(rows[0][1])
    out = scalar("SELECT dispute_service(%s)", (bk_c,), user=svc2)
    r.check("svc_c_disputed", out == "disputed", out)
    svc2_mid = balance(wallets[svc2])
    out = scalar("SELECT resolve_service(%s, 'release')", (bk_c,),
                 user=mod1, moderator="on", settlement="on")
    r.check("svc_c_four_eyes_gate", out == "approval_required", out)
    r.check("svc_c_no_value_on_gate",
            balance(wallets[svc2]) == svc2_mid
            and scalar("SELECT state FROM service_bookings"
                       " WHERE booking_id = %s", (bk_c,)) == "disputed")
    appr_svc = scalar("SELECT a.approval_id FROM escrow_resolve_approvals a"
                      " JOIN service_bookings b ON b.escrow_id = a.escrow_id"
                      " WHERE b.booking_id = %s AND a.state = 'pending'",
                      (bk_c,))
    r.check("svc_c_approval_recorded", appr_svc is not None)
    out = scalar("SELECT approve_escrow_resolution(%s)", (appr_svc,),
                 user=mod2, moderator="on", settlement="on")
    r.check("svc_c_second_pair_resolves", out == "resolved", out)
    r.check("svc_c_booking_propagated",
            scalar("SELECT state FROM service_bookings"
                   " WHERE booking_id = %s", (bk_c,)) == "completed"
            and scalar("SELECT completed_at IS NOT NULL"
                       " FROM service_bookings"
                       " WHERE booking_id = %s", (bk_c,)) is True
            and scalar("SELECT count(*) FROM service_events"
                       " WHERE booking_id = %s AND to_state = 'completed'"
                       " AND actor = %s", (bk_c, mod2)) == 1
            and balance(wallets[svc2]) == svc2_mid + 1_500_000)

    # Flow D: the ghosting clock — an accepted booking the provider never
    # starts auto-refunds at 168 h. Aging bypasses the row guards via the
    # replica role.
    svc1_before_d = balance(wallets[svc1])
    rows = q("SELECT outcome, booking_id FROM book_service(%s, %s, %s::smallint)",
             (lst_svc, 200_000, 1), user=svc1, settlement="on")
    bk_d = str(rows[0][1])
    conn.execute("SET session_replication_role = replica")
    conn.execute("UPDATE service_bookings"
                 "   SET created_at = now() - interval '169 hours'"
                 " WHERE booking_id = %s", (bk_d,))
    conn.execute("SET session_replication_role = DEFAULT")
    n = scalar("SELECT expire_stale_services()", (), settlement="on")
    r.check("svc_ghost_booking_expired", n == 1, str(n))
    r.check("svc_ghost_refund_walks_legal_path",
            scalar("SELECT state FROM service_bookings"
                   " WHERE booking_id = %s", (bk_d,)) == "cancelled"
            and scalar("SELECT e.state FROM escrow_agreements e"
                       " JOIN service_bookings b ON b.escrow_id = e.escrow_id"
                       " WHERE b.booking_id = %s", (bk_d,)) == "refunded"
            and scalar("SELECT h.state FROM wallet_holds h"
                       " JOIN escrow_agreements e ON e.hold_id = h.hold_id"
                       " JOIN service_bookings b ON b.escrow_id = e.escrow_id"
                       " WHERE b.booking_id = %s", (bk_d,)) == "voided"
            and balance(wallets[svc1]) == svc1_before_d)

    # Flow E: stalled work escalates — an in_progress booking with no
    # completion for 30 days moves to disputed, then moderation refunds.
    rows = q("SELECT outcome, booking_id FROM book_service(%s, %s, %s::smallint)",
             (lst_svc, 200_000, 1), user=svc1, settlement="on")
    bk_e = str(rows[0][1])
    out = scalar("SELECT start_service(%s)", (bk_e,), user=svc2)
    r.check("svc_e_started", out == "started", out)
    conn.execute("SET session_replication_role = replica")
    conn.execute("UPDATE service_bookings"
                 "   SET started_at = now() - interval '31 days'"
                 " WHERE booking_id = %s", (bk_e,))
    conn.execute("SET session_replication_role = DEFAULT")
    n = scalar("SELECT expire_stale_services()", (), settlement="on")
    r.check("svc_stale_work_escalates", n == 1, str(n))
    r.check("svc_e_disputed_by_clock",
            scalar("SELECT state FROM service_bookings"
                   " WHERE booking_id = %s", (bk_e,)) == "disputed")
    out = scalar("SELECT resolve_service(%s, 'refund')", (bk_e,),
                 user=mod1, moderator="on", settlement="on")
    r.check("svc_e_refunded", out == "resolved", out)

    # The expirer refuses to run with the settlement rail off (value moves
    # on the refund path), and the event log is append-only.
    try:
        scalar("SELECT expire_stale_services()")
        r.check("svc_expire_requires_settlement", False, "no exception")
    except Exception as exc:  # noqa: BLE001 — the expirer MUST raise
        r.check("svc_expire_requires_settlement",
                "AMD-SVC-04" in str(exc), str(exc)[:200])
    try:
        q("DELETE FROM service_events")
        r.check("svc_events_guard_blocks_delete", False, "no exception")
    except Exception as exc:  # noqa: BLE001 — the guard MUST raise
        r.check("svc_events_guard_blocks_delete",
                "AMD-SVC-05" in str(exc), str(exc)[:200])

    # AMD-SVC-05: the services surface joins the DSAR export and the
    # service dispute queue joins reconciliation.
    exp = scalar("SELECT dsar_export(%s)", (svc1,), user=svc1)
    r.check("svc_dsar_export",
            exp is not None and "services" in exp
            and len(exp["services"]) >= 5
            and all("role" in b and "counterparty" in b
                    for b in exp["services"]),
            str(exp)[:200])
    rec_svc = scalar("SELECT wallet_reconciliation()", (),
                     user=mod1, moderator="on")
    r.check("svc_reconciliation_keys",
            rec_svc is not None
            and all(k in rec_svc for k in (
                "openServiceDisputes", "oldestServiceDisputeSeconds",
                "stuckServices"))
            and rec_svc["openServiceDisputes"] == 0
            and rec_svc["stuckServices"] == 0,
            str(rec_svc)[:200])

    # AMD-SVC-01: `services` is the tenth catalogue vertical (sort 45) and
    # resolves through the vertical_enabled definer like every other.
    r.check("svc_vertical_catalogue_row",
            scalar("SELECT sort_order FROM vertical_catalogue"
                   " WHERE vertical = 'services'") == 45
            and scalar("SELECT count(*) FROM vertical_catalogue") == 10)
    r.check("svc_vertical_default_on",
            scalar("SELECT vertical_enabled('services')", (),
                   user=svc1) is True)
    out = scalar("SELECT set_user_verticals('{\"services\": false}'::jsonb,"
                 " 'settings')", (), user=svc1)
    r.check("svc_vertical_narrowed", out == "updated", out)
    r.check("svc_vertical_narrowed_resolves_off",
            scalar("SELECT vertical_enabled('services')", (),
                   user=svc1) is False)
    out = scalar("SELECT set_user_verticals('{\"services\": true}'::jsonb,"
                 " 'settings')", (), user=svc1)
    r.check("svc_vertical_restored", out == "updated", out)


    # ------------------------- phase 8e: stakeholder onboarding -----------
    # AMD-ONB-01..06: governed applications for the non-consumer kinds —
    # KYC-verified prerequisite, per-kind payload validation, four-eyes
    # moderation decisions with mandatory rejection reasons, venue
    # provisioning as a prospect with the venue_accounts binding and the
    # separate venue-ops activation, the consumer KYC review loop and the
    # stepper read model.
    onb_new = str(uuid.uuid4())
    q("INSERT INTO users (user_id, birth_year, kyc_state)"
      " VALUES (%s, 1992, 'pending')", (onb_new,))
    onb_app, onb_prov, onb_mod2 = mkuser(), mkuser(), mkuser()

    poly = json.dumps({"name": "Rooftop Lounge",
                       "polygon": [[3.37, 6.45], [3.38, 6.45],
                                   [3.38, 6.46], [3.37, 6.46]],
                       "statement": "We run a rooftop venue in Yaba."})
    out = scalar("SELECT outcome FROM submit_onboarding_application"
                 " ('venue_partner', %s::jsonb)", (poly,), user=onb_new)
    r.check("onb_unverified_refused", out == "kyc_required", out)
    rows = q("SELECT outcome, application_id FROM submit_onboarding_application"
             " ('venue_partner', %s::jsonb)", (poly,), user=onb_app)
    r.check("onb_submitted", rows[0][0] == "submitted", str(rows))
    onb_app_id = str(rows[0][1])
    rows = q("SELECT outcome, application_id FROM submit_onboarding_application"
             " ('venue_partner', %s::jsonb)", (poly,), user=onb_app)
    r.check("onb_resubmit_idempotent",
            rows[0][0] == "already_open" and str(rows[0][1]) == onb_app_id,
            str(rows))

    bad_poly = json.dumps({"name": "Rooftop Lounge",
                           "polygon": [[3.37, 6.45], [3.38, 6.45]],
                           "statement": "We run a rooftop venue in Yaba."})
    out = scalar("SELECT outcome FROM submit_onboarding_application"
                 " ('venue_partner', %s::jsonb)", (bad_poly,), user=onb_prov)
    r.check("onb_bad_polygon", out == "invalid_payload", out)
    bad_key = json.dumps({"termsVersion": "v1.0",
                          "statement": "I sell refurbished phones.",
                          "extra": True})
    out = scalar("SELECT outcome FROM submit_onboarding_application"
                 " ('provider', %s::jsonb)", (bad_key,), user=onb_prov)
    r.check("onb_bad_key_refused", out == "invalid_payload", out)
    bad_terms = json.dumps({"termsVersion": "1.0",
                            "statement": "I sell refurbished phones."})
    out = scalar("SELECT outcome FROM submit_onboarding_application"
                 " ('provider', %s::jsonb)", (bad_terms,), user=onb_prov)
    r.check("onb_bad_terms_refused", out == "invalid_payload", out)
    out = scalar("SELECT outcome FROM submit_onboarding_application"
                 " ('astrology', %s::jsonb)", (bad_terms,), user=onb_prov)
    r.check("onb_unknown_kind", out == "unknown_kind", out)

    out = scalar("SELECT outcome FROM decide_onboarding_application"
                 " (%s, 'approved', NULL)", (onb_app_id,), user=onb_app)
    r.check("onb_decide_needs_moderator", out == "forbidden", out)
    # Four-eyes: the applicant moderates but may never decide their own.
    rows = q("SELECT application_id FROM submit_onboarding_application"
             " ('provider', %s::jsonb)",
             (json.dumps({"termsVersion": "v1.0",
                          "statement": "I sell refurbished phones."}),),
             user=onb_mod2)
    onb_self_id = str(rows[0][0])
    out = scalar("SELECT outcome FROM decide_onboarding_application"
                 " (%s, 'approved', NULL)", (onb_self_id,),
                 user=onb_mod2, moderator="on")
    r.check("onb_four_eyes", out == "four_eyes", out)
    out = scalar("SELECT outcome FROM decide_onboarding_application"
                 " (%s, 'rejected', NULL)", (onb_app_id,),
                 user=mod1, moderator="on")
    r.check("onb_reject_needs_reason", out == "reason_required", out)
    out = scalar("SELECT outcome FROM decide_onboarding_application"
                 " (%s, 'rejected', %s)",
                 (onb_self_id, "The statement names no market presence."),
                 user=mod1, moderator="on")
    r.check("onb_rejected", out == "rejected", out)
    r.check("onb_rejection_reason_visible",
            scalar("SELECT decision_reason FROM onboarding_applications"
                   " WHERE application_id = %s", (onb_self_id,))
            == "The statement names no market presence.")

    # Venue approval provisions the prospect and binds the operator.
    rows = q("SELECT outcome, venue_id FROM decide_onboarding_application"
             " (%s, 'approved', NULL)", (onb_app_id,),
             user=mod1, moderator="on")
    r.check("onb_venue_approved", rows[0][0] == "approved", str(rows))
    onb_venue = str(rows[0][1])
    r.check("onb_venue_prospect",
            scalar("SELECT partner_status || ':' || active FROM venues"
                   " WHERE venue_id = %s", (onb_venue,)) == "prospect:false")
    r.check("onb_owner_bound",
            scalar("SELECT role FROM venue_accounts WHERE venue_id = %s"
                   " AND user_id = %s", (onb_venue, onb_app)) == "owner")
    r.check("onb_decided_immutable",
            scalar("SELECT outcome FROM decide_onboarding_application"
                   " (%s, 'approved', NULL)", (onb_app_id,),
                   user=mod2, moderator="on") == "not_pending")

    # The prospect goes live only through the separate venue-ops act.
    q("SELECT venue_activate(%s, %s)", (onb_venue, onb_mod2), venue_ops="on")
    r.check("onb_venue_live",
            scalar("SELECT partner_status || ':' || active FROM venues"
                   " WHERE venue_id = %s", (onb_venue,)) == "active:true")
    try:
        q("SELECT venue_activate(%s, %s)", (onb_venue, onb_mod2))
        r.check("onb_activate_twice_refused", False, "no exception")
    except Exception as exc:  # noqa: BLE001 — the definer MUST raise
        r.check("onb_activate_twice_refused",
                "venue is not a prospect" in str(exc), str(exc)[:200])

    # The consumer KYC loop: request, idempotency, worklist, decision
    # clears the stamp, re-request after rejection.
    out = scalar("SELECT request_kyc_review()", user=onb_new)
    r.check("onb_kyc_requested", out == "recorded", out)
    out = scalar("SELECT request_kyc_review()", user=onb_new)
    r.check("onb_kyc_request_idempotent", out == "already_requested", out)
    r.check("onb_kyc_queue_lists",
            scalar("SELECT count(*) FROM kyc_review_queue()",
                   (), moderator="on") == 1)
    out = scalar("SELECT record_kyc_decision(%s, 'mod1', 'rejected', NULL)",
                 (onb_new,), moderator="on")
    r.check("onb_kyc_rejected", out == "recorded", out)
    r.check("onb_kyc_stamp_cleared",
            scalar("SELECT kyc_review_requested_at IS NULL FROM users"
                   " WHERE user_id = %s", (onb_new,)) is True)
    out = scalar("SELECT request_kyc_review()", user=onb_new)
    r.check("onb_kyc_rerequest", out == "recorded", out)
    out = scalar("SELECT request_kyc_review()", user=onb_app)
    r.check("onb_kyc_verified_not_requestable", out == "not_requestable", out)
    # rejected -> pending -> verified is the legal re-review path.
    out = scalar("SELECT record_kyc_decision(%s, 'mod1', 'pending', NULL)",
                 (onb_new,), moderator="on")
    r.check("onb_kyc_back_to_pending", out == "recorded", out)
    r.check("onb_kyc_redecision_clears_stamp",
            scalar("SELECT kyc_review_requested_at IS NULL FROM users"
                   " WHERE user_id = %s", (onb_new,)) is True)
    out = scalar("SELECT record_kyc_decision(%s, 'mod1', 'verified', NULL)",
                 (onb_new,), moderator="on")
    r.check("onb_kyc_verified", out == "recorded", out)

    # The stepper: age -> kyc -> avatar -> verticals, then complete.
    doc = scalar("SELECT onboarding_status()", user=onb_new)
    r.check("onb_status_shape",
            doc is not None
            and doc["kycState"] == "verified"
            and doc["ageDeclared"] is False
            and doc["avatarSet"] is False
            and doc["verticalsChosen"] is False
            and doc["complete"] is False,
            str(doc))
    q("UPDATE users SET age_declared_at = now() WHERE user_id = %s", (onb_new,))
    q("INSERT INTO user_identities (user_id, handle, avatar_key,"
      " avatar_set_at) VALUES (%s, %s, 'sunrise', now())",
      (onb_new, "onb-" + onb_new[:8]))
    out = scalar("SELECT set_user_verticals(%s::jsonb, 'onboarding')",
                 (json.dumps({"venues": True}),), user=onb_new)
    r.check("onb_verticals_chosen", out == "updated", out)
    doc = scalar("SELECT onboarding_status()", user=onb_new)
    r.check("onb_complete", doc is not None and doc["complete"] is True,
            str(doc))

    # Withdrawal discipline and the offboard binding revocation.
    rows = q("SELECT application_id FROM submit_onboarding_application"
             " ('provider', %s::jsonb)",
             (json.dumps({"termsVersion": "v1.2",
                          "statement": "I tailor agbada in Surulere."}),),
             user=onb_prov)
    onb_prov_id = str(rows[0][0])
    out = scalar("SELECT withdraw_onboarding_application(%s)",
                 (onb_prov_id,), user=onb_app)
    r.check("onb_withdraw_other_refused", out == "forbidden", out)
    out = scalar("SELECT withdraw_onboarding_application(%s)",
                 (onb_prov_id,), user=onb_prov)
    r.check("onb_withdrawn", out == "withdrawn", out)
    out = scalar("SELECT withdraw_onboarding_application(%s)",
                 (onb_prov_id,), user=onb_prov)
    r.check("onb_withdraw_decided_refused", out == "not_pending", out)
    rows = q("SELECT application_id FROM submit_onboarding_application"
             " ('provider', %s::jsonb)",
             (json.dumps({"termsVersion": "v2.0",
                          "statement": "I repair generators in Ikeja."}),),
             user=onb_app)
    r.check("onb_second_application_opens", rows is not None and len(rows) == 1,
            str(rows))
    r.check("onb_queue_pending_first",
            scalar("SELECT status FROM onboarding_review_queue() LIMIT 1",
                   (), moderator="on") == "pending")
    q("SELECT venue_offboard(%s, %s)", (onb_venue, onb_mod2), venue_ops="on")
    r.check("onb_offboard_revokes_bindings",
            scalar("SELECT count(*) FROM venue_accounts WHERE venue_id = %s",
                   (onb_venue,)) == 0)
    r.check("onb_audit_trail",
            scalar("SELECT count(*) FROM admin_audit WHERE target_id IN"
                   " (%s, %s) AND action IN ('onboarding.submitted',"
                   " 'onboarding.approved', 'onboarding.rejected',"
                   " 'venue.provisioned', 'venue.activate',"
                   " 'venue.offboard', 'venue.bindings_revoked')",
                   (onb_app_id, onb_venue)) >= 5)
    rec = scalar("SELECT dsar_export(%s)", (onb_app,))
    r.check("onb_dsar_inclusion",
            rec is not None
            and "onboardingApplications" in rec
            and rec["onboardingApplications"][0]["kind"] == "venue_partner"
            and rec["onboardingApplications"][0]["status"] == "approved"
            and "kycReviewRequestedAt" in rec["user"],
            str(rec)[:200])

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

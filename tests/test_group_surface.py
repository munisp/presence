#!/usr/bin/env python3
"""FR-72/FR-73 acceptance criteria for the group surface, plus the SEC-34
no-fetch guarantee and the FR-75 enumeration restrictions.

These tests verify the boundaries that must hold no matter what the edge
code does: the data-layer cap and single-host triggers, the RLS policies on
every group table, the scoped directory, the booking primary key, and the
column-limited grants. Behavioural coverage of the route layer lives in
services/edge/test/groups.test.ts + links.test.ts; route/contract coverage
is enforced globally by test_openapi_contract.py.

Run: python3 -m pytest tests/test_group_surface.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db/migrations/0007_group_surface.sql").read_text()
TABLES_ROUTE = (ROOT / "services/edge/src/routes/tables.ts").read_text()
LINKS_ROUTE = (ROOT / "services/edge/src/routes/links.ts").read_text()
LINKS_LIB = (ROOT / "services/edge/src/links.ts").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()

GROUP_TABLES = [
    "group_tables",
    "group_table_members",
    "group_table_interests",
    "table_slots",
    "slot_bookings",
    "pair_links",
]


# ------------------------------------------------------------ FR-72 --------
# Table boundaries: six seats, one host, member-only everything.

def test_fr72_member_cap_trigger_enforces_six() -> None:
    assert "CREATE OR REPLACE FUNCTION group_table_member_cap()" in MIGRATION
    assert "FOR UPDATE" in MIGRATION, "cap check must lock the table row"
    assert re.search(r"n >= 6", MIGRATION), "cap must reject the seventh member"
    assert "SEC-33" in MIGRATION
    assert re.search(
        r"CREATE TRIGGER group_table_member_cap\s+BEFORE INSERT ON group_table_members",
        MIGRATION,
    )


def test_fr72_exactly_one_host_trigger() -> None:
    assert "CREATE OR REPLACE FUNCTION group_table_single_host()" in MIGRATION
    assert re.search(
        r"CREATE TRIGGER group_table_single_host\s+BEFORE INSERT OR UPDATE ON group_table_members",
        MIGRATION,
    )
    assert "role = 'host'" in MIGRATION


def test_fr72_rls_enabled_on_every_group_table() -> None:
    for table in GROUP_TABLES:
        assert re.search(
            rf"ALTER TABLE {table}\s+ENABLE ROW LEVEL SECURITY", MIGRATION
        ), f"RLS missing on {table}"


def test_fr72_member_only_visibility_policies() -> None:
    assert re.search(
        r"CREATE POLICY group_tables_member ON group_tables\s+FOR SELECT USING "
        r"\(is_group_member\(table_id, app_user\(\)\)\)",
        MIGRATION,
    )
    assert re.search(
        r"CREATE POLICY group_members_select ON group_table_members\s+FOR SELECT USING "
        r"\(is_group_member\(table_id, app_user\(\)\)\)",
        MIGRATION,
    )
    # Creation is self-scoped; host rows only via the creator helper.
    assert "WITH CHECK (created_by = app_user())" in MIGRATION
    assert "is_group_creator(table_id, app_user())" in MIGRATION


def test_fr72_directory_is_scoped_to_members_and_name_role_only() -> None:
    assert "CREATE OR REPLACE FUNCTION group_member_directory" in MIGRATION
    assert "SECURITY DEFINER" in MIGRATION
    body = MIGRATION.split("group_member_directory")[1].split("$$;")[0]
    assert "is_group_member" in body, "directory must reject non-members"
    assert "ui.handle" in body and "gm.role" in body
    assert "photo_url" not in body, "directory must not expose photos (FR-69/FR-74)"


def test_fr72_join_probe_reveals_only_open_tables() -> None:
    body = MIGRATION.split("group_join_info")[1].split("$$;")[0]
    assert "gt.state = 'open'" in body
    assert "member_count" in body and "venue_id" in body
    assert "created_by" not in body, "join probe must not expose the host"


def test_fr72_edge_table_list_is_membership_scoped() -> None:
    get_tables = TABLES_ROUTE.split('app.get(\n    "/v1/tables"')[1].split("app.get(")[0]
    assert "m.user_id = $1" in get_tables, "GET /v1/tables must filter by membership"
    assert "/v1/venues/{venueId}/tables" not in OPENAPI, "no venue-wide table listing (FR-75)"


def test_fr72_non_members_get_uniform_404() -> None:
    table_scoped = ["table not found", "slot not found"]
    for needle in table_scoped:
        assert needle in TABLES_ROUTE, f"missing uniform 404: {needle}"
    # every table-scoped GET/POST/DELETE answers 404 for non-members
    assert TABLES_ROUTE.count("404") >= 6


# ------------------------------------------------------------ FR-73 --------
# Booked slots: booking is the consent act; double-booking is impossible.

def test_fr73_booking_primary_key_caps_one_booking() -> None:
    assert re.search(
        r"slot_id\s+uuid PRIMARY KEY REFERENCES table_slots", MIGRATION
    ), "slot_bookings must key on slot_id — one booking per slot"


def test_fr73_slot_state_and_duration_constraints() -> None:
    assert re.search(r"CHECK \(state IN \('open','booked','cancelled'\)\)", MIGRATION)
    assert re.search(r"CHECK \(duration_minutes BETWEEN 5 AND 60\)", MIGRATION)


def test_fr73_booking_policies_scope_actor_and_visibility() -> None:
    insert = MIGRATION.split("CREATE POLICY bookings_insert_own")[1].split(";")[0]
    assert "booker = app_user()" in insert
    assert "ts.offerer <> app_user()" in insert, "cannot book your own slot"
    cancel = MIGRATION.split("CREATE POLICY bookings_cancel")[1].split(";")[0]
    assert "booker = app_user()" in cancel
    assert "ts.offerer = app_user()" in cancel


def test_fr73_grants_are_column_limited() -> None:
    assert "GRANT UPDATE (state) ON table_slots TO presence_app" in MIGRATION
    assert "GRANT UPDATE (cancelled_at) ON slot_bookings TO presence_app" in MIGRATION
    assert "GRANT UPDATE (state) ON group_tables TO presence_app" in MIGRATION
    assert not re.search(
        r"GRANT UPDATE ON table_slots", MIGRATION
    ), "slot rows must be immutable apart from state"


def test_fr73_book_route_uses_conditional_state_flip() -> None:
    assert "UPDATE table_slots SET state = 'booked' WHERE slot_id = $1 AND state = 'open'" in (
        TABLES_ROUTE
    ), "booking must flip state atomically — the race guard"
    book_route = TABLES_ROUTE.split('app.post(\n    "/v1/slots/:slotId/book"')[1]
    for code in ("404", "409", "410", "422"):
        assert code in book_route


def test_fr73_host_actions_are_audit_logged() -> None:
    assert "group.member.remove" in TABLES_ROUTE
    assert "group.table.close" in TABLES_ROUTE
    assert "host_discretion" in TABLES_ROUTE, "audit reason codes stay governed (FR-60)"


# ------------------------------------------------------------ SEC-34 -------
def test_sec34_server_never_fetches_shared_links() -> None:
    assert "fetch(" not in LINKS_ROUTE, "the link route must contain no network code"
    assert "https://" not in LINKS_ROUTE or "https://" in LINKS_ROUTE.split("parseSharedLink")[0]


def test_sec34_allowlist_and_https_only() -> None:
    assert re.search(r"CHECK \(url ~ '\^https://'", MIGRATION), "https-only at the data layer"
    assert "ALLOWED_LINK_DOMAINS" in LINKS_LIB
    assert 'parsed.protocol !== "https:"' in LINKS_LIB
    assert "interstitial: true" in LINKS_ROUTE, "responses carry the interstitial flag"


def test_sec34_link_is_counterpart_only() -> None:
    assert "owner <> $2" in LINKS_ROUTE, "GET must never return the caller's own link"
    assert 'm.rows[0].state !== "OPEN"' in LINKS_ROUTE, "the pair must be OPEN (FR-65)"

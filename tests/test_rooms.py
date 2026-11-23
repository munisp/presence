#!/usr/bin/env python3
"""FR-44/45/46 acceptance criteria for crowd-mode interest rooms.

Pins the invariants: rooms derive from live members' declared non-sensitive
interests via a SECURITY DEFINER aggregate (never raw profile rows through
the app role), the crowd-band transition, member-only content with uniform
404s, k-suppressed counts, the five-minute posting gate with first-note
screening, unattributed notes, and full ephemerality (Valkey TTLs only —
no room table in Postgres).

Behavioural coverage of the lib lives in services/edge/test/rooms.test.ts;
route/contract coverage is enforced globally by test_openapi_contract.py.

Run: python3 -m pytest tests/test_rooms.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db/migrations/0009_rooms.sql").read_text()
ROOMS_ROUTE = (ROOT / "services/edge/src/routes/rooms.ts").read_text()
ROOMS_LIB = (ROOT / "services/edge/src/rooms.ts").read_text()
SCAN_ROUTE = (ROOT / "services/edge/src/routes/scan.ts").read_text()
INTERESTS_ROUTE = (ROOT / "services/edge/src/routes/interests.ts").read_text()
APP = (ROOT / "services/edge/src/app.ts").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()


# ------------------------------------------------------------ FR-44 --------
# The crowd-mode transition and the room derivation.

def test_fr44_room_topics_aggregate_is_owner_side() -> None:
    fn = MIGRATION.split("CREATE OR REPLACE FUNCTION room_topics")[1].split("$$;")[0]
    assert "SECURITY DEFINER" in fn
    assert "FROM profile_interests" in fn
    assert "NOT tn.sensitive" in fn, "sensitive nodes never form rooms (TR-22)"
    assert "count(DISTINCT pi.user_id) >= 2" in fn, "a room of one is a spotlight"
    assert "REVOKE ALL ON FUNCTION room_topics(uuid[]) FROM PUBLIC" in MIGRATION
    assert "GRANT EXECUTE ON FUNCTION room_topics(uuid[]) TO presence_app" in MIGRATION


def test_fr44_transition_is_density_driven() -> None:
    route = ROOMS_ROUTE.split('"/v1/venues/:venueId/rooms"')[1].split("app.post")[0]
    assert "densityMode" in route
    assert 'mode !== "crowd"' in route
    assert "rooms: []" in route, "below the crowd band there are no rooms"
    helper = ROOMS_ROUTE.split("function densityMode")[1].split("}")[0]
    assert "BUDGET_CROWD_MIN_POP" in helper


def test_fr44_scan_announces_room_mode_in_crowd_band() -> None:
    assert 'mode: "rooms"' in SCAN_ROUTE
    assert "roomsUrl" in SCAN_ROUTE
    assert 'budget.band === "crowd"' in SCAN_ROUTE


def test_fr44_listing_requires_live_venue_presence() -> None:
    route = ROOMS_ROUTE.split('"/v1/venues/:venueId/rooms"')[1].split("app.post")[0]
    assert "sismember" in route
    assert "403" in route


def test_fr44_join_requires_crowd_presence_and_declaration() -> None:
    route = ROOMS_ROUTE.split('"/v1/rooms/:roomKey/join"')[1].split("app.get")[0]
    assert "BUDGET_CROWD_MIN_POP" in route, "a thinning crowd dissolves its rooms"
    assert "sismember" in route
    assert "withRls" in route, "the declaration check reads the caller's own row under RLS"
    assert "profile_interests" in route
    assert "422" in route


# ------------------------------------------------------------ FR-45 --------
# Content rules: topic, k-suppressed count, opted-in notes, member-only.

def test_fr45_member_only_content_with_uniform_404() -> None:
    get_room = ROOMS_ROUTE.split('app.get("/v1/rooms/:roomKey"')[1].split("app.post")[0]
    assert get_room.count('"room not found"') >= 2, "missing room and non-member must be indistinguishable"
    assert "sismember" in get_room


def test_fr45_count_is_k_suppressed() -> None:
    assert "kSuppressed" in ROOMS_ROUTE
    assert "K_MIN" in ROOMS_ROUTE


def test_fr45_notes_carry_no_author() -> None:
    # The stored note shape is noteId/body/at only — no user id anywhere in
    # the note path, so no one can be singled out of a room note.
    assert "interface RoomNote" in ROOMS_LIB
    shape = ROOMS_LIB.split("interface RoomNote")[1]
    assert "author" not in shape and "userId" not in shape and "user_id" not in shape
    post = ROOMS_ROUTE.split('"/v1/rooms/:roomKey/notes"')[1]
    note_ctor = post.split("const note: RoomNote")[1].split("};")[0]
    assert "req.userId" not in note_ctor


# ------------------------------------------------------------ FR-46 --------
# Posting discipline: 1 note/5 min/member, first note screened.

def test_fr46_five_minute_gate() -> None:
    route = ROOMS_ROUTE.split('"/v1/rooms/:roomKey/notes"')[1]
    assert "ROOM_NOTE_INTERVAL_S" in route
    assert '"NX"' in route, "the gate must be a set-if-absent, not a counter"
    assert "429" in route
    assert "room:rate:" in route


def test_fr46_first_note_is_screened() -> None:
    route = ROOMS_ROUTE.split('"/v1/rooms/:roomKey/notes"')[1]
    assert "screenText" in route
    assert "screeningErrorMessage" in route
    assert "room:screened:" in route, "later notes are not re-screened"


def test_fr46_notes_are_ephemeral_and_bounded() -> None:
    route = ROOMS_ROUTE.split('"/v1/rooms/:roomKey/notes"')[1]
    assert "ltrim" in route, "ring buffer"
    assert "ROOM_NOTES_MAX" in route
    assert route.count("ROOM_TTL_S") >= 2, "every artefact expires with presence"


# ------------------------------------------------------- ephemerality ------
# Rooms never persist: no room table may exist in any migration.

def test_rooms_have_no_postgres_table() -> None:
    for migration in (ROOT / "db/migrations").glob("*.sql"):
        text = migration.read_text()
        assert "CREATE TABLE rooms" not in text
        assert "CREATE TABLE room_notes" not in text
        assert "CREATE TABLE room_members" not in text


# ------------------------------------------------------------- FR-13 fix ---
# The popularity endpoint must aggregate owner-side, not through the RLS
# policy that hides every row but the caller's own.

def test_fr13_popularity_uses_owner_side_aggregate() -> None:
    assert "interest_popularity" in INTERESTS_ROUTE
    fn = MIGRATION.split("CREATE OR REPLACE FUNCTION interest_popularity")[1].split("$$;")[0]
    assert "SECURITY DEFINER" in fn
    assert "tc.ancestor_id = p_node" in fn, "descendants still count"
    assert "FROM profile_interests" not in INTERESTS_ROUTE, "raw profile reads must not go through the app role"


# ---------------------------------------------------------- registration ---

def test_room_routes_registered_in_app() -> None:
    assert 'from "./routes/rooms.js"' in APP
    assert "registerRoomRoutes(authed, ctx)" in APP


def test_openapi_covers_every_room_route() -> None:
    for path in [
        "/v1/venues/{venueId}/rooms",
        "/v1/rooms/{roomKey}/join",
        "/v1/rooms/{roomKey}",
        "/v1/rooms/{roomKey}/notes",
        "/v1/rooms/{roomKey}/leave",
    ]:
        assert f"  {path}:" in OPENAPI, f"openapi path missing: {path}"
    # The scan response documents the crowd transition.
    scan = OPENAPI.split("/v1/scan:")[1].split("/v1/consent:")[0]
    assert "roomsUrl" in scan


def test_every_room_key_has_presence_aligned_ttl() -> None:
    assert re.search(r"ROOM_TTL_S = 900", ROOMS_LIB), "aligned with the FR-16 session TTL"
    for fragment in ["room:meta:", "room:screened:", "room:${key}:notes", "room:${key}:members"]:
        assert fragment in ROOMS_ROUTE

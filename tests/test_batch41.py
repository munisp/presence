"""Batch 41 invariants — journey contracts and conversation surfaces.

The four remaining partial requirements close, and the conversation
surfaces land inside the shared skeleton:

  - journeyContracts.ts (FR-03, FR-08, FR-41, FR-48): account deletion
    in a pinned three-step journey ending at DELETE /v1/account with no
    support contact; the 3..20 interest mirror cross-pinned to
    profile.ts with the <=3-level first interaction and the FR-08/FR-11
    publish block (explain, offer the picker, fail closed); the 24-hour
    own-message revocation window cross-pinned to messages.ts with the
    pinned 410 sentence and the local-delete honesty note; and the
    venue check-in confidence ordering (higher than cell, FR-89
    fallback) tied to the FR-88 refusal alternative.
  - conversationThread.ts (FR-41, FR-84, FR-87): the chat thread —
    typing indicators and read receipts absent from the pinned
    affordance list and audited against the surface-integrity registry;
    the per-message revoke plan rendering the server's 410 sentence
    past the window; the first-message screening marker (FR-38/SEC-21);
    the close offer delegated to closeOffer.ts, never reimplemented.
  - roomBoard.ts (FR-45, FR-46): the RoomBoard in the skeleton's result
    region — k-suppressed crowd count (null below the threshold,
    cross-pinned to aggregate.ts K_MIN), notes only above the threshold
    and never carrying an author field, the one-note-per-five-minutes
    cadence mirrored from the rooms route, first note screened.
  - tableCard.ts (FR-66, FR-67): the TableCard — exactly time, place,
    head count and ONE generated prompt mirroring the buildCards
    contract (shared-minimum members, sorted, generated:true,
    cross-pinned to groups.ts); self-serve join while open with the
    FR-67 snapshot refresh, the seventh seat refused (SEC-33), and the
    FR-75 pre-join probe revealing only venue and headcount.

Every pin here fails loudly if a future change relaxes one of those
guarantees — module purity and import lists, the pinned constants and
sentences, the fail-closed behaviours, the cross-pins into the edge
service, and the reflection of the batch in the client README, the App
shell, the UX doc and the traceability matrix.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIENT_SRC = ROOT / "client" / "src" / "presence"
CLIENT_TEST = ROOT / "client" / "test"

JOURNEY_CONTRACTS_TS = (CLIENT_SRC / "journeyContracts.ts").read_text(encoding="utf-8")
CONVERSATION_THREAD_TS = (CLIENT_SRC / "conversationThread.ts").read_text(encoding="utf-8")
ROOM_BOARD_TS = (CLIENT_SRC / "roomBoard.ts").read_text(encoding="utf-8")
TABLE_CARD_TS = (CLIENT_SRC / "tableCard.ts").read_text(encoding="utf-8")
JOURNEY_CONTRACTS_TEST = (CLIENT_TEST / "journeyContracts.test.ts").read_text(encoding="utf-8")
CONVERSATION_THREAD_TEST = (CLIENT_TEST / "conversationThread.test.ts").read_text(encoding="utf-8")
ROOM_BOARD_TEST = (CLIENT_TEST / "roomBoard.test.ts").read_text(encoding="utf-8")
TABLE_CARD_TEST = (CLIENT_TEST / "tableCard.test.ts").read_text(encoding="utf-8")

PUBLISH_GATE_TS = (CLIENT_SRC / "publishGate.ts").read_text(encoding="utf-8")
EDGE_PROFILE_TS = (ROOT / "services" / "edge" / "src" / "profile.ts").read_text(encoding="utf-8")
EDGE_AGGREGATE_TS = (ROOT / "services" / "edge" / "src" / "aggregate.ts").read_text(encoding="utf-8")
EDGE_GROUPS_TS = (ROOT / "services" / "edge" / "src" / "groups.ts").read_text(encoding="utf-8")
EDGE_MESSAGES_TS = (ROOT / "services" / "edge" / "src" / "routes" / "messages.ts").read_text(encoding="utf-8")
EDGE_ROOMS_ROUTE_TS = (ROOT / "services" / "edge" / "src" / "routes" / "rooms.ts").read_text(encoding="utf-8")
EDGE_ROOMS_TS = (ROOT / "services" / "edge" / "src" / "rooms.ts").read_text(encoding="utf-8")
EDGE_TABLES_ROUTE_TS = (ROOT / "services" / "edge" / "src" / "routes" / "tables.ts").read_text(encoding="utf-8")
EDGE_CHECKIN_ROUTE_TS = (ROOT / "services" / "edge" / "src" / "routes" / "checkin.ts").read_text(encoding="utf-8")

README = (ROOT / "client" / "README.md").read_text(encoding="utf-8")
APP_TSX = (ROOT / "client" / "App.tsx").read_text(encoding="utf-8")
UX_DOC = (ROOT / "docs" / "ux" / "journeys-and-conversations.md").read_text(encoding="utf-8")
TRACEABILITY = (ROOT / "docs" / "traceability.md").read_text(encoding="utf-8")


def _imports(source: str) -> list[str]:
    return re.findall(r'from "(\./[^"]+)"', source)


# --------------------------------------------------------------- purity ---

def test_journey_contracts_imports() -> None:
    assert _imports(JOURNEY_CONTRACTS_TS) == [
        "./publishGate.js",
        "./constellationPicker.js",
    ]


def test_conversation_thread_imports() -> None:
    assert _imports(CONVERSATION_THREAD_TS) == [
        "./closeOffer.js",
        "./journeyContracts.js",
        "./surfaceIntegrity.js",
    ]


def test_room_board_imports() -> None:
    assert _imports(ROOM_BOARD_TS) == [
        "./discoverySkeleton.js",
        "./surfaceIntegrity.js",
    ]


def test_table_card_imports_only_the_registry() -> None:
    assert _imports(TABLE_CARD_TS) == ["./surfaceIntegrity.js"]


# ---------------------------------------------------------------- FR-03 ---

def test_fr03_journey_is_three_taps_inside_the_app() -> None:
    assert "ACCOUNT_DELETE_MAX_TAPS = 3;" in JOURNEY_CONTRACTS_TS
    for step in ('"open-settings"', '"open-account"', '"confirm-delete"'):
        assert step in JOURNEY_CONTRACTS_TS, step
    assert 'ACCOUNT_DELETE_ENDPOINT = "DELETE /v1/account"' in JOURNEY_CONTRACTS_TS
    assert "journey.length <= ACCOUNT_DELETE_MAX_TAPS" in JOURNEY_CONTRACTS_TS


def test_fr03_no_support_contact_proof() -> None:
    assert '.includes("support")' in JOURNEY_CONTRACTS_TS
    assert "journeyNeedsNoSupport" in JOURNEY_CONTRACTS_TS


# ---------------------------------------------------------------- FR-08 ---

def test_fr08_mirror_cross_pinned_to_profile_ts() -> None:
    assert "INTEREST_MIN_DECLARED = 3;" in JOURNEY_CONTRACTS_TS
    assert "INTEREST_MAX_DECLARED = 20;" in JOURNEY_CONTRACTS_TS
    assert "export const INTEREST_MIN = 3;" in EDGE_PROFILE_TS
    assert "export const INTEREST_MAX = 20;" in EDGE_PROFILE_TS


def test_fr08_first_interaction_depth_pinned() -> None:
    assert "TAXONOMY_FIRST_INTERACTION_MAX_DEPTH = 3;" in JOURNEY_CONTRACTS_TS
    assert "depth <= TAXONOMY_FIRST_INTERACTION_MAX_DEPTH" in JOURNEY_CONTRACTS_TS


def test_fr08_publish_block_explains_offers_picker_fails_closed() -> None:
    assert "INTERESTS_PUBLISH_BLOCK_SENTENCE" in JOURNEY_CONTRACTS_TS
    assert 'offer: "constellation-picker"' in JOURNEY_CONTRACTS_TS
    assert 'reason: "too-few-interests"' in JOURNEY_CONTRACTS_TS
    # The offered picker resolves the block inside its interaction budget.
    assert "readiness.missing <= MAX_PICKER_INTERACTIONS" in JOURNEY_CONTRACTS_TS


# ---------------------------------------------------------------- FR-41 ---

def test_fr41_window_cross_pinned_to_messages_route() -> None:
    assert "MESSAGE_REVOKE_WINDOW_MS = 24 * 60 * 60 * 1000;" in JOURNEY_CONTRACTS_TS
    assert "interval '24 hours'" in EDGE_MESSAGES_TS
    assert (
        'REVOKE_WINDOW_CLOSED_ERROR =\n  "the 24-hour revocation window has closed (FR-41)";'
        in JOURNEY_CONTRACTS_TS
    )
    assert "the 24-hour revocation window has closed (FR-41)" in EDGE_MESSAGES_TS


def test_fr41_revocation_is_own_only_and_fail_closed() -> None:
    assert "if (!message.own) return false;" in JOURNEY_CONTRACTS_TS
    assert "age >= 0 && age < MESSAGE_REVOKE_WINDOW_MS" in JOURNEY_CONTRACTS_TS


def test_fr41_local_delete_honesty_note() -> None:
    assert (
        '"Deleting removes this conversation from this device only."'
        in JOURNEY_CONTRACTS_TS
    )
    assert "deleteConversationLocally" in JOURNEY_CONTRACTS_TS


# ---------------------------------------------------------------- FR-48 ---

def test_fr48_confidence_ordering_and_refusal_tie() -> None:
    assert '"venue-checkin": 2,' in JOURNEY_CONTRACTS_TS
    assert "cell: 1," in JOURNEY_CONTRACTS_TS
    assert 'ACCURACY_REFUSAL_ALTERNATIVE === "venue-checkin"' in JOURNEY_CONTRACTS_TS
    assert 'export const ACCURACY_REFUSAL_ALTERNATIVE = "venue-checkin" as const;' in PUBLISH_GATE_TS


def test_fr48_checkin_journey_fails_closed_on_empty_code() -> None:
    assert 'VENUE_CHECKIN_ENDPOINT = "POST /v1/presence/checkin"' in JOURNEY_CONTRACTS_TS
    assert 'reason: "empty-code"' in JOURNEY_CONTRACTS_TS
    assert "attributesPresence: true" in JOURNEY_CONTRACTS_TS


def test_fr48_server_mints_and_verifies_signed_floor_tokens() -> None:
    # FR-99: the venue mints the displayable artefact (printed QR/NFC).
    assert "POST /v1/venues/:venueId/checkin-tokens" in EDGE_CHECKIN_ROUTE_TS
    assert "printed as the" in EDGE_CHECKIN_ROUTE_TS
    # FR-100: the user presents the token for attribution.
    assert "POST /v1/presence/checkin" in EDGE_CHECKIN_ROUTE_TS


# ----------------------------------------------------- conversationThread ---

def test_thread_affordances_ban_typing_indicators_and_read_receipts() -> None:
    for affordance in (
        '"send-message"',
        '"revoke-own-message"',
        '"answer-close-offer"',
        '"delete-local-copy"',
        '"leave-conversation"',
    ):
        assert affordance in CONVERSATION_THREAD_TS, affordance
    assert 'THREAD_AFFORDANCES.includes("typing-indicator" as never)' in CONVERSATION_THREAD_TS
    assert 'THREAD_AFFORDANCES.includes("read-receipt" as never)' in CONVERSATION_THREAD_TS


def test_thread_revoke_plan_mirrors_the_server() -> None:
    assert (
        'REVOKE_ENDPOINT_TEMPLATE =\n  "DELETE /v1/pairs/:pairId/messages/:messageId";'
        in CONVERSATION_THREAD_TS
    )
    assert 'reason: "window-closed"' in CONVERSATION_THREAD_TS
    assert 'reason: "not-own"' in CONVERSATION_THREAD_TS
    assert "REVOKE_WINDOW_CLOSED_ERROR" in CONVERSATION_THREAD_TS


def test_thread_first_message_screening_marker() -> None:
    assert "composeRequiresScreening" in CONVERSATION_THREAD_TS
    assert "sentCount === 0" in CONVERSATION_THREAD_TS


def test_thread_close_offer_is_delegated_not_reimplemented() -> None:
    assert "planCloseOffer(thread.closeOffer)" in CONVERSATION_THREAD_TS
    assert "applyCloseOfferDecision(action, thread.snapshot)" in CONVERSATION_THREAD_TS
    assert "COLOCATION_CLOSE_OFFER_MIN_MS" not in CONVERSATION_THREAD_TS.replace(
        "closeOffer.js", ""
    ), "the threshold lives in closeOffer.ts only"


def test_thread_descriptor_audited_against_the_registry() -> None:
    assert 'kind: "conversation-thread"' in CONVERSATION_THREAD_TS
    assert "honoursSurfaceProhibitions(threadDescriptor(thread))" in CONVERSATION_THREAD_TS
    assert 'deleteScope: "local-only"' in CONVERSATION_THREAD_TS


# ------------------------------------------------------------- roomBoard ---

def test_room_board_k_cross_pinned_to_aggregate() -> None:
    assert "ROOM_CROWD_K = 11;" in ROOM_BOARD_TS
    assert "export const K_MIN = 11;" in EDGE_AGGREGATE_TS


def test_room_board_mounts_in_the_skeleton_result_region() -> None:
    assert 'BOARD_REGION = "resultRegion" as const;' in ROOM_BOARD_TS
    assert "SKELETON_REGIONS.includes(BOARD_REGION)" in ROOM_BOARD_TS


def test_room_board_suppressed_count_renders_null() -> None:
    assert "if (snapshot.suppressed || snapshot.members === null) return null;" in ROOM_BOARD_TS
    assert "snapshot.members < snapshot.k" in ROOM_BOARD_TS


def test_room_board_notes_have_no_author_field() -> None:
    interface_body = re.search(
        r"export interface RoomBoardNote \{(.*?)\}", ROOM_BOARD_TS, re.DOTALL
    )
    assert interface_body is not None
    assert "author" not in interface_body.group(1)
    assert '("author" in note)' in ROOM_BOARD_TS


def test_room_board_notes_only_above_the_threshold() -> None:
    assert "if (renderCrowd(snapshot) === null) return [];" in ROOM_BOARD_TS
    assert "ROOM_NOTES_MAX_CLIENT = 50;" in ROOM_BOARD_TS
    assert "export const ROOM_NOTES_MAX = 50;" in EDGE_ROOMS_TS


def test_room_board_note_cadence_mirrors_the_route() -> None:
    assert "ROOM_NOTE_INTERVAL_MS = 5 * 60 * 1000;" in ROOM_BOARD_TS
    assert "nowMs - lastPostedAtMs >= ROOM_NOTE_INTERVAL_MS" in ROOM_BOARD_TS
    assert '"NX"' in EDGE_ROOMS_ROUTE_TS
    assert "noteRequiresScreening" in ROOM_BOARD_TS
    assert "notesPosted === 0" in ROOM_BOARD_TS


# ------------------------------------------------------------- tableCard ---

def test_table_card_field_set_pinned() -> None:
    fields_block = re.search(
        r"TABLE_CARD_FIELDS = \[(.*?)\] as const;", TABLE_CARD_TS, re.DOTALL
    )
    assert fields_block is not None
    for field in ('"time"', '"place"', '"headCount"', '"prompt"'):
        assert field in fields_block.group(1), field


def test_table_card_prompt_mirror_cross_pinned_to_groups() -> None:
    assert "TABLE_CARD_MIN_SHARED = 2;" in TABLE_CARD_TS
    assert "TABLE_CARD_LIMIT = 5;" in TABLE_CARD_TS
    assert "export const CARD_MIN_SHARED = 2;" in EDGE_GROUPS_TS
    assert "export const CARD_LIMIT = 5;" in EDGE_GROUPS_TS
    assert "generated: true" in TABLE_CARD_TS


def test_table_card_seat_cap_cross_pinned_to_sec33() -> None:
    assert "TABLE_SEAT_MAX = 6;" in TABLE_CARD_TS
    assert "the seventh join is refused (SEC-33)" in EDGE_TABLES_ROUTE_TS
    assert "seatedCount >= TABLE_SEAT_MAX" in TABLE_CARD_TS
    assert 'reason: "table-full"' in TABLE_CARD_TS
    assert 'reason: "table-closed"' in TABLE_CARD_TS


def test_table_card_join_refreshes_the_snapshot() -> None:
    assert "refreshesSnapshot: true" in TABLE_CARD_TS


def test_table_card_probe_reveals_only_venue_and_headcount() -> None:
    probe_block = re.search(
        r"PROBE_FIELDS = \[(.*?)\] as const;", TABLE_CARD_TS, re.DOTALL
    )
    assert probe_block is not None
    assert '"venue"' in probe_block.group(1)
    assert '"headCount"' in probe_block.group(1)
    assert "keys.length === PROBE_FIELDS.length" in TABLE_CARD_TS


# ----------------------------------------------------------- client tests ---

def test_client_suites_exist_and_pin_the_contracts() -> None:
    for body, needle in (
        (JOURNEY_CONTRACTS_TEST, "ACCOUNT_DELETE_MAX_TAPS, 3"),
        (JOURNEY_CONTRACTS_TEST, "the 24-hour revocation window has closed (FR-41)"),
        (JOURNEY_CONTRACTS_TEST, "preferredPresenceSource"),
        (CONVERSATION_THREAD_TEST, "typingAndReceiptsBanned"),
        (CONVERSATION_THREAD_TEST, "DELETE /v1/pairs/pair-1/messages/m1"),
        (CONVERSATION_THREAD_TEST, "composeRequiresScreening"),
        (ROOM_BOARD_TEST, "ROOM_CROWD_K, 11"),
        (ROOM_BOARD_TEST, "roomBoardNoteHasNoAuthor"),
        (ROOM_BOARD_TEST, "below the threshold there are no notes"),
        (TABLE_CARD_TEST, "the seventh join is refused"),
        (TABLE_CARD_TEST, "probeRevealsOnlyVenueAndHeadcount"),
        (TABLE_CARD_TEST, "an unsorted member list is refused"),
    ):
        assert needle in body, needle


# -------------------------------------------------------------- reflection ---

def test_readme_maps_the_four_modules() -> None:
    for module, requirement in (
        ("journeyContracts.ts", "FR-03"),
        ("journeyContracts.ts", "FR-48"),
        ("conversationThread.ts", "FR-87"),
        ("roomBoard.ts", "FR-45"),
        ("tableCard.ts", "FR-66"),
    ):
        assert module in README, module
        row = next(line for line in README.splitlines() if module in line)
        assert requirement in row, (module, requirement)


def test_app_shell_reflects_the_batch() -> None:
    for import_name in (
        "checkinHonoursFr48",
        "presenceReadiness",
        "planAccountDelete",
        "threadHonoursFr87",
        "roomBoardHonoursFr87",
        "planJoin",
        "tableCardHonoursFr87",
    ):
        assert import_name in APP_TSX, import_name


def test_ux_doc_maps_components_to_requirements() -> None:
    for component in (
        "journey contracts",
        "conversation thread",
        "RoomBoard",
        "TableCard",
    ):
        assert component in UX_DOC, component
    for requirement in (
        "FR-03",
        "FR-08",
        "FR-41",
        "FR-48",
        "FR-45",
        "FR-66",
        "FR-67",
        "FR-87",
    ):
        assert requirement in UX_DOC, requirement


# ----------------------------------------------------------- traceability ---

def test_traceability_reclassifies_the_batch() -> None:
    for requirement in ("FR-03", "FR-08", "FR-41", "FR-48"):
        match = re.search(rf"\| {requirement} \| ([^|]+) \|", TRACEABILITY)
        assert match is not None, requirement
        assert match.group(1).strip() == "implemented", requirement


def test_traceability_counts_after_batch_43() -> None:
    # Batch 42: NFR-36 + TECH-16 client → implemented,
    # NFR-04/05/29/30/35 client → partial: 223 → 225, 3 → 8, 14 → 7.
    # Batch 43: FR-70 + NFR-25/26/37 client → implemented: 225 → 229, 8 → 8, 7 → 3.
    # Batch 44: NFR-27 + NFR-28 client → implemented: 229 → 231, 8 → 8, 3 → 1.
    # Batch 45: TECH-08 client → implemented: 231 → 232, 8 → 8, 1 → 0.
    assert "| implemented | 232 |" in TRACEABILITY
    assert "| partial | 8 |" in TRACEABILITY
    assert "| client | 0 |" in TRACEABILITY

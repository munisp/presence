"""AMD-VERT-01..05: vertical feature flags — Python reference mirror.

The SQL catalogue (db/migrations/0034_vertical_flags.sql) is the source of
truth; services/edge/src/verticals.ts is the edge gate; this module is the
Python reference the batch-59 pytest suite pins against, alongside the Go
(services/presence-go/verticals.go) and Rust
(services/match-core/src/verticals.rs) mirrors. All five carry the same
nine keys, the same order, the same locked core and the same gates.
"""

from __future__ import annotations

VERTICALS: tuple[str, ...] = (
    "discovery",
    "venues",
    "groups",
    "dating",
    "marketplace",
    "payments",
    "trust",
    "introductions",
    "serendipity",
)

LOCKED_VERTICAL = "discovery"

# Mirrors of the seeded vertical_catalogue rows, in sort order:
# (vertical, locked, requires_kyc, requires_adult, default_enabled,
#  sort_order).
CATALOGUE: tuple[tuple[str, bool, bool, bool, bool, int], ...] = (
    ("discovery", True, False, False, True, 0),
    ("venues", False, False, False, True, 10),
    ("groups", False, True, False, True, 20),
    ("dating", False, True, True, True, 30),
    ("marketplace", False, True, False, True, 40),
    ("payments", False, True, False, True, 50),
    ("trust", False, True, False, True, 60),
    ("introductions", False, True, False, True, 70),
    ("serendipity", False, False, False, True, 80),
)

_CATALOGUE_BY_KEY = {row[0]: row for row in CATALOGUE}


def vertical_enabled(vertical: str, explicit: bool | None = None) -> bool:
    """Mirror of the vertical_enabled definer: the locked core is always
    on; an explicit row wins; otherwise the catalogue default. Unknown
    verticals fail closed. `explicit` is None when the user holds no row."""
    row = _CATALOGUE_BY_KEY.get(vertical)
    if row is None:
        return False
    _, locked, _, _, default_enabled, _ = row
    if locked:
        return True
    return default_enabled if explicit is None else explicit


# Ordered route-template rules: segment-boundary prefixes. /v1/moderation/*
# is deliberately absent — moderation surfaces answer to workforce roles,
# not to consumer flags.
_TEMPLATE_RULES: tuple[tuple[str, str], ...] = (
    ("/v1/rooms", "venues"),
    ("/v1/tables", "venues"),
    ("/v1/slots", "venues"),
    ("/v1/announcements", "venues"),
    ("/v1/presence/checkin", "venues"),
    ("/v1/groups", "groups"),
    ("/v1/dating", "dating"),
    ("/v1/marketplace", "marketplace"),
    ("/v1/transfers", "payments"),
    ("/v1/wallets", "payments"),
    ("/v1/presence/bond", "trust"),
    ("/v1/met-receipts", "trust"),
    ("/v1/escrows", "trust"),
    ("/v1/disclosure-grants", "trust"),
    ("/v1/attestation", "trust"),
    ("/v1/introductions", "introductions"),
    ("/v1/serendipity", "serendipity"),
)


def _segment_prefix_match(template: str, prefix: str) -> bool:
    return template == prefix or template.startswith(prefix + "/")


def vertical_for_template(template: str) -> str | None:
    """Resolve the vertical a route template belongs to, or None when the
    template is ungated (account, consent, profile, moderation, taxonomy,
    telemetry and ops surfaces stay open)."""
    if template.startswith("/v1/venues/"):
        rest = template[len("/v1/venues/"):]
        if "/" in rest:
            tail = rest.split("/", 1)[1]
            if tail == "rooms" or tail.startswith("rooms/"):
                return "venues"
        return None
    for prefix, vertical in _TEMPLATE_RULES:
        if _segment_prefix_match(template, prefix):
            return vertical
    return None

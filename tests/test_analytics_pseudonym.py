"""SEC-16: pseudonymisation contract tests."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from analytics import pseudonym
from analytics.pseudonym import K_MIN, k_suppress, monthly_salt, pseudonym as pseudo

ROOT = Path(__file__).resolve().parent.parent
AT = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)


def test_k_min_matches_edge_aggregate():
    """The k floor is one governed constant, shared with the operational
    store — pinned against services/edge/src/aggregate.ts so the two cannot
    drift."""
    src = (ROOT / "services" / "edge" / "src" / "aggregate.ts").read_text()
    m = re.search(r"K_MIN\s*=\s*(\d+)", src)
    assert m, "K_MIN not found in aggregate.ts"
    assert int(m.group(1)) == K_MIN == 11


def test_deterministic_within_month():
    a = pseudo("user-1", AT, "key")
    b = pseudo("user-1", datetime(2026, 11, 30, 23, 59, tzinfo=timezone.utc), "key")
    assert a == b
    assert re.fullmatch(r"[0-9a-f]{64}", a)


def test_rotates_monthly():
    """The salt rotates every calendar month: the same account is
    uncorrelatable across months."""
    nov = pseudo("user-1", datetime(2026, 11, 30, 23, 59, tzinfo=timezone.utc), "key")
    dec = pseudo("user-1", datetime(2026, 12, 1, 0, 0, tzinfo=timezone.utc), "key")
    assert nov != dec


def test_keyed_not_plain_hash():
    """The pseudonym is keyed — an unkeyed sha256 of the account id must not
    reproduce it."""
    import hashlib

    assert pseudo("user-1", AT, "key") != hashlib.sha256(b"user-1").hexdigest()
    assert pseudo("user-1", AT, "key") != pseudo("user-1", AT, "other-key")


def test_distinct_accounts_distinct_pseudonyms():
    assert pseudo("user-1", AT, "key") != pseudo("user-2", AT, "key")


def test_naive_datetime_treated_as_utc():
    assert monthly_salt(pseudonym.month_of(AT)) == monthly_salt("2026-11")
    naive = datetime(2026, 11, 24, 12, 0)
    assert pseudonym.month_of(naive) == "2026-11"


def test_month_format_validated():
    with pytest.raises(ValueError):
        monthly_salt("2026-1")


def test_k_suppress_boundary():
    assert k_suppress(10) is None
    assert k_suppress(11) == 11
    assert k_suppress(11, k=12) is None

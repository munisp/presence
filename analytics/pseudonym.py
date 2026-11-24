"""SEC-16: pseudonymisation and k-floor suppression for the analytics pipeline.

Direct identifiers never enter the lakehouse (FR-61). Where an event stream
needs an actor dimension at all, the production-side extractor substitutes a
pseudonym: HMAC-SHA256 over the account id, keyed by a salt that rotates every
calendar month (ARC-002 §6.1 silver layer: "identifiers pseudonymised with a
rotating salt").

Monthly rotation is deliberate: it makes cross-month correlation of a single
pseudonym impossible, so longitudinal analysis can only happen at aggregate
level — which is exactly what SEC-16 permits. Within one month the pseudonym
is deterministic, so sessionisation and funnel counts work.

The k floor is shared with the operational store: K_MIN = 11, the same
constant as services/edge/src/aggregate.ts (BR-13). A pytest pin reads the
TypeScript source so the two cannot drift.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from datetime import datetime, timezone

K_MIN = 11  # BR-13 / SEC-16 — pinned to services/edge/src/aggregate.ts by test

KEY_ENV = "ANALYTICS_PSEUDONYM_KEY"
DEV_DEFAULT_KEY = "p1-dev-analytics-key-change-me"


def _key(key: str | None = None) -> bytes:
    return (key if key is not None else os.environ.get(KEY_ENV, DEV_DEFAULT_KEY)).encode()


def month_of(occurred_at: datetime) -> str:
    """Calendar month (UTC) an event belongs to — the salt rotation epoch."""
    if occurred_at.tzinfo is None:
        occurred_at = occurred_at.replace(tzinfo=timezone.utc)
    return occurred_at.astimezone(timezone.utc).strftime("%Y-%m")


def monthly_salt(month: str, key: str | None = None) -> bytes:
    """The rotating salt for one calendar month (YYYY-MM)."""
    if len(month) != 7 or month[4] != "-":
        raise ValueError("month must be YYYY-MM")
    return hmac.new(_key(key), f"analytics-salt:{month}".encode(), hashlib.sha256).digest()


def pseudonym(account_id: str, occurred_at: datetime, key: str | None = None) -> str:
    """Pseudonymous actor dimension for one event: deterministic within the
    event's calendar month, uncorrelatable across months."""
    salt = monthly_salt(month_of(occurred_at), key)
    return hmac.new(salt, account_id.encode(), hashlib.sha256).hexdigest()


def k_suppress(count: int, k: int = K_MIN) -> int | None:
    """SEC-16: no aggregate may expose a cell-level count below the k floor.
    Mirrors kSuppressed in services/edge/src/aggregate.ts."""
    return count if count >= k else None

"""OpenKYC — the in-house verification provider (SRS Addendum 001,
AMD-KYC-06..10).

An open-source KYC pipeline composing PaddleOCR (text), Docling (layout /
structure) and a VLM (semantic authenticity) behind one conformance
interface, plus deterministic reference engines for CI (the b16
ngram-hash embedder discipline: real engines behind lazy imports,
reference engines golden-pinned).

The service NEVER writes OLTP (ADR-0009) and NEVER persists a capture:
frames are processed in memory, purged before the verdict callback, and
the purge receipt lands in kyc_session_events as 'capture_purged'
(AMD-KYC-10). The verdict carries derived facts only (AMD-KYC-02/08).
"""

from .liveness import (
    ACTION_WINDOW_MS,
    CHALLENGE_ACTIONS,
    CHALLENGE_COUNT,
    LIVENESS_WEIGHTS,
    challenge_digest,
    verify_challenge_token,
    fuse_liveness,
)
from .pipeline import (
    ACCEPT_MIN,
    REVIEW_FLOOR,
    SESSION_TTL_SECONDS,
    Verdict,
    verdict_payload_fields,
    verify_capture,
)

__all__ = [
    "ACTION_WINDOW_MS",
    "CHALLENGE_ACTIONS",
    "CHALLENGE_COUNT",
    "LIVENESS_WEIGHTS",
    "ACCEPT_MIN",
    "REVIEW_FLOOR",
    "SESSION_TTL_SECONDS",
    "Verdict",
    "challenge_digest",
    "verify_challenge_token",
    "fuse_liveness",
    "verdict_payload_fields",
    "verify_capture",
]

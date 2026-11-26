"""AMD-KYC-07: next-generation liveness.

The challenge protocol (mirrored by services/edge/src/kycVerification.ts
and client/src/presence/kycCapture.ts — cross-pinned in
tests/test_batch63.py):

  * the edge issues 3 of the 5 actions, shuffled, each with a
    ACTION_WINDOW_MS window, and pins sha256(canonical challenge JSON)
    in kyc_sessions.challenge_digest;
  * the member performs the actions on an ATTESTED device (FR-51) while
    the client captures a short frame burst per action;
  * the upload carries the performed challenge; the pipeline recomputes
    the digest — a mismatch means the frames answer a challenge the
    platform never issued.

Six-signal fusion (weights pinned; sum == 1.0):

  challenge_response  0.30  actions performed, in order, in window
  rppg                0.20  remote photoplethysmography — a live pulse
                            modulates skin reflectance; a screen or a
                            print has none
  moire               0.15  screen-replay texture (moire / pixel-grid
                            aliasing) must be ABSENT
  depth               0.15  specular / parallax depth heuristics over
                            the head-turn frames
  rigidity            0.10  3-D motion consistency across the sequence
                            (a photo bends wrong)
  injection           0.10  capture-channel integrity — the burst must
                            arrive from the attested camera path, not a
                            virtual-camera injection

Reference scoring is deterministic (sha256-derived, CI); real scoring
comes from the engine adapters. Either way the fusion is the same.
"""

from __future__ import annotations

import hashlib
import hmac
import json

CHALLENGE_ACTIONS = ("blink", "turn_left", "turn_right", "smile", "nod")
CHALLENGE_COUNT = 3
ACTION_WINDOW_MS = 4000
SESSION_TTL_SECONDS = 600
SESSION_TTL_MIN_SECONDS = 60
SESSION_TTL_MAX_SECONDS = 900

LIVENESS_SIGNALS = (
    "challenge_response",
    "rppg",
    "moire",
    "depth",
    "rigidity",
    "injection",
)
LIVENESS_WEIGHTS = {
    "challenge_response": 0.30,
    "rppg": 0.20,
    "moire": 0.15,
    "depth": 0.15,
    "rigidity": 0.10,
    "injection": 0.10,
}
assert abs(sum(LIVENESS_WEIGHTS.values()) - 1.0) < 1e-9
assert set(LIVENESS_WEIGHTS) == set(LIVENESS_SIGNALS)


def canonical_challenge(challenge: list[dict]) -> str:
    """Canonical wire form: compact JSON, keys sorted — the digest both
    sides pin is over THIS string."""
    return json.dumps(challenge, sort_keys=True, separators=(",", ":"))


def challenge_digest(challenge: list[dict]) -> str:
    return hashlib.sha256(canonical_challenge(challenge).encode("utf8")).hexdigest()


def challenge_well_formed(challenge: object) -> bool:
    """3 distinct known actions, each with a positive in-window budget."""
    if not isinstance(challenge, list) or len(challenge) != CHALLENGE_COUNT:
        return False
    actions: list[str] = []
    for step in challenge:
        if not isinstance(step, dict) or set(step) != {"action", "windowMs"}:
            return False
        if step["action"] not in CHALLENGE_ACTIONS:
            return False
        if not isinstance(step["windowMs"], int) or not (500 <= step["windowMs"] <= ACTION_WINDOW_MS):
            return False
        actions.append(step["action"])
    return len(set(actions)) == CHALLENGE_COUNT


def verify_challenge_token(
    secret: str, session_id: str, challenge: list[dict], expires_at_epoch: int, token: str
) -> bool:
    """The single-use upload token: HMAC over session:digest:expiry —
    the edge signs at issue, the pipeline verifies before reading a
    frame. Constant-time compare; malformed input refuses."""
    if not isinstance(token, str) or len(token) != 64:
        return False
    payload = f"{session_id}:{challenge_digest(challenge)}:{expires_at_epoch}"
    expected = hmac.new(secret.encode("utf8"), payload.encode("utf8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, token.lower())


def fuse_liveness(signals: dict[str, float]) -> float:
    """Weighted fusion; every signal must be present and in [0, 1]."""
    if set(signals) != set(LIVENESS_SIGNALS):
        raise ValueError("liveness fusion needs exactly the six pinned signals")
    total = 0.0
    for name, weight in LIVENESS_WEIGHTS.items():
        value = signals[name]
        if not (0.0 <= value <= 1.0):
            raise ValueError(f"signal {name} out of range")
        total += weight * value
    return round(total, 4)


def reference_signals(frame_blobs: list[bytes], challenge: list[dict]) -> dict[str, float]:
    """Deterministic reference scorer (CI / rehearsal). Real captures are
    scored by the engine adapters; here every signal derives from the
    frame bytes so golden tests are byte-stable. A frame burst starting
    with b'OKVEC:' is a test vector — its JSON payload steers the
    signals explicitly (same idea as the golden embedder fixtures)."""
    if frame_blobs and frame_blobs[0].startswith(b"OKVEC:"):
        vector = json.loads(frame_blobs[0][len(b"OKVEC:"):].decode("utf8"))
        return {name: float(vector["liveness"][name]) for name in LIVENESS_SIGNALS}
    seed = hashlib.sha256(b"".join(frame_blobs) + canonical_challenge(challenge).encode("utf8"))
    digest = seed.digest()
    signals: dict[str, float] = {}
    for index, name in enumerate(LIVENESS_SIGNALS):
        # Map two digest bytes into [0, 1] with a mid bias — reference
        # captures score as plausible-but-not-perfect.
        raw = int.from_bytes(digest[index * 2 : index * 2 + 2], "big") / 65535.0
        signals[name] = round(0.35 + 0.5 * raw, 4)
    return signals

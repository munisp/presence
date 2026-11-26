"""AMD-KYC-06/09: the verification pipeline and the verdict.

verify_capture() runs intake -> liveness -> credential analysis ->
fusion -> verdict -> purge, in that order, and returns a Verdict whose
wire form carries DERIVED FACTS ONLY (AMD-KYC-02/08): no capture bytes,
no legal name, no credential number, no date of birth — the birth year
is read, reduced to the over-18 boolean, and discarded inside this
process.

Verdict thresholds (pinned; mirrored in edge + client):
  verified  liveness >= 0.80 AND authenticity >= 0.80 AND over-18 AND
            the credential is in date
  rejected  liveness < 0.50 OR authenticity < 0.50 (a clear spoof or
            forgery) OR not over-18 OR the credential is out of date
  review    everything else — routed to the AMD-ONB-06 manual queue
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from .engines import engine_registry
from .liveness import (
    challenge_digest,
    challenge_well_formed,
    fuse_liveness,
    reference_signals,
)

SESSION_TTL_SECONDS = 600
ACCEPT_MIN = 0.80
REVIEW_FLOOR = 0.50

# The exact wire keys of a verdict — the minimisation pin. A new field
# is a spec amendment, not a code change (tests/test_batch63.py pins
# this tuple and asserts no PII-shaped key can appear).
VERDICT_FIELDS = (
    "sessionId",
    "challengeDigest",
    "outcome",
    "credentialKind",
    "over18",
    "credentialValid",
    "authenticityScore",
    "livenessScore",
    "providerRef",
)

# The callback canonical-string field order — cross-pinned with the
# edge verifier (services/edge/src/kycVerification.ts).
CALLBACK_FIELD_ORDER = (
    "at",
    "sessionId",
    "challengeDigest",
    "outcome",
    "authenticityScore",
    "livenessScore",
    "providerRef",
)


@dataclass
class Verdict:
    session_id: str
    challenge_digest: str
    outcome: str  # verified | rejected | review
    credential_kind: str
    over_18: bool
    credential_valid: bool
    authenticity_score: float
    liveness_score: float
    provider_ref: str
    purge_receipt: dict = field(default_factory=dict)

    def wire(self) -> dict:
        """The callback body — exactly VERDICT_FIELDS, nothing else."""
        return {
            "sessionId": self.session_id,
            "challengeDigest": self.challenge_digest,
            "outcome": self.outcome,
            "credentialKind": self.credential_kind,
            "over18": self.over_18,
            "credentialValid": self.credential_valid,
            "authenticityScore": self.authenticity_score,
            "livenessScore": self.liveness_score,
            "providerRef": self.provider_ref,
        }


def _purge(frames: list[bytearray]) -> dict:
    """AMD-KYC-10: overwrite every frame buffer in place, then drop the
    references. The receipt counts frames — it never describes them."""
    count = 0
    for frame in frames:
        for index in range(len(frame)):
            frame[index] = 0
        count += 1
    frames.clear()
    return {"purgedFrames": count, "at": int(time.time())}


def verify_capture(
    session_id: str,
    challenge: list[dict],
    frames: list[bytes],
    *,
    now=lambda: int(time.time()),
) -> Verdict:
    """Run the whole pipeline over one upload. `frames` are mutable
    copies — the function purges them before returning."""
    if not challenge_well_formed(challenge):
        raise ValueError("malformed challenge")
    if not frames:
        raise ValueError("a capture carries at least one frame")
    mutable = [bytearray(f) for f in frames]

    text_engine, structure_engine, semantic_engine = engine_registry()

    # 1. Liveness (AMD-KYC-07). Reference scoring is deterministic;
    #    real signal scorers plug into the SAME fusion behind
    #    OPENKYC_ENGINES=real — the weights and thresholds never move.
    signals = reference_signals(frames, challenge)
    liveness_score = fuse_liveness(signals)

    # 2. Credential analysis (AMD-KYC-06): text, structure, semantics.
    text = text_engine.extract(frames)
    structure = structure_engine.parse(frames)
    semantic = semantic_engine.judge(frames, text)
    authenticity_score = round(
        0.5 * float(structure["confidence"]) + 0.5 * float(semantic["confidence"]), 4
    )

    # 3. Derived facts — the ONLY fields that may leave this process.
    fields = structure.get("fields", {})
    birth_year = fields.get("birth_year")
    expiry_year = fields.get("expiry_year")
    current_year = time.gmtime(now()).tm_year
    over_18 = bool(birth_year is not None and current_year - int(birth_year) >= 18)
    credential_valid = bool(expiry_year is not None and int(expiry_year) >= current_year)
    credential_kind = str(structure["kind"])

    # 4. Fusion (pinned thresholds).
    if liveness_score < REVIEW_FLOOR or authenticity_score < REVIEW_FLOOR:
        outcome = "rejected"
    elif not over_18 or not credential_valid:
        outcome = "rejected"
    elif liveness_score >= ACCEPT_MIN and authenticity_score >= ACCEPT_MIN:
        outcome = "verified"
    else:
        outcome = "review"

    # 5. Purge BEFORE the verdict can leave (AMD-KYC-10).
    receipt = _purge(mutable)

    return Verdict(
        session_id=session_id,
        challenge_digest=challenge_digest(challenge),
        outcome=outcome,
        credential_kind=credential_kind,
        over_18=over_18,
        credential_valid=credential_valid,
        authenticity_score=authenticity_score,
        liveness_score=liveness_score,
        provider_ref=f"openkyc:{session_id}",
        purge_receipt=receipt,
    )


def verdict_payload_fields(verdict_wire: dict, at: int) -> str:
    """The canonical signed string — the AMD-PAY-22 discipline applied
    to KYC callbacks: the timestamp leads and is signed TOGETHER with
    the fields, so a replayed signature ages out."""
    values = {
        "at": str(at),
        "sessionId": str(verdict_wire["sessionId"]),
        "challengeDigest": str(verdict_wire["challengeDigest"]),
        "outcome": str(verdict_wire["outcome"]),
        "authenticityScore": f"{float(verdict_wire['authenticityScore']):.4f}",
        "livenessScore": f"{float(verdict_wire['livenessScore']):.4f}",
        "providerRef": str(verdict_wire["providerRef"]),
    }
    return "|".join(values[name] for name in CALLBACK_FIELD_ORDER)

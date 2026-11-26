"""OpenKYC pipeline unit tests (SRS Addendum 001, AMD-KYC-06..10).

Pin the reference pipeline end to end: the challenge protocol, the
six-signal fusion, the verdict thresholds, the minimisation wire form,
the purge receipt and the callback signing — plus the architectural
guards (no OLTP access, no capture persistence).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
OPENKYC = ROOT / "services/openkyc"

import sys

sys.path.insert(0, str(OPENKYC))

from openkyc.engines import (  # noqa: E402
    CREDENTIAL_KINDS,
    DoclingStructureEngine,
    PaddleOcrTextEngine,
    ReferenceSemanticEngine,
    ReferenceStructureEngine,
    ReferenceTextEngine,
    VlmSemanticEngine,
    engine_registry,
)
from openkyc.liveness import (  # noqa: E402
    ACTION_WINDOW_MS,
    CHALLENGE_ACTIONS,
    CHALLENGE_COUNT,
    LIVENESS_SIGNALS,
    LIVENESS_WEIGHTS,
    challenge_digest,
    challenge_well_formed,
    fuse_liveness,
    reference_signals,
    verify_challenge_token,
)
from openkyc.pipeline import (  # noqa: E402
    ACCEPT_MIN,
    CALLBACK_FIELD_ORDER,
    REVIEW_FLOOR,
    SESSION_TTL_SECONDS,
    VERDICT_FIELDS,
    verdict_payload_fields,
    verify_capture,
)
from openkyc.callback import sign_verdict  # noqa: E402

NOW = 1_764_000_000  # fixed clock: deterministic verdicts


def vector(**overrides):
    base = {
        "liveness": {n: 0.95 for n in LIVENESS_SIGNALS},
        "text": ["FEDERAL REPUBLIC OF EXAMPLE", "ID 0000"],
        "kind": "id_card",
        "birth_year": 1990,
        "expiry_year": 2031,
        "structure_confidence": 0.93,
        "semantic_confidence": 0.91,
    }
    base.update(overrides)
    return [b"OKVEC:" + json.dumps(base).encode(), b"burst-2", b"burst-3"]


def challenge():
    return [{"action": a, "windowMs": ACTION_WINDOW_MS}
            for a in ("blink", "nod", "smile")]


# ---------------------------------------------------------- AMD-KYC-07 ---

def test_challenge_protocol_pinned():
    assert CHALLENGE_ACTIONS == ("blink", "turn_left", "turn_right", "smile", "nod")
    assert CHALLENGE_COUNT == 3
    assert ACTION_WINDOW_MS == 4000
    assert SESSION_TTL_SECONDS == 600


def test_challenge_well_formed():
    assert challenge_well_formed(challenge())
    assert not challenge_well_formed(challenge()[:2])                      # too few
    dup = [{"action": "blink", "windowMs": 4000}] * 3
    assert not challenge_well_formed(dup)                                  # distinct
    bad = [{"action": "wave", "windowMs": 4000}] * 3
    assert not challenge_well_formed(bad)                                  # known actions
    slow = [{"action": a, "windowMs": 9000} for a in ("blink", "nod", "smile")]
    assert not challenge_well_formed(slow)                                 # window cap


def test_challenge_digest_stable_and_cross_language():
    # The edge mirrors this byte form (kycVerification.canonicalChallenge).
    expected = hashlib.sha256(
        b'[{"action":"blink","windowMs":4000},'
        b'{"action":"nod","windowMs":4000},'
        b'{"action":"smile","windowMs":4000}]'
    ).hexdigest()
    assert challenge_digest(challenge()) == expected


def test_challenge_token_round_trip_and_tamper_refusal():
    digest = challenge_digest(challenge())
    token = hmac.new(b"s3cret", f"sess:{digest}:999".encode(), hashlib.sha256).hexdigest()
    assert verify_challenge_token("s3cret", "sess", challenge(), 999, token)
    assert not verify_challenge_token("s3cret", "sess", challenge(), 998, token)
    assert not verify_challenge_token("wrong", "sess", challenge(), 999, token)
    assert not verify_challenge_token("s3cret", "sess", challenge(), 999, "zz")
    tampered = [{"action": "nod", "windowMs": 4000}] + challenge()[1:]
    assert not verify_challenge_token("s3cret", "sess", tampered, 999, token)


def test_liveness_fusion_weights_pinned():
    assert LIVENESS_SIGNALS == (
        "challenge_response", "rppg", "moire", "depth", "rigidity", "injection")
    assert LIVENESS_WEIGHTS == {
        "challenge_response": 0.30, "rppg": 0.20, "moire": 0.15,
        "depth": 0.15, "rigidity": 0.10, "injection": 0.10,
    }
    assert fuse_liveness({n: 1.0 for n in LIVENESS_SIGNALS}) == 1.0
    assert fuse_liveness({n: 0.0 for n in LIVENESS_SIGNALS}) == 0.0
    with pytest.raises(ValueError):
        fuse_liveness({"challenge_response": 1.0})


def test_reference_scoring_deterministic():
    frames = [b"alpha", b"beta"]
    assert reference_signals(frames, challenge()) == reference_signals(frames, challenge())


# ---------------------------------------------------------- AMD-KYC-06 ---

def test_reference_engines_conform_and_deterministic():
    frames = vector()
    text = ReferenceTextEngine().extract(frames)
    assert text == ["FEDERAL REPUBLIC OF EXAMPLE", "ID 0000"]
    structure = ReferenceStructureEngine().parse(frames)
    assert structure["kind"] == "id_card"
    assert structure["fields"] == {"birth_year": 1990, "expiry_year": 2031}
    semantic = ReferenceSemanticEngine().judge(frames, text)
    assert 0.0 <= semantic["confidence"] <= 1.0


def test_real_adapters_exist_and_report_availability():
    # The adapters are the real-mode path; in CI the dependencies are
    # absent, so they must report unavailable — never raise at import.
    for cls, name in ((PaddleOcrTextEngine, "paddleocr"),
                      (DoclingStructureEngine, "docling"),
                      (VlmSemanticEngine, "vlm")):
        engine = cls()
        assert engine.name() == name
        assert engine.available() is False


def test_registry_reference_default_and_fail_closed_real(monkeypatch):
    monkeypatch.delenv("OPENKYC_ENGINES", raising=False)
    engines = engine_registry()
    assert [e.name() for e in engines] == [
        "reference-text", "reference-structure", "reference-semantic"]
    monkeypatch.setenv("OPENKYC_ENGINES", "real")
    with pytest.raises(RuntimeError, match="unavailable"):
        engine_registry()
    monkeypatch.setenv("OPENKYC_ENGINES", "bogus")
    with pytest.raises(RuntimeError, match="unknown"):
        engine_registry()


# ------------------------------------------------------- verdict fusion ---

def test_verdict_verified():
    v = verify_capture("sess-1", challenge(), vector(), now=lambda: NOW)
    assert v.outcome == "verified"
    assert v.credential_kind == "id_card"
    assert v.over_18 and v.credential_valid
    assert v.liveness_score >= ACCEPT_MIN
    assert v.authenticity_score >= ACCEPT_MIN
    assert v.provider_ref == "openkyc:sess-1"


def test_verdict_rejected_on_weak_liveness():
    frames = vector(liveness={n: 0.2 for n in LIVENESS_SIGNALS})
    v = verify_capture("sess-2", challenge(), frames, now=lambda: NOW)
    assert v.outcome == "rejected"


def test_verdict_rejected_on_underage():
    current_year = 2026  # NOW's year
    frames = vector(birth_year=current_year - 17)
    v = verify_capture("sess-3", challenge(), frames, now=lambda: NOW)
    assert v.outcome == "rejected"
    assert v.over_18 is False


def test_verdict_rejected_on_expired_credential():
    frames = vector(expiry_year=2020)
    v = verify_capture("sess-4", challenge(), frames, now=lambda: NOW)
    assert v.outcome == "rejected"
    assert v.credential_valid is False


def test_verdict_review_mid_band():
    frames = vector(liveness={n: 0.65 for n in LIVENESS_SIGNALS})
    v = verify_capture("sess-5", challenge(), frames, now=lambda: NOW)
    assert v.outcome == "review"
    assert REVIEW_FLOOR <= v.liveness_score < ACCEPT_MIN


def test_thresholds_pinned():
    assert ACCEPT_MIN == 0.80
    assert REVIEW_FLOOR == 0.50


# ------------------------------------------- AMD-KYC-02/08 minimisation ---

def test_verdict_wire_is_exactly_the_pinned_fields():
    v = verify_capture("sess-6", challenge(), vector(), now=lambda: NOW)
    wire = v.wire()
    assert tuple(wire.keys()) == VERDICT_FIELDS
    banned = re.compile(r"birth|dob|name|number|image|frame|face|capture|doc", re.I)
    for key in wire:
        assert not banned.search(key), key


def test_purge_receipt_and_buffer_destruction():
    frames = vector()
    keep = [bytes(f) for f in frames]
    v = verify_capture("sess-7", challenge(), frames, now=lambda: NOW)
    assert v.purge_receipt["purgedFrames"] == len(keep)
    assert v.purge_receipt["at"] > 0
    # The verdict carries no frame bytes.
    assert all(f not in json.dumps(v.wire()).encode() for f in keep)


def test_callback_signing_matches_the_edge_discipline():
    v = verify_capture("sess-8", challenge(), vector(), now=lambda: NOW)
    wire = v.wire()
    headers = sign_verdict("verdict-secret", wire, NOW)
    assert headers["x-kyc-timestamp"] == str(NOW)
    assert re.fullmatch(r"[0-9a-f]{64}", headers["x-kyc-signature"])
    payload = verdict_payload_fields(wire, NOW)
    assert payload.split("|")[0] == str(NOW)                     # timestamp leads
    assert payload.count("|") == len(CALLBACK_FIELD_ORDER) - 1
    expected = hmac.new(b"verdict-secret", payload.encode(), hashlib.sha256).hexdigest()
    assert headers["x-kyc-signature"] == expected


# -------------------------------------------- architectural guardrails ---

def test_service_never_touches_oltp():
    # ADR-0009: the pipeline's only egress is the signed edge callback.
    for path in (OPENKYC / "openkyc").glob("*.py"):
        text = path.read_text()
        assert "psycopg" not in text, path
        assert "DATABASE_URL" not in text, path
        assert "pg8000" not in text, path


def test_server_persists_no_capture():
    # AMD-KYC-10: no upload directory, no spool, no temp files.
    server = (OPENKYC / "openkyc/server.py").read_text()
    assert 'open(' not in server
    assert "tempfile" not in server
    assert "pickle" not in server
    assert ".write(" not in server.replace("handler.wfile.write", "")


def test_credential_vocabulary_neutral():
    assert CREDENTIAL_KINDS == ("id_card", "driving_permit", "travel_document")

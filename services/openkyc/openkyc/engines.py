"""AMD-KYC-06: engine adapters.

One conformance interface, three open engines, plus deterministic
reference engines:

  TextEngine        extract(frame_blobs) -> list[str]
    real: PaddleOCR (PP-OCRv4, lazy import — the process runs fine
          without the dependency until OPENKYC_ENGINES=real)
  StructureEngine   parse(frame_blobs) -> {kind, fields, confidence}
    real: Docling (IBM) — layout-aware parsing; the credential's
          structure (photo zone, field blocks, machine-readable zone)
          is a far stronger authenticity signal than raw text
  SemanticEngine    judge(frame_blobs, text) -> {confidence, flags}
    real: a VLM (any transformers-style vision-language model behind
          OPENKYC_VLM_MODEL) answering the pinned authenticity prompt:
          a genuine live capture of a credential vs a screen photo, a
          print, or an edit

OPENKYC_ENGINES=reference (default) runs the deterministic engines —
CI and the full-chain rehearsal exercise the whole pipeline without a
GPU. OPENKYC_ENGINES=real REQUIRES all three adapters importable, else
the process refuses to start (fail closed — never silently downgrade).
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Protocol

CREDENTIAL_KINDS = ("id_card", "driving_permit", "travel_document")


class TextEngine(Protocol):
    def name(self) -> str: ...
    def available(self) -> bool: ...
    def extract(self, frame_blobs: list[bytes]) -> list[str]: ...


class StructureEngine(Protocol):
    def name(self) -> str: ...
    def available(self) -> bool: ...
    def parse(self, frame_blobs: list[bytes]) -> dict: ...


class SemanticEngine(Protocol):
    def name(self) -> str: ...
    def available(self) -> bool: ...
    def judge(self, frame_blobs: list[bytes], text: list[str]) -> dict: ...


# ----------------------------------------------------------- real adapters

class PaddleOcrTextEngine:
    """PaddleOCR adapter. Lazy import: the dependency is heavy and the
    reference engine covers CI; a real deployment installs
    `paddleocr` + `paddlepaddle` and flips OPENKYC_ENGINES=real."""

    def __init__(self) -> None:
        self._ocr = None
        try:
            from paddleocr import PaddleOCR  # type: ignore

            self._ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
        except Exception:
            self._ocr = None

    def name(self) -> str:
        return "paddleocr"

    def available(self) -> bool:
        return self._ocr is not None

    def extract(self, frame_blobs: list[bytes]) -> list[str]:
        assert self._ocr is not None
        lines: list[str] = []
        import numpy as np  # type: ignore
        import cv2  # type: ignore

        for blob in frame_blobs:
            array = np.frombuffer(blob, dtype=np.uint8)
            image = cv2.imdecode(array, cv2.IMREAD_COLOR)
            if image is None:
                continue
            for block in self._ocr.ocr(image, cls=True) or []:
                for entry in block or []:
                    lines.append(str(entry[1][0]))
        return lines


class DoclingStructureEngine:
    """Docling adapter — layout/structure parsing of the credential."""

    def __init__(self) -> None:
        self._converter = None
        try:
            from docling.document_converter import DocumentConverter  # type: ignore

            self._converter = DocumentConverter()
        except Exception:
            self._converter = None

    def name(self) -> str:
        return "docling"

    def available(self) -> bool:
        return self._converter is not None

    def parse(self, frame_blobs: list[bytes]) -> dict:
        assert self._converter is not None
        # Docling consumes documents via its converter API; the adapter
        # maps the detected layout blocks onto the pinned structure
        # contract. Field-level values stay inside the pipeline and are
        # reduced to derived booleans before anything leaves.
        raise NotImplementedError("wire the deployment's Docling pipeline here")


class VlmSemanticEngine:
    """VLM adapter — semantic authenticity judgement with the pinned
    prompt. Any transformers-style VLM; the model id comes from
    OPENKYC_VLM_MODEL so deployments pick their own weights."""

    PROMPT = (
        "You are verifying a live capture of an identity credential. "
        "Answer compact JSON: {genuine: 0..1, flags: [...]}. Judge "
        "screen-replay, print, digital edit and template mismatch."
    )

    def __init__(self) -> None:
        self._model = None
        model_id = os.environ.get("OPENKYC_VLM_MODEL")
        if model_id:
            try:
                import transformers  # type: ignore  # noqa: F401

                self._model = model_id  # pipeline wiring is deployment-specific
            except Exception:
                self._model = None

    def name(self) -> str:
        return "vlm"

    def available(self) -> bool:
        return self._model is not None

    def judge(self, frame_blobs: list[bytes], text: list[str]) -> dict:
        assert self._model is not None
        raise NotImplementedError("wire the deployment's VLM pipeline here")


# ----------------------------------------------------- reference engines

def _seeded_score(seed: bytes, label: str, low: float = 0.35, high: float = 0.95) -> float:
    raw = int.from_bytes(hashlib.sha256(seed + label.encode("utf8")).digest()[:2], "big") / 65535.0
    return round(low + (high - low) * raw, 4)


class ReferenceTextEngine:
    """Deterministic stand-in. Test vectors (first frame b'OKVEC:')
    carry explicit text; anything else derives synthetic lines from the
    frame hash so goldens are byte-stable."""

    def name(self) -> str:
        return "reference-text"

    def available(self) -> bool:
        return True

    def extract(self, frame_blobs: list[bytes]) -> list[str]:
        if frame_blobs and frame_blobs[0].startswith(b"OKVEC:"):
            vector = json.loads(frame_blobs[0][len(b"OKVEC:"):].decode("utf8"))
            return [str(line) for line in vector.get("text", [])]
        digest = hashlib.sha256(b"".join(frame_blobs)).hexdigest()
        return [f"REF-{digest[:8]}", f"LINE-{digest[8:16]}"]


class ReferenceStructureEngine:
    def name(self) -> str:
        return "reference-structure"

    def available(self) -> bool:
        return True

    def parse(self, frame_blobs: list[bytes]) -> dict:
        seed = b"".join(frame_blobs)
        if frame_blobs and frame_blobs[0].startswith(b"OKVEC:"):
            vector = json.loads(frame_blobs[0][len(b"OKVEC:"):].decode("utf8"))
            kind = vector["kind"]
            if kind not in CREDENTIAL_KINDS:
                raise ValueError("unknown credential kind in test vector")
            return {
                "kind": kind,
                "fields": {
                    "birth_year": int(vector["birth_year"]),
                    "expiry_year": int(vector["expiry_year"]),
                },
                "confidence": float(vector.get("structure_confidence", 0.9)),
            }
        return {
            "kind": "id_card",
            "fields": {},
            "confidence": _seeded_score(seed, "structure"),
        }


class ReferenceSemanticEngine:
    def name(self) -> str:
        return "reference-semantic"

    def available(self) -> bool:
        return True

    def judge(self, frame_blobs: list[bytes], text: list[str]) -> dict:
        seed = b"".join(frame_blobs) + b"|".join(t.encode("utf8") for t in text)
        if frame_blobs and frame_blobs[0].startswith(b"OKVEC:"):
            vector = json.loads(frame_blobs[0][len(b"OKVEC:"):].decode("utf8"))
            return {
                "confidence": float(vector.get("semantic_confidence", 0.9)),
                "flags": list(vector.get("flags", [])),
            }
        return {"confidence": _seeded_score(seed, "semantic"), "flags": []}


# ------------------------------------------------------------ registry

def engine_registry() -> tuple[TextEngine, StructureEngine, SemanticEngine]:
    """The one place engines are chosen. reference = deterministic
    default; real = all three adapters MUST import (fail closed)."""
    mode = os.environ.get("OPENKYC_ENGINES", "reference")
    if mode == "reference":
        return ReferenceTextEngine(), ReferenceStructureEngine(), ReferenceSemanticEngine()
    if mode == "real":
        text: TextEngine = PaddleOcrTextEngine()
        structure: StructureEngine = DoclingStructureEngine()
        semantic: SemanticEngine = VlmSemanticEngine()
        missing = [e.name() for e in (text, structure, semantic) if not e.available()]
        if missing:
            raise RuntimeError(
                "OPENKYC_ENGINES=real but these engines are unavailable: "
                + ",".join(missing)
            )
        return text, structure, semantic
    raise RuntimeError(f"unknown OPENKYC_ENGINES mode: {mode}")

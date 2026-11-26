"""AMD-KYC-09: the signed verdict callback.

The pipeline reaches the platform ONLY here: an HMAC-SHA256 signature
over the canonical field string (verdict_payload_fields — timestamp
first, the AMD-PAY-22 freshness discipline), sent to the edge webhook
which verifies freshness BEFORE the signature and composes
complete_kyc_session under app.kyc_callback. Stdlib only — the service
carries no third-party runtime dependency in reference mode.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.request

from .pipeline import Verdict, verdict_payload_fields

TIMESTAMP_HEADER = "x-kyc-timestamp"
SIGNATURE_HEADER = "x-kyc-signature"


def sign_verdict(secret: str, verdict_wire: dict, at: int) -> dict[str, str]:
    payload = verdict_payload_fields(verdict_wire, at)
    signature = hmac.new(secret.encode("utf8"), payload.encode("utf8"), hashlib.sha256).hexdigest()
    return {TIMESTAMP_HEADER: str(at), SIGNATURE_HEADER: signature}


def send_verdict(
    edge_url: str,
    secret: str,
    verdict: Verdict,
    *,
    now=lambda: int(time.time()),
    timeout_s: float = 5.0,
) -> int:
    """POST the verdict to POST /v1/webhooks/kyc-verdict. Returns the
    HTTP status; the caller retries on 5xx (the definer is idempotent —
    a replayed verdict answers 'replayed')."""
    wire = verdict.wire()
    headers = sign_verdict(secret, wire, now())
    headers["content-type"] = "application/json"
    request = urllib.request.Request(
        edge_url,
        data=json.dumps(wire).encode("utf8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            return int(response.status)
    except urllib.error.HTTPError as err:
        return int(err.code)

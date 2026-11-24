#!/usr/bin/env python3
"""SEC-02 revocation drill: prove a revoked device loses access within 60 s.

Session tokens are short-lived (5-minute consumer-realm access tokens), but
passive expiry alone cannot satisfy SEC-02's 60-second revocation budget.
The platform therefore revokes server-side: deleting a device writes the
Valkey denylist before the route replies, and the edge's authenticate hook
denies any request presenting that device id. This drill measures the
end-to-end propagation time against a live stack and asserts it stays within
budget.

Flow:
  1. mint a drill token (HS256 dev secret when no KEYCLOAK_ISSUER is set);
  2. enrol a device (legacy attestation header path);
  3. confirm an authed call with x-device-id answers 200;
  4. DELETE /v1/devices/{deviceId};
  5. poll with x-device-id until 401 — elapsed must be <= DRILL_BUDGET_S
     (default 60, matching services/edge/src/revocation.ts).

Environment:
  EDGE_URL          edge base URL (default http://localhost:4000)
  DRILL_JWT_SECRET  dev HS256 secret (default p0-dev-secret-change-me)
  DRILL_BUDGET_S    revocation budget in seconds (default 60)

Exit code 0 = PASS, 1 = FAIL. Stdlib only.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

EDGE_URL = os.environ.get("EDGE_URL", "http://localhost:4000").rstrip("/")
JWT_SECRET = os.environ.get("DRILL_JWT_SECRET", "p0-dev-secret-change-me")
BUDGET_S = int(os.environ.get("DRILL_BUDGET_S", "60"))


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def mint_token(sub: str) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url(json.dumps({"sub": sub, "iat": int(time.time())}).encode())
    sig = hmac.new(JWT_SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    return f"{header}.{payload}.{_b64url(sig)}"


def call(method: str, path: str, token: str, body: dict | None = None,
         headers: dict | None = None) -> tuple[int, dict]:
    req_headers = {"authorization": f"Bearer {token}", "content-type": "application/json"}
    if headers:
        req_headers.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{EDGE_URL}{path}", data=data, method=method,
                                 headers=req_headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def main() -> int:
    if BUDGET_S > 60:
        print("FAIL: the drill budget may not exceed SEC-02's 60 seconds")
        return 1
    user = f"drill-{uuid.uuid4()}"
    token = mint_token(user)

    status, body = call("POST", "/v1/devices", token, {"label": "drill"},
                        {"x-app-attest-assertion": f"drill-{uuid.uuid4()}"})
    if status != 201:
        print(f"FAIL: enrolment answered {status}: {body}")
        return 1
    device_id = body["deviceId"]

    authed = {"x-device-id": device_id}
    status, _ = call("GET", "/v1/devices", token, headers=authed)
    if status != 200:
        print(f"FAIL: authed call before revocation answered {status}")
        return 1

    status, _ = call("DELETE", f"/v1/devices/{device_id}", token)
    if status != 200:
        print(f"FAIL: revocation call answered {status}")
        return 1

    started = time.monotonic()
    deadline = started + BUDGET_S
    while True:
        status, _ = call("GET", "/v1/devices", token, headers=authed)
        if status == 401:
            elapsed = time.monotonic() - started
            print(f"PASS: revoked device denied after {elapsed:.2f}s "
                  f"(budget {BUDGET_S}s, SEC-02)")
            return 0
        if time.monotonic() > deadline:
            print(f"FAIL: still answered {status} after {BUDGET_S}s — "
                  "revocation did not propagate within budget")
            return 1
        time.sleep(0.25)


if __name__ == "__main__":
    sys.exit(main())

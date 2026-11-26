"""AMD-KYC-06/10: the capture intake server (stdlib http.server).

  POST /v1/captures   the member's client uploads {sessionId,
                      challengeToken, challenge, expiresAt, frames[]}
                      (frames base64); the token is verified BEFORE a
                      frame is decoded; the pipeline runs; captures are
                      purged; the signed verdict goes to the edge.
  GET  /healthz       engine inventory for deploy checks.

The server keeps NOTHING on disk: no upload directory, no spool, no
temp file — captures exist only as in-memory buffers inside one request
(the AMD-KYC-10 discipline; tests/test_batch63.py pins the absence of
any file-write call in this module).
"""

from __future__ import annotations

import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .callback import send_verdict
from .engines import engine_registry
from .liveness import challenge_well_formed, verify_challenge_token
from .pipeline import verify_capture

MAX_FRAMES = 48
MAX_FRAME_BYTES = 2 * 1024 * 1024  # 2 MiB per frame, decoded


def _json(handler: BaseHTTPRequestHandler, status: int, body: dict) -> None:
    payload = json.dumps(body).encode("utf8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


class Handler(BaseHTTPRequestHandler):
    server_version = "openkyc/1.0"

    def log_message(self, *_args) -> None:  # no request logging: the URL
        pass  # path alone would be a capture-adjacent record

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path != "/healthz":
            return _json(self, 404, {"error": "unknown route"})
        engines = engine_registry()
        return _json(self, 200, {"ok": True, "engines": [e.name() for e in engines]})

    def do_POST(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path != "/v1/captures":
            return _json(self, 404, {"error": "unknown route"})
        secret = os.environ.get("KYC_CHALLENGE_SECRET")
        edge_url = os.environ.get("EDGE_VERDICT_URL")
        verdict_secret = os.environ.get("KYC_VERDICT_SECRET")
        if not secret or not edge_url or not verdict_secret:
            return _json(self, 503, {"error": "openkyc not configured (AMD-KYC-09)"})
        try:
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return _json(self, 400, {"error": "a capture upload is a JSON body"})
        session_id = body.get("sessionId")
        token = body.get("challengeToken")
        challenge = body.get("challenge")
        expires_at = body.get("expiresAt")
        frames_b64 = body.get("frames")
        if (
            not isinstance(session_id, str)
            or not isinstance(expires_at, int)
            or not challenge_well_formed(challenge)
            or not isinstance(frames_b64, list)
            or not (1 <= len(frames_b64) <= MAX_FRAMES)
        ):
            return _json(self, 422, {"error": "malformed capture upload (AMD-KYC-07)"})
        # Verify the single-use token BEFORE decoding a single frame.
        if not verify_challenge_token(secret, session_id, challenge, expires_at, token):
            return _json(self, 401, {"error": "bad challenge token"})
        frames: list[bytes] = []
        try:
            for entry in frames_b64:
                if not isinstance(entry, str):
                    raise ValueError("frame not base64")
                blob = base64.b64decode(entry, validate=True)
                if len(blob) > MAX_FRAME_BYTES:
                    raise ValueError("frame too large")
                frames.append(blob)
        except Exception:
            return _json(self, 422, {"error": "malformed frame payload"})
        try:
            verdict = verify_capture(session_id, challenge, frames)
        except ValueError as err:
            return _json(self, 422, {"error": str(err)})
        status = send_verdict(edge_url, verdict_secret, verdict)
        return _json(
            self,
            200 if status < 500 else 502,
            {"outcome": verdict.outcome, "callbackStatus": status},
        )


def main() -> None:
    port = int(os.environ.get("OPENKYC_PORT", "4200"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()

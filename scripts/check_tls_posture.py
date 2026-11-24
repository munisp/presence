#!/usr/bin/env python3
"""INF-11: TLS posture gate and OCSP stapling evidence collector.

Two modes, one contract:

  python3 scripts/check_tls_posture.py
      Static CI mode. Asserts the APISIX gateway manifest carries the OCSP
      stapling directives (ssl_stapling, verification, trusted chain,
      in-cluster resolver) and that the verification runbook exists.

  python3 scripts/check_tls_posture.py --host api.presence.example
      Evidence mode. Runs openssl s_client against the live gateway and
      requires a successful stapled OCSP response — the production evidence
      INF-11 asks for. Budget-capped like the revocation drill: a hanging
      network path fails the check rather than stalling a runbook.

Exit 0 on pass, 1 on any failure.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APISIX = ROOT / "deploy" / "k8s" / "apisix.yaml"
RUNBOOK = ROOT / "docs" / "ops" / "tls.md"

EVIDENCE_BUDGET_S = 30


def static_checks() -> list[str]:
    problems: list[str] = []
    src = APISIX.read_text() if APISIX.exists() else ""
    for directive in (
        "ssl_stapling: on",
        "ssl_stapling_verify: on",
        "ssl_trusted_certificate: /usr/local/apisix/conf/ssl/tls.crt",
        "resolver: kube-dns.kube-system.svc.cluster.local",
        "ssl_protocols: TLSv1.3",
    ):
        if directive not in src:
            problems.append(f"apisix.yaml missing directive: {directive}")
    if not RUNBOOK.exists():
        problems.append("docs/ops/tls.md runbook missing")
    return problems


def collect_evidence(host: str, port: int) -> list[str]:
    try:
        proc = subprocess.run(
            [
                "openssl", "s_client",
                "-connect", f"{host}:{port}",
                "-servername", host,
                "-status",
            ],
            input=b"",
            capture_output=True,
            timeout=EVIDENCE_BUDGET_S,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return [f"openssl evidence collection failed: {exc}"]
    out = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
    problems: list[str] = []
    if "OCSP Response Status: successful" not in out:
        problems.append("no successful stapled OCSP response in the handshake")
    if "TLSv1.3" not in out:
        problems.append("handshake did not negotiate TLS 1.3 (TR-26)")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", help="collect live OCSP stapling evidence from this host")
    parser.add_argument("--port", type=int, default=443)
    args = parser.parse_args()

    problems = static_checks()
    if args.host:
        problems += collect_evidence(args.host, args.port)
    for problem in problems:
        print(f"FAIL  {problem}")
    if problems:
        print(f"{len(problems)} check(s) FAILED")
        return 1
    print("TLS posture holds" + (f"; OCSP stapling verified against {args.host}" if args.host else " (static)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())

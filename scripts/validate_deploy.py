#!/usr/bin/env python3
"""Validate the deployment manifests against the safety-critical invariants.

Asserts (with requirement ids):
  TR-26  APISIX serves TLS 1.3 only, HTTP/2 enabled on the TLS listener.
  INF-10 HPAs scale in at most 1 pod per 10 minutes and target p95 <= 120 ms.
  INF-12 default-deny ingress+egress exists; only APISIX is a LoadBalancer.
  INF-14 default-deny egress plus explicit per-workload egress allowlists.
  INF-16 canary step weight is 5%% with a 10-minute step interval and
         automatic rollback thresholds on latency and success rate.
  INF-11 HSTS + CSP headers are set at the gateway.
  TECH-21 APISIX is the sole public (LoadBalancer) ingress.

Run: python3 scripts/validate_deploy.py   (exit 1 on any failure)
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
K8S = ROOT / "deploy" / "k8s"

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def docs(path: Path) -> list[dict]:
    return [d for d in yaml.safe_load_all(path.read_text()) if d]


def main() -> int:
    apisix_docs = docs(K8S / "apisix.yaml")
    cm = next(d for d in apisix_docs if d["kind"] == "ConfigMap")
    config = yaml.safe_load(cm["data"]["config.yaml"])
    routes = yaml.safe_load(cm["data"]["apisix.yaml"])

    # TR-26: TLS 1.3 only + HTTP/2
    ssl_protocols = config["nginx_config"]["http"]["ssl_protocols"].split()
    check("TR-26 TLS 1.3 only", ssl_protocols == ["TLSv1.3"], str(ssl_protocols))
    listeners = config["apisix"]["node_listen"]
    tls_listener = [l for l in listeners if l.get("tls")]
    check("TR-26 HTTP/2 on TLS listener", bool(tls_listener) and tls_listener[0].get("enable_http2") is True)

    # INF-11: HSTS + CSP at the gateway
    edge_route = next(r for r in routes["routes"] if r["id"] == "edge-api")
    headers = edge_route["plugins"]["response-rewrite"]["headers"]["set"]
    check("INF-11 HSTS header", "Strict-Transport-Security" in headers)
    check("INF-11 CSP header", "Content-Security-Policy" in headers)

    # NFR-31: request-id plugin generates and echoes the id
    check(
        "NFR-31 request-id plugin",
        edge_route["plugins"]["request-id"]["include_in_response"] is True,
    )

    # INF-10: HPA behaviour on both latency-critical services
    for svc in ("edge", "match"):
        hpa = next(d for d in docs(K8S / f"{svc}.yaml") if d["kind"] == "HorizontalPodAutoscaler")
        down = hpa["spec"]["behavior"]["scaleDown"]["policies"]
        check(
            f"INF-10 {svc} scale-in <= 1 pod / 10 min",
            any(p["type"] == "Pods" and p["value"] <= 1 and p["periodSeconds"] >= 600 for p in down),
            str(down),
        )
        ext = [m for m in hpa["spec"]["metrics"] if m["type"] == "External"]
        check(
            f"INF-10 {svc} p95 <= 120 ms metric",
            bool(ext) and ext[0]["external"]["target"]["value"] == "120",
        )
        check(
            f"INF-10 {svc} 3-min scale-up window",
            hpa["spec"]["behavior"]["scaleUp"]["stabilizationWindowSeconds"] == 180,
        )

    # INF-12/INF-14: NetworkPolicies
    nps = docs(K8S / "networkpolicy.yaml")
    default_deny = next(p for p in nps if p["metadata"]["name"] == "default-deny-all")
    check(
        "INF-12/14 default-deny ingress+egress",
        set(default_deny["spec"]["policyTypes"]) == {"Ingress", "Egress"}
        and default_deny["spec"]["podSelector"] == {},
    )
    egress_policies = [p for p in nps if "Egress" in p["spec"]["policyTypes"] and p["metadata"]["name"] != "default-deny-all"]
    check("INF-14 egress allowlists exist", len(egress_policies) >= 4, f"{len(egress_policies)} allowlists")
    edge_in = next(p for p in nps if p["metadata"]["name"] == "edge-from-apisix")
    sources = {f["podSelector"]["matchLabels"]["app"] for r in edge_in["spec"]["ingress"] for f in r["from"] if "podSelector" in f}
    check("INF-12 edge reachable only from apisix (+prometheus)", sources == {"apisix", "prometheus"}, str(sources))

    # TECH-21: APISIX is the only LoadBalancer
    lbs = [
        d
        for f in K8S.glob("*.yaml")
        for d in docs(f)
        if d["kind"] == "Service" and d["spec"].get("type") == "LoadBalancer"
    ]
    check("TECH-21 sole public ingress", len(lbs) == 1 and lbs[0]["metadata"]["name"] == "apisix", str([s["metadata"]["name"] for s in lbs]))

    # INF-16: canary contract
    canaries = docs(K8S / "canary.yaml")
    for c in canaries:
        a = c["spec"]["analysis"]
        check(
            f"INF-16 {c['metadata']['name']} canary 5%/10min",
            a["stepWeight"] == 5 and a["interval"] == "10m",
        )
        metric_names = {m["name"] for m in a["metrics"]}
        check(
            f"INF-16 {c['metadata']['name']} auto-rollback metrics",
            {"request-success-rate", "request-duration"} <= metric_names,
        )

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED")
        return 1
    print("All deployment invariants hold.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

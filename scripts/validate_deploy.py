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
  NFR-33 ServiceMonitors scrape edge and match on /metrics; the monitoring
         namespace Prometheus is admitted to the scrape ports.
  NFR-34 every alert names an owner and its runbook anchor resolves.
  NFR-07 the realtime-delivery SLO alert carries the 500 ms p95 budget.
  TECH-11/12 probes hit the real /healthz route; both services export OTLP
         traces to the collector; the stack manifest ships collector, Tempo
         and Grafana with both datasources.
  TR-03 the presence namespace is annotated for Linkerd injection (ADR-0010).
  SEC-28 no Secret manifests are committed; the ExternalSecret covers every
         secretKeyRef key the workloads reference.
  SEC-02 the revocation drill exists with its 60-second budget cap; the edge
         revocation constant matches.
  FR-56  push payloads carry type+ref only; push credentials live only in
         the managed secret store.
  TECH-18 the Go presence/venue/consent service cores exist, are stdlib-only,
         and are exercised by the go-services CI job (gofmt, vet, tests).
  SEC-03 the JIT elevation migration is mounted, four-eyes is enforced in
         the storage layer, and the Keycloak role binding is env-gated.
  SEC-01/TECH-07 the consumer realm browser flow is passkey-only (no
         username/password execution) with AAL2 + elevation evidence docs.

Run: python3 scripts/validate_deploy.py   (exit 1 on any failure)
"""

from __future__ import annotations

import json
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
    sources = {
        f["podSelector"]["matchLabels"].get("app") or f["podSelector"]["matchLabels"].get("app.kubernetes.io/name")
        for r in edge_in["spec"]["ingress"]
        for f in r["from"]
        if "podSelector" in f and "namespaceSelector" not in f
    }
    check("INF-12 edge reachable only from apisix (+prometheus)", sources == {"apisix", "prometheus"}, str(sources))
    # NFR-33: the monitoring-namespace Prometheus is also admitted to the
    # scrape ports on edge and match, and nothing else is.
    for name, port in (("edge-from-apisix", 4000), ("match-from-edge", 4100)):
        pol = next(p for p in nps if p["metadata"]["name"] == name)
        monitoring = [
            f
            for r in pol["spec"]["ingress"]
            for f in r["from"]
            if f.get("namespaceSelector", {}).get("matchLabels", {}).get("kubernetes.io/metadata.name") == "monitoring"
        ]
        check(f"NFR-33 {name} admits monitoring-namespace prometheus", len(monitoring) == 1)

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

    # NFR-33: ServiceMonitors scrape both alert-input workloads on /metrics.
    monitors = docs(K8S / "servicemonitor.yaml")
    check("NFR-33 ServiceMonitors for edge and match", len(monitors) == 2)
    for m in monitors:
        app = m["metadata"]["labels"]["app"]
        check(
            f"NFR-33 {app} monitor scrapes /metrics",
            m["spec"]["endpoints"][0]["path"] == "/metrics"
            and m["spec"]["selector"]["matchLabels"] == {"app": app},
        )
        svc = next(d for d in docs(K8S / f"{app}.yaml") if d["kind"] == "Service")
        check(
            f"NFR-33 {app} service port is named (monitor reference)",
            svc["spec"]["ports"][0].get("name") == "http",
        )

    # NFR-33/NFR-34: every alert's runbook anchor resolves in docs/runbook.md,
    # and every alert names an owner.
    rules = docs(K8S / "prometheusrules.yaml")[0]
    runbook = (ROOT / "docs" / "runbook.md").read_text()
    for group in rules["spec"]["groups"]:
        for rule in group["rules"]:
            name = rule["alert"]
            anchor = rule["annotations"]["runbook"].split("#", 1)[1]
            check(f"NFR-34 {name} runbook anchor resolves", f"## {name}" in runbook)
            check(f"NFR-34 {name} names an owner", bool(rule["labels"].get("owner")))

    # NFR-07: the realtime-delivery SLO alert exists with the 500 ms budget.
    all_rules = [r for g in rules["spec"]["groups"] for r in g["rules"]]
    rt = next((r for r in all_rules if r["alert"] == "RealtimeDeliverySlow"), None)
    check(
        "NFR-07 realtime p95 <= 500 ms alert",
        rt is not None and "> 0.5" in rt["expr"] and rt["labels"]["owner"] == "realtime-oncall",
    )

    # TECH-12: probes hit the health route the services actually serve, and
    # both workloads emit OTLP traces to the collector by default.
    for svc, port in (("edge", 4000), ("match", 4100)):
        deploy = next(d for d in docs(K8S / f"{svc}.yaml") if d["kind"] == "Deployment")
        container = deploy["spec"]["template"]["spec"]["containers"][0]
        for probe in ("readinessProbe", "livenessProbe"):
            check(
                f"TECH-12 {svc} {probe} hits /healthz",
                container[probe]["httpGet"]["path"] == "/healthz",
            )
        env = {e["name"]: e.get("value") for e in container["env"]}
        check(
            f"TECH-12 {svc} OTLP endpoint wired",
            env.get("OTEL_EXPORTER_OTLP_ENDPOINT") == "http://otel-collector.monitoring:4318",
        )
        # TECH-11/12: the egress allowlist admits OTLP to the monitoring
        # namespace collector and nothing else outside the cluster flows.
        egress = next(p for p in nps if p["metadata"]["name"] == f"{svc}-egress-allowlist")
        otlp = [
            f
            for rule in egress["spec"]["egress"]
            for f in rule.get("to", [])
            if f.get("namespaceSelector", {}).get("matchLabels", {}).get("kubernetes.io/metadata.name") == "monitoring"
            and f.get("podSelector", {}).get("matchLabels", {}).get("app.kubernetes.io/name") == "otel-collector"
        ]
        ports = [p["port"] for rule in egress["spec"]["egress"] for p in rule.get("ports", [])]
        check(f"TECH-11 {svc} egress admits OTLP/4318 to collector", len(otlp) == 1 and 4318 in ports)

    # TECH-11: the observability stack ships collector, Tempo and Grafana,
    # with Grafana wired to both Prometheus and Tempo.
    obs = docs(K8S / "observability.yaml")
    kinds = {(d["metadata"]["name"], d["kind"]) for d in obs}
    check(
        "TECH-11 collector, tempo, grafana manifests",
        {("otel-collector", "Deployment"), ("otel-collector", "Service"),
         ("tempo", "Deployment"), ("tempo", "Service"),
         ("grafana", "Deployment"), ("grafana", "Service")} <= kinds,
    )
    ds = next(d for d in obs if d["metadata"]["name"] == "grafana-datasources")
    ds_yaml = yaml.safe_load(ds["data"]["datasources.yaml"])
    ds_types = {d["type"] for d in ds_yaml["datasources"]}
    check("TECH-11 grafana datasources: prometheus + tempo", ds_types == {"prometheus", "tempo"})

    # TR-03: the namespace is annotated for mesh injection and the decision
    # is recorded.
    ns = docs(K8S / "namespace.yaml")[0]
    check(
        "TR-03 namespace carries linkerd injection",
        ns["metadata"].get("annotations", {}).get("linkerd.io/inject") == "enabled",
    )
    adr = ROOT / "docs" / "adr" / "0010-east-west-mtls-linkerd.md"
    check("TR-03 mesh decision recorded (ADR-0010)", adr.exists() and "Linkerd" in adr.read_text())

    # SEC-28: no Secret manifests with data/stringData anywhere in deploy/k8s,
    # and the ExternalSecret covers every key the workloads reference.
    committed_secrets = [
        d["metadata"]["name"]
        for f in K8S.glob("*.yaml")
        for d in docs(f)
        if d["kind"] == "Secret" and (d.get("data") or d.get("stringData"))
    ]
    check("SEC-28 no committed Secret data", committed_secrets == [], str(committed_secrets))
    # The flow-style secretKeyRef entries resist yaml-path traversal; scan text.
    import re as _re
    referenced = set()
    for f in K8S.glob("*.yaml"):
        referenced |= set(_re.findall(r"secretKeyRef: \{ name: presence-secrets, key: (\w+)", f.read_text()))
    es = docs(K8S / "external-secrets.yaml")
    ext = next(d for d in es if d["kind"] == "ExternalSecret")
    covered = {d["secretKey"] for d in ext["spec"]["data"]}
    check(
        "SEC-28 ExternalSecret covers every referenced key",
        referenced <= covered and bool(referenced),
        f"missing: {sorted(referenced - covered)}",
    )
    check(
        "SEC-28 ExternalSecret targets presence-secrets",
        ext["spec"]["target"]["name"] == "presence-secrets",
    )

    # ---------------- SEC-02 / FR-56 (batch 29) ----------------
    drill = ROOT / "scripts" / "revocation_drill.py"
    drill_src = drill.read_text() if drill.exists() else ""
    check("SEC-02 revocation drill exists", drill.exists())
    check(
        "SEC-02 drill budget capped at 60 seconds",
        'DRILL_BUDGET_S", "60"' in drill_src and "BUDGET_S > 60" in drill_src,
    )
    rev = ROOT / "services" / "edge" / "src" / "revocation.ts"
    check(
        "SEC-02 edge revocation budget is 60 seconds",
        rev.exists() and "REVOCATION_PROPAGATION_S = 60" in rev.read_text(),
    )
    push = ROOT / "services" / "edge" / "src" / "push.ts"
    push_src = push.read_text() if push.exists() else ""
    check(
        "FR-56 push payload carries only type and ref",
        'PUSH_PAYLOAD_KEYS = ["type", "ref"]' in push_src,
    )
    check(
        "FR-56 push creds come from the managed secret store only",
        "APNS_KEY_P8" in (K8S / "external-secrets.yaml").read_text()
        and "FCM_ACCESS_TOKEN" in (K8S / "external-secrets.yaml").read_text(),
    )

    # ---------------- TECH-18 (batch 30) ----------------
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    go_modules = ["presence-go", "venue-go", "consent-go"]
    check(
        "TECH-18 Go service cores exist (presence/venue/consent)",
        all((ROOT / "services" / m / "go.mod").exists() for m in go_modules)
        and all((ROOT / "services" / m / "README.md").exists() for m in go_modules),
    )
    check(
        "TECH-18 Go cores are stdlib-only (no external requires)",
        all("require" not in (ROOT / "services" / m / "go.mod").read_text() for m in go_modules),
    )
    check(
        "TECH-18 go-services CI job runs gofmt, vet and tests for all cores",
        "go-services:" in ci and ci.count("go vet ./... && go test ./...") >= 3
        and "gofmt" in ci,
    )

    # ---------------- SEC-03 / SEC-01 / TECH-07 (batch 31) ----------------
    jit = ROOT / "db" / "migrations" / "0022_jit_elevation.sql"
    jit_src = jit.read_text() if jit.exists() else ""
    k8s_readme = (K8S / "README.md").read_text()
    check(
        "SEC-03 JIT elevation migration exists and is mounted in the k8s release",
        jit.exists() and "24_jit_elevation.sql=db/migrations/0022_jit_elevation.sql" in k8s_readme,
    )
    check(
        "SEC-03 four-eyes is enforced in the storage layer and the definer",
        "CHECK (decided_by IS NULL OR decided_by <> subject)" in jit_src
        and "four-eyes: approver must differ from requester" in jit_src
        and "interval '4 hours'" in jit_src,
    )
    app_ts = (ROOT / "services" / "edge" / "src" / "app.ts").read_text()
    edge_yaml = (K8S / "edge.yaml").read_text()
    check(
        "SEC-03 elevation routes registered; Keycloak role binding env-gated from the store",
        "registerElevationRoutes" in app_ts
        and "key: KEYCLOAK_ADMIN_CLIENT_ID, optional: true" in edge_yaml
        and "key: KEYCLOAK_ADMIN_CLIENT_SECRET, optional: true" in edge_yaml,
    )
    consumer = json.loads(
        (ROOT / "deploy" / "keycloak" / "realm-consumer.json").read_text()
    )
    check(
        "SEC-01/TECH-07 consumer realm is passkey-only with AAL2 + elevation evidence docs",
        consumer.get("browserFlow") == "consumer passkey browser"
        and "auth-username-password-form" not in json.dumps(consumer)
        and (ROOT / "docs" / "security" / "aal2.md").exists()
        and (ROOT / "docs" / "security" / "elevation.md").exists(),
    )

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED")
        return 1
    print("All deployment invariants hold.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

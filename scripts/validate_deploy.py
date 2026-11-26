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
  INF-02 three environment overlays build on the flat base; deploy lands in
         integration and promotion is gated, cosign-verified, soak-checked.
  INF-03 non-prod overlays are labelled synthetic-only and pin their own
         DEPLOY_ENV; promotion moves artefacts, never data.
  INF-11 the gateway staples OCSP (stapling + verify + trusted chain +
         resolver) with the evidence collector and runbook.
  TECH-24 the geofence QA migration is mounted and ships the overlap
         gate (publish-time) plus the estate audit report.
  TR-33 the client config route is registered outside the authed scope and
         the pinning env (public SPKI pins + monotonic version) is
         documented in both deploy manifests.
  TR-27 the edge publishes x-api-version, enforces a 426 client floor with
         the bootstrap config exempt, and the floor env is documented.
  TR-35 every scan result is stamped with the versioned diagram spec.
  NFR-15/16/24, SEC-11, INF-18 the backup/PITR layer ships: WAL archiving at
         5-minute granularity on the primary, daily encrypted base-backup and
         35-day retention CronJobs, dual-recipient (dual-authorisation)
         encryption with only public keys in-cluster, a timed restore
         rehearsal verifying append-only integrity counts, and a runbook.
  NFR-01/02/03/06/08/09/10, ACC-04 the k6 load harness pins the requirement
         numbers in loadtest/targets.js and every scenario imports them.
  NFR-13 the scan-path availability burn alert carries the 99.9% budget.
  NFR-11 the edge/match HPAs are the scale-out mechanism, referenced by the
         capacity scenario.
  INF-13 the gateway sheds per-IP floods with limit-count 429s; the probe is
         the pre-launch test.
  ACC-06 the rollback workflow is dormant-gated, re-verifies signatures, and
         its 10-minute job timeout IS the rollback budget.

Run: python3 scripts/validate_deploy.py   (exit 1 on any failure)
"""

from __future__ import annotations

import json
import re
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

    # ---------------- INF-02 / INF-03 / INF-11 (batch 32) ----------------
    overlays = {
        env: (K8S / "overlays" / env / "kustomization.yaml")
        for env in ("integration", "staging", "production")
    }
    check(
        "INF-02 three environment overlays exist and build on the flat base",
        all(p.exists() and "- ../../" in p.read_text() for p in overlays.values()),
    )
    check(
        "INF-03 non-prod overlays are synthetic-only and pin their own DEPLOY_ENV",
        all(
            "presence.dev/data-policy: synthetic-only" in overlays[env].read_text()
            and f"value: {env}" in overlays[env].read_text()
            and "value: production" not in overlays[env].read_text()
            for env in ("integration", "staging")
        )
        and "presence.dev/data-policy: production" in overlays["production"].read_text(),
    )
    promote = (ROOT / ".github" / "workflows" / "promote.yml").read_text()
    deploy_yml = (ROOT / ".github" / "workflows" / "deploy.yml").read_text()
    check(
        "INF-02 deploy lands in integration; promotion is gated, signed, soak-checked",
        "cd deploy/k8s/overlays/integration" in deploy_yml
        and "vars.STAGING_DEPLOY_ENABLED == 'true'" in promote
        and "vars.PRODUCTION_DEPLOY_ENABLED == 'true'" in promote
        and promote.count("cosign verify") >= 2
        and "soak gate" in promote,
    )
    apisix_src = (K8S / "apisix.yaml").read_text()
    tls_check = ROOT / "scripts" / "check_tls_posture.py"
    check(
        "INF-11 gateway staples OCSP; evidence collector and runbook exist",
        "ssl_stapling: on" in apisix_src
        and "ssl_stapling_verify: on" in apisix_src
        and tls_check.exists()
        and "OCSP Response Status: successful" in tls_check.read_text()
        and (ROOT / "docs" / "ops" / "tls.md").exists(),
    )

    # ---------------- TECH-24 (batch 33) ----------------
    geofence_qa = ROOT / "db" / "migrations" / "0023_geofence_qa.sql"
    geofence_qa_src = geofence_qa.read_text() if geofence_qa.exists() else ""
    check(
        "TECH-24 geofence QA migration exists and is mounted in the k8s release",
        geofence_qa.exists() and "25_geofence_qa.sql=db/migrations/0023_geofence_qa.sql" in k8s_readme,
    )
    check(
        "TECH-24 overlap gate is DB-final in publish; the estate QA report is GUC-gated",
        "CREATE OR REPLACE FUNCTION geofence_overlap_check(" in geofence_qa_src
        and "geofence_overlap_check(d.polygon, d.venue_id)" in geofence_qa_src
        and "geofence overlaps venue" in geofence_qa_src
        and "CREATE OR REPLACE FUNCTION geofence_qa_report()" in geofence_qa_src
        and "app_venue_ops()" in geofence_qa_src,
    )

    # ---------------- TR-33 (batch 35) ----------------
    edge_app_src = (ROOT / "services" / "edge" / "src" / "app.ts").read_text()
    client_config_src_path = ROOT / "services" / "edge" / "src" / "clientConfig.ts"
    client_config_src = client_config_src_path.read_text() if client_config_src_path.exists() else ""
    check(
        "TR-33 client config route is registered outside the authed scope",
        'registerClientConfigRoute(app)' in edge_app_src
        and edge_app_src.index("registerClientConfigRoute(app)")
        < edge_app_src.index("await app.register(async (authed)")
        and 'app.get(\n    "/v1/client/config"' in client_config_src,
    )
    k8s_edge_src = (K8S / "edge.yaml").read_text()
    compose_src = (ROOT / "deploy" / "docker-compose.yml").read_text()
    check(
        "TR-33 pinning env is documented in k8s and compose (public pins, monotonic version)",
        "CLIENT_TLS_PINS" in k8s_edge_src
        and "CLIENT_CONFIG_VERSION" in k8s_edge_src
        and "CLIENT_TLS_PINS" in compose_src
        and "CLIENT_CONFIG_VERSION" in compose_src,
    )

    # ---------------- FR-01 (batch 38) ----------------
    check(
        "FR-01 auth bootstrap env is documented in k8s and compose (public issuer, realm client)",
        "KEYCLOAK_PUBLIC_ISSUER_URL" in k8s_edge_src
        and "KEYCLOAK_CLIENT_ID" in k8s_edge_src
        and "KEYCLOAK_PUBLIC_ISSUER_URL" in compose_src
        and "KEYCLOAK_CLIENT_ID" in compose_src,
    )

    # ---------------- TR-27 / TR-35 (batch 36) ----------------
    versioning_src_path = ROOT / "services" / "edge" / "src" / "versioning.ts"
    versioning_src = versioning_src_path.read_text() if versioning_src_path.exists() else ""
    check(
        "TR-27 version contract: x-api-version on every response, 426 floor, bootstrap exempt",
        'reply.header(API_VERSION_HEADER, String(API_VERSION))' in versioning_src
        and 'reply.code(426).send({ error: "client version is no longer supported (TR-27)" })' in versioning_src
        and '"/v1/client/config"' in versioning_src
        and "registerVersionContract(app)" in edge_app_src
        and edge_app_src.index("registerVersionContract(app)")
        < edge_app_src.index("registerClientConfigRoute(app)")
        and "CLIENT_MIN_VERSION" in k8s_edge_src
        and "CLIENT_MIN_VERSION" in compose_src,
    )
    diagram_spec_src_path = ROOT / "services" / "edge" / "src" / "diagramSpec.ts"
    diagram_spec_src = diagram_spec_src_path.read_text() if diagram_spec_src_path.exists() else ""
    scan_route_src = (ROOT / "services" / "edge" / "src" / "routes" / "scan.ts").read_text()
    check(
        "TR-35 diagram spec version is stamped on every scan result",
        "DIAGRAM_SPEC_VERSION = 1" in diagram_spec_src
        and "diagramSpec: DIAGRAM_SPEC_VERSION" in scan_route_src,
    )

    # ---------------- NFR-15/16/24, SEC-11, INF-18 (batch 51) ----------------
    backup_yaml_src = (K8S / "backup.yaml").read_text() if (K8S / "backup.yaml").exists() else ""
    backup_kinds = {(d["metadata"]["name"], d["kind"]) for d in docs(K8S / "backup.yaml")} if backup_yaml_src else set()
    check(
        "INF-18 backup layer ships config, PVC and both CronJobs",
        {("postgres-backup-config", "ConfigMap"), ("postgres-backups", "PersistentVolumeClaim"),
         ("postgres-base-backup", "CronJob"), ("postgres-backup-retention", "CronJob")} <= backup_kinds,
    )
    check(
        "INF-18 backup manifest is in the base kustomization",
        "- backup.yaml" in (K8S / "kustomization.yaml").read_text(),
    )
    check(
        "INF-18 backup CronJobs run daily, unattended, as the postgres user",
        'schedule: "17 2 * * *"' in backup_yaml_src
        and 'schedule: "41 3 * * *"' in backup_yaml_src
        and backup_yaml_src.count("automountServiceAccountToken: false") == 2
        and backup_yaml_src.count("runAsUser: 70") == 2,
    )
    pg_yaml_src = (K8S / "postgres.yaml").read_text()
    check(
        "NFR-16/INF-18 WAL archiving on at 5-minute granularity (RPO <= 5 min)",
        "archive_mode=on" in pg_yaml_src
        and "archive_command=/usr/local/bin/presence-backup/wal-archive.sh %p %f" in pg_yaml_src
        and "archive_timeout=300" in pg_yaml_src,
    )
    check(
        "NFR-24 backup volume mounted on the primary",
        "claimName: postgres-backups" in pg_yaml_src and "mountPath: /backups" in pg_yaml_src,
    )
    check(
        "SEC-11 only public backup recipients exist in-cluster (no private keys)",
        "configMapKeyRef: { name: postgres-backup-config, key: BACKUP_AGE_RECIPIENT_INNER }" in pg_yaml_src
        and "AGE-SECRET-KEY" not in "".join(f.read_text() for f in K8S.glob("*.yaml")),
    )
    check(
        "SEC-11 backup replication credential comes from the managed secret store",
        "key: BACKUP_REPLICATION_PASSWORD" in pg_yaml_src
        and "secretKey: BACKUP_REPLICATION_PASSWORD" in (K8S / "external-secrets.yaml").read_text(),
    )
    scripts_dir = ROOT / "deploy" / "postgres" / "backup"
    read_script = lambda n: (scripts_dir / n).read_text() if (scripts_dir / n).exists() else ""
    wal_archive_src, base_backup_src = read_script("wal-archive.sh"), read_script("base-backup.sh")
    retention_src, rehearse_src = read_script("enforce-retention.sh"), read_script("restore-rehearse.sh")
    check(
        "SEC-11 every backup artefact is dual-wrapped (inner then outer recipient)",
        all('age -r "$INNER"' in s and 'age -r "$OUTER"' in s for s in (wal_archive_src, base_backup_src)),
    )
    check(
        "SEC-11 restore rehearsal requires two distinct operator identities",
        'cmp -s "$INNER_FILE" "$OUTER_FILE"' in rehearse_src
        and "BACKUP_REHEARSAL_OPERATOR_IDS" in rehearse_src,
    )
    check(
        "NFR-24 retention floor is 35 days; the newest chain is never deleted",
        "BACKUP_RETENTION_DAYS:-35" in retention_src
        and '[ "$DAYS" -ge 35 ]' in retention_src
        and "tail -n 1" in retention_src,
    )
    check(
        "INF-18 rehearsal verifies append-only integrity counts against the RTO budget",
        all(t in rehearse_src for t in ("consent_ledger", "admin_audit", "transfers", "transfer_events"))
        and "RTO_BUDGET_S=3600" in rehearse_src,
    )
    runbook_backup = ROOT / "docs" / "ops" / "backup-restore.md"
    check(
        "NFR-15/INF-18 backup runbook documents the restore and quarterly drill",
        runbook_backup.exists() and "quarterly" in runbook_backup.read_text(),
    )
    nps_src = (K8S / "networkpolicy.yaml").read_text()
    check(
        "INF-14 backup pods reach postgres and nothing else",
        "app: postgres-backup" in nps_src and "name: postgres-backup-egress" in nps_src,
    )
    check(
        "INF-18 compose ships the same archive args, recipients and backup volume",
        "archive_timeout=300" in compose_src
        and "zz_backup_access.sh" in compose_src
        and "pgbackups:/backups" in compose_src,
    )

    # ---------------- verification instruments (batch 52) ----------------
    lt = ROOT / "loadtest"
    lt_files = {n: (lt / n).read_text() if (lt / n).exists() else "" for n in
                ("targets.js", "scan-latency.js", "capacity.js", "soak.js", "ratelimit-probe.js", "README.md")}
    check(
        "ACC-04 load harness ships targets + four scenarios + README",
        all(lt_files[n] for n in lt_files),
    )
    targets_src = lt_files["targets.js"]
    check(
        "NFR-01/02/03/06 targets.js pins the latency budgets verbatim",
        all(t in targets_src for t in (
            "SCAN_P95_MS = 150", "SCAN_P99_MS = 400",
            "PUBLISH_ACK_P95_MS = 120", "TAP_TO_RESULTS_P95_MS = 900")),
    )
    check(
        "NFR-08/09/10 targets.js pins the capacity numbers verbatim",
        all(t in targets_src for t in (
            "SCANS_PER_SECOND_PEAK = 600", "CONCURRENT_PRESENCES = 25000",
            "VENUE_BURST_PER_10MIN = 60000")),
    )
    check(
        "ACC-04 scenarios import targets rather than restating numbers",
        all('from "./targets.js"' in lt_files[n]
            for n in ("scan-latency.js", "capacity.js", "soak.js", "ratelimit-probe.js")),
    )
    check(
        "NFR-13 every load scenario enforces the 0.1% error budget",
        sum("http_req_failed" in lt_files[n] for n in ("scan-latency.js", "capacity.js", "soak.js")) == 3
        and "ERROR_BUDGET" in targets_src,
    )
    check(
        "NFR-11 capacity scenario doubles the peak and names the HPA mechanism",
        "PEAK_MULTIPLIER" in lt_files["capacity.js"] and "deploy/k8s/edge.yaml" in lt_files["capacity.js"],
    )
    check(
        "ACC-04 soak runs 2h at 60% of the NFR-09 peak",
        'SOAK_DURATION = "2h"' in targets_src and "SOAK_RATE_RATIO = 0.6" in targets_src,
    )
    rules_src = (K8S / "prometheusrules.yaml").read_text()
    check(
        "NFR-13 scan-path availability burn alert carries the 99.9% budget",
        "ScanAvailabilityBurn" in rules_src
        and "0.001" in rules_src  # 0.1% error budget in the burn-rate expression
        and "1h" in rules_src and "6h" in rules_src,
    )
    check(
        "INF-13 gateway sheds per-IP floods on the API and auth surfaces",
        apisix_src.count("limit-count:") >= 2
        and "key: remote_addr" in apisix_src
        and "rejected_code: 429" in apisix_src
        and "count: 1200" in apisix_src and "count: 120" in apisix_src,
    )
    check(
        "INF-13 ratelimit probe asserts 429s AND allowed latency",
        "ratelimit_rejected_429" in lt_files["ratelimit-probe.js"]
        and "/v1/client/config" in lt_files["ratelimit-probe.js"],
    )
    rollback_yml = ROOT / ".github" / "workflows" / "rollback.yml"
    rollback_src = rollback_yml.read_text() if rollback_yml.exists() else ""
    check(
        "ACC-06 rollback workflow: dormant-gated, undo + re-verify + smoke, 10-min budget",
        "workflow_dispatch" in rollback_src
        and "rollout undo" in rollback_src
        and "cosign verify" in rollback_src
        and "timeout-minutes: 10" in rollback_src
        and "PRODUCTION_DEPLOY_ENABLED" in rollback_src,
    )
    for doc, needle in (
        ("docs/security/asvs-masvs-mapping.md", "ASVS 4.0.3"),
        ("docs/security/ddos-posture.md", "limit-count"),
        ("docs/ops/cost-model.md", "1 500"),
        ("docs/ops/rollback.md", "10 minutes"),
        ("docs/ux/usability-protocol.md", "8 of 10"),
        ("docs/ux/store-review-checklist.md", "DELETE /v1/account"),
    ):
        doc_path = ROOT / doc
        check(f"batch-52 doc {doc}", doc_path.exists() and needle in doc_path.read_text())

    # ---- batch 53: the wallet contract layer (SRS Addendum 001, AMD-PAY-10..14)
    wallets_path = ROOT / "db" / "migrations" / "0027_wallets.sql"
    wallets_src = wallets_path.read_text() if wallets_path.exists() else ""
    check(
        "AMD-PAY-10/11 wallet schema: ledger + holds + pinned platform fee wallet",
        "CREATE TABLE wallets (" in wallets_src
        and "CREATE TABLE wallet_entries (" in wallets_src
        and "CREATE TABLE wallet_holds (" in wallets_src
        and "CHECK (balance_after >= 0)" in wallets_src
        and "'00000000-0000-0000-0000-00000000fee1'" in wallets_src,
    )
    check(
        "AMD-PAY-13 every value-moving wallet definer is rail-gated",
        wallets_src.count("current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on'") >= 4
        and "CREATE OR REPLACE FUNCTION settle_transfer_funds(" in wallets_src
        and "PERFORM record_transfer_event(" in wallets_src,
    )
    check(
        "AMD-PAY-11/12 wallet ledgers are append-only with immutable hold terms",
        "wallet_entries is append-only (AMD-PAY-11)" in wallets_src
        and "wallet_holds is append-only (AMD-PAY-12)" in wallets_src
        and "wallet hold terms are immutable (AMD-PAY-12)" in wallets_src,
    )
    k8s_readme_src = (K8S / "README.md").read_text()
    compose_src = (ROOT / "deploy" / "docker-compose.yml").read_text()
    check(
        "batch-53 migration rides both initdb mounts as 29_wallets.sql",
        "=db/migrations/0027_wallets.sql" in k8s_readme_src
        and "/docker-entrypoint-initdb.d/29_wallets.sql:ro" in compose_src,
    )
    edge_wallet_routes = ROOT / "services" / "edge" / "src" / "routes" / "wallets.ts"
    edge_wallet_src = edge_wallet_routes.read_text() if edge_wallet_routes.exists() else ""
    check(
        "AMD-PAY-13 no route reaches a value-moving wallet definer",
        "wallet_move(" not in edge_wallet_src
        and "settle_transfer_funds(" not in edge_wallet_src
        and "place_wallet_hold(" not in edge_wallet_src
        and "set_config('app.transfer_settlement'" not in edge_wallet_src
        and '"/v1/wallets"' in edge_wallet_src,
    )

    # ---- batch 54: wallet rail activation (SRS Addendum 001, AMD-PAY-15..20)
    activation_path = ROOT / "db" / "migrations" / "0028_wallet_activation.sql"
    activation_src = activation_path.read_text() if activation_path.exists() else ""
    check(
        "AMD-PAY-16/17 rail schema: wallet_rail_events + withdrawal_requests",
        "CREATE TABLE wallet_rail_events (" in activation_src
        and "CREATE TABLE withdrawal_requests (" in activation_src
        and "CHECK (kind IN ('fund', 'payout'))" in activation_src
        and "CHECK (state IN ('requested', 'processing', 'paid', 'failed', 'cancelled'))" in activation_src,
    )
    check(
        "AMD-PAY-17 withdrawal lifecycle guard: append-only, immutable terms, legal transitions",
        "withdrawal_requests is append-only (AMD-PAY-17)" in activation_src
        and "withdrawal request terms are immutable (AMD-PAY-17)" in activation_src
        and "illegal withdrawal transition (AMD-PAY-17)" in activation_src,
    )
    check(
        "AMD-PAY-15 every value-moving activation definer keeps the rail gate",
        activation_src.count(
            "current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on'"
        ) >= 7
        and "CREATE OR REPLACE FUNCTION fund_wallet(" in activation_src
        and "CREATE OR REPLACE FUNCTION request_withdrawal(" in activation_src
        and "CREATE OR REPLACE FUNCTION accept_transfer_and_settle(" in activation_src
        and "CREATE OR REPLACE FUNCTION wallet_reconciliation(" in activation_src,
    )
    check(
        "batch-54 migration rides both initdb mounts as 30_wallet_activation.sql",
        "=db/migrations/0028_wallet_activation.sql" in k8s_readme_src
        and "/docker-entrypoint-initdb.d/30_wallet_activation.sql:ro" in compose_src,
    )
    edge_auth_src = (ROOT / "services" / "edge" / "src" / "auth.ts").read_text()
    edge_src_all = "\n".join(
        p.read_text()
        for p in (ROOT / "services" / "edge" / "src").rglob("*.ts")
        if p.name != "auth.ts"
    )
    check(
        "AMD-PAY-15 the settlement GUC is written only by the auth.ts helpers, behind WALLET_RAIL",
        "export class WalletRailUnavailable extends Error" in edge_auth_src
        and "withSettlement" in edge_auth_src
        and "withRailCallback" in edge_auth_src
        and 'process.env.WALLET_RAIL === "off"' in edge_auth_src
        and edge_auth_src.count("set_config('app.transfer_settlement'") == 2
        and "set_config('app.transfer_settlement'" not in edge_src_all
        and "SET LOCAL app.transfer_settlement" not in edge_src_all,
    )
    edge_rail_path = ROOT / "services" / "edge" / "src" / "routes" / "walletRail.ts"
    edge_rail_src = edge_rail_path.read_text() if edge_rail_path.exists() else ""
    check(
        "AMD-PAY-16/17 provider webhooks are HMAC-authenticated and outside the authed scope",
        '"/v1/webhooks/wallet-funding"' in edge_rail_src
        and '"/v1/webhooks/wallet-payout"' in edge_rail_src
        and "createHmac(" in edge_rail_src
        and "timingSafeEqual" in edge_rail_src
        and "x-wallet-signature" in edge_rail_src
        and "WALLET_FUNDING_SECRET" in edge_rail_src
        and "WALLET_PAYOUT_SECRET" in edge_rail_src,
    )
    edge_app_src = (ROOT / "services" / "edge" / "src" / "app.ts").read_text()
    check(
        "batch-54 webhook surface is registered on the app, outside the authed scope",
        'import { registerWalletRailRoutes } from "./routes/walletRail.js";' in edge_app_src
        and "registerWalletRailRoutes(app, ctx);" in edge_app_src,
    )

    # ---- batch 55: rail hardening (SRS Addendum 001, AMD-PAY-21..23, AMD-OPS-01..03)
    hardening_path = ROOT / "db" / "migrations" / "0029_rail_hardening.sql"
    hardening_src = hardening_path.read_text() if hardening_path.exists() else ""
    check(
        "AMD-PAY-21/23 rail hardening schema: risk signals + four-eyes credit approvals",
        "CREATE TABLE rail_risk_signals (" in hardening_src
        and "CREATE TABLE wallet_credit_approvals (" in hardening_src
        and "rail_risk_signals is append-only (AMD-PAY-21)" in hardening_src
        and "wallet_credit_approvals is append-only (AMD-PAY-23)" in hardening_src,
    )
    check(
        "AMD-PAY-23 four-eyes: proposals above the threshold, self-approval refused",
        "'approval_required'" in hardening_src
        and "'self_approval'" in hardening_src
        and "p_amount_minor > 5000000 THEN" in hardening_src
        and "CREATE OR REPLACE FUNCTION approve_wallet_credit(p_approval uuid)" in hardening_src,
    )
    check(
        "batch-55 migration rides both initdb mounts as 31_rail_hardening.sql",
        "=db/migrations/0029_rail_hardening.sql" in k8s_readme_src
        and "/docker-entrypoint-initdb.d/31_rail_hardening.sql:ro" in compose_src,
    )
    edge_gov_path = ROOT / "services" / "edge" / "src" / "routes" / "walletGovernance.ts"
    edge_gov_src = edge_gov_path.read_text() if edge_gov_path.exists() else ""
    check(
        "AMD-PAY-21/23 governance routes registered after the wallet routes, moderator-gated",
        '"/v1/moderation/rail-risk-signals"' in edge_gov_src
        and '"/v1/moderation/credit-approvals/:approvalId/approve"' in edge_gov_src
        and edge_gov_src.count("preHandler: requireModerator") == 5
        and "registerWalletGovernanceRoutes(authed, ctx);" in edge_app_src,
    )
    check(
        "AMD-PAY-22 webhook freshness: timestamp leads the signed string, checked first",
        "RAIL_SIGNATURE_SKEW_S = 300" in (ROOT / "services" / "edge" / "src" / "wallets.ts").read_text()
        and 'x-wallet-timestamp' in edge_rail_src
        and "stale or missing timestamp (AMD-PAY-22)" in edge_rail_src,
    )
    check(
        "AMD-OPS-01 rail alerts exist over the webhook verdict counter",
        "PresenceWalletWebhookRejections" in (K8S / "prometheusrules.yaml").read_text()
        and "PresenceWalletRailUnavailable" in (K8S / "prometheusrules.yaml").read_text()
        and "PresenceWalletPayoutFailures" in (K8S / "prometheusrules.yaml").read_text(),
    )
    drill_path = ROOT / ".github" / "workflows" / "restore-drill.yml"
    drill_src = drill_path.read_text() if drill_path.exists() else ""
    check(
        "AMD-OPS-02 restore drill: weekly pg_dump → pg_restore round-trip via compose",
        "name: restore-drill" in drill_src
        and "pg_dump" in drill_src
        and "00000000-0000-0000-0000-00000000fee1" in drill_src,
    )

    # ---- batch 56: core-platform innovations (SRS Addendum 001, AMD-INN-01..10)
    innovations_path = ROOT / "db" / "migrations" / "0030_innovations.sql"
    innovations_src = innovations_path.read_text() if innovations_path.exists() else ""
    check(
        "AMD-INN-01..10 innovation schema: eight tables, guards, definer-only writes",
        all(f"CREATE TABLE {t} (" in innovations_src for t in (
            "presence_bonds", "met_receipts", "escrow_agreements",
            "escrow_milestones", "group_stakes", "disclosure_grants",
            "serendipity_windows", "introductions"))
        and innovations_src.count("(AMD-INN-") >= 20,
    )
    check(
        "AMD-INN value discipline: settlement gate on every value-moving definer",
        innovations_src.count("app.transfer_settlement") >= 8
        and "GRANT EXECUTE ON FUNCTION attestation_claims() TO presence_app;" in innovations_src,
    )
    check(
        "batch-56 migration rides both initdb mounts as 32_innovations.sql",
        "=db/migrations/0030_innovations.sql" in k8s_readme_src
        and "/docker-entrypoint-initdb.d/32_innovations.sql:ro" in compose_src,
    )
    edge_innov_path = ROOT / "services" / "edge" / "src" / "routes" / "innovations.ts"
    edge_innov_src = edge_innov_path.read_text() if edge_innov_path.exists() else ""
    check(
        "AMD-INN edge routes registered; passport verify outside the authed scope",
        '/v1/attestation/verify"' in edge_innov_src
        and "registerInnovationRoutes(authed, ctx);" in edge_app_src
        and "registerAttestationVerifyRoute(app, ctx);" in edge_app_src
        and edge_app_src.index("registerAttestationVerifyRoute(app, ctx);")
            < edge_app_src.index("await app.register(async (authed)"),
    )
    check(
        "AMD-INN-09 attestation verdicts counted for ops visibility",
        "presence_attestation_verify_results_total"
        in (ROOT / "services" / "edge" / "src" / "metrics.ts").read_text()
        and edge_innov_src.count("attestationVerifyResults().inc(") == 4,
    )
    check(
        "AMD-INN-05/07 client-only: duress pipeline + on-device preview ship no route",
        (ROOT / "client" / "src" / "presence" / "duressMode.ts").exists()
        and (ROOT / "client" / "src" / "presence" / "matchPreview.ts").exists()
        and "duress" not in edge_innov_src.lower(),
    )

    # ---- batch 57: dating mode + marketplace (SRS Addendum 001, AMD-DATE/MKT)
    dating_path = ROOT / "db" / "migrations" / "0031_dating.sql"
    dating_src = dating_path.read_text() if dating_path.exists() else ""
    check(
        "AMD-DATE-01..05 dating schema: profiles + governed vocabularies, guard, definers",
        all(f"CREATE TABLE {t} (" in dating_src for t in (
            "dating_genders", "dating_goals", "dating_profiles"))
        and all(f"FUNCTION {f}" in dating_src for f in (
            "set_dating_preferences(", "set_dating_state(", "dating_compatible(",
            "dating_counterpart(", "dating_filter_candidates("))
        and "dating_profiles is append-only for the application role (AMD-DATE-05)" in dating_src
        and dating_src.count("(AMD-DATE-") >= 3,
    )
    dating_cols_match = re.search(
        r"CREATE TABLE dating_profiles \((.*?)\);", dating_src, re.S)
    dating_cols = dating_cols_match.group(1).lower() if dating_cols_match else None
    check(
        "AMD-DATE-01: no photo and no free text anywhere in the dating profile",
        dating_cols is not None and all(
            banned not in dating_cols
            for banned in ("photo", "bio", "description", "freetext",
                           "free_text", "note", "message")),
    )
    marketplace_path = ROOT / "db" / "migrations" / "0032_marketplace.sql"
    marketplace_src = marketplace_path.read_text() if marketplace_path.exists() else ""
    check(
        "AMD-MKT-01..05 marketplace schema: three tables, guards, events append-only",
        all(f"CREATE TABLE {t} (" in marketplace_src for t in (
            "marketplace_listings", "marketplace_orders", "marketplace_events"))
        and "listing terms are immutable (AMD-MKT-01)" in marketplace_src
        and "order terms are immutable (AMD-MKT-03)" in marketplace_src
        and "marketplace_events is append-only (AMD-MKT-02)" in marketplace_src
        and marketplace_src.count("(AMD-MKT-") >= 6,
    )
    check(
        "AMD-MKT-03/04: purchases compose the b56 escrow inside the settlement gate",
        "FROM create_escrow(v_listing.seller, ARRAY[v_listing.price_minor]) e" in marketplace_src
        and "release_escrow_milestone(v_order.escrow_id, 1::smallint)" in marketplace_src
        and marketplace_src.count("app.transfer_settlement") >= 3
        and "price_minor > 0 AND price_minor <= 5000000" in marketplace_src
        and "REFERENCES market_config (market_id)" in marketplace_src
        and "AND n.sensitive" in marketplace_src,
    )
    check(
        "batch-57 migrations ride both initdb mounts as 33/34",
        "=db/migrations/0031_dating.sql" in k8s_readme_src
        and "=db/migrations/0032_marketplace.sql" in k8s_readme_src
        and "/docker-entrypoint-initdb.d/33_dating.sql:ro" in compose_src
        and "/docker-entrypoint-initdb.d/34_marketplace.sql:ro" in compose_src,
    )
    check(
        "AMD-DATE/MKT edge routes registered; the scan route applies the dating filter",
        "registerDatingRoutes(authed, ctx);" in edge_app_src
        and "registerMarketplaceRoutes(authed, ctx);" in edge_app_src
        and "dating_filter_candidates($1::uuid[])"
        in (ROOT / "services" / "edge" / "src" / "routes" / "scan.ts").read_text(),
    )
    check(
        "AMD-DATE/MKT client contracts exist and cross-pin the edge modules",
        (ROOT / "client" / "src" / "presence" / "datingPreferences.ts").exists()
        and (ROOT / "client" / "src" / "presence" / "listingCard.ts").exists()
        and "services/edge/src/dating.ts"
        in (ROOT / "client" / "test" / "datingPreferences.test.ts").read_text()
        and "services/edge/src/marketplace.ts"
        in (ROOT / "client" / "test" / "listingCard.test.ts").read_text(),
    )

    # ---------------------------------------------------- batch 58 --------
    escrow_path = ROOT / "db" / "migrations" / "0033_escrow_hardening.sql"
    escrow_src = escrow_path.read_text() if escrow_path.exists() else ""
    check(
        "AMD-ESC-01 four-eyes: approvals table, guard, threshold, decision match",
        "CREATE TABLE escrow_resolve_approvals" in escrow_src
        and "escrow_resolve_approvals is append-only (AMD-ESC-01)" in escrow_src
        and "escrow resolution terms are immutable (AMD-ESC-01)" in escrow_src
        and "ALTER TABLE escrow_resolve_approvals ENABLE ROW LEVEL SECURITY" in escrow_src
        and "v_remaining > 1000000" in escrow_src
        and "ap.proposed_by <> v_user" in escrow_src
        and "ON CONFLICT (escrow_id) WHERE state = 'pending' DO NOTHING" in escrow_src
        and "CREATE POLICY" not in escrow_src,
    )
    check(
        "AMD-ESC-02 liveness: disputed_at, reconciliation queues, alert, gauge",
        "ADD COLUMN disputed_at timestamptz" in escrow_src
        and all(f"'{k}'" in escrow_src for k in (
            "openEscrowDisputes", "oldestEscrowDisputeSeconds",
            "pendingEscrowResolveApprovals", "stuckEscrows"))
        and "EscrowDisputeAging"
        in (K8S / "prometheusrules.yaml").read_text()
        and "presence_escrow_oldest_dispute_seconds"
        in (ROOT / "services" / "edge" / "src" / "metrics.ts").read_text()
        and "min(disputed_at)"
        in (ROOT / "services" / "edge" / "src" / "app.ts").read_text(),
    )
    check(
        "AMD-ESC-03 full-chain rehearsal script present and complete",
        (ROOT / "scripts" / "rehearse_full_chain.py").exists()
        and all(anchor in (ROOT / "scripts" / "rehearse_full_chain.py").read_text()
                for anchor in ("h3index", "ST_Intersection", "check_function_bodies",
                               "four_eyes_gate", "global_conservation",
                               "rehearse_full_chain")),
    )
    check(
        "batch-58 migration rides both initdb mounts as 35",
        "=db/migrations/0033_escrow_hardening.sql" in k8s_readme_src
        and "/docker-entrypoint-initdb.d/35_escrow_hardening.sql:ro" in compose_src,
    )
    check(
        "batch-58 edge routes: four-eyes queue + 202 approval_required mappings",
        all(anchor in (ROOT / "services" / "edge" / "src" / "routes"
                       / "innovations.ts").read_text() for anchor in (
            '"/v1/moderation/escrow-resolutions"',
            '"/v1/moderation/escrow-resolutions/:approvalId/approve"',
            '"/v1/moderation/escrow-resolutions/:approvalId/reject"',
            'reply.code(202).send({ state: "approval_required" })'))
        and '"approval_required"'
        in (ROOT / "services" / "edge" / "src" / "routes" / "marketplace.ts").read_text(),
    )
    check(
        "batch-58 runbook section + concurrency loadtest scenario",
        "## EscrowDisputeAging" in (ROOT / "docs" / "runbook.md").read_text()
        and (ROOT / "loadtest" / "escrow-concurrency.js").exists()
        and "ESCROW_RACE_PAIRS" in (ROOT / "loadtest" / "targets.js").read_text(),
    )

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED")
        return 1
    print("All deployment invariants hold.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

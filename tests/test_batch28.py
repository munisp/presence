"""Batch 28 — observability, migration rehearsal, managed secrets, east-west
mutual authentication.

TECH-11  OpenTelemetry + Grafana observability stack
TECH-12  health endpoint, structured logs and OTel traces by default
INF-17   forward-only, reviewed, rehearsed migrations
SEC-28   no production credentials in source; managed secret store
TR-03    inter-service traffic over private transport with mutual auth

Wiring invariants asserted against the sources and manifests; behavioural
pins live in the node suites and validate_deploy.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import rehearse_migrations  # noqa: E402

EDGE_INDEX = (ROOT / "services" / "edge" / "src" / "index.ts").read_text()
EDGE_TRACING = (ROOT / "services" / "edge" / "src" / "tracing.ts").read_text()
MATCH_INDEX = (ROOT / "services" / "match" / "src" / "index.ts").read_text()
MATCH_TRACING = (ROOT / "services" / "match" / "src" / "tracing.ts").read_text()
EDGE_PKG = (ROOT / "services" / "edge" / "package.json").read_text()
MATCH_PKG = (ROOT / "services" / "match" / "package.json").read_text()
OBSERVABILITY = (ROOT / "deploy" / "k8s" / "observability.yaml").read_text()
EXTERNAL_SECRETS = (ROOT / "deploy" / "k8s" / "external-secrets.yaml").read_text()
CI = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
OPS_DOC = (ROOT / "docs" / "ops" / "migrations.md").read_text()
ADR = (ROOT / "docs" / "adr" / "0010-east-west-mtls-linkerd.md").read_text()
README = (ROOT / "deploy" / "k8s" / "README.md").read_text()
MIGRATIONS = sorted((ROOT / "db" / "migrations").glob("*.sql"))


# ----------------------------------------------------------------- TECH-12 --

def test_tech12_tracing_starts_before_the_module_graph():
    for index, name in ((EDGE_INDEX, "presence-edge"), (MATCH_INDEX, "presence-match")):
        assert f'startTracing("{name}")' in index
        assert 'await import("./main.js")' in index
        assert index.index("startTracing(") < index.index("await import(")
        # The only static import is the tracing module itself — anything else
        # would load unpatched before the SDK is up.
        static_imports = [l for l in index.splitlines() if l.startswith("import ")]
        assert static_imports == ['import { startTracing } from "./tracing.js";'], static_imports


def test_tech12_sdk_auto_instruments_the_service_surfaces():
    for tracing in (EDGE_TRACING, MATCH_TRACING):
        assert "getNodeAutoInstrumentations" in tracing
        assert "OTLPTraceExporter" in tracing
        assert "OTEL_SDK_DISABLED" in tracing  # opt-out for bare-metal runs
        assert "instrumentation-fs" in tracing  # fs spans are noise here


def test_tech12_otel_dependencies_declared():
    for pkg in (EDGE_PKG, MATCH_PKG):
        assert "@opentelemetry/sdk-node" in pkg
        assert "@opentelemetry/auto-instrumentations-node" in pkg
        assert "@opentelemetry/exporter-trace-otlp-http" in pkg


# ----------------------------------------------------------------- TECH-11 --

def test_tech11_stack_is_collector_tempo_grafana():
    assert "otel/opentelemetry-collector" in OBSERVABILITY
    assert "grafana/tempo" in OBSERVABILITY
    assert "grafana/grafana" in OBSERVABILITY
    assert "otlp/tempo" in OBSERVABILITY  # collector forwards to Tempo
    assert "name: Prometheus" in OBSERVABILITY and "name: Tempo" in OBSERVABILITY


def test_tech11_grafana_internal_only():
    # AGPL constraint honoured: no Service exposes Grafana (or anything in
    # the stack) outside the cluster.
    assert "type: LoadBalancer" not in OBSERVABILITY
    assert "NodePort" not in OBSERVABILITY
    assert "GF_AUTH_ANONYMOUS_ORG_ROLE" in OBSERVABILITY  # viewer-only fallback


# ------------------------------------------------------------------ INF-17 --

def test_inf17_forward_only_lint_clean_on_the_tree():
    assert rehearse_migrations.lint_forward_only(MIGRATIONS) == []


def test_inf17_lint_catches_destructive_sql(tmp_path):
    bad = tmp_path / "9999_bad.sql"
    bad.write_text("BEGIN;\nDROP TABLE users;\nALTER TABLE matches DROP COLUMN state;\n")
    violations = rehearse_migrations.lint_forward_only([bad])
    assert len(violations) == 2
    assert "DROP TABLE" in violations[0] and "DROP COLUMN" in violations[1]


def test_inf17_lint_ignores_comments_and_governed_purges(tmp_path):
    ok = tmp_path / "0001_ok.sql"
    ok.write_text(
        "-- never DROP TABLE in production\n"
        "CREATE FUNCTION purge() RETURNS void LANGUAGE sql AS $$\n"
        "  DELETE FROM messages WHERE sent_at < now() - interval '24 hours';\n"
        "$$;\n"
    )
    assert rehearse_migrations.lint_forward_only([ok]) == []


def test_inf17_snapshot_is_production_sized_and_fk_ordered():
    stmts = rehearse_migrations.snapshot_statements(1.0)
    labels = [l for l, _ in stmts]
    # Dependency order: taxonomy -> users -> profiles; venues -> events;
    # pairs -> matches -> messages/ledger/reports.
    assert labels.index("taxonomy roots") < labels.index("profile interests")
    assert labels.index("users") < labels.index("profile interests")
    assert labels.index("venues") < labels.index("events")
    assert labels.index("matches") < labels.index("messages")
    assert labels.index("matches") < labels.index("consent ledger")
    assert labels.index("matches") < labels.index("reports")
    sql = "\n".join(s for _, s in stmts)
    for figure in ("100000", "600000"):
        assert figure in sql.replace("_", "")


def test_inf17_rehearsal_gate_runs_in_ci():
    assert "migration-rehearsal:" in CI
    assert "rehearse_migrations.py" in CI
    assert "postgres:17-alpine" in CI


def test_inf17_review_checklist_documented():
    for topic in ("Forward-only", "Reviewed", "Rehearsed", "Lock profile"):
        assert topic in OPS_DOC


# ------------------------------------------------------------------ SEC-28 --

def test_sec28_external_secret_covers_every_referenced_key():
    import re

    referenced = set()
    for f in (ROOT / "deploy" / "k8s").glob("*.yaml"):
        referenced |= set(re.findall(r"secretKeyRef: \{ name: presence-secrets, key: (\w+)", f.read_text()))
    assert len(referenced) == 22  # the full key inventory (9 core + 6 FR-56 push + 2 SEC-03 elevation binding + 1 SEC-11 backup replication + 4 AMD-WA WhatsApp), not a sample
    covered = set(re.findall(r"secretKey: (\w+)", EXTERNAL_SECRETS))
    assert referenced <= covered


def test_sec28_store_is_managed_not_manifest():
    assert "kind: ClusterSecretStore" in EXTERNAL_SECRETS
    assert "kind: ExternalSecret" in EXTERNAL_SECRETS
    assert 'target:\n    name: presence-secrets' in EXTERNAL_SECRETS


# -------------------------------------------------------------------- TR-03 --

def test_tr03_mesh_decision_recorded_and_wired():
    assert "Linkerd" in ADR
    assert "mutual authentication" in ADR
    assert "linkerd.io/inject: enabled" in (ROOT / "deploy" / "k8s" / "namespace.yaml").read_text()
    assert "ADR-0010" in README
    assert "linkerd check" in README

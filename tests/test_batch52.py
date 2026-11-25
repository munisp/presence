"""Batch 52 invariants — verification-instrument layer: the in-repo portion
of the 19 bare external-evidence requirements. Latency NFR-01/02/03 and
NFR-06, capacity NFR-08/09/10/11/12, availability NFR-13, assurance SEC-23,
infrastructure INF-08/13/19 and acceptance ACC-01/04/06/08/09 each gain a
concrete instrument (k6 scenario, alert, workflow or document) without
changing classification: all 19 stay external-evidence — the mechanism ships
in-repo, the production evidence stays operational. Ledger counts unchanged:
234 implemented / 6 partial / 0 gap-p0 / 1 phase-gated / 29 external-evidence
of 306.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
K8S = ROOT / "deploy/k8s"
LT = ROOT / "loadtest"

TARGETS = (LT / "targets.js").read_text()
SCAN_LATENCY = (LT / "scan-latency.js").read_text()
CAPACITY = (LT / "capacity.js").read_text()
SOAK = (LT / "soak.js").read_text()
PROBE = (LT / "ratelimit-probe.js").read_text()
LT_README = (LT / "README.md").read_text()

RULES = list(yaml.safe_load_all((K8S / "prometheusrules.yaml").read_text()))[0]
APISIX = list(yaml.safe_load_all((K8S / "apisix.yaml").read_text()))
ROLLBACK = (ROOT / ".github/workflows/rollback.yml").read_text()
ROLLBACK_DOC = (ROOT / "docs/ops/rollback.md").read_text()
ASVS = (ROOT / "docs/security/asvs-masvs-mapping.md").read_text()
DDOS = (ROOT / "docs/security/ddos-posture.md").read_text()
COST = (ROOT / "docs/ops/cost-model.md").read_text()
USABILITY = (ROOT / "docs/ux/usability-protocol.md").read_text()
STORE = (ROOT / "docs/ux/store-review-checklist.md").read_text()
CENTRIFUGO = (K8S / "centrifugo.yaml").read_text()
EDGE = (K8S / "edge.yaml").read_text()
MATCH = (K8S / "match.yaml").read_text()
CLOSURE_SCALE = (ROOT / "tests/test_closure_scale.py").read_text()
TRACE_JSON = json.loads((ROOT / "docs/traceability.json").read_text())

B52_IDS = (
    "NFR-01", "NFR-02", "NFR-03", "NFR-06", "NFR-08", "NFR-09", "NFR-10",
    "NFR-11", "NFR-12", "NFR-13", "SEC-23", "INF-08", "INF-13", "INF-19",
    "ACC-01", "ACC-04", "ACC-06", "ACC-08", "ACC-09",
)


def test_loadtest_files_exist():
    for rel in (
        "loadtest/targets.js", "loadtest/scan-latency.js", "loadtest/capacity.js",
        "loadtest/soak.js", "loadtest/ratelimit-probe.js", "loadtest/README.md",
    ):
        assert (ROOT / rel).exists(), rel


def test_targets_pin_latency_budgets():
    # NFR-01/02/03/06 — the requirement numbers live in exactly one place.
    assert "SCAN_P95_MS = 150" in TARGETS
    assert "SCAN_P99_MS = 400" in TARGETS
    assert "PUBLISH_ACK_P95_MS = 120" in TARGETS
    assert "TAP_TO_RESULTS_P95_MS = 900" in TARGETS


def test_targets_pin_capacity_numbers():
    # NFR-08/09/10 plus the error budget and ACC-04 soak shape.
    assert "SCANS_PER_SECOND_PEAK = 600" in TARGETS
    assert "CONCURRENT_PRESENCES = 25000" in TARGETS
    assert "VENUE_BURST_PER_10MIN = 60000" in TARGETS
    assert "ERROR_BUDGET = 0.001" in TARGETS
    assert 'SOAK_DURATION = "2h"' in TARGETS
    assert "SOAK_RATE_RATIO = 0.6" in TARGETS


def test_scenarios_import_targets_not_restate():
    for src in (SCAN_LATENCY, CAPACITY, SOAK, PROBE):
        assert 'from "./targets.js"' in src


def test_scan_latency_scenario_measures_all_four_budgets():
    for trend in ("scan_latency", "publish_ack_latency", "tap_to_results"):
        assert trend in SCAN_LATENCY
    for budget in ("SCAN_P95_MS", "SCAN_P99_MS", "PUBLISH_ACK_P95_MS", "TAP_TO_RESULTS_P95_MS"):
        assert budget in SCAN_LATENCY


def test_capacity_scenarios_cover_peak_concurrent_and_burst():
    assert "peak_scans" in CAPACITY and "concurrent" in CAPACITY and "venue_burst" in CAPACITY
    assert "SCANS_PER_SECOND_PEAK * PEAK_MULTIPLIER" in CAPACITY
    assert "VENUE_BURST_PER_10MIN / 600" in CAPACITY  # 60000 scans / 600 s = 100/s
    # NFR-11: doubling knob plus the HPA mechanism pointer.
    assert "PEAK_MULTIPLIER" in CAPACITY and "deploy/k8s/edge.yaml" in CAPACITY


def test_error_budget_enforced_in_load_scenarios():
    # NFR-13: k6 exits non-zero when the 0.1% budget is breached — the run
    # is the gate.
    for src in (SCAN_LATENCY, CAPACITY, SOAK):
        assert "http_req_failed" in src
        assert "ERROR_BUDGET" in src


def test_ratelimit_probe_asserts_rejection_and_allowed_latency():
    assert "ratelimit_rejected_429" in PROBE
    assert "/v1/client/config" in PROBE
    assert "SCAN_P99_MS" in PROBE  # allowed traffic still meets NFR-02 under flood


def _burn_alert():
    for group in RULES["spec"]["groups"]:
        for rule in group["rules"]:
            if rule.get("alert") == "ScanAvailabilityBurn":
                return rule
    raise AssertionError("ScanAvailabilityBurn alert missing from prometheusrules.yaml")


def test_nfr13_burn_alert_shape():
    rule = _burn_alert()
    expr = rule["expr"]
    assert "0.001" in expr  # 0.1% monthly error budget
    assert "1h" in expr and "6h" in expr  # multiwindow burn rate
    assert "14.4" in expr and "6 *" in expr  # fast and slow burn factors
    assert "/v1/(scan|presence)" in expr  # scoped to the scan path
    assert rule["labels"]["severity"] == "page"
    assert rule["labels"]["owner"] == "edge-oncall"
    assert rule["annotations"]["runbook"] == "docs/runbook.md#scanavailabilityburn"


def test_runbook_carries_burn_section():
    runbook = (ROOT / "docs/runbook.md").read_text()
    assert "## ScanAvailabilityBurn" in runbook


def test_inf13_limit_count_parsed_from_apisix_yaml():
    plugins = json.dumps(APISIX)
    assert plugins.count("limit-count") >= 2
    assert "remote_addr" in plugins
    assert "1200" in plugins and "120" in plugins
    # plugin config is an embedded multi-line string inside the route doc
    assert "rejected_code: 429" in plugins


def test_acc06_rollback_workflow():
    assert "workflow_dispatch" in ROLLBACK
    assert "rollout undo" in ROLLBACK
    assert "cosign verify" in ROLLBACK
    assert "timeout-minutes: 10" in ROLLBACK  # the ACC-06 budget
    assert "STAGING_DEPLOY_ENABLED" in ROLLBACK and "PRODUCTION_DEPLOY_ENABLED" in ROLLBACK
    assert "/healthz" in ROLLBACK


def test_acc06_rollback_doc_contract():
    assert "10 minutes" in ROLLBACK_DOC
    assert "kubectl rollout undo" in ROLLBACK_DOC
    assert "expand-only" in ROLLBACK_DOC  # why artefact-only rollback is safe


def test_sec23_mapping_covers_asvs_and_masvs():
    assert "ASVS 4.0.3" in ASVS and "MASVS" in ASVS
    for vid in ("V1", "V7", "V14"):
        assert vid in ASVS
    assert "external-evidence" in ASVS  # classification unchanged


def test_inf19_cost_model_inside_budget():
    assert "1 500" in COST  # EUR cap, thin-space form
    assert "1 400" in COST  # modelled total incl. headroom
    assert "Kubecost" in COST  # standing monthly review duty


def test_acc09_usability_protocol_pass_bar():
    assert "8 of 10" in USABILITY
    assert "proximity-based discovery" in USABILITY and "consent-gated visibility" in USABILITY


def test_acc08_store_checklist():
    assert "DELETE /v1/account" in STORE
    assert "18+" in STORE


def test_evidence_pointers_in_existing_manifests():
    assert "INF-08" in CENTRIFUGO
    assert "NFR-11" in EDGE and "NFR-11" in MATCH
    assert "NFR-12" in CLOSURE_SCALE


def test_ledger_counts_unchanged_and_evidence_present():
    assert TRACE_JSON["total"] == 306
    by_id = TRACE_JSON["requirements"]
    assert len(by_id) == 306
    for rid in B52_IDS:
        assert rid in by_id, rid
        r = by_id[rid]
        assert r["evidence"], f"{rid} still bare"
        # classification stays external-evidence — the b51/SEC-07/INF-01 pattern
        assert r["status"] == "external-evidence", rid

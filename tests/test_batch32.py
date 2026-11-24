"""Batch 32 — INF-02 environment promotion, INF-03 data separation, INF-11 OCSP.

These invariants pin the three-environment overlay model (integration /
staging / production), the promotion workflow contract (signed digests only,
staging soak gate before production, environment-scoped kubeconfigs), the
synthetic-only data policy for non-prod, and the gateway's OCSP stapling
directives plus the evidence collector — cross-layer, so a drift in any one
layer fails CI.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

ENVS = ("integration", "staging", "production")
OVERLAY_SRC = {
    env: (ROOT / "deploy" / "k8s" / "overlays" / env / "kustomization.yaml").read_text()
    for env in ENVS
}
BASE_KUSTOMIZATION = (ROOT / "deploy" / "k8s" / "kustomization.yaml").read_text()
DEPLOY_YML = (ROOT / ".github" / "workflows" / "deploy.yml").read_text()
PROMOTE_YML = (ROOT / ".github" / "workflows" / "promote.yml").read_text()
APISIX_YAML = (ROOT / "deploy" / "k8s" / "apisix.yaml").read_text()
K8S_README = (ROOT / "deploy" / "k8s" / "README.md").read_text()
CI_YML = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
ENVS_MD = (ROOT / "docs" / "ops" / "environments.md").read_text()
TLS_MD = (ROOT / "docs" / "ops" / "tls.md").read_text()
CHECK_ENV_SEPARATION = (ROOT / "scripts" / "check_env_separation.py").read_text()
CHECK_TLS_POSTURE = (ROOT / "scripts" / "check_tls_posture.py").read_text()
VALIDATE_DEPLOY = (ROOT / "scripts" / "validate_deploy.py").read_text()

STAGING_JOB = PROMOTE_YML.split("promote-staging:", 1)[1].split("promote-production:", 1)[0]
PRODUCTION_JOB = PROMOTE_YML.split("promote-production:", 1)[1]


# -------------------------------------------------------------- overlays ---

def test_three_overlays_exist_and_reference_the_base() -> None:
    for env in ENVS:
        assert (ROOT / "deploy" / "k8s" / "overlays" / env / "kustomization.yaml").is_file()
        src = OVERLAY_SRC[env]
        assert "kind: Kustomization" in src
        assert "- ../../" in src, f"{env} overlay must build on the flat base"


def test_each_overlay_pins_deploy_env_to_its_own_name() -> None:
    for env in ENVS:
        src = OVERLAY_SRC[env]
        for workload in ("edge", "match"):
            patch = src.split(f"name: {workload}", 1)[1]
            assert re.search(rf"name: DEPLOY_ENV\s*\n\s*value: {env}\b", patch), (
                f"{env}/{workload} does not pin DEPLOY_ENV={env}"
            )


def test_namespace_data_policy_labels() -> None:
    for env in ENVS:
        src = OVERLAY_SRC[env]
        want = "production" if env == "production" else "synthetic-only"
        assert f"presence.dev/data-policy: {want}" in src
        assert f"presence.dev/environment: {env}" in src
    for env in ("integration", "staging"):
        assert "value: production" not in OVERLAY_SRC[env], (
            "non-prod overlay must never claim DEPLOY_ENV=production (INF-03)"
        )


def test_non_prod_footprint_is_capped() -> None:
    integ = OVERLAY_SRC["integration"]
    stag = OVERLAY_SRC["staging"]
    for workload in ("edge", "match"):
        assert re.search(
            rf"kind: Deployment\n\s*metadata:\n\s*name: {workload}\n\s*spec:\n\s*replicas: 1\b",
            integ,
        ), f"integration {workload} must run a single replica"
        assert re.search(
            rf"kind: Deployment\n\s*metadata:\n\s*name: {workload}\n\s*spec:\n\s*replicas: 2\b",
            stag,
        ), f"staging {workload} must run two replicas"
        integ_hpa = re.search(
            rf"kind: HorizontalPodAutoscaler\n\s*metadata:\n\s*name: {workload}\n\s*spec:\n\s*minReplicas: (\d+)\n\s*maxReplicas: (\d+)",
            integ,
        )
        assert integ_hpa and int(integ_hpa.group(1)) == 1 and int(integ_hpa.group(2)) <= 4
        stag_hpa = re.search(
            rf"kind: HorizontalPodAutoscaler\n\s*metadata:\n\s*name: {workload}\n\s*spec:\n\s*minReplicas: (\d+)\n\s*maxReplicas: (\d+)",
            stag,
        )
        assert stag_hpa and int(stag_hpa.group(1)) == 2 and int(stag_hpa.group(2)) <= 8
    # Production inherits base scale: no replicas or HPA patch at all.
    prod = OVERLAY_SRC["production"]
    assert "replicas:" not in prod
    assert "HorizontalPodAutoscaler" not in prod


def test_base_kustomization_resources_unchanged() -> None:
    # The flat deploy/k8s directory stays the base — the overlays were added
    # without moving or renaming any base resource.
    for resource in (
        "namespace.yaml",
        "postgres.yaml",
        "valkey.yaml",
        "centrifugo.yaml",
        "keycloak.yaml",
        "match.yaml",
        "edge.yaml",
        "apisix.yaml",
        "networkpolicy.yaml",
    ):
        assert f"- {resource}" in BASE_KUSTOMIZATION


# ------------------------------------------------------------- pipelines ---

def test_deploy_yml_applies_the_integration_overlay() -> None:
    assert "cd deploy/k8s/overlays/integration" in DEPLOY_YML
    assert "vars.INTEGRATION_DEPLOY_ENABLED == 'true'" in DEPLOY_YML


def test_promote_yml_shape_and_gates() -> None:
    assert "workflow_dispatch:" in PROMOTE_YML
    assert "options: [staging, production]" in PROMOTE_YML
    assert "inputs.target == 'staging' && vars.STAGING_DEPLOY_ENABLED == 'true'" in PROMOTE_YML
    assert "inputs.target == 'production' && vars.PRODUCTION_DEPLOY_ENABLED == 'true'" in PROMOTE_YML
    assert "environment: staging" in PROMOTE_YML
    assert "environment: production" in PROMOTE_YML
    # Both jobs re-verify the merge pipeline's OIDC signature (SEC-24).
    assert STAGING_JOB.count("cosign verify") >= 1
    assert PRODUCTION_JOB.count("cosign verify") >= 1
    assert "token.actions.githubusercontent.com" in PROMOTE_YML
    assert ".github/workflows/deploy.yml" in PROMOTE_YML


def test_promotion_moves_artefacts_not_data() -> None:
    # Staging resolves the digest integration is actually running — the
    # promoted artefact is the observed one, never a re-build.
    assert "Resolve digests from integration" in STAGING_JOB
    assert "INTEGRATION_KUBECONFIG" in STAGING_JOB
    assert "cut -d@ -f2" in STAGING_JOB
    # Kubeconfigs stay environment-scoped: the staging job may not hold the
    # production kubeconfig (INF-03).
    assert "PRODUCTION_KUBECONFIG" not in STAGING_JOB
    assert "STAGING_KUBECONFIG" in STAGING_JOB
    # Production is explicit-only and gated on the staging soak.
    assert "digest-edge is required for production" in PRODUCTION_JOB
    assert "Verify the staging soak gate" in PRODUCTION_JOB
    assert "PRODUCTION_KUBECONFIG" in PRODUCTION_JOB
    assert "overlays/staging" in STAGING_JOB
    assert "overlays/production" in PRODUCTION_JOB


# ------------------------------------------------------------ separation ---

def test_env_separation_gate_is_real_and_passes() -> None:
    assert "def main() -> int:" in CHECK_ENV_SEPARATION
    assert "return 1" in CHECK_ENV_SEPARATION, "violations must exit non-zero"
    # Stdlib-only: it must run in the slimmest CI image.
    assert "import yaml" not in CHECK_ENV_SEPARATION
    proc = subprocess.run(
        [sys.executable, "scripts/check_env_separation.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_environments_doc_records_the_policy() -> None:
    for needle in ("synthetic-only", "synthetic data", "promotion", "never data"):
        assert needle in ENVS_MD


# ------------------------------------------------------------------ INF-11 ---

def test_gateway_staples_ocsp() -> None:
    for directive in (
        "ssl_stapling: on",
        "ssl_stapling_verify: on",
        "ssl_trusted_certificate: /usr/local/apisix/conf/ssl/tls.crt",
        "resolver: kube-dns.kube-system.svc.cluster.local",
        "ssl_protocols: TLSv1.3",
    ):
        assert directive in APISIX_YAML


def test_tls_posture_collector_and_runbook() -> None:
    assert "openssl" in CHECK_TLS_POSTURE
    assert "s_client" in CHECK_TLS_POSTURE
    assert "-status" in CHECK_TLS_POSTURE
    assert "OCSP Response Status: successful" in CHECK_TLS_POSTURE
    # Budget-capped like the revocation drill: a hanging path fails the
    # check rather than stalling a runbook.
    assert re.search(r"timeout=EVIDENCE_BUDGET_S", CHECK_TLS_POSTURE)
    assert "EVIDENCE_BUDGET_S = 30" in CHECK_TLS_POSTURE
    assert "openssl s_client" in TLS_MD
    assert "OCSP" in TLS_MD
    proc = subprocess.run(
        [sys.executable, "scripts/check_tls_posture.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


# ------------------------------------------------------------- regression ---

def test_validate_deploy_covers_batch32() -> None:
    assert 'K8S / "overlays"' in VALIDATE_DEPLOY
    for env in ENVS:
        assert f'"{env}"' in VALIDATE_DEPLOY
    assert "promote.yml" in VALIDATE_DEPLOY
    assert "ssl_stapling" in VALIDATE_DEPLOY
    proc = subprocess.run(
        [sys.executable, "scripts/validate_deploy.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    passed = [ln for ln in proc.stdout.splitlines() if ln.startswith("PASS")]
    assert len(passed) == 70, f"expected 70 checks (66 + 4 batch-32), got {len(passed)}"


def test_k8s_readme_and_ci_cover_the_new_gates() -> None:
    assert "overlays/" in K8S_README
    assert "promote.yml" in K8S_README
    assert "check_env_separation.py" in CI_YML

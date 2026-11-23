#!/usr/bin/env python3
"""INF-15 acceptance criteria: merge -> signed reproducible artefact ->
auto-deploy to integration.

Pins the deploy workflow contract: triggers on merge to main, reproducible
build settings (commit-timestamp SOURCE_DATE_EPOCH, digest addressing),
SBOM + max-mode provenance attestations (SEC-24), keyless cosign signing
and self-verification over the GitHub OIDC identity, the digest fan-in
between the matrix and the deploy job, and the integration rollout that
pins the signed digests rather than mutable tags.

Run: python3 -m pytest tests/test_deploy_pipeline.py
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW_TEXT = (ROOT / ".github/workflows/deploy.yml").read_text()
WORKFLOW = yaml.safe_load(WORKFLOW_TEXT)
CI = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())


def _job(name: str) -> dict:
    return WORKFLOW["jobs"][name]


def _runs(job: dict) -> str:
    return "\n".join(str(s.get("run", "")) for s in job["steps"])


# ------------------------------------------------------------- trigger -----

def test_inf15_triggers_on_merge_to_main() -> None:
    on = WORKFLOW[True] if True in WORKFLOW else WORKFLOW["on"]
    assert "main" in on["push"]["branches"]
    assert "workflow_dispatch" in on


def test_inf15_oidc_and_registry_permissions() -> None:
    perms = WORKFLOW["permissions"]
    assert perms["id-token"] == "write"   # cosign keyless
    assert perms["packages"] == "write"   # GHCR push
    assert perms["contents"] == "read"


# ------------------------------------------------------------- build -------

def test_inf15_both_services_built() -> None:
    matrix = _job("build-and-sign")["strategy"]["matrix"]
    assert matrix["service"] == ["edge", "match"]


def test_inf15_reproducible_epoch_from_commit() -> None:
    steps = _runs(_job("build-and-sign"))
    assert 'echo "value=$(git log -1 --format=%ct)" >> "$GITHUB_OUTPUT"' in WORKFLOW_TEXT
    assert "SOURCE_DATE_EPOCH=${{ steps.epoch.outputs.value }}" in WORKFLOW_TEXT


def test_inf15_sbom_and_provenance_attestations() -> None:
    assert "sbom: true" in WORKFLOW_TEXT
    assert "provenance: mode=max" in WORKFLOW_TEXT


def test_inf15_images_addressable_by_immutable_sha_tag() -> None:
    assert "${{ github.sha }}" in WORKFLOW_TEXT
    # The deploy job pins digests, never the mutable :main tag (pinned below).


# ---------------------------------------------------------------- sign -----

def test_inf15_cosign_signs_and_verifies_the_digest() -> None:
    runs = _runs(_job("build-and-sign"))
    assert 'cosign sign --yes "${IMAGE}@${DIGEST}"' in runs
    assert "cosign verify" in runs
    # The signature is bound to this workflow's OIDC identity.
    assert "--certificate-identity-regexp" in runs
    assert "deploy.yml" in runs
    assert "--certificate-oidc-issuer https://token.actions.githubusercontent.com" in runs


def test_inf15_digest_fans_in_for_deploy() -> None:
    artefacts = _job("artefacts")
    assert artefacts["needs"] == "build-and-sign"
    outputs = artefacts["outputs"]
    assert "edge-digest" in outputs and "match-digest" in outputs
    runs = _runs(artefacts)
    assert "digest-edge/digest.txt" in runs
    assert "digest-match/digest.txt" in runs


# -------------------------------------------------------------- deploy -----

def test_inf15_deploy_job_shape() -> None:
    job = _job("deploy-integration")
    assert job["needs"] == "artefacts"
    assert job["environment"] == "integration"
    assert job["if"] == "vars.INTEGRATION_DEPLOY_ENABLED == 'true'"


def test_inf15_deploy_pins_signed_digests() -> None:
    runs = _runs(_job("deploy-integration"))
    assert "kustomize edit set image" in runs
    assert "edge@${{ needs.artefacts.outputs.edge-digest }}" in runs
    assert "match@${{ needs.artefacts.outputs.match-digest }}" in runs
    assert "kubectl apply -k ." in runs
    assert "rollout status deployment/edge" in runs
    assert "rollout status deployment/match" in runs
    # Mutable tags never reach the cluster.
    assert ":main" not in runs


def test_inf15_kubeconfig_comes_from_environment_secret() -> None:
    assert "secrets.INTEGRATION_KUBECONFIG" in WORKFLOW_TEXT
    assert re.search(r'printf \'%s\' "\$INTEGRATION_KUBECONFIG"', WORKFLOW_TEXT)


def test_inf15_action_versions_pinned() -> None:
    # SEC-24/26 discipline: every action pinned to a major version, none
    # floating on a branch.
    uses = re.findall(r"uses: ([^\s]+)", WORKFLOW_TEXT)
    assert uses
    for action in uses:
        assert re.search(r"@v\d+$", action), action

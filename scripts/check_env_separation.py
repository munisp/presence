#!/usr/bin/env python3
"""INF-03: environment separation gate.

Non-production environments run SYNTHETIC DATA ONLY. Promotion moves
artefacts (signed image digests), never data. This gate makes the policy
machine-checkable so it cannot quietly rot:

  1. every environment overlay labels the namespace with its data policy —
     integration/staging are `synthetic-only`, production is `production`;
  2. every overlay pins DEPLOY_ENV to its own name (non-prod never claims
     to be production);
  3. the promotion workflow keeps kubeconfigs environment-scoped — the
     staging job may not touch the production kubeconfig (production's
     soak gate reads staging read-only, which is the intended direction);
  4. integration and staging overlays shrink the footprint (fewer
     replicas, capped HPA) — non-prod is never a silent second production;
  5. docs/ops/environments.md records the matrix and the synthetic-only
     rule.

Exit 0 on pass, 1 on any violation. Run: python3 scripts/check_env_separation.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OVERLAYS = ROOT / "deploy" / "k8s" / "overlays"
PROMOTE = ROOT / ".github" / "workflows" / "promote.yml"
ENVS_DOC = ROOT / "docs" / "ops" / "environments.md"

ENVS = ("integration", "staging", "production")


def overlay_src(env: str) -> str:
    path = OVERLAYS / env / "kustomization.yaml"
    return path.read_text() if path.exists() else ""


def main() -> int:
    problems: list[str] = []

    for env in ENVS:
        src = overlay_src(env)
        if not src:
            problems.append(f"overlays/{env}/kustomization.yaml missing")
            continue
        if "- ../../" not in src:
            problems.append(f"overlays/{env}: does not reference the base")
        # 1. data-policy label on the namespace patch.
        want_policy = "production" if env == "production" else "synthetic-only"
        if f"presence.dev/data-policy: {want_policy}" not in src:
            problems.append(f"overlays/{env}: namespace lacks data-policy {want_policy}")
        if f"presence.dev/environment: {env}" not in src:
            problems.append(f"overlays/{env}: namespace lacks environment label")
        # 2. DEPLOY_ENV pinned to the overlay's own name.
        if not re.search(rf"name: DEPLOY_ENV\s*\n\s*value: {env}\b", src):
            problems.append(f"overlays/{env}: DEPLOY_ENV is not pinned to {env}")
        if env != "production" and "value: production" in src:
            problems.append(f"overlays/{env}: non-prod overlay claims DEPLOY_ENV=production")

    # 3. kubeconfig isolation in the promotion workflow.
    promote = PROMOTE.read_text() if PROMOTE.exists() else ""
    if not promote:
        problems.append(".github/workflows/promote.yml missing")
    else:
        staging_job = promote.split("promote-staging:", 1)[1].split("promote-production:", 1)[0]
        if "PRODUCTION_KUBECONFIG" in staging_job:
            problems.append("staging job may not reference PRODUCTION_KUBECONFIG")
        production_job = promote.split("promote-production:", 1)[1]
        for needle in ("PRODUCTION_KUBECONFIG", "STAGING_KUBECONFIG", "soak gate", "cosign verify"):
            if needle not in production_job:
                problems.append(f"production promotion is missing: {needle}")
        if "overlays/staging" not in staging_job:
            problems.append("staging job does not apply overlays/staging")
        if "overlays/production" not in production_job:
            problems.append("production job does not apply overlays/production")

    # 4. non-prod stays small.
    for env in ("integration", "staging"):
        src = overlay_src(env)
        for workload in ("edge", "match"):
            m = re.search(
                rf"kind: Deployment\n\s*metadata:\n\s*name: {workload}\n\s*spec:\n\s*replicas: (\d+)",
                src,
            )
            if not m or int(m.group(1)) > 2:
                problems.append(f"overlays/{env}: {workload} replicas must be pinned at 1–2")

    # 5. the policy is documented.
    doc = ENVS_DOC.read_text() if ENVS_DOC.exists() else ""
    for needle in ("synthetic-only", "synthetic data", "promotion", "never data"):
        if needle not in doc:
            problems.append(f"docs/ops/environments.md missing: {needle}")

    for problem in problems:
        print(f"FAIL  {problem}")
    if problems:
        print(f"{len(problems)} violation(s)")
        return 1
    print("Environment separation holds (INF-03).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

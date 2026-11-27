#!/usr/bin/env python3
"""SEC-18 acceptance criteria: third-party SDK allowlist enforced in CI.

Pins: the governed allowlist document and its schema, the fail-closed
checker (missing entry, version-constraint violation, duplicate entries,
unknown ecosystems), the manifest scanners for all four client ecosystems,
the version-matching contract (exact/caret/tilde), and the CI job that
runs the gate on every pull request and push to main.

Run: python3 -m pytest tests/test_sdk_allowlist.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
ALLOWLIST = ROOT / "docs/security/sdk-allowlist.json"
CI = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())


def _checker():
    spec = importlib.util.spec_from_file_location(
        "check_sdk_allowlist", ROOT / "scripts/check_sdk_allowlist.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["check_sdk_allowlist"] = module
    spec.loader.exec_module(module)
    return module


checker = _checker()


# ----------------------------------------------------------- document ------

def test_sec18_allowlist_document_schema() -> None:
    doc = json.loads(ALLOWLIST.read_text())
    assert doc["version"] == "sdk-allowlist/v1"
    assert "fail-closed" in doc["governance"]
    assert isinstance(doc["sdks"], list)
    assert set(doc["fields"]) == {
        "name", "ecosystem", "versionConstraint", "justification", "dataAccess", "approvedBy",
    }


def test_sec18_loaded_entries_are_valid() -> None:
    # load_allowlist exits non-zero on any schema violation.
    entries = checker.load_allowlist()
    assert isinstance(entries, list)


# -------------------------------------------------------- version math -----

@pytest.mark.parametrize(
    "version,constraint,expected",
    [
        ("1.2.3", "1.2.3", True),
        ("1.2.4", "1.2.3", False),
        ("1.9.9", "^1.2.3", True),
        ("2.0.0", "^1.2.3", False),
        ("1.2.2", "^1.2.3", False),       # below the floor
        ("0.4.9", "^0.4.1", True),        # zero-major caret pins minor
        ("0.5.0", "^0.4.1", False),
        ("0.0.9", "^0.0.3", False),       # zero.minor caret is exact
        ("0.0.3", "^0.0.3", True),
        ("1.2.9", "~1.2.3", True),
        ("1.3.0", "~1.2.3", False),
        ("not-a-version", "^1.2.3", False),
        ("1.2.3", "garbage", False),
    ],
)
def test_sec18_version_matching(version: str, constraint: str, expected: bool) -> None:
    assert checker.satisfies(version, constraint) is expected


# ----------------------------------------------------------------- gate ----

def test_sec18_unlisted_dependency_fails() -> None:
    dep = checker.Dependency("npm", "evil-sdk", "1.0.0", "client/app/package.json")
    violations = checker.check([dep], [])
    assert len(violations) == 1
    assert "not on the SEC-18 allowlist" in violations[0]


def test_sec18_constraint_violation_fails() -> None:
    entry = {
        "name": "maps", "ecosystem": "npm", "versionConstraint": "^2.0.0",
        "justification": "j", "dataAccess": "d", "approvedBy": "a",
    }
    dep = checker.Dependency("npm", "maps", "3.1.0", "client/app/package.json")
    violations = checker.check([dep], [entry])
    assert len(violations) == 1
    assert "violates allowlisted constraint" in violations[0]
    good = checker.Dependency("npm", "maps", "2.4.0", "client/app/package.json")
    assert checker.check([good], [entry]) == []


def test_sec18_duplicate_entries_rejected(tmp_path: Path) -> None:
    doc = json.loads(ALLOWLIST.read_text())
    entry = {
        "name": "x", "ecosystem": "npm", "versionConstraint": "1.0.0",
        "justification": "j", "dataAccess": "d", "approvedBy": "a",
    }
    doc["sdks"] = [entry, dict(entry)]
    path = tmp_path / "allowlist.json"
    path.write_text(json.dumps(doc))
    with pytest.raises(SystemExit):
        checker.load_allowlist(path)


def test_sec18_unknown_ecosystem_rejected(tmp_path: Path) -> None:
    doc = json.loads(ALLOWLIST.read_text())
    doc["sdks"] = [{
        "name": "x", "ecosystem": "rubygems", "versionConstraint": "1.0.0",
        "justification": "j", "dataAccess": "d", "approvedBy": "a",
    }]
    path = tmp_path / "allowlist.json"
    path.write_text(json.dumps(doc))
    with pytest.raises(SystemExit):
        checker.load_allowlist(path)


# -------------------------------------------------------------- scanners ---

def test_sec18_npm_manifest_scanned(tmp_path: Path) -> None:
    app = tmp_path / "client" / "app"
    app.mkdir(parents=True)
    (app / "package.json").write_text(json.dumps({
        "dependencies": {"react": "^18.2.0", "left-pad": "1.3.0"},
        "devDependencies": {"vite": "~5.0.0"},
    }))
    deps = checker.scan_manifests(tmp_path / "client")
    assert {(d.ecosystem, d.name, d.version) for d in deps} == {
        ("npm", "react", "18.2.0"),
        ("npm", "left-pad", "1.3.0"),
        ("npm", "vite", "5.0.0"),
    }


def test_sec18_pubspec_scanned(tmp_path: Path) -> None:
    app = tmp_path / "client" / "flutter"
    app.mkdir(parents=True)
    (app / "pubspec.yaml").write_text(
        "name: app\ndependencies:\n  http: ^1.2.0\n  bloc: 8.1.0\n"
        "dev_dependencies:\n  flutter_test:\n    sdk: flutter\n"
    )
    deps = checker.scan_manifests(tmp_path / "client")
    assert {(d.ecosystem, d.name, d.version) for d in deps} == {
        ("pub", "http", "1.2.0"),
        ("pub", "bloc", "8.1.0"),
    }


def test_sec18_podfile_and_gradle_scanned(tmp_path: Path) -> None:
    ios = tmp_path / "client" / "ios"
    android = tmp_path / "client" / "android"
    ios.mkdir(parents=True)
    android.mkdir(parents=True)
    (ios / "Podfile").write_text("pod 'Firebase/Analytics', '10.20.0'\npod 'Alamofire', '~> 5.9.0'\n")
    (android / "build.gradle").write_text(
        'dependencies { implementation "com.squareup.okhttp3:okhttp:4.12.0" }\n'
    )
    deps = checker.scan_manifests(tmp_path / "client")
    assert ("cocoapods", "Firebase/Analytics", "10.20.0") in {
        (d.ecosystem, d.name, d.version) for d in deps
    }
    assert ("cocoapods", "Alamofire", "5.9.0") in {(d.ecosystem, d.name, d.version) for d in deps}
    assert ("maven", "com.squareup.okhttp3:okhttp", "4.12.0") in {
        (d.ecosystem, d.name, d.version) for d in deps
    }


def test_sec18_gate_passes_with_the_landed_client() -> None:
    # Batch 34 landed client/: every declared dependency is allowlisted
    # and the gate passes over the real manifests.
    deps = checker.scan_manifests(ROOT / "client")
    # Batch 66 (AMD-CRT-04): was ten; centrifuge admitted via TECH-16.
    assert len(deps) == 11
    assert {d.ecosystem for d in deps} == {"npm"}
    assert checker.main() == 0


# ------------------------------------------------------------------ CI -----

def test_sec18_ci_job_runs_the_gate() -> None:
    job = CI["jobs"]["sdk-allowlist"]
    steps = "\n".join(str(s.get("run", "")) for s in job["steps"])
    assert "python3 scripts/check_sdk_allowlist.py" in steps

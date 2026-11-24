"""TR-39: gold catalogue gate tests."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from analytics.catalogue import CatalogueError, check, load_catalogue
from analytics.gold import GOLD_REGISTRY

ROOT = Path(__file__).resolve().parent.parent
CATALOGUE = ROOT / "docs" / "analytics" / "catalogue.yaml"
SCRIPT = ROOT / "scripts" / "check_gold_catalogue.py"


def test_shipped_catalogue_satisfies_registry():
    problems = check(GOLD_REGISTRY, load_catalogue(CATALOGUE))
    assert problems == []


def test_unregistered_gold_table_fails():
    tables = load_catalogue(CATALOGUE)
    tables = {k: v for k, v in tables.items() if k != "venue_kpi"}
    problems = check(GOLD_REGISTRY, tables)
    assert any("venue_kpi" in p and "not registered" in p for p in problems)


def test_missing_field_fails():
    tables = load_catalogue(CATALOGUE)
    del tables["consent_funnel"]["owner"]
    problems = check(GOLD_REGISTRY, tables)
    assert any("consent_funnel" in p and "owner" in p for p in problems)


def test_retention_cap_enforced():
    """NFR-23: no analytics store may claim a retention beyond 25 months,
    whatever the ARC's 'indefinite' wording says."""
    tables = load_catalogue(CATALOGUE)
    tables["density_cell_hour"]["retention_months"] = 999
    problems = check(GOLD_REGISTRY, tables)
    assert any("density_cell_hour" in p and "25" in p for p in problems)


def test_orphan_entry_fails():
    tables = load_catalogue(CATALOGUE)
    tables["ghost_table"] = {
        "owner": "x", "grain": "y", "freshness_slo": "z", "retention_months": 1,
    }
    problems = check(GOLD_REGISTRY, tables)
    assert any("ghost_table" in p for p in problems)


def test_version_required(tmp_path):
    bad = tmp_path / "bad.yaml"
    bad.write_text("tables: {}\n")
    with pytest.raises(CatalogueError):
        load_catalogue(bad)


def test_ci_script_passes_on_shipped_catalogue():
    result = subprocess.run(
        [sys.executable, str(SCRIPT)], capture_output=True, text=True, cwd=ROOT
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "4 tables registered" in result.stdout

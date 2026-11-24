"""TR-39: the gold-table catalogue contract.

Every gold table MUST declare an owner, a grain, a freshness SLO and a
retention period, and MUST be registered in the data catalogue before use by
any product surface.

The machine half is GOLD_REGISTRY in analytics/gold.py (the tables the code
can actually produce). The human half is docs/analytics/catalogue.yaml. This
module loads both and checks they agree; scripts/check_gold_catalogue.py is
the CI gate that fails the build on any drift, so an unregistered gold table
can never ship to a product surface.
"""

from __future__ import annotations

from pathlib import Path

import yaml

from .gold import GOLD_REGISTRY

REQUIRED_FIELDS = ("owner", "grain", "freshness_slo", "retention_months")
MAX_RETENTION_MONTHS = 25  # NFR-23 caps every analytics store


class CatalogueError(ValueError):
    """A TR-39 catalogue violation."""


def load_catalogue(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    if not isinstance(doc, dict) or doc.get("version") != "gold-catalogue/v1":
        raise CatalogueError("catalogue must declare version: gold-catalogue/v1")
    tables = doc.get("tables")
    if not isinstance(tables, dict):
        raise CatalogueError("catalogue must hold a tables mapping")
    return tables


def check(registry: dict[str, dict[str, object]], tables: dict) -> list[str]:
    """Return the list of violations (empty when the contract holds)."""
    problems: list[str] = []
    for name in sorted(registry):
        entry = tables.get(name)
        if entry is None:
            problems.append(f"{name}: gold table is not registered in the catalogue")
            continue
        for field in REQUIRED_FIELDS:
            if not entry.get(field):
                problems.append(f"{name}: catalogue entry is missing {field}")
        retention = entry.get("retention_months")
        if isinstance(retention, int) and retention > MAX_RETENTION_MONTHS:
            problems.append(
                f"{name}: retention {retention} months exceeds the NFR-23 cap of {MAX_RETENTION_MONTHS}"
            )
    for name in sorted(tables):
        if name not in registry:
            problems.append(f"{name}: catalogue entry has no producing gold table")
    return problems
